import { defineConfig } from 'vite';
export default defineConfig({
  root: 'studio',
  base: './',
  build: { outDir: '../.ui-build', emptyOutDir: true },
});
