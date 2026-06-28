import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const base = process.env.APP_BASE_PATH || '/psychapp/';

export default defineConfig({
  base: base.endsWith('/') ? base : `${base}/`,
  plugins: [react()],
  server: {
    proxy: {
      '/api': 'http://127.0.0.1:10000',
      '/psychapp/api': 'http://127.0.0.1:10000'
    }
  }
});
