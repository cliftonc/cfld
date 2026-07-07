import { deleteTunnel } from "../core/cloudflared.js";
import { resolveCert } from "../core/cert-store.js";
import { getEntry, listEntries, removeEntry } from "../core/registry.js";
import { readProjectConfig } from "../core/project-config.js";
import { CfldError } from "../util/errors.js";
import { askConfirm } from "../ui/prompts.js";
import { done, isInteractive, note, warn } from "../ui/output.js";

/**
 * The explicit, opt-in teardown competitors do automatically on exit. Deletes
 * the named tunnel and removes local/registry state. Confirmation-guarded.
 */
export async function destroyCommand(
  name: string | undefined,
  force: boolean,
): Promise<void> {
  const entry = name
    ? getEntry(name) ?? getEntry(`cfld-${name}`)
    : resolveCurrentEntry();

  if (!entry) {
    throw new CfldError(
      name ? `No registered tunnel named "${name}".` : "No cfld tunnel found here.",
      "Run `cfld list` to see all tunnels.",
    );
  }

  if (!force) {
    if (!isInteractive()) {
      throw new CfldError(
        "Refusing to destroy without confirmation in a non-interactive shell.",
        "Re-run with --force to skip the prompt.",
      );
    }
    const ok = await askConfirm(
      `Delete tunnel ${entry.name} (https://${entry.hostname})? This is permanent.`,
    );
    if (!ok) {
      note("Aborted.");
      return;
    }
  }

  const cert = resolveCert(entry.zone);
  if (cert) {
    await deleteTunnel(entry.name, cert);
    done(`Deleted tunnel ${entry.name}`);
  } else {
    warn(`No cert for ${entry.zone}; skipped remote delete. Remove it in the dashboard.`);
  }

  removeEntry(entry.name);
  done("Removed local registry entry");
  warn(
    `The DNS record ${entry.hostname} may still exist — remove it in the Cloudflare dashboard, ` +
      `or it will be repointed automatically next time you run cfld for this project.`,
  );
}

function resolveCurrentEntry() {
  const config = readProjectConfig(process.cwd());
  if (config?.name) {
    const entry = getEntry(`cfld-${config.name}`);
    if (entry) return entry;
  }
  return listEntries().find((e) => e.projectDir === process.cwd());
}
