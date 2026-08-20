import { defineConfig } from 'vite';
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  envPrefix: ['VITE_', 'BOT_'],
  plugins: [tailwindcss(), react()],
  css: {
    postcss: {}
  },
  server: { host: '127.0.0.1' }
});
