import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { chromium, type Browser, type Page } from '@playwright/test';
import { CLIENT_SCRIPT } from '../../src/web/clientScript.js';

// Run the public browser script against synthetic DOM/media/network boundaries.
// No application servers, student records, source rewriting, or shared e2e fixtures.
interface PendingRequest {
  url: string;
  options: RequestInit;
  resolve: (response: Response) => void;
  finishBody?: (text: string) => void;
}
interface Harness {
  requests: PendingRequest[];
  tracksStopped: number;
  contextsClosed: number;
  recorderStops: number;
  fail: 'constructor' | 'start' | null;
  deferMic: boolean;
  grantMic?: () => void;
  recorder?: { onerror: (() => void) | null };
  errors: string[];
}
type TestWindow = typeof window & { __lifecycle: Harness };

const voiceHtml = (token?: string): string => `<!doctype html><html><head>
${token === undefined ? '' : `<meta name="sel-voice-context" content="${token}">`}
</head><body><form id="answer-form"><textarea id="answer-text">my draft</textarea>
<input name="method" value="keyboard"><div data-voice-for="answer-text" data-endpoint="/s/voice">
<button type="button" data-voice-btn>record</button>
<button type="button" class="hidden" data-voice-retry>retry</button>
<button type="button" class="hidden" data-voice-cancel>cancel</button>
<span data-voice-live class="hidden"><span data-voice-meter></span><span data-voice-time></span></span>
<span data-voice-note></span><span data-voice-wait></span></div></form>
<button type="submit" form="answer-form" data-testid="next-step-primary">submit draft</button></body></html>`;
const pollHtml = '<!doctype html><body data-poll="3"><div data-live="status">waiting</div><span class="hidden" data-wait-net></span></body>';

let browser: Browser;
const pages: Page[] = [];
beforeAll(async () => { browser = await chromium.launch({ headless: true }); });
afterEach(async () => { await Promise.all(pages.splice(0).map(page => page.context().close())); });
afterAll(async () => { await browser?.close(); });

async function boot(html: string): Promise<Page> {
  const page = await browser.newPage();
  pages.push(page);
  await page.clock.install();
  await page.route('**/*', route => route.fulfill({ contentType: 'text/html', body: html }));
  await page.goto('https://lifecycle.invalid/s/synthetic');
  await page.evaluate(() => {
    const h: Harness = { requests: [], tracksStopped: 0, contextsClosed: 0, recorderStops: 0, fail: null, deferMic: false, errors: [] };
    (window as unknown as TestWindow).__lifecycle = h;
    window.addEventListener('unhandledrejection', event => h.errors.push(String(event.reason)));
    window.addEventListener('error', event => h.errors.push(event.message));
    window.fetch = (input, options = {}) => {
      if (options.method === 'HEAD') return Promise.resolve(new Response(''));
      return new Promise<Response>(resolve => h.requests.push({ url: String(input), options, resolve }));
    };
    navigator.mediaDevices.getUserMedia = () => {
      const stream = { getTracks: () => [{ stop() { h.tracksStopped += 1; } }] } as unknown as MediaStream;
      if (h.deferMic) return new Promise<MediaStream>(resolve => { h.grantMic = () => resolve(stream); });
      return Promise.resolve(stream);
    };
    class FakeRecorder {
      static isTypeSupported(): boolean { return true; }
      state = 'inactive';
      mimeType = 'audio/mp4';
      ondataavailable: ((event: { data: Blob }) => void) | null = null;
      onstop: (() => void) | null = null;
      onerror: (() => void) | null = null;
      constructor() {
        if (h.fail === 'constructor') throw new Error('synthetic constructor failure');
        h.recorder = this;
      }
      start(): void {
        if (h.fail === 'start') throw new Error('synthetic start failure');
        this.state = 'recording';
      }
      stop(): void {
        h.recorderStops += 1;
        this.state = 'inactive';
        this.ondataavailable?.({ data: new Blob(['synthetic student A audio'], { type: this.mimeType }) });
        this.onstop?.();
      }
    }
    class FakeAudioContext {
      resume(): Promise<void> { return Promise.resolve(); }
      close(): Promise<void> { h.contextsClosed += 1; return Promise.resolve(); }
      createMediaStreamSource(): { connect(): void; disconnect(): void } { return { connect() {}, disconnect() {} }; }
      createAnalyser(): { fftSize: number; disconnect(): void; getByteTimeDomainData(buffer: Uint8Array): void } {
        return { fftSize: 512, disconnect() {}, getByteTimeDomainData(buffer) { buffer.fill(128); } };
      }
    }
    Object.defineProperty(window, 'MediaRecorder', { configurable: true, value: FakeRecorder });
    Object.defineProperty(window, 'AudioContext', { configurable: true, value: FakeAudioContext });
  });
  await page.addScriptTag({ content: CLIENT_SCRIPT });
  await page.evaluate(() => document.dispatchEvent(new Event('DOMContentLoaded')));
  return page;
}

async function record(page: Page): Promise<void> {
  await page.locator('[data-voice-btn]').click();
  await page.waitForFunction(() => document.querySelector('[data-voice-btn]')?.textContent === '说完了');
}
async function transcribe(page: Page): Promise<void> {
  await record(page);
  await page.locator('[data-voice-btn]').click();
  await page.waitForFunction(() => (window as unknown as TestWindow).__lifecycle.requests.length > 0);
}
async function respond(page: Page, status: number, body: string, stallBody = false, index = 0): Promise<void> {
  await page.evaluate(({ status, body, stallBody, index }) => {
    const request = (window as unknown as TestWindow).__lifecycle.requests[index]!;
    const response = new Response(body, { status, headers: { 'content-type': 'application/json' } });
    Object.defineProperty(response, 'url', { value: location.href });
    if (stallBody) {
      response.text = () => new Promise<string>(resolve => { request.finishBody = resolve; });
      response.json = () => new Promise<string>(resolve => { request.finishBody = resolve; }).then(text => JSON.parse(text));
    }
    request.resolve(response);
  }, { status, body, stallBody, index });
  // Flush the response/body microtasks without depending on any private script function.
  await page.evaluate(() => Promise.resolve());
}
async function stats(page: Page) {
  return page.evaluate(() => {
    const h = (window as unknown as TestWindow).__lifecycle;
    return {
      requests: h.requests.length, stopped: h.tracksStopped, closed: h.contextsClosed,
      aborted: h.requests.map(request => request.options.signal?.aborted ?? false),
      text: (document.querySelector('#answer-text') as HTMLTextAreaElement | null)?.value,
      primaryDisabled: (document.querySelector('[data-testid=next-step-primary]') as HTMLButtonElement | null)?.disabled,
      recordDisabled: (document.querySelector('[data-voice-btn]') as HTMLButtonElement | null)?.disabled,
      retryDisabled: (document.querySelector('[data-voice-retry]') as HTMLButtonElement | null)?.disabled,
      retryHidden: document.querySelector('[data-voice-retry]')?.classList.contains('hidden'),
      cancelHidden: document.querySelector('[data-voice-cancel]')?.classList.contains('hidden'),
      liveHidden: document.querySelector('[data-voice-live]')?.classList.contains('hidden'),
      netHidden: document.querySelector('[data-wait-net]')?.classList.contains('hidden'),
      note: document.querySelector('[data-voice-note]')?.textContent,
      errors: h.errors,
    };
  });
}

it('keeps a secondary submit button accessible name in sync with its waiting message', async () => {
  const page = await boot('<!doctype html><meta charset="utf-8"><form id="skip" data-wait="正在准备练习纸…"><button type="submit" aria-label="跳过，直接打印">跳过，直接打印</button></form>');
  await page.evaluate(() => document.querySelector('form')!.addEventListener('submit', event => event.preventDefault()));
  await page.getByRole('button', { name: '跳过，直接打印', exact: true }).click();
  expect(await page.locator('button').textContent()).toBe('正在准备练习纸…');
  expect(await page.locator('button').getAttribute('aria-label')).toBe('正在准备练习纸…');
});

describe('voice request and microphone lifecycle', () => {
  it.each([false, true])('times out the whole response, including a stalled body=%s, and permits same-clip retry', async stallBody => {
    const page = await boot(voiceHtml('page-A'));
    await transcribe(page);
    if (stallBody) await respond(page, 200, '', true);
    await page.clock.fastForward(45_001);
    expect(await stats(page)).toMatchObject({ primaryDisabled: false, retryHidden: false, cancelHidden: true, stopped: 1, closed: 1, aborted: [true], text: 'my draft', errors: [] });
    expect((await stats(page)).note).toContain('超时');
    await page.locator('[data-voice-retry]').click();
    await page.waitForFunction(() => (window as unknown as TestWindow).__lifecycle.requests.length === 2);
    expect(await page.evaluate(() => {
      const requests = (window as unknown as TestWindow).__lifecycle.requests;
      return requests[0]!.options.body === requests[1]!.options.body;
    })).toBe(true);
    await page.evaluate(() => {
      const old = (window as unknown as TestWindow).__lifecycle.requests[0]!;
      if (old.finishBody) old.finishBody(JSON.stringify({ text: 'late old response' }));
      else old.resolve(new Response(JSON.stringify({ text: 'late old response' })));
    });
    await respond(page, 200, JSON.stringify({ text: 'new result' }), false, 1);
    await page.waitForFunction(() => (document.querySelector('#answer-text') as HTMLTextAreaElement).value === 'my draft new result');
    expect(await stats(page)).toMatchObject({ primaryDisabled: false, retryHidden: true, errors: [] });
  });

  it.each(['cancel', 'pagehide'])('discards a stalled transcription and ignores its late response on %s', async action => {
    const page = await boot(voiceHtml());
    await transcribe(page);
    await respond(page, 200, '', true);
    if (action === 'cancel') await page.locator('[data-voice-cancel]').click();
    else await page.evaluate(() => window.dispatchEvent(new Event('pagehide')));
    await page.evaluate(() => (window as unknown as TestWindow).__lifecycle.requests[0]!.finishBody!(JSON.stringify({ text: 'must never appear' })));
    await page.clock.fastForward(60_001);
    expect(await stats(page)).toMatchObject({ text: 'my draft', primaryDisabled: false, retryHidden: true, cancelHidden: true, requests: 1, aborted: [true], stopped: 1, closed: 1, errors: [] });
  });

  it.each(['cancel', 'pagehide'])('stops a live microphone without uploading on %s', async action => {
    const page = await boot(voiceHtml());
    await record(page);
    if (action === 'cancel') await page.locator('[data-voice-cancel]').click();
    else await page.evaluate(() => window.dispatchEvent(new Event('pagehide')));
    await page.clock.fastForward(60_001);
    expect(await stats(page)).toMatchObject({ requests: 0, stopped: 1, closed: 1, primaryDisabled: false, liveHidden: true, errors: [] });
    if (action === 'pagehide') await page.evaluate(() => window.dispatchEvent(new Event('pageshow')));
    await record(page);
    expect(await stats(page)).toMatchObject({ requests: 0, primaryDisabled: true });
  });

  it.each(['constructor', 'start'] as const)('releases acquired tracks and audio context after %s failure', async fail => {
    const page = await boot(voiceHtml());
    await page.evaluate(fail => { (window as unknown as TestWindow).__lifecycle.fail = fail; }, fail);
    await page.locator('[data-voice-btn]').click();
    await page.waitForFunction(() => document.querySelector('[data-voice-note]')?.textContent?.includes('用不了'));
    await page.clock.fastForward(60_001);
    expect(await stats(page)).toMatchObject({ requests: 0, stopped: 1, closed: 1, primaryDisabled: false, recordDisabled: false, cancelHidden: true, errors: [] });
  });

  it('releases resources on a recorder error without sending partial audio', async () => {
    const page = await boot(voiceHtml());
    await record(page);
    await page.evaluate(() => (window as unknown as TestWindow).__lifecycle.recorder!.onerror!());
    await page.clock.fastForward(60_001);
    expect(await stats(page)).toMatchObject({ requests: 0, stopped: 1, closed: 1, primaryDisabled: false, liveHidden: true, errors: [] });
  });

  it.each(['cancel', 'pagehide'])('stops a late getUserMedia stream after %s', async action => {
    const page = await boot(voiceHtml());
    await page.evaluate(() => { (window as unknown as TestWindow).__lifecycle.deferMic = true; });
    await page.locator('[data-voice-btn]').click();
    await page.waitForFunction(() => Boolean((window as unknown as TestWindow).__lifecycle.grantMic));
    if (action === 'cancel') await page.locator('[data-voice-cancel]').click();
    else await page.evaluate(() => window.dispatchEvent(new Event('pagehide')));
    await page.evaluate(() => (window as unknown as TestWindow).__lifecycle.grantMic!());
    await page.clock.fastForward(60_001);
    expect(await stats(page)).toMatchObject({ requests: 0, stopped: 1, closed: 1, primaryDisabled: false, recordDisabled: false, errors: [] });
  });

  it('pins the page token across retries and permanently disables voice on 409 without changing the draft', async () => {
    const page = await boot(voiceHtml('page-A'));
    await transcribe(page);
    await respond(page, 503, JSON.stringify({ error: { message: 'temporary' } }));
    await page.waitForFunction(() => !document.querySelector('[data-voice-retry]')!.classList.contains('hidden'));
    await page.evaluate(() => document.querySelector('meta[name=sel-voice-context]')!.setAttribute('content', 'page-B'));
    await page.locator('[data-voice-retry]').click();
    await page.waitForFunction(() => (window as unknown as TestWindow).__lifecycle.requests.length === 2);
    expect(await page.evaluate(() => (window as unknown as TestWindow).__lifecycle.requests.map(r => (r.options.headers as Record<string, string>)['x-sel-voice-context']))).toEqual(['page-A', 'page-A']);
    // Even a non-JSON or stalled 409 body must not postpone the session lock.
    await respond(page, 409, '', true, 1);
    await page.waitForFunction(() => (document.querySelector('[data-voice-btn]') as HTMLButtonElement).disabled);
    expect(await stats(page)).toMatchObject({ text: 'my draft', recordDisabled: true, retryDisabled: true, retryHidden: true, primaryDisabled: false, errors: [] });
    expect((await stats(page)).note).toContain('登录已切换');
    await page.evaluate(() => {
      document.querySelector('[data-voice-retry]')!.dispatchEvent(new Event('click'));
      document.querySelector('[data-voice-btn]')!.dispatchEvent(new Event('click'));
    });
    expect((await stats(page)).requests).toBe(2);
  });

  it('allows legacy pages without a context meta and sends no context header', async () => {
    const page = await boot(voiceHtml());
    await transcribe(page);
    expect(await page.evaluate(() => (window as unknown as TestWindow).__lifecycle.requests[0]!.options.headers)).toEqual({ 'content-type': 'audio/mp4' });
    await respond(page, 200, JSON.stringify({ text: 'legacy result' }));
    await page.waitForFunction(() => (document.querySelector('#answer-text') as HTMLTextAreaElement).value === 'my draft legacy result');
    expect(await stats(page)).toMatchObject({ stopped: 1, closed: 1, primaryDisabled: false, errors: [] });
  });
});

describe('poll request lifecycle', () => {
  it('uses the current grid and camera labels when a poll completed before album selection', async () => {
    const html = `<!doctype html><body data-poll="3">
      <form data-upload action="/s/capture" data-photo-count="1">
        <input id="camera-input" type="file"><input id="library-input" type="file">
        <div data-upload-progress><div role="progressbar"><i></i></div></div>
        <p data-upload-message></p><ul data-upload-list></ul><button type="button" data-upload-retry>retry</button>
      </form>
      <p data-testid="photo-count">已拍 1 张</p>
      <div data-live="grid" data-photo-grid><figure data-testid="photo-tile">waiting</figure></div>
      <nav class="next-bar" data-live="bar"><label for="camera-input">camera</label><label for="library-input">album</label></nav>
    </body>`;
    const page = await boot(html);
    await page.clock.fastForward(3_001);
    await respond(page, 200, html.replace(' data-poll="3"', '').replace('waiting', 'found').replace('>camera<', '>take another<'));
    await page.waitForFunction(() => !document.body.hasAttribute('data-poll'));
    expect(await page.locator('[data-photo-grid]').textContent()).toBe('found');
    const base64 = await page.evaluate(() => {
      XMLHttpRequest.prototype.send = function() {
        (window as unknown as { finishSyntheticUpload: () => void }).finishSyntheticUpload = () => {
          Object.defineProperty(this, 'status', { value: 200 });
          Object.defineProperty(this, 'responseText', { value: JSON.stringify({ ok: true, jobId: 'synthetic-job' }) });
          this.onload?.call(this, new ProgressEvent('load'));
        };
      };
      const canvas = document.createElement('canvas'); canvas.width = 4; canvas.height = 4;
      return canvas.toDataURL('image/png').split(',')[1]!;
    });
    await page.locator('#library-input').setInputFiles([
      { name: 'valid.png', mimeType: 'image/png', buffer: Buffer.from(base64, 'base64') },
      { name: 'broken.jpg', mimeType: 'image/jpeg', buffer: Buffer.from('broken') },
    ]);
    await page.waitForFunction(() => typeof (window as unknown as { finishSyntheticUpload?: () => void }).finishSyntheticUpload === 'function');
    await expect.poll(() => page.locator('.next-bar label[for=camera-input]').getAttribute('aria-disabled')).toBe('true');
    expect(await page.locator('.next-bar label[for=camera-input]').evaluate(label => label.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true })))).toBe(false);
    await page.evaluate(() => (window as unknown as { finishSyntheticUpload: () => void }).finishSyntheticUpload());
    await page.waitForFunction(() => document.querySelector('[data-upload-message]')?.textContent?.includes('1 张失败'));
    expect(await page.locator('[data-photo-grid] [data-testid=photo-tile]').count()).toBe(2);
    expect(await page.locator('[data-testid=photo-count]').textContent()).toBe('已拍 2 张');
  });

  it('retains local upload results when an earlier poll finishes during a pending batch', async () => {
    const page = await boot(pollHtml.replace('<div data-live=', '<form data-upload></form><div data-live='));
    await page.clock.fastForward(3_001);
    await page.waitForFunction(() => (window as unknown as TestWindow).__lifecycle.requests.length === 1);
    await page.evaluate(() => {
      document.querySelector('form[data-upload]')!.setAttribute('data-upload-pending', '');
      document.querySelector('[data-live=status]')!.textContent = 'local uploaded photos';
    });
    await respond(page, 200, '<body><div data-live="status">server status</div></body>');
    await page.clock.runFor(50);
    expect(await page.locator('[data-live=status]').textContent()).toBe('local uploaded photos');
    await page.clock.fastForward(3_001);
    expect(await stats(page)).toMatchObject({ requests: 2, errors: [] });
    await respond(page, 200, '<body><div data-live="status">new server status</div></body>', false, 1);
    await page.clock.runFor(50);
    expect(await page.locator('[data-live=status]').textContent()).toBe('local uploaded photos');
  });

  it.each([false, true])('recovers from a stalled poll body=%s without a reload or a permanent busy flag', async stallBody => {
    const page = await boot(pollHtml);
    await page.clock.fastForward(3_001);
    await page.waitForFunction(() => (window as unknown as TestWindow).__lifecycle.requests.length === 1);
    if (stallBody) await respond(page, 200, '', true);
    await page.clock.fastForward(15_001);
    expect(await stats(page)).toMatchObject({ requests: 1, aborted: [true], netHidden: false, errors: [] });
    await page.clock.fastForward(6_001);
    await page.waitForFunction(() => (window as unknown as TestWindow).__lifecycle.requests.length === 2);
    await respond(page, 200, '<body><div data-live="status">done</div></body>', false, 1);
    await page.waitForFunction(() => !document.body.hasAttribute('data-poll'));
    expect(await page.locator('[data-live=status]').textContent()).toBe('done');
  });

  it.each([429, 503])('keeps page state and retries HTTP %s', async status => {
    const page = await boot(pollHtml);
    await page.clock.fastForward(3_001);
    await respond(page, status, 'temporary');
    await page.waitForFunction(() => !document.querySelector('[data-wait-net]')!.classList.contains('hidden'));
    expect(await page.locator('[data-live=status]').textContent()).toBe('waiting');
    await page.clock.fastForward(6_001);
    expect((await stats(page)).requests).toBe(2);
  });

  it('aborts polls on pagehide and discards old responses after pageshow', async () => {
    const page = await boot(pollHtml);
    await page.clock.fastForward(3_001);
    await respond(page, 200, '', true);
    await page.evaluate(() => window.dispatchEvent(new Event('pagehide')));
    await page.clock.fastForward(30_001);
    expect(await stats(page)).toMatchObject({ requests: 1, aborted: [true], errors: [] });
    await page.evaluate(() => {
      (window as unknown as TestWindow).__lifecycle.requests[0]!.finishBody!('<body><div data-live="status">stale</div></body>');
      window.dispatchEvent(new Event('pageshow'));
    });
    await page.clock.fastForward(1);
    await page.waitForFunction(() => (window as unknown as TestWindow).__lifecycle.requests.length === 2);
    expect(await page.locator('[data-live=status]').textContent()).toBe('waiting');
  });
});
