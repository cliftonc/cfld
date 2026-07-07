import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  mkdtempSync,
  writeFileSync,
  rmSync,
  existsSync,
  mkdirSync,
  readFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Mock the cloudflared wrapper so we assert reuse-vs-create decisions without
// ever shelling out.
const findTunnel = vi.fn();
const createTunnel = vi.fn();
const fetchToken = vi.fn();
const routeDns = vi.fn();

vi.mock("../src/core/cloudflared.js", () => ({
  findTunnel: (...a: unknown[]) => findTunnel(...a),
  createTunnel: (...a: unknown[]) => createTunnel(...a),
  fetchToken: (...a: unknown[]) => fetchToken(...a),
  routeDns: (...a: unknown[]) => routeDns(...a),
}));

import { reconcile } from "../src/core/state-machine.js";

const UUID = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
let home: string;

function credsFile(uuid: string): string {
  return join(home, ".cloudflared", `${uuid}.json`);
}

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "cfld-test-"));
  process.env.CFLD_HOME = join(home, ".cfld");
  process.env.CLOUDFLARED_HOME = join(home, ".cloudflared");
  mkdirSync(process.env.CLOUDFLARED_HOME, { recursive: true });
  findTunnel.mockReset();
  createTunnel.mockReset();
  fetchToken.mockReset();
  routeDns.mockReset();
  routeDns.mockResolvedValue(undefined);
  fetchToken.mockResolvedValue(undefined);
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
  delete process.env.CFLD_HOME;
  delete process.env.CLOUDFLARED_HOME;
});

const input = () => ({
  slug: "myapp",
  tunnelName: "cfld-myapp",
  zone: "example.com",
  certPath: "/certs/example.com.pem",
  routes: [{ hostname: "myapp.example.com", port: 3000 }],
  projectDir: "/proj",
});

describe("reconcile", () => {
  it("creates a tunnel when none exists, then routes DNS", async () => {
    findTunnel.mockResolvedValue(undefined);
    createTunnel.mockResolvedValue(UUID);

    const res = await reconcile(input());

    expect(createTunnel).toHaveBeenCalledWith("cfld-myapp", "/certs/example.com.pem");
    expect(fetchToken).not.toHaveBeenCalled();
    expect(routeDns).toHaveBeenCalledWith(
      "cfld-myapp",
      "myapp.example.com",
      "/certs/example.com.pem",
    );
    expect(res.created).toBe(true);
    expect(res.uuid).toBe(UUID);
  });

  it("reuses an existing tunnel without creating, when creds are present", async () => {
    findTunnel.mockResolvedValue({ id: UUID, name: "cfld-myapp" });
    writeFileSync(credsFile(UUID), "{}"); // creds already local

    const res = await reconcile(input());

    expect(createTunnel).not.toHaveBeenCalled();
    expect(fetchToken).not.toHaveBeenCalled();
    expect(routeDns).toHaveBeenCalledOnce();
    expect(res.created).toBe(false);
    expect(res.uuid).toBe(UUID);
  });

  it("refetches credentials when the tunnel exists but local creds are missing", async () => {
    findTunnel.mockResolvedValue({ id: UUID, name: "cfld-myapp" });
    // no creds file written

    await reconcile(input());

    expect(createTunnel).not.toHaveBeenCalled();
    expect(fetchToken).toHaveBeenCalledWith(
      "cfld-myapp",
      credsFile(UUID),
      "/certs/example.com.pem",
    );
  });

  it("writes an ingress config and a registry entry", async () => {
    findTunnel.mockResolvedValue(undefined);
    createTunnel.mockResolvedValue(UUID);

    const res = await reconcile(input());

    expect(existsSync(res.configPath)).toBe(true);
    const registry = JSON.parse(
      readFileSync(join(process.env.CFLD_HOME!, "registry.json"), "utf8"),
    );
    expect(registry.tunnels).toHaveLength(1);
    expect(registry.tunnels[0]).toMatchObject({
      name: "cfld-myapp",
      uuid: UUID,
      hostname: "myapp.example.com",
      zone: "example.com",
    });
  });
});
