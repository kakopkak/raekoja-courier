import { defineConfig } from "vite";

export default defineConfig({
  server: {
    port: 5173,
    proxy: {
      "/matchmake": { target: "http://localhost:2567", changeOrigin: true },
      "/colyseus": { target: "http://localhost:2567", changeOrigin: true },
    },
  },
  build: {
    target: "es2020",
    sourcemap: true,
    outDir: "dist",
  },
});
