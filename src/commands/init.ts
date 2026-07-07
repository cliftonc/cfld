import type { CliFlags } from "../cli.js";
import { reconcile } from "../core/state-machine.js";
import { listStoredZones } from "../core/cert-store.js";
import {
  buildHostname,
  deriveSlug,
  slugify,
  tunnelNameForSlug,
} from "../core/hostname.js";
import { detectDevPorts } from "../core/port.js";
import { writeProjectConfig } from "../core/project-config.js";
import { listEntries } from "../core/registry.js";
import { ensureCert, normalizeZone } from "./login.js";
import { CfldError } from "../util/errors.js";
import { ensureGitignored } from "../util/gitignore.js";
import { askConfirm, askSelect, askText } from "../ui/prompts.js";
import { done, info, isInteractive, note, step } from "../ui/output.js";

/**
 * Interactive setup wizard. Confirms domain/name/port/hostname, creates the
 * tunnel + DNS + registry entry, and writes `.cfld.json` — but does NOT run.
 * Follow with `cfld` to go live.
 */
export async function initCommand(flags: CliFlags): Promise<void> {
  if (!isInteractive()) {
    throw new CfldError(
      "`cfld init` is interactive.",
      "In scripts, run `cfld` directly with --zone/--host/--name flags.",
    );
  }
  const cwd = process.cwd();

  // 1. Domain — pick a known one or enter a new one.
  const knownZones = Array.from(
    new Set([...listStoredZones(), ...listEntries().map((e) => e.zone)]),
  );
  let zone: string;
  if (knownZones.length) {
    const picked = await askSelect<string>("Which Cloudflare domain?", [
      ...knownZones.map((z) => ({ value: z, label: z })),
      { value: "__new__", label: "Use a different domain…" },
    ]);
    zone = picked === "__new__"
      ? normalizeZone(await askText("Domain (zone) on Cloudflare?", "example.com"))
      : picked;
  } else {
    zone = normalizeZone(await askText("Domain (zone) on Cloudflare?", "example.com"));
  }

  // 2. Ensure a cert for that zone (may open the browser login).
  const certPath = await ensureCert(zone, { interactive: true });

  // 3. Name, port, hostname → create the tunnel + DNS + registry entry (no launch).
  await configureProject(flags, { zone, certPath, cwd });
  note("Run `cfld` to go live.");
}

/**
 * Interactive project configuration, shared by `cfld init` and `cfld setup`:
 * prompt for name/port, reconcile the tunnel + DNS + registry entry, and write
 * `.cfld.json`. Does NOT run the tunnel. Returns the resolved hostname/port.
 */
export async function configureProject(
  flags: CliFlags,
  ctx: { zone: string; certPath: string; cwd?: string },
): Promise<{ name: string; hostname: string; port: number }> {
  const cwd = ctx.cwd ?? process.cwd();

  const defaultSlug = deriveSlug(cwd, flags.name);
  const name = slugify((await askText("Project name (used in the URL)", defaultSlug)) || defaultSlug);
  const detected = await detectDevPorts();
  const portStr = await askText(
    "Local port your dev server runs on",
    detected[0] ? String(detected[0]) : "3000",
  );
  const port = Number(portStr.trim());
  if (!Number.isInteger(port) || port <= 0) {
    throw new CfldError(`"${portStr}" is not a valid port.`);
  }
  const hostname = flags.host ?? buildHostname(name, ctx.zone);

  const result = await reconcile(
    {
      slug: name,
      tunnelName: tunnelNameForSlug(name),
      zone: ctx.zone,
      certPath: ctx.certPath,
      routes: [{ hostname, port }],
      projectDir: cwd,
      force: flags.force,
    },
    {
      onStep: (s) => step(s),
      confirmOverwrite: (h, t) =>
        askConfirm(`${h} already points to ${t}. Repoint it to this tunnel?`),
    },
  );

  writeProjectConfig(cwd, {
    name,
    zone: ctx.zone,
    uuid: result.uuid,
    hostname,
    port,
    envKey: flags.envKey ?? "PUBLIC_URL",
  });

  if (ensureGitignored(cwd, ".cfld.json")) info("Added .cfld.json to .gitignore.");

  done(`Configured https://${hostname} → localhost:${port}`);
  return { name, hostname, port };
}
