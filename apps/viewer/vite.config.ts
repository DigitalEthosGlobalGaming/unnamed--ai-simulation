import { defineConfig, loadEnv } from 'vite';

// The dev server proxies the world server: REST at /api/* and the WebSocket at /api/ws.
// Point it elsewhere with VITE_UAS_SERVER (default http://localhost:8080).
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '');
  const target = env.VITE_UAS_SERVER ?? process.env.VITE_UAS_SERVER ?? 'http://localhost:8080';
  const api = { target, changeOrigin: true, ws: true, rewrite: (p: string) => p.replace(/^\/api/, '') };
  return {
    server: { port: 5173, host: true, proxy: { '/api': api } },
    preview: { proxy: { '/api': api } },
    build: { target: 'es2022', chunkSizeWarningLimit: 1200 },
  };
});
