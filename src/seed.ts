/** demo seed：创建匿名学生档案（若不存在）。fixture 请先用 npm run fixtures:generate 生成。 */
import fs from 'node:fs';
import { getDb, resetDbForTest } from './db/connection.js';
import { MANIFEST_PATH } from './fixtures/generate.js';
import { createProfile, getProfile } from './services/studentService.js';

getDb();

if (!fs.existsSync(MANIFEST_PATH)) {
  console.error('缺少 fixture：请先运行 npm run fixtures:generate');
  process.exit(1);
}

if (!getProfile()) {
  createProfile({ nickname: '演示学生', subjects: ['数学', '物理', '化学'], weekendPref: '周六上午' });
  console.log('已创建匿名学生档案：演示学生');
} else {
  console.log('学生档案已存在，跳过创建');
}

resetDbForTest();
console.log('seed 完成。启动 npm run dev 后，在首页上传 fixtures/assets/week1/ 下的 19 个文件即可演示完整闭环。');
