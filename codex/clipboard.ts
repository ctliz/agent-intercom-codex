import { spawn } from "node:child_process";

export interface ClipboardCopyResult {
  ok: boolean;
  method?: string;
  error?: string;
}

export interface ClipboardCopyOptions {
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  timeoutMs?: number;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function runDetachedClipboardCommand(
  command: string,
  args: string[],
  text: string,
  env: NodeJS.ProcessEnv,
  timeoutMs: number,
): Promise<ClipboardCopyResult> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (result: ClipboardCopyResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      resolve(result);
    };
    const timeout = setTimeout(() => finish({ ok: false, error: `${command} did not start within ${timeoutMs}ms` }), timeoutMs);

    try {
      const proc = spawn(command, args, { env, stdio: ["pipe", "ignore", "ignore"], shell: false });
      proc.once("error", (error) => finish({ ok: false, error: error.message }));
      proc.once("spawn", () => {
        proc.stdin.on("error", () => {
          // Ignore EPIPE if the clipboard helper exits early.
        });
        proc.stdin.end(text);
        proc.unref();
        finish({ ok: true, method: command });
      });
    } catch (error) {
      finish({ ok: false, error: errorMessage(error) });
    }
  });
}

function runClipboardCommand(
  command: string,
  args: string[],
  text: string,
  env: NodeJS.ProcessEnv,
  timeoutMs: number,
): Promise<ClipboardCopyResult> {
  if (command === "wl-copy") return runDetachedClipboardCommand(command, args, text, env, timeoutMs);

  return new Promise((resolve) => {
    let settled = false;
    let stderr = "";
    const finish = (result: ClipboardCopyResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      resolve(result);
    };
    const timeout = setTimeout(() => {
      proc?.kill("SIGKILL");
      finish({ ok: false, error: `${command} timed out after ${timeoutMs}ms` });
    }, timeoutMs);
    let proc: ReturnType<typeof spawn> | undefined;

    try {
      proc = spawn(command, args, { env, stdio: ["pipe", "ignore", "pipe"], shell: false });
      proc.stderr?.setEncoding("utf8");
      proc.stderr?.on("data", (chunk: string) => {
        if (stderr.length < 4096) stderr += chunk;
      });
      proc.once("error", (error) => finish({ ok: false, error: error.message }));
      proc.once("close", (code) => {
        finish(code === 0
          ? { ok: true, method: command }
          : { ok: false, error: stderr.trim() || `${command} exited ${code}` });
      });
      proc.stdin.on("error", (error) => finish({ ok: false, error: error.message }));
      proc.stdin.end(text);
    } catch (error) {
      finish({ ok: false, error: errorMessage(error) });
    }
  });
}

export async function copyTextToClipboard(
  text: string,
  options: ClipboardCopyOptions = {},
): Promise<ClipboardCopyResult> {
  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;
  const timeoutMs = options.timeoutMs ?? 2000;
  const candidates: Array<[string, string[]]> = [];
  if (platform === "darwin") candidates.push(["pbcopy", []]);
  else if (platform === "win32") candidates.push(["clip.exe", []]);
  else {
    if (env.WAYLAND_DISPLAY) candidates.push(["wl-copy", []]);
    if (env.DISPLAY) {
      candidates.push(["xclip", ["-selection", "clipboard"]]);
      candidates.push(["xsel", ["--clipboard", "--input"]]);
    }
    candidates.push(["clip.exe", []]);
  }

  let lastError = "No clipboard command available";
  for (const [command, args] of candidates) {
    const result = await runClipboardCommand(command, args, text, env, timeoutMs);
    if (result.ok) return result;
    lastError = result.error ?? lastError;
  }
  return { ok: false, error: lastError };
}

export function buildOsc52Sequence(text: string, env: NodeJS.ProcessEnv = process.env): string {
  const osc = `\x1b]52;c;${Buffer.from(text, "utf8").toString("base64")}\x07`;
  // tmux requires DCS passthrough and a doubled ESC for the nested OSC sequence.
  return env.TMUX ? `\x1bPtmux;\x1b${osc}\x1b\\` : osc;
}

export function copyTextToTerminalClipboard(
  text: string,
  write: (sequence: string) => unknown,
  env: NodeJS.ProcessEnv = process.env,
): ClipboardCopyResult {
  try {
    write(buildOsc52Sequence(text, env));
    return { ok: true, method: "osc52" };
  } catch (error) {
    return { ok: false, error: errorMessage(error) };
  }
}
