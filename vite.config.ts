import { defineConfig } from 'vite';

/**
 * 纯静态产物：`base: './'` 让 dist/ 可以丢到任意子路径（GitHub Pages / CDN）直接跑。
 */
export default defineConfig({
  base: './',
  server: { port: 5173, host: '127.0.0.1' },
  build: {
    target: 'es2022',
    assetsInlineLimit: 4096,
    sourcemap: false,
  },
});
