import { afterEach, describe, expect, it } from "vitest";
import { createTerminalHost } from "./terminal.js";

describe("local shell", () => {
  const previous = process.env.SHELL;

  afterEach(() => {
    process.env.SHELL = previous;
  });

  // Windows has no pty for the local shell (basic PowerShell over pipes), so there is no size to set.
  it.skipIf(process.platform === "win32")("sizes the shell to the requested columns", async () => {
    process.env.SHELL = "/bin/bash";
    const chunks: string[] = [];
    const host = createTerminalHost({
      kubeconfig: () => null,
      emit(event) {
        if (event.type === "data") chunks.push(event.data);
      },
    });
    const { id } = await host.open({ mode: "shell" });
    host.resize(id, 48, 16);
    await new Promise((resolve) => setTimeout(resolve, 1200));
    host.write(id, "printf '%s\\n' \"$COLUMNS\"\n");
    const started = Date.now();
    let text = "";
    while (Date.now() - started < 3000) {
      await new Promise((resolve) => setTimeout(resolve, 100));
      text = chunks.join("");
      if (/(^|[\r\n])48(\r|\n)/.test(text)) break;
    }
    host.close(id);
    expect(text).toMatch(/48/);
  }, 8000);

  // Windows: a real ConPTY terminal, so the size set here is what PowerShell sees.
  it.runIf(process.platform === "win32")("gives PowerShell a real terminal of the requested size on Windows", async () => {
    const chunks: string[] = [];
    const host = createTerminalHost({
      kubeconfig: () => null,
      emit(event) {
        if (event.type === "data") chunks.push(event.data);
      },
    });
    const { id } = await host.open({ mode: "shell" });
    host.resize(id, 48, 16);
    await new Promise((resolve) => setTimeout(resolve, 3000));
    host.write(id, "Write-Output \"W=$($Host.UI.RawUI.WindowSize.Width)\"\r");
    const started = Date.now();
    let text = "";
    while (Date.now() - started < 8000) {
      await new Promise((resolve) => setTimeout(resolve, 200));
      text = chunks.join("");
      if (/W=48/.test(text)) break;
    }
    host.close(id);
    expect(text).toMatch(/W=48/);
  }, 15000);
});
