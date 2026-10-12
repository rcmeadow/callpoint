import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

const apiPort = Number(process.env.PORT ?? 8787);

export default defineConfig({
  base: "./",
  server: {
    port: 5173,
    // The API listens on 127.0.0.1 only; point the proxy there (localhost can resolve to ::1).
    proxy: { "/api": `http://127.0.0.1:${apiPort}` },
  },
  build: {
    outDir: "dist",
    emptyOutDir: true,
    // Two pages: the landing page at / and the app at /demo/.
    rollupOptions: {
      input: {
        main: fileURLToPath(new URL("./index.html", import.meta.url)),
        demo: fileURLToPath(new URL("./demo/index.html", import.meta.url)),
      },
    },
  },
});
