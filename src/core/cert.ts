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

/**
 * The zone *name* a cert authorizes, looked up with the cert's own embedded
 * token — the same authority cloudflared uses for `route dns`, so still no
 * user-supplied API token. Undefined when offline or the API refuses; callers
 * must treat that as "unknown", not "mismatch".
 */
export async function certZoneName(certPath: string): Promise<string | undefined> {
  const token = readCertToken(certPath);
  if (!token?.zoneID || !token.apiToken) return undefined;
  try {
    const res = await fetch(
      `https://api.cloudflare.com/client/v4/zones/${token.zoneID}`,
      {
        headers: { Authorization: `Bearer ${token.apiToken}` },
        signal: AbortSignal.timeout(5000),
      },
    );
    if (!res.ok) return undefined;
    const body = (await res.json()) as { result?: { name?: string } };
    return body.result?.name?.toLowerCase();
  } catch {
    return undefined;
  }
}
