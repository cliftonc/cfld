import { exec, type ExecOptions, type ExecResult } from "../util/exec.js";
import { CfldError } from "../util/errors.js";

/**
 * The single wrapper around the `cloudflared` binary. Every invocation flows
 * through {@link runTunnel}, which resolves the binary once and injects
 * `--origincert` (the per-zone cert) so multi-domain setups never cross wires.
 */

let cachedBinary: string | undefined;

/**
 * Resolve the cloudflared binary path, in priority order:
 *   1. CFLD_CLOUDFLARED / CLOUDFLARED_BIN env override
 *   2. `cloudflared` on PATH (respect an existing system install — fast)
 *   3. lazy-download via the optional `cloudflared` npm package
 */
export async function resolveBinary(): Promise<string> {
  if (cachedBinary) return cachedBinary;

  const override = process.env.CFLD_CLOUDFLARED ?? process.env.CLOUDFLARED_BIN;
  if (override) return (cachedBinary = override);

  // Try a system binary on PATH first.
  try {
    const res = await exec("cloudflared", ["--version"]);
    if (res.code === 0) return (cachedBinary = "cloudflared");
  } catch {
    // ENOENT — not on PATH, fall through to the managed binary.
  }

  // Fall back to the optional node-cloudflared managed binary.
  try {
    const mod = (await import("cloudflared")) as {
      bin: string;
      install?: (path: string) => Promise<string> | string;
    };
    return (cachedBinary = mod.bin);
  } catch {
    throw new CfldError(
      "cloudflared is not installed and the managed binary could not be loaded.",
      "Install it with `brew install cloudflared`, or set CFLD_CLOUDFLARED to its path.",
    );
  }
}

/**
 * Absolute path to the binary — required for service unit files, where PATH is
 * not the interactive shell's. Resolves a bare `cloudflared` via `which`.
 */
export async function resolveBinaryAbsolute(): Promise<string> {
  const bin = await resolveBinary();
  if (bin.includes("/")) return bin;
  try {
    const res = await exec("which", [bin]);
    const path = res.stdout.trim().split("\n")[0];
    if (res.code === 0 && path) return path;
  } catch {
    // fall through
  }
  return bin;
}

export interface TunnelExecOptions extends ExecOptions {
  /** Per-zone cert passed as `--origincert`; omit for `login`. */
  originCert?: string;
}

/**
 * Run `cloudflared tunnel [--origincert X] <...subArgs>`. The `--origincert`
 * flag belongs to the parent `tunnel` command, so it goes before the
 * subcommand.
 */
export async function runTunnel(
  subArgs: string[],
  options: TunnelExecOptions = {},
): Promise<ExecResult> {
  const { originCert, ...execOptions } = options;
  const bin = await resolveBinary();
  const args = ["tunnel"];
  if (originCert) args.push("--origincert", originCert);
  args.push(...subArgs);
  return exec(bin, args, execOptions);
}

export interface TunnelInfo {
  id: string;
  name: string;
  created_at?: string;
  connections?: unknown[];
}

/** `cloudflared tunnel list --output json` → parsed, name-indexed reuse source. */
export async function listTunnels(originCert?: string): Promise<TunnelInfo[]> {
  const res = await runTunnel(["list", "--output", "json"], { originCert });
  if (res.code !== 0) {
    throw new CfldError(
      "Failed to list Cloudflare tunnels.",
      res.stderr.trim() || "Check that your cert is valid — try `cfld login`.",
    );
  }
  try {
    const parsed = JSON.parse(res.stdout);
    return Array.isArray(parsed) ? (parsed as TunnelInfo[]) : [];
  } catch {
    // Some cloudflared versions print "no tunnels" text instead of `[]`.
    return [];
  }
}

/** Find a tunnel by exact name, or undefined. */
export async function findTunnel(
  name: string,
  originCert?: string,
): Promise<TunnelInfo | undefined> {
  const tunnels = await listTunnels(originCert);
  return tunnels.find((t) => t.name === name);
}

const UUID_RE =
  /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

/**
 * Create a named tunnel and return its UUID. Parses the UUID from stdout,
 * falling back to a list lookup for robustness across cloudflared versions.
 */
export async function createTunnel(
  name: string,
  originCert?: string,
): Promise<string> {
  const res = await runTunnel(["create", name], { originCert });
  if (res.code !== 0) {
    // A concurrent run may have created it first — let the caller re-list.
    if (/already exists/i.test(res.stderr)) {
      const existing = await findTunnel(name, originCert);
      if (existing) return existing.id;
    }
    throw new CfldError(
      `Failed to create tunnel "${name}".`,
      res.stderr.trim() || undefined,
    );
  }
  const match = res.stdout.match(UUID_RE);
  if (match) return match[0];
  const created = await findTunnel(name, originCert);
  if (created) return created.id;
  throw new CfldError(
    `Created tunnel "${name}" but could not determine its UUID.`,
  );
}

/**
 * Refetch run credentials for an existing tunnel into `credFile`. Used when the
 * tunnel exists remotely but its local `<uuid>.json` is missing.
 */
export async function fetchToken(
  nameOrUuid: string,
  credFile: string,
  originCert?: string,
): Promise<void> {
  const res = await runTunnel(
    ["token", "--cred-file", credFile, nameOrUuid],
    { originCert },
  );
  if (res.code !== 0) {
    throw new CfldError(
      `Failed to fetch credentials for tunnel "${nameOrUuid}".`,
      res.stderr.trim() || undefined,
    );
  }
}

/** Idempotently point a hostname's CNAME at the tunnel. */
export async function routeDns(
  nameOrUuid: string,
  hostname: string,
  originCert?: string,
): Promise<void> {
  const res = await runTunnel(
    ["route", "dns", "--overwrite-dns", nameOrUuid, hostname],
    { originCert },
  );
  if (res.code !== 0) {
    throw new CfldError(
      `Failed to route DNS ${hostname} → tunnel "${nameOrUuid}".`,
      res.stderr.trim() ||
        "The hostname's zone may not match this cert — try `cfld login --reauth`.",
    );
  }
}

/** Delete a named tunnel (used only by `cfld destroy`). */
export async function deleteTunnel(
  nameOrUuid: string,
  originCert?: string,
): Promise<void> {
  const res = await runTunnel(["delete", nameOrUuid], { originCert });
  if (res.code !== 0) {
    throw new CfldError(
      `Failed to delete tunnel "${nameOrUuid}".`,
      res.stderr.trim() || undefined,
    );
  }
}
