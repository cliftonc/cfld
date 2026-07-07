import { existsSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";

/**
 * Deterministic identity derivation: a project always maps to the same slug →
 * the same tunnel name and hostname, so the public URL is stable across runs.
 */

/** Lowercase, keep [a-z0-9-], collapse and trim dashes. */
export function slugify(input: string): string {
  return input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
}

/**
 * Derive the project slug: explicit `--name`, else package.json `name`, else
 * the current directory's basename.
 */
export function deriveSlug(cwd: string, nameFlag?: string): string {
  if (nameFlag) return slugify(nameFlag);
  const pkgPath = join(cwd, "package.json");
  if (existsSync(pkgPath)) {
    try {
      const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as {
        name?: string;
      };
      if (pkg.name) {
        // Strip an npm scope: "@acme/api" → "api".
        const unscoped = pkg.name.replace(/^@[^/]+\//, "");
        const slug = slugify(unscoped);
        if (slug) return slug;
      }
    } catch {
      // fall through
    }
  }
  return slugify(basename(cwd)) || "app";
}

/** Namespaced tunnel name to avoid collisions with hand-made tunnels. */
export function tunnelNameForSlug(slug: string): string {
  return `cfld-${slug}`;
}

/** Compose the public hostname from slug + zone. */
export function buildHostname(slug: string, zone: string): string {
  return `${slug}.${zone}`;
}

/**
 * Find the zone for a hostname. Prefer the longest known zone that is a suffix
 * of the hostname (robust for multi-level TLDs); otherwise fall back to the
 * last two labels.
 */
export function zoneForHostname(hostname: string, knownZones: string[]): string {
  const matches = knownZones
    .filter((z) => hostname === z || hostname.endsWith(`.${z}`))
    .sort((a, b) => b.length - a.length);
  if (matches[0]) return matches[0];
  const labels = hostname.split(".");
  return labels.slice(-2).join(".");
}
