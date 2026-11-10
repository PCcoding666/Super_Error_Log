import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import { readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { env } from 'node:process';
import { brotliCompressSync, constants as zlib, gzipSync } from 'node:zlib';

/**
 * 构建后把 assets/ 里的文本资源预先压好，.br 和 .gz 放在原文件旁边；服务器按 Accept-Encoding 选着发
 * （src/web/clientApp.ts 的 sendClientAsset）。主脚本约 1.5 MB，压完约 260 KB（br）/ 340 KB（gzip）。
 * 文件名带内容指纹，同名就是同内容，所以压缩件不会和原文件对不上。
 * watch 模式不压：每次改动要多等几秒；没有压缩件时服务器照发原文件。
 */
function precompress(): Plugin {
  return {
    name: 'sel-precompress',
    apply: 'build',
    writeBundle(options, bundle) {
      if (this.meta.watchMode || !options.dir) return;
      for (const fileName of Object.keys(bundle)) {
        if (!/^assets\/[^/]+\.(?:js|css|svg|json)$/.test(fileName)) continue;
        const file = path.join(options.dir, fileName);
        const source = readFileSync(file);
        if (source.length < 1024) continue;
        // 先写到临时名再改名：构建中途被打断时，不会留下一份写了一半却叫 .br 的文件被当成完整的发出去。
        const write = (target: string, bytes: Buffer): void => { writeFileSync(`${target}.tmp`, bytes); renameSync(`${target}.tmp`, target); };
        write(`${file}.br`, brotliCompressSync(source, { params: { [zlib.BROTLI_PARAM_QUALITY]: zlib.BROTLI_MAX_QUALITY, [zlib.BROTLI_PARAM_SIZE_HINT]: source.length } }));
        write(`${file}.gz`, gzipSync(source, { level: 9 }));
      }
    },
  };
}

/** 客户端构建号：提交短号（CI 里是 GITHUB_SHA）+ 构建时间；出错上报带着它，排查时知道学生手里是哪一版。 */
const CLIENT_BUILD = `${(env.GITHUB_SHA ?? env.SEL_BUILD_SHA ?? 'local').slice(0, 7)}.${new Date().toISOString().slice(2, 16).replace(/[-:T]/g, '')}`;

/**
 * 学生端单页应用（Ionic React）。构建产物放进 dist/client，和服务器一起打包发布：
 * 页面壳 dist/client/index.html 由 worker 在 /s/ 等路由下发（需要登录），
 * 静态资源 dist/client/assets 由网关和 worker 共同的公开静态路由 /s/app/assets 下发。
 */
export default defineConfig({
  root: fileURLToPath(new URL('.', import.meta.url)),
  base: '/s/app/',
  plugins: [react(), precompress()],
  define: { __SEL_CLIENT_BUILD__: JSON.stringify(CLIENT_BUILD) },
  build: {
    outDir: fileURLToPath(new URL('../dist/client', import.meta.url)),
    emptyOutDir: true,
    sourcemap: false,
    target: 'es2020',
  },
});
