import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig(({ mode }) => ({
  // GitHub Pages serves the app from /Hephaestus/ (`--mode pages`); local dev and preview stay at /.
  base: mode === 'pages' ? '/Hephaestus/' : '/',
  plugins: [react()],
  build: {
    target: 'es2020',
    rollupOptions: { output: { manualChunks: { three: ['three'] } } },
  },
  test: { environment: 'node', include: ['src/**/*.test.ts'] },
} as never));
