import { existsSync } from "node:fs";
import { credentialsPath } from "../util/paths.js";
import {
  createTunnel,
  fetchToken,
  findTunnel,
  routeDns,
} from "./cloudflared.js";
import { cfargoTunnelUuid, existingCnameTarget } from "./dns.js";
import { writeIngressConfig, type IngressRoute } from "./config-file.js";
import { getEntry, upsertEntry } from "./registry.js";
import { CfldError } from "../util/errors.js";

/**
 * The idempotency heart. Given a fully-resolved target (tunnel name, zone,
 * cert, hostname, port), reconcile Cloudflare + local state so that the SAME
 * named tunnel and DNS record are reused across runs — creating them only when
 * they are genuinely absent, never tearing them down.
 *
 * Cloudflare is the source of truth (`tunnel list`); the registry is a cache.
 */
export interface ReconcileInput {
  slug: string;
  tunnelName: string;
  zone: string;
  certPath: string;
  /** One or more routes; the first is the primary (dashboard/.env) hostname. */
  routes: IngressRoute[];
  projectDir: string;
  /** Skip the DNS-ownership guard and repoint unconditionally. */
  force?: boolean;
}

export interface ReconcileResult {
  uuid: string;
  tunnelName: string;
  /** Primary hostname/port (routes[0]) — what the dashboard and .env use. */
  hostname: string;
  port: number;
  routes: IngressRoute[];
  certPath: string;
  configPath: string;
  /** True when the tunnel was freshly created this run (vs reused). */
  created: boolean;
}

export interface ReconcileEvents {
  /** Called for each step so the UI can render progress. */
  onStep?: (step: string) => void;
  /**
   * Called when the hostname already points somewhere else and we're about to
   * repoint it. Return true to proceed. If omitted, a foreign record aborts.
   */
  confirmOverwrite?: (hostname: string, currentTarget: string) => Promise<boolean>;
}

export async function reconcile(
  input: ReconcileInput,
  events: ReconcileEvents = {},
): Promise<ReconcileResult> {
  const step = (s: string) => events.onStep?.(s);
  const { tunnelName, certPath, routes, slug, zone, projectDir } = input;
  const primary = routes[0];
  if (!primary) throw new CfldError("At least one route is required.");

  // 1. Resolve tunnel — reuse by name, or create. Cloudflare is truth.
  step(`Resolving tunnel ${tunnelName}`);
  const existing = await findTunnel(tunnelName, certPath);
  let uuid: string;
  let created = false;
  if (existing) {
    uuid = existing.id;
    // Ensure run credentials are present locally; refetch if the JSON is gone.
    if (!existsSync(credentialsPath(uuid))) {
      step("Refetching tunnel credentials");
      await fetchToken(tunnelName, credentialsPath(uuid), certPath);
    }
  } else {
    step(`Creating tunnel ${tunnelName}`);
    uuid = await createTunnel(tunnelName, certPath);
    created = true;
  }

  // 2. Route DNS for every hostname, guarding each against theft.
  const prior = getEntry(tunnelName);
  const owned = new Set([
    prior?.hostname,
    ...(prior?.routes ?? []).map((r) => r.hostname),
  ]);
  for (const route of routes) {
    if (!input.force && !owned.has(route.hostname)) {
      const target = await existingCnameTarget(route.hostname);
      if (target && cfargoTunnelUuid(target) !== uuid.toLowerCase()) {
        const ok = events.confirmOverwrite
          ? await events.confirmOverwrite(route.hostname, target)
          : false;
        if (!ok) {
          throw new CfldError(
            `${route.hostname} already points to ${target}.`,
            "Re-run with --force to repoint it, or pick another host.",
          );
        }
      }
    }
    step(`Routing ${route.hostname}`);
    await routeDns(tunnelName, route.hostname, certPath);
  }

  // 3. Materialize the ingress config from resolved state.
  step("Writing ingress config");
  const configPath = writeIngressConfig({ slug, uuid, routes });

  // 4. Update the machine-wide registry (preserve original createdAt).
  upsertEntry({
    name: tunnelName,
    zone,
    certPath,
    uuid,
    hostname: primary.hostname,
    port: primary.port,
    routes,
    projectDir,
    createdAt: prior?.createdAt ?? nowIso(),
    lastRun: nowIso(),
  });

  return {
    uuid,
    tunnelName,
    hostname: primary.hostname,
    port: primary.port,
    routes,
    certPath,
    configPath,
    created,
  };
}

function nowIso(): string {
  return new Date().toISOString();
}
