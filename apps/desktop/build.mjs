import { build } from "esbuild";
import path from "node:path";
import { fileURLToPath } from "node:url";

const dir = path.dirname(fileURLToPath(import.meta.url));

await build({
  entryPoints: [path.join(dir, "src/main.ts")],
  outfile: path.join(dir, "dist/main.js"),
  bundle: true,
  platform: "node",
  format: "esm",
  sourcemap: true,
  // Everything is bundled so the installed app needs no node_modules. ws loads these two only if present.
  external: ["electron", "bufferutil", "utf-8-validate", "@lydell/node-pty"],
  banner: {
    js: "import { createRequire as __createRequire } from 'node:module'; const require = __createRequire(import.meta.url);",
  },
});

await build({
  entryPoints: [path.join(dir, "src/preload.ts")],
  outfile: path.join(dir, "dist/preload.cjs"),
  bundle: true,
  platform: "node",
  format: "cjs",
  sourcemap: true,
  external: ["electron"],
});
