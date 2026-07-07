import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  launchAgentLabel,
  renderLaunchAgent,
  renderSystemdUnit,
  serviceSlug,
} from "../src/core/service.js";
import { ensureGitignored } from "../src/util/gitignore.js";
import { readProjectConfig, writeProjectConfig } from "../src/core/project-config.js";

const spec = {
  name: "cfld-myapp",
  binPath: "/opt/homebrew/bin/cloudflared",
  certPath: "/home/u/.cfld/certs/example.com.pem",
  configPath: "/home/u/.cloudflared/myapp.cfld.yml",
};

describe("service unit rendering", () => {
  it("derives slug and label", () => {
    expect(serviceSlug("cfld-myapp")).toBe("myapp");
    expect(launchAgentLabel("cfld-myapp")).toBe("com.cfld.myapp");
  });

  it("renders a LaunchAgent plist with the run args and cert env", () => {
    const plist = renderLaunchAgent(spec);
    expect(plist).toContain("<string>com.cfld.myapp</string>");
    expect(plist).toContain("<string>/opt/homebrew/bin/cloudflared</string>");
    expect(plist).toContain("<string>--origincert</string>");
    expect(plist).toContain(spec.certPath);
    expect(plist).toContain("<string>cfld-myapp</string>");
    expect(plist).toContain("<key>KeepAlive</key>");
  });

  it("renders a systemd unit with ExecStart and Restart", () => {
    const unit = renderSystemdUnit(spec);
    expect(unit).toContain("ExecStart=/opt/homebrew/bin/cloudflared tunnel --origincert");
    expect(unit).toContain("run cfld-myapp");
    expect(unit).toContain("Restart=always");
    expect(unit).toContain("WantedBy=default.target");
  });
});

describe("ensureGitignored", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "cfld-gi-"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("skips a non-git directory", () => {
    expect(ensureGitignored(dir, ".cfld.json")).toBe(false);
  });

  it("creates .gitignore in a git repo and is idempotent", () => {
    mkdirSync(join(dir, ".git"));
    expect(ensureGitignored(dir, ".cfld.json")).toBe(true);
    expect(readFileSync(join(dir, ".gitignore"), "utf8")).toBe(".cfld.json\n");
    expect(ensureGitignored(dir, ".cfld.json")).toBe(false); // already there
  });

  it("appends to an existing .gitignore without clobbering", () => {
    writeFileSync(join(dir, ".gitignore"), "node_modules/\n");
    expect(ensureGitignored(dir, ".cfld.json")).toBe(true);
    expect(readFileSync(join(dir, ".gitignore"), "utf8")).toBe(
      "node_modules/\n.cfld.json\n",
    );
  });
});

describe("project config merge (package.json cfld + .cfld.json)", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "cfld-cfg-"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("reads authored config from package.json", () => {
    writeFileSync(
      join(dir, "package.json"),
      JSON.stringify({ name: "x", cfld: { zone: "example.com", port: 4321 } }),
    );
    const cfg = readProjectConfig(dir);
    expect(cfg?.zone).toBe("example.com");
    expect(cfg?.port).toBe(4321);
  });

  it("authored fields win over the cache, but uuid comes from the cache", () => {
    writeFileSync(
      join(dir, "package.json"),
      JSON.stringify({ cfld: { port: 4321 } }),
    );
    writeProjectConfig(dir, { name: "x", port: 3000, uuid: "u-1", zone: "z" });
    const cfg = readProjectConfig(dir);
    expect(cfg?.port).toBe(4321); // authored wins
    expect(cfg?.uuid).toBe("u-1"); // resolved from cache
    expect(cfg?.zone).toBe("z"); // cache-only field still available
  });

  it("normalizes host → hostname and passes routes through", () => {
    writeFileSync(
      join(dir, "package.json"),
      JSON.stringify({
        cfld: {
          host: "api.example.com",
          routes: [{ name: "api", port: 8080 }],
        },
      }),
    );
    const cfg = readProjectConfig(dir);
    expect(cfg?.hostname).toBe("api.example.com");
    expect(cfg?.routes).toEqual([{ name: "api", port: 8080 }]);
  });
});
