import { resolveCname } from "node:dns/promises";

/**
 * Best-effort DNS-ownership check used to guard `--overwrite-dns` from silently
 * stealing a hostname that belongs to another tunnel or service. Uses a plain
 * CNAME lookup — no API token needed.
 */

const CFARGO_RE = /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.cfargotunnel\.com/i;

/** The current CNAME target of a hostname, or undefined if none/unresolvable. */
export async function existingCnameTarget(
  hostname: string,
): Promise<string | undefined> {
  try {
    const records = await resolveCname(hostname);
    return records[0];
  } catch {
    return undefined; // ENOTFOUND / ENODATA — no CNAME, safe to create.
  }
}

/** Extract the tunnel UUID from a `<uuid>.cfargotunnel.com` target. */
export function cfargoTunnelUuid(target: string | undefined): string | undefined {
  return target?.match(CFARGO_RE)?.[1]?.toLowerCase();
}
