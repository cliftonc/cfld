import { copyFileSync, existsSync, mkdirSync, readdirSync } from "node:fs";
import {
  certPathForZone,
  certStoreDir,
  defaultCertPath,
} from "../util/paths.js";
import { certExists, readCertToken } from "./cert.js";

/**
 * The per-domain cert store: `~/.cfld/certs/<zone>.pem`. cloudflared certs are
 * zone-scoped, so we keep one per domain and select it via `--origincert`,
 * letting multiple domains coexist on one machine.
 */

function ensureStoreDir(): void {
  mkdirSync(certStoreDir(), { recursive: true });
}

/** Path to a zone's cert if it exists in the store, else undefined. */
export function storedCertForZone(zone: string): string | undefined {
  const p = certPathForZone(zone);
  return existsSync(p) ? p : undefined;
}

/** Zone names that have a stored cert (`<zone>.pem` → `<zone>`). */
export function listStoredZones(): string[] {
  try {
    return readdirSync(certStoreDir())
      .filter((f) => f.endsWith(".pem"))
      .map((f) => f.slice(0, -".pem".length));
  } catch {
    return [];
  }
}

/**
 * Another stored zone whose cert carries the same zoneID as `certPath`, if any.
 * Two domain names can't share a zoneID, so a hit means the cert was saved under
 * the wrong name (or is about to be).
 */
export function storedZoneClaiming(certPath: string, except?: string): string | undefined {
  const zoneID = readCertToken(certPath)?.zoneID;
  if (!zoneID) return undefined;
  return listStoredZones().find(
    (z) => z !== except && readCertToken(certPathForZone(z))?.zoneID === zoneID,
  );
}

/**
 * Resolve the cert to use for a zone: the stored per-zone cert if present,
 * otherwise the default `~/.cloudflared/cert.pem` (first-time single-domain
 * setup) unless it is already known to belong to a different stored zone,
 * otherwise undefined (onboarding required).
 */
export function resolveCert(zone: string): string | undefined {
  const stored = storedCertForZone(zone);
  if (stored) return stored;
  const def = defaultCertPath();
  if (!certExists(def) || storedZoneClaiming(def, zone)) return undefined;
  return def;
}

/**
 * Copy a freshly-minted cert (default `~/.cloudflared/cert.pem`) into the store
 * under a zone name, so future runs for that zone select it explicitly.
 * Returns the stored path.
 */
export function importCert(zone: string, fromPath = defaultCertPath()): string {
  ensureStoreDir();
  const dest = certPathForZone(zone);
  copyFileSync(fromPath, dest);
  return dest;
}
