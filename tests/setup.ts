import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// 每个测试文件（worker 进程）使用独立数据目录，互不污染
process.env.SEL_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'sel-test-'));
process.env.SEL_AI_MODE = 'mock';
// Local HTTP fixtures must not traverse a developer's external proxy.
process.env.NO_PROXY = '127.0.0.1,localhost,::1';
process.env.no_proxy = process.env.NO_PROXY;
