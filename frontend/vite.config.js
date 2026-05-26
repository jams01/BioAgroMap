import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

/** En Docker: http://backend:8000. En el host: 127.0.0.1:8000 */
const backendProxy =
  process.env.BACKEND_PROXY_URL || "http://127.0.0.1:8000";

export default defineConfig({
  plugins: [react()],
  server: {
    host: "0.0.0.0",
    port: 5173,
    allowedHosts: ['campbell-monitoring-perhaps-thoughts.trycloudflare.com'],// Volúmen ./frontend:/app: asegura HMR cuando el host no propaga inotify al contenedor.,
    watch: {
      usePolling: true,
      interval: 800,
    },
    proxy: {
      "/api": {
        target: backendProxy,
        changeOrigin: true,
      },
    },
  },
});
