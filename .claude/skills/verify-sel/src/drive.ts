import { appendFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { chromium, type Browser, type BrowserContext, type Locator, type Page } from 'playwright';
import { syntheticJpeg } from './jpeg.js';
import { assertSafeBase, readInstance, slotValue, type VerifyInstance } from './instance.js';
import { evidenceDir, IPHONE_SAFARI, storageStatePath } from './paths.js';

export interface DriveOp {
  op: string;
  path?: string;
  testid?: string;
  role?: string;
  name?: string;
  text?: string;
  label?: string;
  exact?: boolean;
  nth?: number;
  timeout?: number;
  state?: 'visible' | 'hidden';
  feature?: string;
  note?: string;
  entry?: string;
  slot?: string;
  key?: string;
  optional?: boolean;
  heading?: string;
  url?: string;
  placeholder?: string;
  blocker?: string;
}

interface LogLine {
  at: string;
  op: string;
  ok: boolean;
  url?: string;
  detail?: string;
  feature?: string;
  entry?: string;
  screenshot?: string;
  aria?: string;
  consoleErrors?: string[];
  networkErrors?: string[];
  error?: string;
}

const DEFAULT_TIMEOUT = 15_000;

export class DriveSession {
  readonly consoleErrors: string[] = [];
  readonly networkErrors: string[] = [];
  private consoleCursor = 0;
  private networkCursor = 0;

  private constructor(
    readonly instance: VerifyInstance,
    readonly browser: Browser,
    readonly context: BrowserContext,
    readonly page: Page,
  ) {}

  static async open(instance: VerifyInstance): Promise<DriveSession> {
    assertSafeBase(instance.base);
    mkdirSync(path.dirname(storageStatePath), { recursive: true });
    const browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({
      baseURL: instance.base,
      viewport: { width: 390, height: 844 },
      deviceScaleFactor: 2,
      isMobile: true,
      hasTouch: true,
      userAgent: IPHONE_SAFARI,
      locale: 'zh-CN',
      timezoneId: 'Asia/Shanghai',
      serviceWorkers: 'block',
      storageState: existsSync(storageStatePath) ? storageStatePath : undefined,
    });
    const page = await context.newPage();
    page.setDefaultTimeout(DEFAULT_TIMEOUT);
    page.setDefaultNavigationTimeout(30_000);
    const session = new DriveSession(instance, browser, context, page);
    page.on('console', message => {
      if (message.type() === 'error') session.consoleErrors.push(trim(message.text()));
    });
    page.on('pageerror', error => session.consoleErrors.push(trim(String(error))));
    page.on('requestfailed', request => {
      if (request.url().includes('favicon')) return;
      session.networkErrors.push(trim(`${request.failure()?.errorText ?? 'failed'} ${request.method()} ${request.url()}`));
    });
    page.on('response', response => {
      if (response.status() >= 500) session.networkErrors.push(trim(`${response.status()} ${response.url()}`));
    });
    return session;
  }

  async close(): Promise<void> {
    await this.context.storageState({ path: storageStatePath }).catch(() => undefined);
    await this.browser.close();
  }

  async run(op: DriveOp, fallbackFeature: string): Promise<LogLine> {
    const timeout = op.timeout ?? DEFAULT_TIMEOUT;
    if (op.op === 'open') {
      await this.page.goto(required(op.path, 'open path'), { waitUntil: 'domcontentloaded', timeout });
      return this.record(op, 'opened');
    }
    if (op.op === 'open-slot') {
      const slot = required(op.slot, 'slot');
      const code = slotValue(this.instance, slot);
      await this.page.goto(`/s/?code=${encodeURIComponent(code)}`, { waitUntil: 'domcontentloaded', timeout });
      return this.record(op, `opened prefill for slot ${slot}`);
    }
    if (op.op === 'reload') {
      await this.page.reload({ waitUntil: 'domcontentloaded', timeout });
      return this.record(op, 'reloaded');
    }
    if (op.op === 'back') {
      await this.page.goBack({ waitUntil: 'domcontentloaded', timeout });
      return this.record(op, 'back');
    }
    if (op.op === 'press') {
      await this.page.keyboard.press(required(op.key, 'key'));
      return this.record(op, `press ${op.key}`);
    }
    if (op.op === 'click') return this.click(op, timeout);
    if (op.op === 'fill') {
      await fillLocator(await this.one(this.locate(op)), required(op.text, 'fill text'));
      return this.record(op, 'filled');
    }
    if (op.op === 'secret') {
      const slot = required(op.slot, 'slot');
      const value = slotValue(this.instance, slot);
      await fillLocator(await this.one(this.locate(op)), value);
      return this.record(op, `filled slot ${slot}`);
    }
    if (op.op === 'files') {
      const testid = required(op.testid, 'testid');
      const input = await fileInput(this.page, testid);
      const jpeg = await syntheticJpeg();
      await input.setInputFiles(jpeg);
      return this.record(op, `attached ${jpeg.name} to ${testid}`);
    }
    if (op.op === 'wait') return this.wait(op, timeout);
    if (op.op === 'shot') return this.shot(op, fallbackFeature);
    if (op.op === 'text') {
      const loc = await this.one(this.locate(op));
      await loc.waitFor({ state: 'visible', timeout });
      const text = trim(await loc.innerText());
      return this.record(op, text);
    }
    if (op.op === 'url') return this.record(op, this.page.url());
    if (op.op === 'swipe') return this.swipe(op);
    if (op.op === 'skip') {
      return this.record(op, `skipped: ${required(op.blocker, 'blocker')}`, { feature: op.feature, entry: op.entry });
    }
    throw new Error(`unknown drive op "${op.op}"`);
  }

  private locate(op: DriveOp): Locator {
    if (op.testid) return nth(this.page.getByTestId(op.testid), op.nth);
    if (op.role && op.name) return nth(this.page.getByRole(op.role as never, { name: op.name, exact: op.exact }), op.nth);
    if (op.label) return nth(this.page.getByLabel(op.label, { exact: op.exact }), op.nth);
    if (op.placeholder) return nth(this.page.getByPlaceholder(op.placeholder, { exact: op.exact }), op.nth);
    if (op.text) return nth(this.page.getByText(op.text, { exact: op.exact }), op.nth);
    if (op.heading) return nth(this.page.getByRole('heading', { name: op.heading, exact: op.exact ?? true }), op.nth);
    throw new Error('name a target with testid, role+name, label, placeholder, text, or heading');
  }

  private async one(loc: Locator): Promise<Locator> {
    const count = await loc.count();
    if (count <= 1) return loc;
    const visible = loc.filter({ visible: true });
    const visibleCount = await visible.count();
    if (visibleCount === 0) throw new Error(`${count} matches, none visible`);
    // The last node is the topmost Ionic overlay when a previous sheet is still dismissing.
    if (visibleCount === 1) return visible;
    return visible.last();
  }

  private async click(op: DriveOp, timeout: number): Promise<LogLine> {
    const loc = this.locate(op);
    if (op.optional) {
      const visible = loc.filter({ visible: true }).first();
      try {
        await visible.waitFor({ state: 'visible', timeout: Math.min(timeout, 1_500) });
      } catch {
        return this.record(op, 'skipped: not visible', { feature: op.feature, entry: op.entry ?? op.testid });
      }
      const ariaDisabled = await visible.getAttribute('aria-disabled');
      const disabledAttr = await visible.getAttribute('disabled');
      if (ariaDisabled === 'true' || disabledAttr !== null || await visible.isDisabled().catch(() => false)) {
        return this.record(op, 'skipped: disabled', { feature: op.feature, entry: op.entry ?? op.testid });
      }
      await visible.click();
      return this.record(op, 'clicked');
    }
    const visible = loc.filter({ visible: true });
    await visible.first().waitFor({ state: 'visible', timeout });
    const target = await this.one(visible);
    await target.click({ timeout });
    return this.record(op, 'clicked');
  }

  private async wait(op: DriveOp, timeout: number): Promise<LogLine> {
    if (op.url) {
      const want = op.url;
      await this.page.waitForURL(url => matchUrl(url.href, want), { timeout });
      return this.record(op, `url ${this.page.url()}`);
    }
    if (op.state === 'hidden') {
      const loc = op.testid
        ? this.page.getByTestId(op.testid)
        : op.role && op.name
          ? this.page.getByRole(op.role as never, { name: op.name, exact: op.exact })
          : op.heading
            ? this.page.getByRole('heading', { name: op.heading, exact: op.exact ?? true })
            : op.text
              ? this.page.getByText(op.text, { exact: op.exact })
              : this.locate(op);
      const deadline = Date.now() + timeout;
      while (Date.now() < deadline) {
        if (await loc.filter({ visible: true }).count() === 0) return this.record(op, 'hidden');
        await this.page.waitForTimeout(50);
      }
      throw new Error(`still visible after ${timeout}ms`);
    }
    if (op.testid && op.text) {
      // Retry until the text appears. A status can be visible as 保存中… before it becomes 已保存.
      const loc = nth(this.page.getByTestId(op.testid), op.nth).filter({ hasText: op.text });
      await loc.first().waitFor({ state: 'visible', timeout });
      return this.record(op, 'visible');
    }
    const target = op.heading
      ? this.page.getByRole('heading', { name: op.heading, exact: op.exact ?? true }).first()
      : op.text
        ? this.page.getByText(op.text, { exact: op.exact }).first()
        : await this.one(this.locate(op));
    await target.waitFor({ state: 'visible', timeout });
    return this.record(op, 'visible');
  }

  private async shot(op: DriveOp, fallbackFeature: string): Promise<LogLine> {
    const feature = slug(op.feature ?? fallbackFeature);
    const name = slug(required(op.name, 'shot name'));
    const dir = path.join(evidenceDir, feature);
    // A page push is still moving when the heading first becomes visible. Wait for finite
    // animations only; a looping skeleton must not block the shot.
    await this.page.evaluate(async () => {
      const running = document.getAnimations().filter(animation => {
        if (animation.playState !== 'running') return false;
        const iterations = animation.effect?.getTiming().iterations;
        return iterations !== Infinity;
      });
      await Promise.race([
        Promise.all(running.map(animation => animation.finished.catch(() => undefined))),
        new Promise(resolve => setTimeout(resolve, 800)),
      ]);
    });
    mkdirSync(dir, { recursive: true });
    const screenshot = path.join(dir, `${name}.png`);
    const aria = path.join(dir, `${name}.aria.txt`);
    await this.page.screenshot({ path: screenshot, type: 'png' });
    try {
      writeFileSync(aria, await this.page.locator('body').ariaSnapshot());
    } catch (error) {
      writeFileSync(aria, `aria snapshot failed: ${error instanceof Error ? error.message : String(error)}\n`);
    }
    const consoleErrors = this.consoleErrors.slice(this.consoleCursor);
    const networkErrors = this.networkErrors.slice(this.networkCursor);
    this.consoleCursor = this.consoleErrors.length;
    this.networkCursor = this.networkErrors.length;
    return this.record(op, op.note ?? '', {
      feature,
      entry: op.entry,
      screenshot,
      aria,
      consoleErrors,
      networkErrors,
    });
  }

  private async swipe(op: DriveOp): Promise<LogLine> {
    const card = await this.one(nth(this.page.getByTestId(required(op.testid, 'testid')), op.nth));
    await card.waitFor({ state: 'visible' });
    const sliding = card.locator('xpath=ancestor-or-self::ion-item-sliding').first();
    const host = (await sliding.count()) ? sliding : card;
    const box = await host.boundingBox();
    if (!box) throw new Error('swipe target has no box');
    const y = box.y + box.height / 2;
    await this.page.mouse.move(box.x + Math.max(8, box.width - 12), y);
    await this.page.mouse.down();
    await this.page.mouse.move(box.x + 12, y, { steps: 12 });
    await this.page.mouse.up();
    const option = host.locator('ion-item-option').first();
    let how = 'pointer';
    try {
      await option.waitFor({ state: 'visible', timeout: 1_000 });
    } catch {
      how = 'ion-item-sliding.open(end)';
      await host.evaluate(async element => {
        const slidingElement = element as HTMLElement & { open?: (side: string) => Promise<void> };
        if (!slidingElement.open) throw new Error('not an ion-item-sliding');
        await slidingElement.open('end');
      });
      await option.waitFor({ state: 'visible', timeout: 3_000 });
    }
    return this.record(op, how);
  }

  async failureShot(message: string, index: number, op: DriveOp): Promise<void> {
    try {
      mkdirSync(evidenceDir, { recursive: true });
      const screenshot = path.join(evidenceDir, 'failure.png');
      await this.page.screenshot({ path: screenshot, type: 'png' });
      this.write({
        at: new Date().toISOString(),
        op: op.op,
        ok: false,
        url: this.page.url(),
        error: message,
        detail: `step ${index}`,
        screenshot,
      });
    } catch { /* the failure itself is the result */ }
  }

  private record(op: DriveOp, detail: string, extra: Partial<LogLine> = {}): LogLine {
    const line: LogLine = {
      at: new Date().toISOString(),
      op: op.op,
      ok: true,
      url: safeUrl(this.page.url()),
      detail: trim(detail),
      ...extra,
    };
    this.write(line);
    return line;
  }

  private write(line: LogLine): void {
    mkdirSync(evidenceDir, { recursive: true });
    appendFileSync(path.join(evidenceDir, 'log.jsonl'), `${JSON.stringify(line)}\n`);
  }
}

function nth(loc: Locator, index: number | undefined): Locator {
  return index === undefined ? loc : loc.nth(index);
}

async function fillLocator(loc: Locator, text: string): Promise<void> {
  const tag = await loc.evaluate(element => element.tagName).catch(() => '');
  if (tag === 'INPUT' || tag === 'TEXTAREA') {
    await loc.fill(text);
    return;
  }
  const inner = loc.locator('textarea:not(.cloned-input), input:not([type=hidden])').first();
  if (await inner.count()) {
    await inner.fill(text);
    return;
  }
  await loc.fill(text);
}

async function fileInput(page: Page, testid: string): Promise<Locator> {
  const host = page.getByTestId(testid).first();
  await host.waitFor({ state: 'attached' });
  const nested = host.locator('input[type="file"]');
  if (await nested.count()) return nested.first();
  const tag = await host.evaluate(element => element.tagName);
  if (tag === 'INPUT') return host;
  throw new Error(`no file input inside ${testid}. Open the 单页 / 多页 sheet and attach the file on capture-mode-single or capture-mode-multi.`);
}

function matchUrl(href: string, want: string): boolean {
  const url = new URL(href);
  if (want.endsWith('*')) return url.pathname.startsWith(want.slice(0, -1));
  const pathOnly = url.pathname.replace(/\/$/, '') || '/';
  const expected = want.replace(/\/$/, '') || '/';
  return pathOnly === expected;
}

function slug(value: string): string {
  const cleaned = value.toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-|-$/g, '');
  if (!cleaned) throw new Error(`unsafe evidence name ${JSON.stringify(value)}`);
  return cleaned;
}

function required(value: string | undefined, label: string): string {
  if (!value) throw new Error(`missing ${label}`);
  return value;
}

function trim(value: string): string {
  return value.replace(/\s+/g, ' ').slice(0, 500);
}

function safeUrl(href: string): string {
  try {
    const url = new URL(href);
    url.searchParams.delete('code');
    return url.pathname + url.search + url.hash;
  } catch {
    return href.replace(/code=[^&]+/g, 'code=redacted');
  }
}
