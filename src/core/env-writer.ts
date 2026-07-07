import { existsSync, readFileSync, writeFileSync } from "node:fs";

/**
 * Surgically upsert a single KEY=value line into a .env file without
 * disturbing anything else. Idempotent: running twice with the same value
 * leaves the file byte-identical. This is what makes the public URL available
 * to webhook/OAuth dev config automatically.
 */
export function upsertEnv(
  envPath: string,
  key: string,
  value: string,
): { changed: boolean } {
  const line = `${key}=${value}`;
  const existing = existsSync(envPath) ? readFileSync(envPath, "utf8") : "";

  // Drop the file's single trailing newline so line arithmetic is clean; we
  // re-add exactly one on write.
  const body = existing.replace(/\n$/, "");
  const lines = body.length ? body.split("\n") : [];
  const keyRe = new RegExp(`^\\s*${escapeRegExp(key)}\\s*=`);
  let found = false;
  let changed = false;

  const next = lines.map((l) => {
    if (keyRe.test(l)) {
      found = true;
      if (l !== line) changed = true;
      return line;
    }
    return l;
  });

  if (!found) {
    next.push(line);
    changed = true;
  }

  if (!changed) return { changed: false };

  writeFileSync(envPath, next.join("\n") + "\n", "utf8");
  return { changed: true };
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
