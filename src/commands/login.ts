import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import type { CliFlags } from "../cli.js";
import { resolveBinary } from "../core/cloudflared.js";
import { importCert, resolveCert } from "../core/cert-store.js";
import { certExists, certHasZone } from "../core/cert.js";
import { defaultCertPath } from "../util/paths.js";
import { CfldError } from "../util/errors.js";
import { askText } from "../ui/prompts.js";
import { done, info, isInteractive, note, step, warn } from "../ui/output.js";

/** Normalize user domain input: strip scheme/path, lowercase. */
export function normalizeZone(input: string): string {
  return input
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, "")
    .replace(/\/.*$/, "");
}

/**
 * `cfld login [--reauth]` — authorize with Cloudflare in the browser and record
 * the resulting cert under its domain in the per-zone store.
 */
export async function loginCommand(flags: CliFlags): Promise<void> {
  const interactive = isInteractive();
  const haveCert = certExists(defaultCertPath());

  if (flags.reauth || !haveCert) {
    await runLogin();
  } else {
    info("A Cloudflare certificate already exists. Use --reauth to authorize another domain.");
  }

  if (!certHasZone(defaultCertPath())) {
    printZeroZoneGuidance();
    throw new CfldError(
      "Logged in, but your account has no domain to authorize.",
      "Add a domain (see above), then run `cfld login --reauth`.",
    );
  }

  let zone = flags.zone ? normalizeZone(flags.zone) : undefined;
  if (!zone) {
    if (!interactive) {
      throw new CfldError(
        "Pass --zone to record which domain this cert is for.",
        "e.g. `cfld login --zone example.com`",
      );
    }
    zone = normalizeZone(await askText("Which domain did you authorize?", "example.com"));
  }

  importCert(zone);
  done(`Saved cert for ${zone}. You're ready — run \`cfld\`.`);
}

/**
 * Run the browser auth flow: `cloudflared tunnel login`. Inherits stdio so the
 * browser opens and the user picks a domain. Resolves once cert.pem appears.
 */
export async function runLogin(): Promise<void> {
  const bin = await resolveBinary();
  step("Opening your browser to authorize with Cloudflare (no API token needed)…");
  note("  Pick the domain you want to use. Waiting for you to finish…");

  await new Promise<void>((resolve, reject) => {
    const child = spawn(bin, ["tunnel", "login"], { stdio: "inherit" });
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0 || existsSync(defaultCertPath())) resolve();
      else reject(new CfldError("Cloudflare login did not complete.", "Re-run `cfld login`."));
    });
  });

  if (!existsSync(defaultCertPath())) {
    throw new CfldError(
      "Login finished but no certificate was written.",
      "Re-run `cfld login` and complete the browser step.",
    );
  }
}

/**
 * Ensure a usable cert exists for `zone`, running login if needed and copying
 * the result into the per-zone store. Returns the cert path to use.
 */
export async function ensureCert(
  zone: string,
  opts: { interactive: boolean } = { interactive: true },
): Promise<string> {
  const existing = resolveCert(zone);
  if (existing) return existing;

  if (!opts.interactive) {
    throw new CfldError(
      `No Cloudflare certificate found for ${zone}.`,
      "Run `cfld login` first (needs a browser), or set TUNNEL_ORIGIN_CERT.",
    );
  }

  await runLogin();

  // The account may have no domain to authorize — the persistent-URL blocker.
  if (!certHasZone(defaultCertPath())) {
    printZeroZoneGuidance();
    throw new CfldError(
      "Your Cloudflare account has no domain yet, so a persistent URL isn't possible.",
      "Add a domain (see above), then re-run. Or use `cfld --quick` for a throwaway URL now.",
    );
  }

  const stored = importCert(zone);
  info(`Saved cert for ${zone}.`);
  return stored;
}

/** Honest guidance for the no-domain case — we cannot automate registrar changes. */
export function printZeroZoneGuidance(): void {
  warn("cfld can't create a permanent custom URL yet — your account has no domains.");
  note(
    [
      "",
      "  Option 1 — Add a domain you own (~5 min + DNS propagation)",
      "    1. Own a domain at any registrar.",
      "    2. Cloudflare dashboard → Add a Site → enter the domain.",
      "    3. At your registrar, switch the nameservers to the ones Cloudflare shows.",
      "       (we can't do this step for you — it's on the registrar)",
      "    4. Wait for the zone to go Active, then: cfld login --reauth && cfld",
      "       https://dash.cloudflare.com/?to=/:account/add-site",
      "",
      "  Option 2 — Buy through Cloudflare Registrar (nameservers auto-configured)",
      "       https://dash.cloudflare.com/?to=/:account/domains/register",
      "",
      "  Option 3 — Just need a URL right now? (ephemeral, not persistent)",
      "       cfld --quick",
      "",
    ].join("\n"),
  );
}
