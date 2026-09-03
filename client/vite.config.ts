import path from 'node:path';

import { svelte } from '@sveltejs/vite-plugin-svelte';
import tailwindcss from '@tailwindcss/vite';
import { defineConfig, loadEnv } from 'vite';

// https://vite.dev/config/
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, __dirname);
  return {
    // Set VITE_BASE_PATH (e.g. "/mediathek/") to serve the app from a subfolder behind a
    // reverse proxy. Vite rewrites asset URLs and exposes the value as import.meta.env.BASE_URL.
    base: env.VITE_BASE_PATH ?? '/',
    plugins: [tailwindcss(), svelte()],
    server: {
      proxy: {
        '/api': {
          target: env.VITE_API_PROXY_TARGET ?? 'http://localhost:8000/',
          changeOrigin: true,
        },
        '/feed': {
          target: env.VITE_API_PROXY_TARGET ?? 'http://localhost:8000/',
          changeOrigin: true,
        },
        '/ws': {
          target: env.VITE_API_PROXY_TARGET ?? 'http://localhost:8000/',
          changeOrigin: true,
          ws: true,
        },
      },
    },
    resolve: {
      alias: {
        '$lib': path.resolve(__dirname, './src/lib')
      }
    }
  };
});
