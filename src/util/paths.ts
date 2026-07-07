import { homedir } from "node:os";
import { join } from "node:path";

/**
 * Central resolution of every filesystem location cfld touches. Kept in one
 * module so tests can reason about paths and nothing hardcodes `~/.cfld`
 * inline.
 */

/** cloudflared's own home, where `login` writes cert.pem and `create` writes creds. */
export function cloudflaredDir(): string {
  return process.env.CLOUDFLARED_HOME ?? join(homedir(), ".cloudflared");
}

/** The default cert produced by `cloudflared tunnel login` (single-domain case). */
export function defaultCertPath(): string {
  return process.env.TUNNEL_ORIGIN_CERT ?? join(cloudflaredDir(), "cert.pem");
}

/** cfld's own home: cert store + registry live here. */
export function cfldDir(): string {
  return process.env.CFLD_HOME ?? join(homedir(), ".cfld");
}

/** Directory holding one cert per zone: `~/.cfld/certs/<zone>.pem`. */
export function certStoreDir(): string {
  return join(cfldDir(), "certs");
}

/** The per-zone cert path within the store. */
export function certPathForZone(zone: string): string {
  return join(certStoreDir(), `${zone}.pem`);
}

/** Machine-wide tunnel index. */
export function registryPath(): string {
  return join(cfldDir(), "registry.json");
}

/** Run credentials file cloudflared writes for a tunnel UUID. */
export function credentialsPath(uuid: string): string {
  return join(cloudflaredDir(), `${uuid}.json`);
}

/** Generated ingress config for a given project slug. */
export function ingressConfigPath(slug: string): string {
  return join(cloudflaredDir(), `${slug}.cfld.yml`);
}

/** The per-project local pointer file. */
export const PROJECT_CONFIG_FILE = ".cfld.json";
