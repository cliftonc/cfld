import pc from "picocolors";
import { findTunnel } from "../core/cloudflared.js";
import { resolveCert } from "../core/cert-store.js";
import { getEntry, listEntries } from "../core/registry.js";
import { readProjectConfig } from "../core/project-config.js";
import { CfldError } from "../util/errors.js";
import { note } from "../ui/output.js";

/**
 * Read-only detail for a tunnel: current project by default, or any registered
 * tunnel by name.
 */
export async function statusCommand(name?: string): Promise<void> {
  const entry = name
    ? getEntry(name) ?? getEntry(`cfld-${name}`)
    : resolveCurrentEntry();

  if (!entry) {
    if (name) {
      throw new CfldError(
        `No registered tunnel named "${name}".`,
        "Run `cfld list` to see all tunnels.",
      );
    }
    note("No cfld tunnel configured in this directory. Run `cfld` to set one up.");
    return;
  }

  const cert = resolveCert(entry.zone);
  let liveState = pc.dim("unknown (no cert)");
  if (cert) {
    try {
      const found = await findTunnel(entry.name, cert);
      liveState = found ? pc.green("exists") : pc.red("deleted remotely");
    } catch {
      liveState = pc.dim("unreachable");
    }
  }

  const rows: [string, string][] = [
    ["URL", pc.cyan(`https://${entry.hostname}`)],
    ["Local target", `localhost:${entry.port}`],
    ["Tunnel", `${entry.name} (${entry.uuid})`],
    ["Zone", entry.zone],
    ["Cert", cert ?? pc.red("missing")],
    ["Remote state", liveState],
    ["Project", entry.projectDir],
    ["Last run", entry.lastRun ?? "never"],
  ];
  process.stdout.write("\n");
  for (const [k, v] of rows) {
    process.stdout.write(`  ${pc.dim(k.padEnd(14))} ${v}\n`);
  }
  process.stdout.write("\n");
}

function resolveCurrentEntry() {
  const config = readProjectConfig(process.cwd());
  if (config?.name) {
    const entry = getEntry(`cfld-${config.name}`);
    if (entry) return entry;
  }
  // Fall back to a registry entry whose projectDir matches cwd.
  return listEntries().find((e) => e.projectDir === process.cwd());
}
