import { spawn, type SpawnOptions } from "node:child_process";

export interface ExecResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

export interface ExecOptions {
  /** Extra environment variables merged over process.env. */
  env?: Record<string, string | undefined>;
  /** Stream child stdout/stderr to this callback line-by-line (also captured). */
  onLine?: (line: string, stream: "stdout" | "stderr") => void;
  /** Working directory. */
  cwd?: string;
}

/**
 * Promisified spawn that captures stdout/stderr and never rejects on a
 * non-zero exit — callers inspect `code` and decide. This is the single choke
 * point every cloudflared invocation flows through, which makes the whole tool
 * testable by mocking exactly this function.
 */
export function exec(
  command: string,
  args: string[],
  options: ExecOptions = {},
): Promise<ExecResult> {
  return new Promise((resolve, reject) => {
    const spawnOptions: SpawnOptions = {
      env: { ...process.env, ...options.env },
      cwd: options.cwd,
      stdio: ["ignore", "pipe", "pipe"],
    };
    const child = spawn(command, args, spawnOptions);

    let stdout = "";
    let stderr = "";

    const wire = (stream: "stdout" | "stderr") => {
      const source = stream === "stdout" ? child.stdout : child.stderr;
      if (!source) return;
      let buffer = "";
      source.setEncoding("utf8");
      source.on("data", (chunk: string) => {
        if (stream === "stdout") stdout += chunk;
        else stderr += chunk;
        if (!options.onLine) return;
        buffer += chunk;
        let idx: number;
        while ((idx = buffer.indexOf("\n")) !== -1) {
          const line = buffer.slice(0, idx);
          buffer = buffer.slice(idx + 1);
          options.onLine(line, stream);
        }
      });
      source.on("end", () => {
        if (options.onLine && buffer.length > 0) options.onLine(buffer, stream);
      });
    };
    wire("stdout");
    wire("stderr");

    child.on("error", (err) => {
      // ENOENT here means the binary isn't runnable — surface it to the caller.
      reject(err);
    });
    child.on("close", (code) => {
      resolve({ code, stdout, stderr });
    });
  });
}
