import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const root = path.dirname(fileURLToPath(import.meta.url));
const desktop = JSON.parse(fs.readFileSync(path.resolve(root, "../../apps/desktop/package.json"), "utf8")) as { version: string };

export default defineConfig({
  plugins: [react()],
  base: "./",
  define: { __PODGAZE_VERSION__: JSON.stringify(desktop.version) },
  server: {
    host: "127.0.0.1",
    port: 5173,
    strictPort: true,
  },
  build: {
    outDir: path.resolve(root, "../../apps/desktop/renderer"),
    emptyOutDir: true,
  },
});
