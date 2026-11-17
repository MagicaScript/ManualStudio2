import { defineConfig } from 'vite';
export default defineConfig({ server: { proxy: { '/api': 'http://127.0.0.1:4189', '/models': 'http://127.0.0.1:4189' } }, build: { target: 'es2023', chunkSizeWarningLimit: 1000 } });
