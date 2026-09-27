import { defineConfig } from "vite"
import react from "@vitejs/plugin-react"

// Em dev, /api vai para o orquestrador (sem CORS). Em produção, sirva o build atrás do mesmo host da API.
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      "/api": {
        target: process.env.ORCH_URL ?? "http://127.0.0.1:8080",
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/api/, ""),
      },
    },
  },
})
