import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

const gateway = process.env.DAVECODE_GATEWAY ?? 'http://127.0.0.1:4040';

export default defineConfig({
  // Relative asset paths: the gateway serves dist/ at `/` with an SPA fallback, and the
  // dashboard uses hash routing, so assets resolve correctly from any URL.
  base: './',
  plugins: [react(), tailwindcss()],
  server: {
    port: 5173,
    strictPort: true,
    proxy: {
      '/api': { target: gateway, changeOrigin: true },
      '/v1': { target: gateway, changeOrigin: true },
    },
  },
  preview: {
    port: 4173,
    proxy: {
      '/api': { target: gateway, changeOrigin: true },
      '/v1': { target: gateway, changeOrigin: true },
    },
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    sourcemap: false,
    target: 'es2022',
  },
});
