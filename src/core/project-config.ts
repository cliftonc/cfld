import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { PROJECT_CONFIG_FILE } from "../util/paths.js";

/**
 * Project configuration comes from two places:
 *   - `package.json` "cfld" block — authored, committable intent.
 *   - `./.cfld.json` — machine-local cache of resolved identity (uuid).
 *
 * Authored fields win (editing package.json takes effect immediately); the
 * cache only supplies the resolved uuid.
 */
export interface RouteConfig {
  /** Subdomain slug; defaults to the project slug. */
  name?: string;
  /** Explicit fully-qualified hostname (overrides name+zone). */
  host?: string;
  port: number;
  /** Optional path prefix, e.g. /api. */
  path?: string;
}

export interface ProjectConfig {
  name?: string;
  zone?: string;
  uuid?: string;
  hostname?: string;
  port?: number;
  envKey?: string;
  routes?: RouteConfig[];
}

function dotConfigPath(cwd: string): string {
  return join(cwd, PROJECT_CONFIG_FILE);
}

/** The authored `"cfld"` block from package.json, normalized. */
function readAuthored(cwd: string): ProjectConfig | undefined {
  const pkgPath = join(cwd, "package.json");
  if (!existsSync(pkgPath)) return undefined;
  try {
    const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as {
      cfld?: ProjectConfig & { host?: string };
    };
    const c = pkg.cfld;
    if (!c) return undefined;
    return {
      name: c.name,
      zone: c.zone,
      port: c.port,
      hostname: c.hostname ?? c.host,
      envKey: c.envKey,
      routes: c.routes,
    };
  } catch {
    return undefined;
  }
}

/** The machine-local cache. */
function readCached(cwd: string): ProjectConfig | undefined {
  const p = dotConfigPath(cwd);
  if (!existsSync(p)) return undefined;
  try {
    return JSON.parse(readFileSync(p, "utf8")) as ProjectConfig;
  } catch {
    return undefined;
  }
}

export function readProjectConfig(cwd: string): ProjectConfig | undefined {
  const authored = readAuthored(cwd);
  const cached = readCached(cwd);
  if (!authored && !cached) return undefined;
  return {
    name: authored?.name ?? cached?.name,
    zone: authored?.zone ?? cached?.zone,
    port: authored?.port ?? cached?.port,
    hostname: authored?.hostname ?? cached?.hostname,
    envKey: authored?.envKey ?? cached?.envKey,
    routes: authored?.routes ?? cached?.routes,
    uuid: cached?.uuid, // resolved identity only ever comes from the cache
  };
}

/** Write the machine-local cache (`.cfld.json`). */
export function writeProjectConfig(cwd: string, config: ProjectConfig): void {
  writeFileSync(
    dotConfigPath(cwd),
    JSON.stringify(config, null, 2) + "\n",
    "utf8",
  );
}
