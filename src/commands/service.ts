import pc from "picocolors";
import { writeIngressConfig } from "../core/config-file.js";
import { ingressConfigPath } from "../util/paths.js";
import {
  buildSpec,
  installService,
  serviceControl,
  serviceSlug,
  serviceState,
  uninstallService,
} from "../core/service.js";
import { CfldError } from "../util/errors.js";
import { resolveEntry } from "./resolve-entry.js";
import { done, info, note } from "../ui/output.js";

const ACTIONS = ["install", "uninstall", "start", "stop", "status"] as const;
type Action = (typeof ACTIONS)[number];

/**
 * `cfld service <install|uninstall|start|stop|status> [name]` — manage the
 * always-on background service for a registered tunnel (LaunchAgent / systemd).
 */
export async function serviceCommand(
  action: string | undefined,
  name: string | undefined,
): Promise<void> {
  if (!action || !ACTIONS.includes(action as Action)) {
    throw new CfldError(
      `Usage: cfld service <${ACTIONS.join("|")}> [name]`,
    );
  }

  const entry = resolveEntry(name);
  if (!entry) {
    throw new CfldError(
      name ? `No registered tunnel named "${name}".` : "No cfld tunnel found here.",
      "Run `cfld` or `cfld init` for this project first, then install the service.",
    );
  }
  const slug = serviceSlug(entry.name);

  switch (action as Action) {
    case "install": {
      // Regenerate the ingress config so the service runs the current mapping.
      writeIngressConfig({
        slug,
        uuid: entry.uuid,
        routes: entry.routes?.length
          ? entry.routes
          : [{ hostname: entry.hostname, port: entry.port }],
      });
      const spec = await buildSpec(entry.name, entry.certPath, ingressConfigPath(slug));
      await installService(spec);
      done(`Installed always-on service for ${entry.name}.`);
      note(
        `https://${entry.hostname} now stays up across logout/reboot. ` +
          `Check with \`cfld service status\`, remove with \`cfld service uninstall\`.`,
      );
      return;
    }
    case "uninstall":
      await uninstallService(entry.name);
      done(`Removed service for ${entry.name}. (Tunnel + DNS are preserved.)`);
      return;
    case "start":
      await serviceControl(entry.name, "start");
      done(`Started ${entry.name}.`);
      return;
    case "stop":
      await serviceControl(entry.name, "stop");
      done(`Stopped ${entry.name}. (Tunnel + DNS are preserved.)`);
      return;
    case "status": {
      const state = await serviceState(entry.name);
      const label =
        state === "running"
          ? pc.green("● running")
          : state === "installed"
            ? pc.yellow("◌ installed (stopped)")
            : pc.dim("· not installed");
      info(`${entry.name}  ${label}  ${pc.dim(`https://${entry.hostname}`)}`);
      return;
    }
  }
}
