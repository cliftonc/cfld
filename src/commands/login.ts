import { spawn } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, renameSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { CliFlags } from "../cli.js";
import { resolveBinary } from "../core/cloudflared.js";
import { importCert, storedCertForZone, storedZoneClaiming } from "../core/cert-store.js";
import { certExists, certHasZone, certZoneName } from "../core/cert.js";
import { certPathForZone, cfldDir, defaultCertPath } from "../util/paths.js";
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
  const haveCert = certExists(defaultCertPath());
  let certPath = defaultCertPath();
  if (flags.reauth || !haveCert) {
    certPath = await runLogin();
  } else {
    info("A Cloudflare certificate already exists. Use --reauth to authorize another domain.");
  }

  try {
    if (!certHasZone(certPath)) {
      printZeroZoneGuidance();
      throw new CfldError(
        "Logged in, but your account has no domain to authorize.",
        "Add a domain (see above), then run `cfld login --reauth`.",
      );
    }
    const zone = await saveCert(flags.zone ? normalizeZone(flags.zone) : undefined, certPath);
    done(`Saved cert for ${zone}. You're ready — run \`cfld\`.`);
  } finally {
    discardLoginCert(certPath);
  }
}

/**
 * Run the browser auth flow: `cloudflared tunnel login`, forcing a *fresh*
 * login. cloudflared refuses to run while `~/.cloudflared/cert.pem` exists, so
 * any existing cert is moved aside first and restored afterwards — otherwise the
 * old cert would be mistaken for the new one. Returns the path of the new cert:
 * the default path on a first login, else a temp file (see `discardLoginCert`).
 */
export async function runLogin(): Promise<string> {
  const bin = await resolveBinary();
  const def = defaultCertPath();
  const backup = existsSync(def) ? `${def}.cfld-backup` : undefined;
  if (backup) renameSync(def, backup);

  try {
    step("Opening your browser to authorize with Cloudflare (no API token needed)…");
    note("  Pick the domain you want to use. Waiting for you to finish…");

    await new Promise<void>((resolve, reject) => {
      const child = spawn(bin, ["tunnel", "login"], { stdio: "inherit" });
      child.on("error", reject);
      child.on("exit", (code) => {
        if (code === 0 || existsSync(def)) resolve();
        else reject(new CfldError("Cloudflare login did not complete.", "Re-run `cfld login`."));
      });
    });

    if (!existsSync(def)) {
      throw new CfldError(
        "Login finished but no certificate was written.",
        "Re-run `cfld login` and complete the browser step.",
      );
    }
    if (!backup) return def;
    mkdirSync(cfldDir(), { recursive: true });
    const fresh = join(cfldDir(), "login-cert.tmp");
    copyFileSync(def, fresh);
    rmSync(def);
    return fresh;
  } finally {
    if (backup) renameSync(backup, def);
  }
}

/** Remove the temp cert `runLogin` returns (a no-op for the default cert). */
export function discardLoginCert(certPath: string): void {
  if (certPath !== defaultCertPath()) rmSync(certPath, { force: true });
}

/**
 * Store `certPath` under its zone, checking the cert really is for that zone.
 * The zone name comes from the cert itself where possible; `expected` (what the
 * user asked for) must match it. Offline, fall back to rejecting a cert whose
 * zoneID is already stored under a different name. Returns the zone saved.
 */
export async function saveCert(expected: string | undefined, certPath: string): Promise<string> {
  const actual = await certZoneName(certPath);
  if (expected && actual && actual !== expected) {
    throw new CfldError(
      `You authorized ${actual} in the browser, not ${expected}.`,
      `Run \`cfld login --reauth --zone ${expected}\` and pick ${expected} this time.`,
    );
  }

  let zone = expected ?? actual;
  if (!zone) {
    if (!isInteractive()) {
      throw new CfldError(
        "Pass --zone to record which domain this cert is for.",
        "e.g. `cfld login --zone example.com`",
      );
    }
    zone = normalizeZone(await askText("Which domain did you authorize?", "example.com"));
  }

  const clash = storedZoneClaiming(certPath, zone);
  if (clash && !actual) {
    throw new CfldError(
      `That cert is for the same domain as your saved ${clash} cert, not ${zone}.`,
      `Run \`cfld login --reauth --zone ${zone}\` and pick ${zone} in the browser.`,
    );
  }

  importCert(zone, certPath);
  return zone;
}

/**
 * Ensure a usable cert exists for `zone`, running login if needed and copying
 * the result into the per-zone store. Returns the cert path to use.
 */
export async function ensureCert(
  zone: string,
  opts: { interactive: boolean } = { interactive: true },
): Promise<string> {
  const usable = await usableCert(zone);
  if (usable) return usable;

  if (!opts.interactive) {
    throw new CfldError(
      `No Cloudflare certificate found for ${zone}.`,
      `Run \`cfld login --reauth --zone ${zone}\` first (needs a browser), or set TUNNEL_ORIGIN_CERT.`,
    );
  }

  info(`No certificate for ${zone} yet — authorize it in the browser.`);
  const fresh = await runLogin();
  try {
    // The account may have no domain to authorize — the persistent-URL blocker.
    if (!certHasZone(fresh)) {
      printZeroZoneGuidance();
      throw new CfldError(
        "Your Cloudflare account has no domain yet, so a persistent URL isn't possible.",
        "Add a domain (see above), then re-run. Or use `cfld --quick` for a throwaway URL now.",
      );
    }
    await saveCert(zone, fresh);
  } finally {
    discardLoginCert(fresh);
  }
  info(`Saved cert for ${zone}.`);
  return certPathForZone(zone);
}

/**
 * An existing cert that is actually for `zone`, or undefined. A stored cert is
 * trusted unless its zoneID is shared with another stored zone (a sign it was
 * copied under the wrong name), in which case it is checked against the API and
 * dropped if wrong. The default cert is adopted into the store only once
 * confirmed to be for `zone`; offline, the old single-domain fallback applies.
 */
async function usableCert(zone: string): Promise<string | undefined> {
  const stored = storedCertForZone(zone);
  if (stored) {
    if (!storedZoneClaiming(stored, zone)) return stored;
    const actual = await certZoneName(stored);
    if (!actual || actual === zone) return stored;
    warn(`The saved cert for ${zone} is actually for ${actual} — discarding it.`);
    rmSync(stored);
  }

  const def = defaultCertPath();
  if (!certHasZone(def)) return undefined;
  const actual = await certZoneName(def);
  if (actual === zone) return importCert(zone, def);
  if (!actual && !storedZoneClaiming(def, zone)) return def;
  return undefined;
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
