import { spawn, type ChildProcess } from "node:child_process";
import { resolveBinary } from "../core/cloudflared.js";

/**
 * Spawn and SUPERVISE the long-lived `cloudflared ... run` process. On an
 * unexpected exit it restarts with exponential backoff; repeated instant
 * failures are treated as fatal (a config/creds problem, not a blip).
 *
 * The defining behavior: stop sends SIGINT for graceful edge de-registration
 * but NEVER deletes the tunnel or DNS — resources persist so the next run
 * reuses the exact same URL.
 */
export type RunnerStatus = "connecting" | "reconnecting" | "stopped";

export interface RunnerOptions {
  configPath: string;
  tunnelName: string;
  certPath: string;
  metricsPort: number;
  onLine?: (line: string, stream: "stdout" | "stderr") => void;
  onStatus?: (status: RunnerStatus) => void;
  /** Called when restarts are exhausted — the tunnel can't stay up. */
  onFatal?: (message: string) => void;
}

export interface Runner {
  /** Graceful stop: SIGINT, then SIGKILL if it lingers. Resources preserved. */
  stop: () => void;
}

const BACKOFF_MS = [1000, 2000, 4000, 8000, 16000, 30000];
const RAPID_FAILURE_MS = 3000;
const MAX_RAPID_FAILURES = 5;

export async function startRunner(options: RunnerOptions): Promise<Runner> {
  const bin = await resolveBinary();
  const args = [
    "tunnel",
    "--origincert",
    options.certPath,
    "--config",
    options.configPath,
    "--metrics",
    `127.0.0.1:${options.metricsPort}`,
    "run",
    options.tunnelName,
  ];

  let child: ChildProcess | undefined;
  let stopped = false;
  let rapidFailures = 0;
  let restartTimer: NodeJS.Timeout | undefined;

  const spawnOnce = () => {
    const startedAt = Date.now();
    child = spawn(bin, args, {
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, TUNNEL_ORIGIN_CERT: options.certPath },
    });
    wireLines(child, "stdout", options.onLine);
    wireLines(child, "stderr", options.onLine);

    child.on("exit", (code) => {
      if (stopped) return;
      const uptime = Date.now() - startedAt;
      rapidFailures = uptime < RAPID_FAILURE_MS ? rapidFailures + 1 : 0;

      if (rapidFailures >= MAX_RAPID_FAILURES) {
        options.onFatal?.(
          `cloudflared exited repeatedly (last code ${code}). Likely a config or credentials problem — run \`cfld doctor\`.`,
        );
        return;
      }

      const delay = BACKOFF_MS[Math.min(rapidFailures, BACKOFF_MS.length - 1)]!;
      options.onStatus?.("reconnecting");
      restartTimer = setTimeout(() => {
        if (stopped) return;
        options.onStatus?.("connecting");
        spawnOnce();
      }, delay);
      restartTimer.unref();
    });
  };

  options.onStatus?.("connecting");
  spawnOnce();

  return {
    stop() {
      stopped = true;
      if (restartTimer) clearTimeout(restartTimer);
      options.onStatus?.("stopped");
      const c = child;
      if (!c || c.exitCode !== null || c.signalCode) return;
      c.kill("SIGINT");
      const t = setTimeout(() => {
        if (c.exitCode === null && !c.signalCode) c.kill("SIGKILL");
      }, 4000);
      t.unref();
    },
  };
}

function wireLines(
  child: ChildProcess,
  stream: "stdout" | "stderr",
  onLine?: (line: string, stream: "stdout" | "stderr") => void,
): void {
  const source = stream === "stdout" ? child.stdout : child.stderr;
  if (!source || !onLine) return;
  let buffer = "";
  source.setEncoding("utf8");
  source.on("data", (chunk: string) => {
    buffer += chunk;
    let idx: number;
    while ((idx = buffer.indexOf("\n")) !== -1) {
      onLine(buffer.slice(0, idx), stream);
      buffer = buffer.slice(idx + 1);
    }
  });
}
