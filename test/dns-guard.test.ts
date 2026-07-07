import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Mock the cloudflared wrapper and the DNS lookup so we drive the ownership
// guard deterministically.
const findTunnel = vi.fn();
const createTunnel = vi.fn();
const fetchToken = vi.fn();
const routeDns = vi.fn();
const existingCnameTarget = vi.fn();

vi.mock("../src/core/cloudflared.js", () => ({
  findTunnel: (...a: unknown[]) => findTunnel(...a),
  createTunnel: (...a: unknown[]) => createTunnel(...a),
  fetchToken: (...a: unknown[]) => fetchToken(...a),
  routeDns: (...a: unknown[]) => routeDns(...a),
}));

vi.mock("../src/core/dns.js", () => ({
  existingCnameTarget: (...a: unknown[]) => existingCnameTarget(...a),
  cfargoTunnelUuid: (t?: string) =>
    t
      ?.match(
        /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.cfargotunnel\.com/i,
      )?.[1]
      ?.toLowerCase(),
}));

import { reconcile } from "../src/core/state-machine.js";

const UUID = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
const OTHER = "11111111-2222-3333-4444-555555555555";
let home: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "cfld-guard-"));
  process.env.CFLD_HOME = join(home, ".cfld");
  process.env.CLOUDFLARED_HOME = join(home, ".cloudflared");
  mkdirSync(process.env.CLOUDFLARED_HOME, { recursive: true });
  for (const m of [findTunnel, createTunnel, fetchToken, routeDns, existingCnameTarget])
    m.mockReset();
  findTunnel.mockResolvedValue(undefined);
  createTunnel.mockResolvedValue(UUID);
  routeDns.mockResolvedValue(undefined);
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
  delete process.env.CFLD_HOME;
  delete process.env.CLOUDFLARED_HOME;
});

const input = (extra = {}) => ({
  slug: "myapp",
  tunnelName: "cfld-myapp",
  zone: "example.com",
  certPath: "/certs/example.com.pem",
  routes: [{ hostname: "myapp.example.com", port: 3000 }],
  projectDir: "/proj",
  ...extra,
});

describe("DNS ownership guard", () => {
  it("aborts when the hostname points at a different tunnel and no confirm is given", async () => {
    existingCnameTarget.mockResolvedValue(`${OTHER}.cfargotunnel.com`);
    await expect(reconcile(input())).rejects.toThrow(/already points to/);
    expect(routeDns).not.toHaveBeenCalled();
  });

  it("proceeds when the user confirms the repoint", async () => {
    existingCnameTarget.mockResolvedValue(`${OTHER}.cfargotunnel.com`);
    await reconcile(input(), { confirmOverwrite: async () => true });
    expect(routeDns).toHaveBeenCalledOnce();
  });

  it("skips the guard entirely with force", async () => {
    existingCnameTarget.mockResolvedValue(`${OTHER}.cfargotunnel.com`);
    const confirm = vi.fn();
    await reconcile(input({ force: true }), { confirmOverwrite: confirm });
    expect(confirm).not.toHaveBeenCalled();
    expect(routeDns).toHaveBeenCalledOnce();
  });

  it("does not prompt when the hostname already points at our own tunnel", async () => {
    existingCnameTarget.mockResolvedValue(`${UUID}.cfargotunnel.com`);
    const confirm = vi.fn();
    await reconcile(input(), { confirmOverwrite: confirm });
    expect(confirm).not.toHaveBeenCalled();
    expect(routeDns).toHaveBeenCalledOnce();
  });

  it("does not do a DNS lookup at all when we already own the record (registry hit)", async () => {
    // First run claims it; second run should skip the lookup.
    existingCnameTarget.mockResolvedValue(undefined);
    await reconcile(input()); // registers cfld-myapp → myapp.example.com
    existingCnameTarget.mockClear();
    findTunnel.mockResolvedValue({ id: UUID, name: "cfld-myapp" });
    await reconcile(input(), { confirmOverwrite: vi.fn() });
    expect(existingCnameTarget).not.toHaveBeenCalled();
  });
});
