import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Builds the React app into dist/client, which the Worker serves as static assets.
// `npm run dev:ui` runs Vite on :5173 and forwards /api to `wrangler dev` on :8787.
export default defineConfig({
  root: 'src/client',
  plugins: [react()],
  build: { outDir: '../../dist/client', emptyOutDir: true, sourcemap: false },
  server: { proxy: { '/api': 'http://localhost:8787' } },
});
