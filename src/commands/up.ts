import { reconcile } from "../core/state-machine.js";
import { resolveCert } from "../core/cert-store.js";
import { getEntry } from "../core/registry.js";
import { CfldError } from "../util/errors.js";
import { launch } from "./run.js";

/**
 * Run a registered tunnel by name from anywhere — no cwd dependency. Uses the
 * registry entry's stored identity and reconciles before launching.
 */
export async function upCommand(name: string): Promise<void> {
  const entry = getEntry(name) ?? getEntry(`cfld-${name}`);
  if (!entry) {
    throw new CfldError(
      `No registered tunnel named "${name}".`,
      "Run `cfld list` to see available tunnels.",
    );
  }

  const cert = resolveCert(entry.zone);
  if (!cert) {
    throw new CfldError(
      `No certificate available for zone ${entry.zone}.`,
      "Run `cfld login` to authorize it.",
    );
  }

  const slug = entry.name.replace(/^cfld-/, "");
  const routes = entry.routes?.length
    ? entry.routes
    : [{ hostname: entry.hostname, port: entry.port }];

  await launch({
    cwd: entry.projectDir,
    slug,
    zone: entry.zone,
    envKey: "PUBLIC_URL",
    noEnv: true, // don't touch a .env we may not be sitting in
    url: `https://${entry.hostname}`,
    port: entry.port,
    tunnelName: entry.name,
    runReconcile: (events) =>
      reconcile(
        {
          slug,
          tunnelName: entry.name,
          zone: entry.zone,
          certPath: cert,
          routes,
          projectDir: entry.projectDir,
        },
        events,
      ),
  });
}
