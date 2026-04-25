import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  base: '/ChessLaunchpad/',
  server: {
    port: 5274,
    strictPort: true,
  },
  preview: {
    port: 4274,
    strictPort: true,
  },
  build: {
    outDir: 'build',
  },
})
