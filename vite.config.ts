import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  // GitHub Pages serves the app under /<repo>/; the deploy workflow sets BASE_PATH. Local dev uses /.
  base: process.env.BASE_PATH ?? '/',
  plugins: [react()],
  // The gym runs batches in a module worker that imports the sim, brain and strategy modules.
  worker: { format: 'es' },
  test: {
    include: ['src/**/*.test.ts'],
    environment: 'node',
  },
});
