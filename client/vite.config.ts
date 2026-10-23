import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';

/**
 * 学生端单页应用（Ionic React）。构建产物放进 dist/client，和服务器一起打包发布：
 * 页面壳 dist/client/index.html 由 worker 在 /s/ 等路由下发（需要登录），
 * 静态资源 dist/client/assets 由网关和 worker 共同的公开静态路由 /s/app/assets 下发。
 */
export default defineConfig({
  root: fileURLToPath(new URL('.', import.meta.url)),
  base: '/s/app/',
  plugins: [react()],
  build: {
    outDir: fileURLToPath(new URL('../dist/client', import.meta.url)),
    emptyOutDir: true,
    sourcemap: false,
    target: 'es2020',
  },
});
