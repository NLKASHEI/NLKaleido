import { defineConfig } from 'vite';
import { resolve } from 'node:path';

export default defineConfig({
  root: 'studio',
  base: './',
  build: {
    outDir: '../.ui-build',
    emptyOutDir: true,
    rollupOptions: {
      input: {
        studio:resolve('studio/index.html'),
        player:resolve('studio/player.html'),
      },
    },
  },
});
