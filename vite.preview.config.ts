import { defineConfig } from 'vite';

export default defineConfig({
  build: {
    outDir: '.preview-extension-build',
    emptyOutDir: true,
    target: 'es2022',
    lib: {
      entry: 'src/ui/st-entry.ts',
      formats: ['es'],
      fileName: () => 'index.js',
    },
  },
});
