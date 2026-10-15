import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  // GitHub Pages serves the app under /<repo>/; the deploy workflow sets BASE_PATH. Local dev uses /.
  base: process.env.BASE_PATH ?? '/',
  plugins: [react()],
  // three.js alone is about 900 kB minified; it loads as its own chunk with the renderer (after the splash paints).
  build: { chunkSizeWarningLimit: 1100 },
  // The gym runs batches in a module worker that imports the sim, brain and strategy modules.
  worker: { format: 'es' },
  test: {
    include: ['src/**/*.test.ts'],
    environment: 'node',
    // Some tests play whole matches (2-3 s alone); under a loaded machine the 5 s default flaked.
    testTimeout: 20_000,
    // Tests read the theme's tokens as text (`theme.css?raw`); every other stylesheet stays empty.
    css: { include: [/src\/ui\/theme\.css/] },
  },
});
