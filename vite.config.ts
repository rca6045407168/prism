import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Electron loads dist/index.html via `file://` — must use relative asset paths.
export default defineConfig({
  base: "./",
  plugins: [react()],
  build: {
    outDir: "dist",
    sourcemap: false,
    target: "esnext",
  },
  server: {
    port: 5173,
    strictPort: true,
  },
});
