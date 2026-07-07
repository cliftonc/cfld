import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import { waitForReady } from "../src/process/ready.js";

/**
 * Drive a fake metrics server that returns 503 then 200 on /ready, and assert
 * waitForReady only resolves once it sees 200.
 */
let server: Server;
let port: number;
let hits = 0;

beforeEach(async () => {
  hits = 0;
  server = createServer((req, res) => {
    if (req.url === "/ready") {
      hits += 1;
      if (hits < 3) {
        res.statusCode = 503;
        res.end("not ready");
      } else {
        res.statusCode = 200;
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ readyConnections: 4 }));
      }
    } else {
      res.statusCode = 404;
      res.end();
    }
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const addr = server.address();
  port = typeof addr === "object" && addr ? addr.port : 0;
});

afterEach(() => {
  server.close();
});

describe("waitForReady", () => {
  it("resolves only after /ready returns 200", async () => {
    const state = await waitForReady(port, { intervalMs: 10, timeoutMs: 5000 });
    expect(state.ready).toBe(true);
    expect(state.connections).toBe(4);
    expect(hits).toBeGreaterThanOrEqual(3);
  });

  it("times out when never ready", async () => {
    server.close();
    const dead = createServer((_req, res) => {
      res.statusCode = 503;
      res.end();
    });
    await new Promise<void>((r) => dead.listen(0, "127.0.0.1", r));
    const addr = dead.address();
    const deadPort = typeof addr === "object" && addr ? addr.port : 0;
    await expect(
      waitForReady(deadPort, { intervalMs: 10, timeoutMs: 120 }),
    ).rejects.toThrow(/Timed out/);
    dead.close();
  });
});
