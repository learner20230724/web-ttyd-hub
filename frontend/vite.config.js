import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'

export default defineConfig({
  base: process.env.HUB_BASE_PATH ? process.env.HUB_BASE_PATH.replace(/\/$/, '') + '/' : '/',
  plugins: [vue()],
  build: {
    outDir: '../server/public',
    emptyOutDir: true
  },
  server: {
    proxy: {
      '/api': 'http://localhost:3000',
      '/ws': {
        target: 'ws://localhost:3000',
        ws: true
      }
    }
  }
})
