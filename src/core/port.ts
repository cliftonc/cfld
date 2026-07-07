import { createServer, Socket } from "node:net";

/** Common local dev ports, probed in order when none is specified. */
export const COMMON_DEV_PORTS = [3000, 5173, 8080, 8000, 5000, 4200, 3001];

/** True if something is listening on 127.0.0.1:port. */
export function isPortListening(port: number, timeoutMs = 300): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = new Socket();
    let settled = false;
    const done = (result: boolean) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(result);
    };
    socket.setTimeout(timeoutMs);
    socket.once("connect", () => done(true));
    socket.once("timeout", () => done(false));
    socket.once("error", () => done(false));
    socket.connect(port, "127.0.0.1");
  });
}

/**
 * Detect which dev port is live. Returns the single listening common port, or
 * a list of candidates when several are up (caller prompts), or empty.
 */
export async function detectDevPorts(): Promise<number[]> {
  const checks = await Promise.all(
    COMMON_DEV_PORTS.map(async (p) => ((await isPortListening(p)) ? p : null)),
  );
  return checks.filter((p): p is number => p !== null);
}

/** Find a free localhost port for the cloudflared metrics endpoint. */
export function findFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.unref();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      if (addr && typeof addr === "object") {
        const { port } = addr;
        server.close(() => resolve(port));
      } else {
        server.close(() => reject(new Error("Could not acquire a free port")));
      }
    });
  });
}
