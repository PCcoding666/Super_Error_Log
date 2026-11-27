// 只读查看本地学生库：node db.mjs <table|all> [limit]
// 目录默认是仓库内 data/hf-e2e-20261107（gitignore）。可用 SEL_HF_STUDENT_DIR 指向别的本地目录。
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('../../../../../', import.meta.url));
const dir = process.env.SEL_HF_STUDENT_DIR ?? path.join(root, 'data/hf-e2e-20261107/student-host/students');
if (!fs.existsSync(dir)) {
  console.error(`Student directory not found: ${dir}`);
  process.exit(1);
}
const student = fs.readdirSync(dir)[0];
const db = new DatabaseSync(`${dir}/${student}/app.db`, { readOnly: true });
const tables = db.prepare("select name from sqlite_master where type='table' order by name").all().map(r => r.name);
const [what = 'all', limit = '5'] = process.argv.slice(2);
if (what === 'tables') { console.log(tables.join(', ')); process.exit(0); }
const wanted = what === 'all' ? tables.filter(t => /material_job|material_asset|material_document|material_question|usage|ai_call|error_item|item_insight/.test(t)) : what.split(',');
for (const t of wanted) {
  if (!tables.includes(t)) { console.log('== missing', t); continue; }
  const rows = db.prepare(`select * from ${t} order by rowid desc limit ${Number(limit)}`).all();
  console.log(`== ${t} (${db.prepare(`select count(*) c from ${t}`).get().c} rows)`);
  for (const r of rows) console.log(JSON.stringify(r, (k, v) => typeof v === 'string' && v.length > 300 ? v.slice(0, 300) + '…' : v instanceof Uint8Array ? `<blob ${v.length}>` : v));
}
