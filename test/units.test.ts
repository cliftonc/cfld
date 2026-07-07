import { describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  slugify,
  deriveSlug,
  tunnelNameForSlug,
  buildHostname,
  zoneForHostname,
} from "../src/core/hostname.js";
import { upsertEnv } from "../src/core/env-writer.js";
import { renderIngressConfig } from "../src/core/config-file.js";
import { parseMetrics } from "../src/process/ready.js";

describe("hostname", () => {
  it("slugifies", () => {
    expect(slugify("My Cool App!")).toBe("my-cool-app");
    expect(slugify("@acme/api")).toBe("acme-api");
    expect(slugify("--weird__name--")).toBe("weird-name");
  });

  it("derives slug from package.json name, stripping scope", () => {
    const dir = mkdtempSync(join(tmpdir(), "cfld-slug-"));
    writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "@acme/web-api" }));
    expect(deriveSlug(dir)).toBe("web-api");
    expect(deriveSlug(dir, "override")).toBe("override");
    rmSync(dir, { recursive: true, force: true });
  });

  it("builds stable names and hostnames", () => {
    expect(tunnelNameForSlug("api")).toBe("cfld-api");
    expect(buildHostname("api", "example.com")).toBe("api.example.com");
  });

  it("resolves zone by longest known suffix", () => {
    expect(zoneForHostname("api.example.com", ["example.com"])).toBe("example.com");
    expect(zoneForHostname("a.b.co.uk", ["b.co.uk"])).toBe("b.co.uk");
    expect(zoneForHostname("api.example.com", [])).toBe("example.com");
  });
});

describe("env-writer", () => {
  it("appends then updates idempotently", () => {
    const dir = mkdtempSync(join(tmpdir(), "cfld-env-"));
    const env = join(dir, ".env");
    writeFileSync(env, "EXISTING=1\n");

    const r1 = upsertEnv(env, "PUBLIC_URL", "https://a.example.com");
    expect(r1.changed).toBe(true);
    expect(readFileSync(env, "utf8")).toBe(
      "EXISTING=1\nPUBLIC_URL=https://a.example.com\n",
    );

    // Second identical write changes nothing.
    const r2 = upsertEnv(env, "PUBLIC_URL", "https://a.example.com");
    expect(r2.changed).toBe(false);
    expect(readFileSync(env, "utf8")).toBe(
      "EXISTING=1\nPUBLIC_URL=https://a.example.com\n",
    );

    // Changing the value updates in place (no duplicate).
    upsertEnv(env, "PUBLIC_URL", "https://b.example.com");
    expect(readFileSync(env, "utf8")).toBe(
      "EXISTING=1\nPUBLIC_URL=https://b.example.com\n",
    );
    rmSync(dir, { recursive: true, force: true });
  });
});

describe("parseMetrics", () => {
  it("sums counters and computes average latency from the histogram", () => {
    const text = [
      "# HELP cloudflared_tunnel_ha_connections foo",
      "cloudflared_tunnel_ha_connections 4",
      'cloudflared_tunnel_total_requests{tunnel="x"} 100',
      'cloudflared_tunnel_total_requests{tunnel="y"} 28',
      "cloudflared_tunnel_request_duration_seconds_sum 6.4",
      "cloudflared_tunnel_request_duration_seconds_count 128",
    ].join("\n");
    const m = parseMetrics(text);
    expect(m.connections).toBe(4);
    expect(m.requests).toBe(128);
    expect(m.avgLatencyMs).toBe(50); // 6.4/128 = 0.05s = 50ms
  });

  it("omits latency when the histogram is absent", () => {
    const m = parseMetrics("cloudflared_tunnel_ha_connections 1\n");
    expect(m.avgLatencyMs).toBeUndefined();
    expect(m.connections).toBe(1);
  });
});

describe("config-file", () => {
  it("renders valid ingress yaml with a catch-all", () => {
    const yaml = renderIngressConfig({
      slug: "api",
      uuid: "uuid-123",
      routes: [{ hostname: "api.example.com", port: 8080 }],
    });
    expect(yaml).toContain("tunnel: uuid-123");
    expect(yaml).toContain("- hostname: api.example.com");
    expect(yaml).toContain("service: http://localhost:8080");
    expect(yaml).toContain("- service: http_status:404");
  });

  it("renders multiple ingress rules with optional paths", () => {
    const yaml = renderIngressConfig({
      slug: "app",
      uuid: "u",
      routes: [
        { hostname: "app.example.com", port: 3000 },
        { hostname: "api.example.com", port: 8080, path: "/v1" },
      ],
    });
    expect(yaml).toContain("- hostname: app.example.com");
    expect(yaml).toContain("- hostname: api.example.com");
    expect(yaml).toContain("path: /v1");
    // Catch-all is last.
    expect(yaml.trim().endsWith("- service: http_status:404")).toBe(true);
  });
});
