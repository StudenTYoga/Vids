import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  base: '/Vids/',          // GitHub Pages: https://studentyoga.github.io/Vids/
});
