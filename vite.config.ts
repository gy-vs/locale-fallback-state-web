/// <reference types="vitest/config" />
import {defineConfig} from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 4173,
    proxy: {'/api': 'http://127.0.0.1:4174'},
  },
  build: {
    outDir: 'dist/client',
    emptyOutDir: true,
  },
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
  },
});
