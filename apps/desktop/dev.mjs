import { build } from "esbuild";
import { spawn } from "node:child_process";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import waitOn from "wait-on";

const dir = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);

await build({
  entryPoints: [path.join(dir, "src/main.ts")],
  outfile: path.join(dir, "dist/main.js"),
  bundle: true,
  platform: "node",
  format: "esm",
  sourcemap: true,
  external: ["electron", "@kubernetes/client-node", "@lydell/node-pty"],
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

await waitOn({ resources: ["tcp:127.0.0.1:5173"], timeout: 60_000 });

const electron = require("electron");
const child = spawn(String(electron), ["."], {
  cwd: dir,
  stdio: "inherit",
  env: { ...process.env, PODGAZE_DEV_SERVER: "http://127.0.0.1:5173" },
});

child.on("exit", (code) => process.exit(code ?? 0));
