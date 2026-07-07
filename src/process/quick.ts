import { spawn, type ChildProcess } from "node:child_process";
import { resolveBinary } from "../core/cloudflared.js";

/**
 * Ephemeral quick tunnel: `cloudflared tunnel --url http://localhost:<port>`.
 * No cert, no domain, random *.trycloudflare.com URL. The escape hatch when
 * there's no domain yet — and the primary automated proof-of-life in tests.
 */
export interface QuickTunnel {
  url: string;
  child: ChildProcess;
  stop: () => void;
}

const QUICK_URL_RE = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/i;

export async function startQuickTunnel(
  port: number,
  opts: {
    timeoutMs?: number;
    onLine?: (line: string) => void;
    metricsPort?: number;
  } = {},
): Promise<QuickTunnel> {
  const bin = await resolveBinary();
  const args = ["tunnel", "--url", `http://localhost:${port}`, "--no-autoupdate"];
  if (opts.metricsPort) args.push("--metrics", `127.0.0.1:${opts.metricsPort}`);
  const child = spawn(bin, args, { stdio: ["ignore", "pipe", "pipe"] });

  return new Promise<QuickTunnel>((resolve, reject) => {
    const timeout = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error("Timed out waiting for a quick tunnel URL."));
    }, opts.timeoutMs ?? 30_000);
    timeout.unref();

    let settled = false;
    const stop = () => {
      if (child.exitCode === null && !child.signalCode) child.kill("SIGINT");
    };

    const scan = (chunk: string) => {
      for (const line of chunk.split("\n")) {
        if (line.trim()) opts.onLine?.(line);
      }
      const match = chunk.match(QUICK_URL_RE);
      if (match && !settled) {
        settled = true;
        clearTimeout(timeout);
        resolve({ url: match[0], child, stop });
      }
    };

    child.stdout?.setEncoding("utf8").on("data", scan);
    child.stderr?.setEncoding("utf8").on("data", scan);
    child.on("error", (err) => {
      if (!settled) {
        settled = true;
        clearTimeout(timeout);
        reject(err);
      }
    });
    child.on("exit", (code) => {
      if (!settled) {
        settled = true;
        clearTimeout(timeout);
        reject(new Error(`cloudflared exited (code ${code}) before a URL appeared.`));
      }
    });
  });
}
