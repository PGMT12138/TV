import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import path from 'path';
import {defineConfig} from 'vite';

// 构建产物直接输出到 manage/static/cine，由 FastAPI 挂载在 /cine 下提供访问
export default defineConfig(() => {
  return {
    plugins: [react(), tailwindcss()],
    base: '/cine/',
    resolve: {
      alias: {
        '@': path.resolve(__dirname, '.'),
      },
    },
    build: {
      outDir: path.resolve(__dirname, '../manage/static/cine'),
      emptyOutDir: true,
      chunkSizeWarningLimit: 1500,
    },
    server: {
      hmr: process.env.DISABLE_HMR !== 'true',
      watch: process.env.DISABLE_HMR === 'true' ? null : {},
      // 开发模式下把后端接口代理到本机 manage 服务（本机 8000 端口在 Windows 保留段，固定用 8100）
      proxy: {
        '/api': {target: 'http://127.0.0.1:8100', changeOrigin: true},
        '/stream': {target: 'http://127.0.0.1:8100', changeOrigin: true},
        '/ws': {target: 'ws://127.0.0.1:8100', ws: true},
      },
    },
  };
});
