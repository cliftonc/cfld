import { existsSync, readFileSync } from "node:fs";

/**
 * cloudflared's cert.pem bundles a certificate, a private key, and an
 * `ARGO TUNNEL TOKEN` block — base64-encoded JSON holding the authorized
 * zone/account ids (but not the human domain name, which we track separately
 * in config/registry). We decode it only for diagnostics and to detect the
 * zero-zone case.
 */

export interface CertToken {
  zoneID?: string;
  accountID?: string;
  apiToken?: string;
}

const TOKEN_BLOCK_RE =
  /-----BEGIN ARGO TUNNEL TOKEN-----\s*([\s\S]*?)\s*-----END ARGO TUNNEL TOKEN-----/;

export function certExists(certPath: string): boolean {
  return existsSync(certPath);
}

/** Decode the embedded token block, or undefined if absent/unparseable. */
export function readCertToken(certPath: string): CertToken | undefined {
  if (!existsSync(certPath)) return undefined;
  let pem: string;
  try {
    pem = readFileSync(certPath, "utf8");
  } catch {
    return undefined;
  }
  const match = pem.match(TOKEN_BLOCK_RE);
  if (!match || !match[1]) return undefined;
  try {
    const json = Buffer.from(match[1].replace(/\s+/g, ""), "base64").toString(
      "utf8",
    );
    const parsed = JSON.parse(json) as CertToken;
    return parsed;
  } catch {
    return undefined;
  }
}

/**
 * A cert is "zone-scoped" (usable for DNS routing) when it carries a zoneID.
 * A cert with no zoneID means the account had no domain to authorize.
 */
export function certHasZone(certPath: string): boolean {
  const token = readCertToken(certPath);
  return Boolean(token?.zoneID);
}
