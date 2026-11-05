// 4806d18 人工发布的建表演练 / 应用：item_insight、item_answer_photo、item_note 及两个索引。
// 用法：node schema-check.mjs <含 app.db 的目录> <新版发布目录> <当前线上发布目录> [rehearse|apply]
// 按服务自己的方式打开 app.db（<发布目录>/dist/db/connection.js 的 getDb，SEL_DATA_DIR 指向该目录），
// 然后证明：旧表的列、行数、内容逐字节不变；只新增了预期的 5 个对象；再开一次没有任何变化（幂等）；
// rehearse 模式下再用当前线上版本打开一次，证明回退代码不会动这个库。
// 只输出一行 JSON，不输出任何学生内容。
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

const [dataDir, release, previous, mode = 'rehearse'] = process.argv.slice(2);
if (!dataDir || !release || !previous || !['rehearse', 'apply'].includes(mode)) {
  throw new Error('usage: schema-check.mjs <dataDir> <release> <previous> [rehearse|apply]');
}
const filename = path.join(dataDir, 'app.db');
const NEW_TABLES = ['item_insight', 'item_answer_photo', 'item_note'];
const NEW_INDEXES = ['idx_item_insight_item', 'idx_item_answer_photo_item'];
const EXPECTED_NEW = [...NEW_TABLES, ...NEW_INDEXES].sort();

const sha = (value) => crypto.createHash('sha256').update(value).digest('hex');
const hash = (value) => sha(JSON.stringify(value));
const cell = (value) => (value instanceof Uint8Array ? 'blob:' + sha(value) : typeof value === 'bigint' ? value.toString() : value);

function snapshot() {
  const db = new DatabaseSync(filename, { readOnly: true });
  try {
    assert.deepEqual(db.prepare('PRAGMA integrity_check').all().map((row) => row.integrity_check), ['ok']);
    assert.equal(db.prepare('PRAGMA foreign_key_check').all().length, 0);
    const objects = db
      .prepare("SELECT type, name, tbl_name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name")
      .all()
      .map((object) => [object.type, object.name, object.tbl_name, object.sql]);
    const tables = {};
    for (const [, name] of objects.filter((object) => object[0] === 'table')) {
      const columns = db.prepare(`PRAGMA table_info("${name}")`).all().map((column) => column.name);
      const select = `SELECT ${columns.map((column) => `"${column}"`).join(',')} FROM "${name}"`;
      let rows;
      try {
        rows = db.prepare(select + ' ORDER BY rowid').all();
      } catch {
        rows = db.prepare(select).all();
      }
      tables[name] = { columns, count: rows.length, hash: hash(rows.map((row) => columns.map((column) => cell(row[column])))) };
    }
    return { objects, tables };
  } finally {
    db.close();
  }
}

function openWith(releaseDir) {
  const connection = pathToFileURL(path.join(releaseDir, 'dist/db/connection.js')).href;
  const result = spawnSync(
    process.execPath,
    ['--input-type=module', '-e', `const m = await import(${JSON.stringify(connection)}); m.getDb().close();`],
    {
      cwd: dataDir,
      env: { ...process.env, SEL_AI_MODE: 'mock', SEL_DATA_DIR: dataDir, SEL_STUDENT_WORKER: '1' },
      encoding: 'utf8',
      timeout: 120_000,
    },
  );
  if (result.status !== 0) throw new Error(`open with ${releaseDir} failed: ${(result.stderr || '').slice(-1500)}`);
}

// 基线：先按线上版本打开一次。线上服务每次启动都会这么做（connection.js 两版相同，老库的补列也在这里发生），
// 这样下面比较的就只剩「新版比线上版本多做了什么」。
const initial = snapshot();
openWith(previous);
const before = snapshot();
const baselineChangedByLiveRelease = hash(initial) !== hash(before);
const alreadyMigrated = EXPECTED_NEW.filter((name) => before.objects.some((object) => object[1] === name));
openWith(release);
const after = snapshot();
for (const [name, table] of Object.entries(before.tables)) {
  assert.deepEqual(after.tables[name], table, 'old table changed: ' + name);
}
const added = after.objects
  .filter((object) => !before.objects.some((existing) => existing[1] === object[1]))
  .map((object) => object[1])
  .sort();
assert.deepEqual(added, EXPECTED_NEW.filter((name) => !alreadyMigrated.includes(name)), 'unexpected set of added objects');
assert.deepEqual(after.objects.filter((object) => !added.includes(object[1])), before.objects, 'existing objects changed');
openWith(release);
assert.deepEqual(snapshot(), after, 'second open changed the database');
let oldVersionCompatible = null;
if (mode === 'rehearse') {
  openWith(previous);
  assert.deepEqual(snapshot(), after, 'previous release changed the migrated database');
  oldVersionCompatible = true;
}
const tablesWithRows = Object.fromEntries(
  Object.entries(after.tables).filter(([, table]) => table.count > 0).map(([name, table]) => [name, table.count]),
);
console.log(JSON.stringify({
  mode, dataDir: path.basename(dataDir), integrity: 'ok', foreignKeys: 'ok', oldRowsUnchanged: true,
  baselineChangedByLiveRelease, alreadyMigrated, added, idempotent: true, oldVersionCompatible, tablesWithRows,
}));
