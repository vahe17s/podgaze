// Starts the packaged app (from release/*-unpacked) hidden, and passes when it loads its page and bridge and
// reads the kubeconfig. Used after `electron-builder` locally and in CI.
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const dir = path.dirname(fileURLToPath(import.meta.url));
const release = path.join(dir, "release");
const candidates = {
  linux: [path.join(release, "linux-unpacked", "podgaze")],
  darwin: ["mac-arm64", "mac", "mac-universal"].map((folder) => path.join(release, folder, "Podgaze.app", "Contents", "MacOS", "Podgaze")),
  win32: [path.join(release, "win-unpacked", "Podgaze.exe")],
}[process.platform] ?? [];
const binary = candidates.find((file) => fs.existsSync(file));
if (!binary) {
  console.error(`No packaged app found. Looked for: ${candidates.join(", ")}`);
  process.exit(1);
}

const args = process.platform === "linux" ? ["--no-sandbox"] : [];
const child = spawn(binary, args, { env: { ...process.env, PODGAZE_SMOKE_TEST: "1" }, stdio: ["ignore", "pipe", "pipe"] });
let output = "";
child.stdout.on("data", (chunk) => (output += chunk));
child.stderr.on("data", (chunk) => (output += chunk));
const killer = setTimeout(() => child.kill("SIGKILL"), 60_000);
child.on("exit", (code) => {
  clearTimeout(killer);
  const line = output.split("\n").find((text) => text.startsWith("PODGAZE_SMOKE_"));
  console.log(line ?? output.slice(-2000));
  process.exit(code === 0 && line?.startsWith("PODGAZE_SMOKE_OK") ? 0 : 1);
});
