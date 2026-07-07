import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { cfldDir, registryPath } from "../util/paths.js";
import type { IngressRoute } from "./config-file.js";

/**
 * The machine-wide tunnel index at `~/.cfld/registry.json`. It lets any tunnel
 * be managed by name from anywhere (`cfld list`/`up`/`status`/`destroy`),
 * independent of the current directory. It is a cache — always reconciled
 * against `cloudflared tunnel list`, never trusted blindly.
 */

export interface RegistryEntry {
  name: string;
  zone: string;
  certPath: string;
  uuid: string;
  /** Primary hostname/port (routes[0]). */
  hostname: string;
  port: number;
  /** Full route list for multi-ingress tunnels. */
  routes?: IngressRoute[];
  projectDir: string;
  createdAt: string;
  lastRun?: string;
}

interface RegistryFile {
  version: 1;
  tunnels: RegistryEntry[];
}

function empty(): RegistryFile {
  return { version: 1, tunnels: [] };
}

export function readRegistry(): RegistryFile {
  const p = registryPath();
  if (!existsSync(p)) return empty();
  try {
    const parsed = JSON.parse(readFileSync(p, "utf8")) as RegistryFile;
    if (!parsed || !Array.isArray(parsed.tunnels)) return empty();
    return parsed;
  } catch {
    return empty();
  }
}

function writeRegistry(data: RegistryFile): void {
  mkdirSync(cfldDir(), { recursive: true });
  writeFileSync(registryPath(), JSON.stringify(data, null, 2) + "\n", "utf8");
}

export function listEntries(): RegistryEntry[] {
  return readRegistry().tunnels;
}

export function getEntry(name: string): RegistryEntry | undefined {
  return readRegistry().tunnels.find((t) => t.name === name);
}

/** Insert or replace the entry for a tunnel name. */
export function upsertEntry(entry: RegistryEntry): void {
  const data = readRegistry();
  const idx = data.tunnels.findIndex((t) => t.name === entry.name);
  if (idx === -1) data.tunnels.push(entry);
  else data.tunnels[idx] = entry;
  writeRegistry(data);
}

export function removeEntry(name: string): void {
  const data = readRegistry();
  data.tunnels = data.tunnels.filter((t) => t.name !== name);
  writeRegistry(data);
}
