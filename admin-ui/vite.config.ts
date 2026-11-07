import tailwindcss from '@tailwindcss/vite';
import { defineConfig } from 'vite';

export default defineConfig({
  base: '/admin/',
  plugins: [tailwindcss()],
  server: { host: '127.0.0.1', port: 4173, strictPort: true },
  build: {
    outDir: '../dist/admin-ui',
    emptyOutDir: true,
    rollupOptions: {
      onwarn(warning, warn) {
        // Ant Design's React Server Component markers have no effect in this browser bundle.
        if (warning.code === 'MODULE_LEVEL_DIRECTIVE' && warning.id?.includes('/antd/') && warning.message.includes('"use client"')) return;
        warn(warning);
      },
    },
  },
});
