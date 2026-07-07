import { getEntry, listEntries, type RegistryEntry } from "../core/registry.js";
import { readProjectConfig } from "../core/project-config.js";

/**
 * Resolve which registered tunnel a command targets: an explicit name (with or
 * without the `cfld-` prefix), else the current project (via `.cfld.json` or a
 * projectDir match). Shared by service/status/destroy.
 */
export function resolveEntry(name?: string): RegistryEntry | undefined {
  if (name) return getEntry(name) ?? getEntry(`cfld-${name}`);
  const config = readProjectConfig(process.cwd());
  if (config?.name) {
    const entry = getEntry(`cfld-${config.name}`);
    if (entry) return entry;
  }
  return listEntries().find((e) => e.projectDir === process.cwd());
}
