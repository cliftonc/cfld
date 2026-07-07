import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isBlankFirstRun } from "../src/commands/setup.js";
import type { CliFlags } from "../src/cli.js";

/**
 * The auto-trigger predicate must be conservative: it only routes into the
 * wizard for a genuinely blank interactive first run, never hijacking a
 * legitimate run. Cert/registry state is redirected via CFLD_HOME /
 * CLOUDFLARED_HOME to empty temp dirs.
 */
describe("isBlankFirstRun", () => {
  const savedEnv = { ...process.env };
  let cfldHome: string;
  let cloudflaredHome: string;
  let cwd: string;
  const flags: CliFlags = {};

  beforeEach(() => {
    cfldHome = mkdtempSync(join(tmpdir(), "cfld-home-"));
    cloudflaredHome = mkdtempSync(join(tmpdir(), "cfld-cfd-"));
    cwd = mkdtempSync(join(tmpdir(), "cfld-cwd-"));
    process.env.CFLD_HOME = cfldHome;
    process.env.CLOUDFLARED_HOME = cloudflaredHome;
    delete process.env.TUNNEL_ORIGIN_CERT;
  });

  afterEach(() => {
    rmSync(cfldHome, { recursive: true, force: true });
    rmSync(cloudflaredHome, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
    process.env = { ...savedEnv };
  });

  it("is true for a blank interactive first run", () => {
    expect(isBlankFirstRun(flags, cwd, true)).toBe(true);
  });

  it("is false when not interactive (CI / non-TTY)", () => {
    expect(isBlankFirstRun(flags, cwd, false)).toBe(false);
  });

  it("is false when an intent-bearing flag is passed", () => {
    expect(isBlankFirstRun({ zone: "example.com" }, cwd, true)).toBe(false);
    expect(isBlankFirstRun({ host: "api.example.com" }, cwd, true)).toBe(false);
    expect(isBlankFirstRun({ quick: true }, cwd, true)).toBe(false);
  });

  it("is false when a local .cfld.json exists", () => {
    writeFileSync(join(cwd, ".cfld.json"), JSON.stringify({ zone: "example.com" }));
    expect(isBlankFirstRun(flags, cwd, true)).toBe(false);
  });

  it("is false when package.json carries a cfld block", () => {
    writeFileSync(
      join(cwd, "package.json"),
      JSON.stringify({ cfld: { zone: "example.com" } }),
    );
    expect(isBlankFirstRun(flags, cwd, true)).toBe(false);
  });

  it("is false once a cert is stored for a zone", () => {
    const store = join(cfldHome, "certs");
    mkdirSync(store, { recursive: true });
    writeFileSync(join(store, "example.com.pem"), "cert");
    expect(isBlankFirstRun(flags, cwd, true)).toBe(false);
  });
});
