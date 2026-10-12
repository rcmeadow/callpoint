import { defineConfig } from "vite";

const apiPort = Number(process.env.PORT ?? 8787);

export default defineConfig({
  base: "./",
  server: {
    port: 5173,
    // The API listens on 127.0.0.1 only; point the proxy there (localhost can resolve to ::1).
    proxy: { "/api": `http://127.0.0.1:${apiPort}` },
  },
  build: { outDir: "dist", emptyOutDir: true },
});
