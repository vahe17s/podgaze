import { spawn } from "node:child_process";

const ui = spawn("pnpm", ["--filter", "@podgaze/ui", "dev"], { stdio: "inherit" });
const desktop = spawn("pnpm", ["--filter", "@podgaze/desktop", "dev"], { stdio: "inherit" });

function stop() {
  ui.kill("SIGINT");
  desktop.kill("SIGINT");
}

process.on("SIGINT", stop);
process.on("SIGTERM", stop);

desktop.on("exit", (code) => {
  ui.kill("SIGINT");
  process.exit(code ?? 0);
});
