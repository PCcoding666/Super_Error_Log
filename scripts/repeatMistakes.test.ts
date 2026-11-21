import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { checkRepeatMistakes, codeViolations, scanNullableTextPrimaryKeys, scanSsrRoutes } from './repeatMistakes.ts';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('SSR route scan ignores header lookups and keeps the router method', () => {
  const source = `
    response.headers.get('retry-after');
    r.get('/items', page(handler));
    r.post(\`/practice/:pid/\${action}\`, form, page(handler));
    router.post('/practice/:pid/confirm', form, handler);
  `;
  assert.deepEqual(scanSsrRoutes(source, 'src/web/router.ts'), [
    'src/web/router.ts GET /items',
    'src/web/router.ts POST /practice/:pid/${action}',
    'src/web/router.ts POST /practice/:pid/confirm',
  ]);
});

test('nullable text primary keys are the lines missing NOT NULL', () => {
  const source = `
    id TEXT PRIMARY KEY,
    student_id TEXT NOT NULL PRIMARY KEY,
    packet_id TEXT PRIMARY KEY REFERENCES review_packet(id),
    name TEXT NOT NULL,
  `;
  assert.deepEqual(scanNullableTextPrimaryKeys(source, 'src/db/schema.ts'), [
    'src/db/schema.ts\tid TEXT PRIMARY KEY,',
    'src/db/schema.ts\tpacket_id TEXT PRIMARY KEY REFERENCES review_packet(id),',
  ]);
});

test('this checkout has none of the repeated mistakes', () => {
  assert.deepEqual(checkRepeatMistakes(root), []);
});

test('machine paths and env-file reads fail; an ops.env fixture does not', () => {
  assert.deepEqual(codeViolations('tools/replay.mjs', "const dir = '/Users/someone/proj';\n"), [
    'tools/replay.mjs: hardcoded machine path (/Users/…)',
  ]);
  assert.deepEqual(codeViolations('tools/replay.mjs', "fs.readFileSync('/tmp/app/.env', 'utf8');\n"), [
    'tools/replay.mjs: reads a .env file; use process.env and do not open env files',
  ]);
  assert.deepEqual(codeViolations('tests/unit/opsScripts.test.ts', "fs.readFileSync(path.join(prefix, 'etc/super-error-log/ops.env'), 'utf8');\n"), []);
});
