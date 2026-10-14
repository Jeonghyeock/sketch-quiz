import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// 개발 모드: Vite(5174)가 화면을, Node 서버(PORT, 기본 3100)가 WebSocket을 맡는다.
// 프로덕션: Node 서버 하나가 dist/와 WebSocket을 모두 제공한다.
// 화이트보드(3000/5173)와 포트가 겹치지 않아 둘을 함께 띄울 수 있다.
export default defineConfig({
  root: 'client',
  plugins: [react()],
  build: {
    outDir: '../dist',
    emptyOutDir: true,
  },
  server: {
    port: 5174,
    fs: { allow: ['..'] },
    proxy: {
      '/ws': { target: `ws://localhost:${process.env.PORT ?? 3100}`, ws: true },
    },
  },
});
