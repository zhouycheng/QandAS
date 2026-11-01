import { defineConfig, loadEnv } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig(({ mode }) => {
  const target = loadEnv(mode, process.cwd(), '').QANDA_API_PROXY_TARGET
  return {
    plugins: [react()],
    server: {
      port: 5174,
      proxy: target ? { '/api': { target, changeOrigin: true } } : undefined,
    },
  }
})
