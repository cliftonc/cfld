import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// `cloudflared tunnel login` is simulated: it writes `nextLoginCert` to the
// default path, refusing (like the real thing) if a cert is already there.
let nextLoginCert: string | undefined;
vi.mock("node:child_process", () => ({
  spawn: () => {
    const child = new EventEmitter();
    setImmediate(() => {
      const def = join(process.env.CLOUDFLARED_HOME!, "cert.pem");
      if (existsSync(def) || !nextLoginCert) return child.emit("exit", 1);
      writeFileSync(def, nextLoginCert);
      child.emit("exit", 0);
    });
    return child;
  },
}));
vi.mock("../src/core/cloudflared.js", () => ({
  resolveBinary: async () => "cloudflared",
}));

import { resolveCert } from "../src/core/cert-store.js";
import { ensureCert, loginCommand, saveCert } from "../src/commands/login.js";

/** A cert.pem whose token block authorizes `zoneID`. */
function fakeCert(zoneID: string): string {
  const token = Buffer.from(
    JSON.stringify({ zoneID, accountID: "acct", apiToken: `tok-${zoneID}` }),
  ).toString("base64");
  return `-----BEGIN ARGO TUNNEL TOKEN-----\n${token}\n-----END ARGO TUNNEL TOKEN-----\n`;
}

const ZONES: Record<string, string> = { "tok-z1": "guidemode.dev", "tok-z2": "clewro.com" };
let online = true;

let home: string;
let cfd: string;
let store: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "cfld-certzone-"));
  cfd = join(home, ".cloudflared");
  store = join(home, ".cfld", "certs");
  mkdirSync(cfd, { recursive: true });
  process.env.CFLD_HOME = join(home, ".cfld");
  process.env.CLOUDFLARED_HOME = cfd;
  delete process.env.TUNNEL_ORIGIN_CERT;
  nextLoginCert = undefined;
  online = true;
  vi.stubGlobal("fetch", async (_url: string, init: { headers: Record<string, string> }) => {
    if (!online) throw new Error("offline");
    const name = ZONES[init.headers.Authorization!.replace("Bearer ", "")];
    return { ok: Boolean(name), json: async () => ({ result: { name } }) };
  });
  vi.spyOn(process.stdout, "write").mockImplementation(() => true);
  vi.spyOn(process.stderr, "write").mockImplementation(() => true);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  rmSync(home, { recursive: true, force: true });
  delete process.env.CFLD_HOME;
  delete process.env.CLOUDFLARED_HOME;
});

const writeDefault = (zoneID: string) => writeFileSync(join(cfd, "cert.pem"), fakeCert(zoneID));
const writeStored = (zone: string, zoneID: string) => {
  mkdirSync(store, { recursive: true });
  writeFileSync(join(store, `${zone}.pem`), fakeCert(zoneID));
};
const stored = (zone: string) => readFileSync(join(store, `${zone}.pem`), "utf8");

describe("resolveCert", () => {
  it("won't hand the default cert to a zone when another stored zone owns it", () => {
    writeDefault("z1");
    writeStored("guidemode.dev", "z1");
    expect(resolveCert("clewro.com")).toBeUndefined();
    expect(resolveCert("guidemode.dev")).toBe(join(store, "guidemode.dev.pem"));
  });
});

describe("saveCert", () => {
  it("rejects a cert whose zone differs from the one asked for", async () => {
    const p = join(home, "c.pem");
    writeFileSync(p, fakeCert("z1"));
    await expect(saveCert("clewro.com", p)).rejects.toThrow(/authorized guidemode\.dev/);
    expect(existsSync(join(store, "clewro.com.pem"))).toBe(false);
  });

  it("offline, rejects a cert already stored under another name", async () => {
    online = false;
    writeStored("guidemode.dev", "z1");
    const p = join(home, "c.pem");
    writeFileSync(p, fakeCert("z1"));
    await expect(saveCert("clewro.com", p)).rejects.toThrow(/saved guidemode\.dev/);
  });

  it("detects the zone from the cert when none is given", async () => {
    const p = join(home, "c.pem");
    writeFileSync(p, fakeCert("z2"));
    await expect(saveCert(undefined, p)).resolves.toBe("clewro.com");
  });
});

describe("login", () => {
  it("--reauth runs a fresh login even with an existing cert, and restores it", async () => {
    writeDefault("z1");
    nextLoginCert = fakeCert("z2");
    await loginCommand({ reauth: true, zone: "clewro.com" });
    expect(stored("clewro.com")).toBe(fakeCert("z2"));
    expect(readFileSync(join(cfd, "cert.pem"), "utf8")).toBe(fakeCert("z1"));
    expect(existsSync(join(cfd, "cert.pem.cfld-backup"))).toBe(false);
    expect(existsSync(join(home, ".cfld", "login-cert.tmp"))).toBe(false);
  });

  it("restores the existing cert when the fresh login is for the wrong zone", async () => {
    writeDefault("z1");
    nextLoginCert = fakeCert("z1");
    await expect(loginCommand({ reauth: true, zone: "clewro.com" })).rejects.toThrow(
      /not clewro\.com/,
    );
    expect(readFileSync(join(cfd, "cert.pem"), "utf8")).toBe(fakeCert("z1"));
    expect(existsSync(join(store, "clewro.com.pem"))).toBe(false);
  });
});

describe("ensureCert", () => {
  it("logs in for a new zone instead of reusing another zone's default cert", async () => {
    writeDefault("z1");
    nextLoginCert = fakeCert("z2");
    const p = await ensureCert("clewro.com");
    expect(p).toBe(join(store, "clewro.com.pem"));
    expect(stored("clewro.com")).toBe(fakeCert("z2"));
  });

  it("adopts the default cert into the store when it matches the zone", async () => {
    writeDefault("z1");
    const p = await ensureCert("guidemode.dev", { interactive: false });
    expect(p).toBe(join(store, "guidemode.dev.pem"));
  });

  it("replaces a stored cert that was saved under the wrong zone", async () => {
    writeDefault("z1");
    writeStored("guidemode.dev", "z1");
    writeStored("clewro.com", "z1");
    nextLoginCert = fakeCert("z2");
    await ensureCert("clewro.com");
    expect(stored("clewro.com")).toBe(fakeCert("z2"));
  });

  it("non-interactive, fails rather than using the wrong zone's cert", async () => {
    writeDefault("z1");
    await expect(ensureCert("clewro.com", { interactive: false })).rejects.toThrow(
      /No Cloudflare certificate found for clewro\.com/,
    );
  });
});
