import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import { PassThrough, Writable } from "node:stream";
import { Exec } from "@kubernetes/client-node";
import type { TerminalEvent, TerminalRequest } from "@podgaze/contracts";
import { loadContextConfig } from "@podgaze/cluster";

const ptyScript = `
import errno, fcntl, os, pty, select, signal, struct, sys, termios

cols = int(sys.argv[1]) if len(sys.argv) > 1 else 80
rows = int(sys.argv[2]) if len(sys.argv) > 2 else 24
shell = sys.argv[3] if len(sys.argv) > 3 else "/bin/bash"

def apply_size(fd, width, height):
    fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", height, width, 0, 0))

def parse_size(blob):
    global cols, rows, pending
    pending += blob
    while b"\\n" in pending:
        line, pending = pending.split(b"\\n", 1)
        parts = line.split()
        if len(parts) >= 2:
            try:
                cols = max(1, int(parts[0]))
                rows = max(1, int(parts[1]))
            except ValueError:
                pass

pending = b""
resize_fd = 3
try:
    os.set_blocking(resize_fd, False)
    ready, _, _ = select.select([resize_fd], [], [], 0.8)
    if ready:
        parse_size(os.read(resize_fd, 256))
except OSError:
    resize_fd = None

pid, fd = pty.fork()
if pid == 0:
    if resize_fd is not None:
        try:
            os.close(resize_fd)
        except OSError:
            pass
    try:
        apply_size(0, cols, rows)
    except OSError:
        pass
    os.environ["TERM"] = "xterm-256color"
    os.environ["COLUMNS"] = str(cols)
    os.environ["LINES"] = str(rows)
    os.execvp(shell, [shell, "-i"])

def set_master():
    try:
        apply_size(fd, cols, rows)
        os.kill(pid, signal.SIGWINCH)
    except OSError:
        pass

set_master()
os.set_blocking(0, False)
os.set_blocking(fd, False)
if resize_fd is not None:
    os.set_blocking(resize_fd, False)

while True:
    watch = [0, fd] + ([resize_fd] if resize_fd is not None else [])
    try:
        readable, _, _ = select.select(watch, [], [])
    except InterruptedError:
        continue
    if 0 in readable:
        try:
            data = os.read(0, 65536)
        except OSError:
            data = b""
        if not data:
            try:
                os.kill(pid, signal.SIGHUP)
            except OSError:
                pass
            break
        try:
            os.write(fd, data)
        except OSError:
            break
    if fd in readable:
        try:
            data = os.read(fd, 65536)
        except OSError as exc:
            if exc.errno == errno.EIO:
                break
            data = b""
        if not data:
            break
        try:
            os.write(1, data)
        except OSError:
            break
    if resize_fd is not None and resize_fd in readable:
        try:
            chunk = os.read(resize_fd, 256)
        except OSError:
            chunk = b""
        if chunk:
            parse_size(chunk)
            set_master()

_, status = os.waitpid(pid, 0)
sys.exit(os.waitstatus_to_exitcode(status))
`;

type LiveSession = {
  mode: "shell" | "exec";
  stdin: PassThrough;
  close: () => void;
  resize: (cols: number, rows: number) => void;
};

type PtyLike = {
  onData(listener: (data: string) => void): unknown;
  onExit(listener: (event: { exitCode: number }) => void): unknown;
  write(data: string): void;
  resize(cols: number, rows: number): void;
  kill(): void;
};

type PtyModule = { spawn(file: string, args: string[], options: { name: string; cols: number; rows: number; cwd: string; env: Record<string, string> }): PtyLike };

// The native pty library is optional at runtime: if it cannot load, the local shell falls back to plain pipes.
function loadPty(): PtyModule | null {
  try {
    return createRequire(import.meta.url)("@lydell/node-pty") as PtyModule;
  } catch {
    return null;
  }
}

// PowerShell 7 when it is installed, Windows PowerShell otherwise.
function windowsShell(): string {
  try {
    execFileSync("where.exe", ["pwsh.exe"], { stdio: "ignore", timeout: 3000 });
    return "pwsh.exe";
  } catch {
    return "powershell.exe";
  }
}

// A real Python on macOS: Homebrew's, or Apple's once the Command Line Tools are installed. Without the tools,
// /usr/bin/python3 is a stub that pops up an installer, so it is only used when xcode-select finds them.
function macPython(): string | null {
  for (const candidate of ["/opt/homebrew/bin/python3", "/usr/local/bin/python3"]) {
    if (fs.existsSync(candidate)) return candidate;
  }
  try {
    execFileSync("xcode-select", ["-p"], { stdio: "ignore", timeout: 3000 });
    return "/usr/bin/python3";
  } catch {
    return null;
  }
}

export function createTerminalHost(options: {
  kubeconfig: () => { path: string; context: string } | null;
  emit: (event: TerminalEvent) => void;
}) {
  const sessions = new Map<string, LiveSession>();
  let nextId = 0;

  function reserve() {
    const id = String(++nextId);
    return id;
  }

  function openShell(): string {
    const id = reserve();
    const shell = process.env.SHELL || (process.platform === "darwin" ? "/bin/zsh" : "bash");
    const stdin = new PassThrough();
    let child: ChildProcess | null = null;
    let resizeStream: Writable | null = null;
    let cols = 80;
    let rows = 24;
    let closed = false;
    let attached = false;

    function attach(proc: ChildProcess, sized: Writable | null) {
      if (attached || closed) {
        proc.kill();
        return;
      }
      attached = true;
      child = proc;
      resizeStream = sized;
      if (proc.stdin) stdin.pipe(proc.stdin);
      proc.stdout?.on("data", (chunk: Buffer) => options.emit({ id, type: "data", data: chunk.toString("utf8") }));
      proc.stderr?.on("data", (chunk: Buffer) => options.emit({ id, type: "data", data: chunk.toString("utf8") }));
      proc.on("exit", (code) => {
        if (!closed) options.emit({ id, type: "exit", code });
      });
      sized?.write(`${cols} ${rows}\n`);
    }

    let terminal: PtyLike | null = null;

    sessions.set(id, {
      mode: "shell",
      stdin,
      close() {
        closed = true;
        child?.kill();
        terminal?.kill();
      },
      resize(nextCols, nextRows) {
        cols = Math.max(1, Math.round(nextCols));
        rows = Math.max(1, Math.round(nextRows));
        resizeStream?.write(`${cols} ${rows}\n`);
        try {
          terminal?.resize(cols, rows);
        } catch {
          // The shell already exited.
        }
      },
    });

    // Windows: a real ConPTY terminal through node-pty's prebuilt binary, so line editing, colours, and resizing
    // work like any Windows terminal.
    if (process.platform === "win32") {
      const pty = loadPty();
      if (pty) {
        try {
          terminal = pty.spawn(windowsShell(), ["-NoLogo"], { name: "xterm-256color", cols, rows, cwd: os.homedir(), env: process.env as Record<string, string> });
          terminal.onData((data) => options.emit({ id, type: "data", data }));
          terminal.onExit(({ exitCode }) => {
            if (!closed) options.emit({ id, type: "exit", code: exitCode });
          });
          stdin.on("data", (chunk: Buffer) => terminal?.write(chunk.toString("utf8")));
          return id;
        } catch {
          terminal = null;
        }
      }
      // Without the native library: PowerShell over pipes still runs commands, without line editing or resizing.
      const powershell = spawn("powershell.exe", ["-NoLogo", "-NoExit", "-Command", "-"], { stdio: ["pipe", "pipe", "pipe"], env: process.env });
      attach(powershell, null);
      return id;
    }
    // macOS: BSD script(1) needs a terminal on stdin and fails on our pipes, so use Python's pty like on Linux.
    // Without Python, a plain interactive shell over pipes still runs commands.
    const python = process.platform === "darwin" ? macPython() : "python3";
    const plainShell = () => spawn(shell, ["-i"], { stdio: ["pipe", "pipe", "pipe"], env: { ...process.env, TERM: "dumb" } });
    if (!python) {
      attach(plainShell(), null);
      return id;
    }
    const proc = spawn(python, ["-c", ptyScript, String(cols), String(rows), shell], {
      stdio: ["pipe", "pipe", "pipe", "pipe"],
      env: { ...process.env, TERM: "xterm-256color" },
    });
    proc.once("error", () => {
      const fallback = process.platform === "darwin"
        ? plainShell()
        : spawn("script", ["-qfec", shell, "/dev/null"], { stdio: ["pipe", "pipe", "pipe"], env: { ...process.env, TERM: "xterm-256color" } });
      attach(fallback, null);
    });
    proc.once("spawn", () => {
      const sized = proc.stdio[3];
      attach(proc, sized && "write" in sized ? sized : null);
    });
    return id;
  }

  async function openExec(request: Extract<TerminalRequest, { mode: "exec" }>): Promise<string> {
    const kube = options.kubeconfig();
    if (!kube) throw new Error("Not connected.");
    const id = reserve();
    const kc = loadContextConfig(kube.path, kube.context);
    const exec = new Exec(kc);
    const stdin = new PassThrough();
    const stdout = new Writable({
      write(chunk, _encoding, callback) {
        const text = Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk);
        options.emit({ id, type: "data", data: text });
        callback();
      },
    }) as Writable & { rows: number; columns: number };
    stdout.rows = 24;
    stdout.columns = 80;
    const stderr = new Writable({
      write(chunk, _encoding, callback) {
        const text = Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk);
        options.emit({ id, type: "data", data: text });
        callback();
      },
    });
    const socket = await exec.exec(
      request.namespace,
      request.pod,
      request.container,
      request.command && request.command.length > 0 ? request.command : ["/bin/sh"],
      stdout,
      stderr,
      stdin,
      true,
      (status) => {
        options.emit({ id, type: "exit", code: status.status === "Success" ? 0 : 1 });
      },
    );
    sessions.set(id, {
      mode: "exec",
      stdin,
      close() {
        socket.close();
      },
      resize(cols, rows) {
        stdout.columns = Math.max(1, cols);
        stdout.rows = Math.max(1, rows);
        stdout.emit("resize");
      },
    });
    return id;
  }

  return {
    async open(request: TerminalRequest) {
      const id = request.mode === "shell" ? openShell() : await openExec(request);
      return { id };
    },
    write(id: string, data: string) {
      sessions.get(id)?.stdin.write(data);
    },
    resize(id: string, cols: number, rows: number) {
      sessions.get(id)?.resize(cols, rows);
    },
    close(id: string) {
      const session = sessions.get(id);
      session?.close();
      sessions.delete(id);
    },
    closeAll() {
      for (const [id, session] of sessions) {
        session.close();
        sessions.delete(id);
      }
    },
    closeExec() {
      for (const [id, session] of sessions) {
        if (session.mode !== "exec") continue;
        session.close();
        sessions.delete(id);
      }
    },
  };
}
