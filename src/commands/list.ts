import pc from "picocolors";
import { listTunnels } from "../core/cloudflared.js";
import { resolveCert } from "../core/cert-store.js";
import { listEntries } from "../core/registry.js";
import { info, note } from "../ui/output.js";

/**
 * Show every registered tunnel across all domains/projects, reconciled against
 * `cloudflared tunnel list` so stale entries are flagged.
 */
export async function listCommand(): Promise<void> {
  const entries = listEntries();
  if (entries.length === 0) {
    note("No tunnels registered yet. Run `cfld` in a project to create one.");
    return;
  }

  // Reconcile live state per zone (best-effort — never blocks the listing).
  const liveByZone = new Map<string, Set<string>>();
  for (const zone of new Set(entries.map((e) => e.zone))) {
    const cert = resolveCert(zone);
    if (!cert) continue;
    try {
      const tunnels = await listTunnels(cert);
      liveByZone.set(zone, new Set(tunnels.map((t) => t.id)));
    } catch {
      // leave unknown
    }
  }

  process.stdout.write(pc.bold("\n  cfld tunnels\n\n"));
  for (const e of entries) {
    const live = liveByZone.get(e.zone);
    const status =
      live === undefined
        ? pc.dim("?")
        : live.has(e.uuid)
          ? pc.green("●")
          : pc.red("✖ missing");
    process.stdout.write(
      `  ${status}  ${pc.cyan(`https://${e.hostname}`)}  ${pc.dim(
        `→ :${e.port}`,
      )}  ${pc.dim(e.projectDir)}\n`,
    );
  }
  process.stdout.write("\n");
  info(pc.dim("● live · ✖ deleted remotely (re-run to recreate) · ? unknown"));
}
