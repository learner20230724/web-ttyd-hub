import { defineConfig } from 'vite'
import { execFileSync } from 'node:child_process'
import vue from '@vitejs/plugin-vue'

export default defineConfig({
  base: process.env.HUB_BASE_PATH ? process.env.HUB_BASE_PATH.replace(/\/$/, '') + '/' : '/',
  plugins: [vue()],
  define: { __HUB_BUILD__: JSON.stringify(execFileSync('git', ['rev-parse', '--short', 'HEAD'], { encoding:'utf8' }).trim()) },
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
