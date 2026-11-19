import { defineConfig, loadEnv } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '')
  const target = env.QANDA_GATEWAY_PROXY_TARGET || env.QANDA_API_PROXY_TARGET || 'http://127.0.0.1:8083'
  const mcp = env.QANDA_MCP_PROXY_TARGET
  return {
    plugins: [react()],
    optimizeDeps: { include: ['@qanda/content-format'] },
    build: { commonjsOptions: { include: [/node_modules/, /packages\/content-format\/dist/] } },
    server: {
      port: 5174,
      proxy: {
        '/api': { target, changeOrigin: true },
        ...(mcp && Object.fromEntries(['/mcp', '/bank-agent/', '/.well-known/oauth-'].map(path => [path, mcp]))),
      },
    },
  }
})
