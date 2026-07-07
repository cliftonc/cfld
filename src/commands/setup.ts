import type { CliFlags } from "../cli.js";
import { resolveBinary } from "../core/cloudflared.js";
import { exec } from "../util/exec.js";
import { importCert, listStoredZones } from "../core/cert-store.js";
import { certHasZone } from "../core/cert.js";
import { readProjectConfig } from "../core/project-config.js";
import { listEntries } from "../core/registry.js";
import { defaultCertPath } from "../util/paths.js";
import { ensureCert, normalizeZone, printZeroZoneGuidance, runLogin } from "./login.js";
import { configureProject } from "./init.js";
import { quickCommand } from "./quick.js";
import { runCommand } from "./run.js";
import { CfldError } from "../util/errors.js";
import { askConfirm, askSelect, askText } from "../ui/prompts.js";
import { done, info, isInteractive, note, step, warn } from "../ui/output.js";

/**
 * Guided first-run onboarding. Leads with the free, no-account instant URL, then
 * offers the persistent path (free Cloudflare account + a domain). Reuses the
 * existing login/reconcile building blocks — the value here is orchestration and
 * honest framing, not new automation (Cloudflare account signup can't be scripted:
 * it needs a browser, ToS acceptance, and email verification).
 */
export async function setupCommand(flags: CliFlags): Promise<void> {
  if (!isInteractive()) {
    throw new CfldError(
      "`cfld setup` is interactive.",
      "In scripts, use `cfld --quick`, or `cfld` with --zone/--host/--name flags.",
    );
  }

  step("Let's get cfld set up.");
  await preflightCloudflared();

  const cwd = process.cwd();
  const knownZones = Array.from(
    new Set([...listStoredZones(), ...listEntries().map((e) => e.zone)]),
  );
  const alreadyAuthorized = knownZones.length > 0 || certHasZone(defaultCertPath());

  // Already authorized — skip login, just wire up this project (if it needs it).
  if (alreadyAuthorized) {
    const config = readProjectConfig(cwd);
    if (config?.uuid || config?.zone) {
      done("You're already set up — run `cfld` to go live.");
      return;
    }
    info("You're already authorized with Cloudflare. Let's configure this project.");
    const zone = await askAuthorizedZone(knownZones);
    const certPath = await ensureCert(zone, { interactive: true });
    await configureProject(flags, { zone, certPath, cwd });
    await offerGoLive(flags, zone);
    return;
  }

  // Brand-new user — instant-first path choice.
  const path = await askSelect<string>("How do you want to start?", [
    {
      value: "quick",
      label: "Get a public URL right now — free, no account (temporary URL)",
    },
    {
      value: "persistent",
      label: "Set up a persistent URL — free Cloudflare account + a domain",
    },
  ]);

  if (path === "quick") {
    note(
      "  Starting a temporary tunnel. Run `cfld setup` again anytime to set up a persistent URL.",
    );
    await quickCommand(flags);
    return;
  }

  // Persistent path — authorize first so the browser handles sign-in OR sign-up,
  // and we learn the domain from what the user picks there.
  note(
    [
      "",
      "  A browser window will open to authorize cfld with Cloudflare.",
      '    • No account yet? Click "Sign up" on that page — it\'s free.',
      "    • Then pick (or add) the domain you want to use.",
      "  Prefer to create the account first? Open:",
      "      https://dash.cloudflare.com/sign-up",
      "",
    ].join("\n"),
  );
  if (!(await askConfirm("Open the browser to authorize now?"))) {
    note(
      "No problem — run `cfld setup` again when you're ready, or `cfld --quick` for a temporary URL.",
    );
    return;
  }

  await runLogin();

  // The account may have no domain to authorize — the persistent-URL blocker.
  // Offer the instant path as an offramp instead of a dead end.
  if (!certHasZone(defaultCertPath())) {
    printZeroZoneGuidance();
    if (await askConfirm("Start a temporary quick tunnel now instead?")) {
      await quickCommand(flags);
      return;
    }
    throw new CfldError(
      "Your Cloudflare account has no domain yet, so a persistent URL isn't possible.",
      "Add a domain (see above), then run `cfld setup` again.",
    );
  }

  const zone = await askAuthorizedZone(knownZones);
  const certPath = importCert(zone);
  info(`Saved cert for ${zone}.`);

  await configureProject(flags, { zone, certPath, cwd });
  await offerGoLive(flags, zone);
}

/**
 * Friendly, up-front cloudflared check — replaces the lazy "not found" failure a
 * new user would otherwise hit deep in a run. On success, reports the version.
 */
export async function preflightCloudflared(): Promise<void> {
  try {
    const bin = await resolveBinary();
    const res = await exec(bin, ["--version"]);
    const version = (res.stdout.trim() || res.stderr.trim()).split("\n")[0];
    done(`cloudflared ready${version ? ` — ${version}` : ""}`);
  } catch {
    warn("cloudflared isn't installed, and the bundled binary couldn't load.");
    note(
      [
        "",
        "  Install it, then run `cfld setup` again:",
        "    macOS     brew install cloudflared",
        "    Linux     apt / dnf / pacman install cloudflared",
        "    Windows   winget install --id Cloudflare.cloudflared",
        "    Any OS    https://developers.cloudflare.com/tunnel/downloads/",
        "",
      ].join("\n"),
    );
    throw new CfldError(
      "cloudflared is required to continue.",
      "Install it (see above), or set CFLD_CLOUDFLARED to its path.",
    );
  }
}

/**
 * True only for a genuinely blank interactive first run, so `cfld` with nothing
 * configured routes into the wizard instead of a lazy failure chain. Deliberately
 * narrow: any prior auth (stored zone or zone-scoped default cert), an existing
 * project config, or an intent-bearing flag (--zone/--host/--quick) opts out.
 */
export function isBlankFirstRun(
  flags: CliFlags,
  cwd: string,
  interactive: boolean = isInteractive(),
): boolean {
  if (!interactive) return false;
  if (flags.zone || flags.host || flags.quick) return false;
  if (readProjectConfig(cwd)) return false;
  if (listStoredZones().length > 0) return false;
  if (certHasZone(defaultCertPath())) return false;
  return true;
}

/** Pick which authorized domain to use — select from known ones or type a new one. */
async function askAuthorizedZone(knownZones: string[]): Promise<string> {
  if (knownZones.length) {
    const picked = await askSelect<string>("Which domain did you authorize?", [
      ...knownZones.map((z) => ({ value: z, label: z })),
      { value: "__new__", label: "A different domain…" },
    ]);
    if (picked !== "__new__") return picked;
  }
  return normalizeZone(await askText("Which domain did you authorize?", "example.com"));
}

/** Offer to run the tunnel immediately, or leave the user with the next step. */
async function offerGoLive(flags: CliFlags, zone: string): Promise<void> {
  if (await askConfirm("Go live now?")) {
    await runCommand({ ...flags, zone });
  } else {
    note("Run `cfld` to go live.");
  }
}
