import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Ensure a pattern is present in the project's .gitignore. Appends to an
 * existing file, or creates one when the directory is a git repo. Skips
 * non-git directories so we never litter a plain folder. Idempotent — returns
 * true only when it actually changed the file.
 */
export function ensureGitignored(cwd: string, pattern: string): boolean {
  const gitignorePath = join(cwd, ".gitignore");
  const hasGitignore = existsSync(gitignorePath);
  const inRepo = hasGitignore || existsSync(join(cwd, ".git"));
  if (!inRepo) return false;

  const existing = hasGitignore ? readFileSync(gitignorePath, "utf8") : "";
  const present = existing
    .split("\n")
    .map((l) => l.trim())
    .includes(pattern);
  if (present) return false;

  const body = existing.replace(/\n$/, "");
  const next = body.length ? `${body}\n${pattern}\n` : `${pattern}\n`;
  writeFileSync(gitignorePath, next, "utf8");
  return true;
}
