import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

/** Code files agents copy. Historical markdown is not in this set. */
const CODE_EXTENSIONS = new Set(['.mjs', '.js', '.cjs', '.ts', '.tsx', '.sh', '.py']);
const SKIP_DIRS = new Set(['node_modules', 'dist', '.git', 'data', 'data-e2e', 'coverage', 'test-results', 'playwright-report', 'releases']);
const MEDIA_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.webp', '.heic', '.gif']);
const MEDIA_ROOTS = ['src/portal/help-img', 'docs/quality'];
const SSR_ROUTE_FILES = [
  'src/web/router.ts',
  'src/web/materialsRouter.ts',
  'src/web/practiceRouter.ts',
  'src/web/practiceSubmissionRouter.ts',
];

export interface RepeatMistakeBaselines {
  webViewFiles: string[];
  ssrRoutes: string[];
  nullableTextPrimaryKeys: string[];
}

const homeDirMarker = `/${'Users'}/`;
const envFileName = `.${'env'}`;

export function loadBaselines(root: string): RepeatMistakeBaselines {
  return JSON.parse(readFileSync(path.join(root, 'scripts/lint/baselines.json'), 'utf8')) as RepeatMistakeBaselines;
}

export function loadMediaAllowlist(root: string): Map<string, string> {
  const allow = new Map<string, string>();
  const text = readFileSync(path.join(root, 'scripts/lint/media-allowlist.txt'), 'utf8');
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const match = /^([0-9a-f]{64})\s+(\S+)$/.exec(trimmed);
    if (!match) throw new Error(`Bad media allowlist line: ${line}`);
    allow.set(match[2]!, match[1]!);
  }
  return allow;
}

export function listWebViewFiles(root: string): string[] {
  const dir = path.join(root, 'src/web/views');
  const found: string[] = [];
  const walk = (current: string): void => {
    for (const name of readdirSync(current)) {
      const full = path.join(current, name);
      if (statSync(full).isDirectory()) walk(full);
      else found.push(path.relative(dir, full).split(path.sep).join('/'));
    }
  };
  walk(dir);
  return found.sort();
}

/** Route registrations on the legacy student SSR routers. `/s/api` is not in this set. */
export function scanSsrRoutes(source: string, file: string): string[] {
  const routes: string[] = [];
  const pattern = /(?:^|[^\w.])(?:r|router)\.(get|post|put|patch|delete)\(\s*(['"`])([\s\S]*?)\2/g;
  for (const match of source.matchAll(pattern)) {
    routes.push(`${file} ${match[1]!.toUpperCase()} ${match[3]}`);
  }
  return routes;
}

export function listSsrRoutes(root: string): string[] {
  const routes: string[] = [];
  for (const file of SSR_ROUTE_FILES) {
    routes.push(...scanSsrRoutes(readFileSync(path.join(root, file), 'utf8'), file));
  }
  return routes.sort();
}

/** SQLite lets a TEXT PRIMARY KEY be NULL unless the column says NOT NULL. */
export function scanNullableTextPrimaryKeys(source: string, file: string): string[] {
  const lines: string[] = [];
  for (const line of source.split('\n')) {
    if (!line.includes('PRIMARY KEY') || !line.includes('TEXT') || line.includes('NOT NULL')) continue;
    lines.push(`${file}\t${line.trim()}`);
  }
  return lines;
}

export function listNullableTextPrimaryKeys(root: string): string[] {
  const dir = path.join(root, 'src/db');
  const found: string[] = [];
  const walk = (current: string): void => {
    for (const name of readdirSync(current)) {
      const full = path.join(current, name);
      if (statSync(full).isDirectory()) walk(full);
      else if (name.endsWith('.ts')) {
        const rel = path.relative(root, full).split(path.sep).join('/');
        found.push(...scanNullableTextPrimaryKeys(readFileSync(full, 'utf8'), rel));
      }
    }
  };
  walk(dir);
  return found.sort();
}

export function listCodeFiles(root: string): string[] {
  const found: string[] = [];
  const walk = (current: string): void => {
    for (const name of readdirSync(current)) {
      if (SKIP_DIRS.has(name)) continue;
      const full = path.join(current, name);
      if (statSync(full).isDirectory()) walk(full);
      else if (CODE_EXTENSIONS.has(path.extname(name))) found.push(full);
    }
  };
  walk(root);
  return found;
}

export function codeViolations(file: string, source: string): string[] {
  const problems: string[] = [];
  if (source.includes(homeDirMarker)) problems.push(`${file}: hardcoded machine path (${homeDirMarker}…)`);
  const envRead = new RegExp(String.raw`readFile(?:Sync)?\([\s\S]{0,200}?['"\`](?:[^'"\`]*\/)?${envFileName}['"\`]`);
  if (envRead.test(source)) problems.push(`${file}: reads a ${envFileName} file; use process.env and do not open env files`);
  return problems;
}

export function listMediaFiles(root: string): { rel: string; hash: string }[] {
  const found: { rel: string; hash: string }[] = [];
  for (const relRoot of MEDIA_ROOTS) {
    const dir = path.join(root, relRoot);
    const walk = (current: string): void => {
      for (const name of readdirSync(current)) {
        const full = path.join(current, name);
        if (statSync(full).isDirectory()) walk(full);
        else if (MEDIA_EXTENSIONS.has(path.extname(name).toLowerCase())) {
          const rel = path.relative(root, full).split(path.sep).join('/');
          const hash = createHash('sha256').update(readFileSync(full)).digest('hex');
          found.push({ rel, hash });
        }
      }
    };
    walk(dir);
  }
  return found.sort((a, b) => a.rel.localeCompare(b.rel));
}

function added(current: string[], allowed: string[]): string[] {
  const known = new Set(allowed);
  return current.filter(item => !known.has(item));
}

export function checkRepeatMistakes(root: string, baselines = loadBaselines(root), media = loadMediaAllowlist(root)): string[] {
  const problems: string[] = [];
  for (const file of added(listWebViewFiles(root), baselines.webViewFiles)) {
    problems.push(`src/web/views/${file}: new legacy SSR view. Student UI goes in client/. Do not add the file to scripts/lint/baselines.json to silence this.`);
  }
  for (const route of added(listSsrRoutes(root), baselines.ssrRoutes)) {
    problems.push(`${route}: new legacy SSR route. Add the JSON API in src/web/api.ts and the screen in client/. Do not extend the baseline to allow it.`);
  }
  for (const column of added(listNullableTextPrimaryKeys(root), baselines.nullableTextPrimaryKeys)) {
    problems.push(`${column}: TEXT PRIMARY KEY without NOT NULL. SQLite will accept NULL and skip the foreign key (see classification schema, 2026-10-16).`);
  }
  for (const full of listCodeFiles(root)) {
    const rel = path.relative(root, full).split(path.sep).join('/');
    // The test fixtures intentionally contain the forbidden strings.
    if (rel === 'scripts/repeatMistakes.test.ts') continue;
    problems.push(...codeViolations(rel, readFileSync(full, 'utf8')));
  }
  const seen = new Set<string>();
  for (const file of listMediaFiles(root)) {
    seen.add(file.rel);
    const expected = media.get(file.rel);
    if (!expected) {
      problems.push(`${file.rel}: image is not in scripts/lint/media-allowlist.txt. Help screenshots and quality evidence have repeatedly included real student exam photos. Add the sha256 only when the image is synthetic and contains no student handwriting.`);
    } else if (expected !== file.hash) {
      problems.push(`${file.rel}: image bytes changed. Update scripts/lint/media-allowlist.txt only if the replacement is synthetic and contains no student work.`);
    }
  }
  for (const rel of media.keys()) {
    if (!seen.has(rel)) problems.push(`scripts/lint/media-allowlist.txt lists missing file ${rel}. Remove that line after the file is deleted.`);
  }
  const playwright = readFileSync(path.join(root, 'playwright.config.ts'), 'utf8');
  for (const name of ['HTTP_PROXY', 'HTTPS_PROXY', 'http_proxy', 'https_proxy', 'NODE_USE_ENV_PROXY']) {
    if (!playwright.includes(name) || !playwright.includes('delete process.env')) {
      problems.push(`playwright.config.ts: must delete ${name}. Local proxy variables make the health check return 502.`);
    }
  }
  const main = readFileSync(path.join(root, 'src/main.ts'), 'utf8');
  if (!main.includes('assertV2AiConfigured(config)')) problems.push('src/main.ts: production entry must call assertV2AiConfigured(config) and must not fall back to mock.');
  const guard = readFileSync(path.join(root, 'src/v2/aiConfigGuard.ts'), 'utf8');
  if (!guard.includes("!== 'bailian'") || !guard.includes('throw')) problems.push("src/v2/aiConfigGuard.ts: non-bailian cloud config must throw, not degrade to mock.");
  const mobile = readFileSync(path.join(root, 'src/mobile/configuration.ts'), 'utf8');
  if (!mobile.includes("!== 'bailian'") || !mobile.includes('throw')) problems.push('src/mobile/configuration.ts: mobile recognition must throw unless mode is bailian.');
  const capture = readFileSync(path.join(root, 'client/src/lib/captureEntry.ts'), 'utf8');
  if (!capture.includes("if (route !== 'materials') return 'direct'")) problems.push('client/src/lib/captureEntry.ts: an unknown upload route must not open the multi-page sheet.');
  if (!capture.includes("if (route !== 'materials') return 'upload'")) problems.push('client/src/lib/captureEntry.ts: an unknown upload route must upload as a single page.');
  if (!capture.includes("return route === 'materials' && pageCount > 0")) problems.push('client/src/lib/captureEntry.ts: the single/multi switch is only for an open materials tray.');
  const uploader = readFileSync(path.join(root, 'client/src/lib/uploader.ts'), 'utf8');
  if (!uploader.includes("fetch('/s/api/upload'") || !uploader.includes('const mode = await this.resolveMode()')) {
    problems.push('client/src/lib/uploader.ts: resolve /s/api/upload before sending a photo. Do not default the queue to legacy.');
  }
  return problems;
}
