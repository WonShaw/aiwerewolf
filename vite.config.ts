import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  root: 'web',
  plugins: [react()],
  build: { outDir: '../dist/web', emptyOutDir: true },
  server: {
    port: Number(process.env.PORT ?? 5181),
    host: true, // 监听所有网卡，局域网里的其他人也能打开
    proxy: { '/api': `http://localhost:${process.env.AIWEREWOLF_API_PORT ?? 8788}` },
  },
});
