import { writeFileSync } from "node:fs";
import { credentialsPath, ingressConfigPath } from "../util/paths.js";

/**
 * Generate the cloudflared ingress config for a project. Supports multiple
 * routes (hostname → local port, optional path) so one tunnel can expose an
 * API and a web app at once. Regenerated from resolved state every run.
 */
export interface IngressRoute {
  hostname: string;
  port: number;
  /** Optional path prefix, e.g. /api. */
  path?: string;
}

export interface IngressConfig {
  slug: string;
  uuid: string;
  routes: IngressRoute[];
}

export function renderIngressConfig(cfg: IngressConfig): string {
  const rules = cfg.routes.flatMap((r) => {
    const lines = [`  - hostname: ${r.hostname}`];
    if (r.path) lines.push(`    path: ${r.path}`);
    lines.push(`    service: http://localhost:${r.port}`);
    return lines;
  });
  return [
    `tunnel: ${cfg.uuid}`,
    `credentials-file: ${credentialsPath(cfg.uuid)}`,
    `ingress:`,
    ...rules,
    `  - service: http_status:404`,
    ``,
  ].join("\n");
}

/** Write the config and return its path. */
export function writeIngressConfig(cfg: IngressConfig): string {
  const path = ingressConfigPath(cfg.slug);
  writeFileSync(path, renderIngressConfig(cfg), "utf8");
  return path;
}
