import { defineConfig } from "vite";

const apiPort = Number(process.env.PORT ?? 8787);

export default defineConfig({
  base: "./",
  server: {
    port: 5173,
    proxy: { "/api": `http://localhost:${apiPort}` },
  },
  build: { outDir: "dist", emptyOutDir: true },
});
