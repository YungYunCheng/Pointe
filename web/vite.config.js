import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: {
    host: true,
    port: 3000,
    // In dev the API is proxied, so the browser only ever talks to one origin
    // and there is no CORS to configure.
    proxy: {
      "/api": { target: process.env.VITE_API_URL || "http://localhost:4000", changeOrigin: true },
    },
  },
  build: { outDir: "dist", sourcemap: false },
});
