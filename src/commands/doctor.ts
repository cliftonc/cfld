import pc from "picocolors";
import { resolveBinary } from "../core/cloudflared.js";
import { exec } from "../util/exec.js";
import { listStoredZones } from "../core/cert-store.js";
import { certExists, certHasZone, certZoneName } from "../core/cert.js";
import { listEntries } from "../core/registry.js";
import { certPathForZone, defaultCertPath } from "../util/paths.js";

/** Diagnostics: binary, certs, registry — a quick "is my setup healthy?" check. */
export async function doctorCommand(): Promise<void> {
  const ok = pc.green("✔");
  const bad = pc.red("✖");
  const out = (s: string) => process.stdout.write(s + "\n");

  out(pc.bold("\n  cfld doctor\n"));

  // cloudflared binary
  try {
    const bin = await resolveBinary();
    const res = await exec(bin, ["--version"]);
    out(`  ${ok} cloudflared: ${res.stdout.trim() || bin}`);
  } catch {
    out(`  ${bad} cloudflared not found (install with \`brew install cloudflared\`)`);
  }

  // Default cert
  const defCert = defaultCertPath();
  if (certExists(defCert)) {
    out(
      `  ${ok} default cert: ${defCert} ${
        certHasZone(defCert) ? pc.dim("(zone-scoped)") : pc.yellow("(no zone!)")
      }`,
    );
  } else {
    out(`  ${pc.dim("·")} no default cert (run \`cfld login\`)`);
  }

  // Per-zone cert store
  const zones = listStoredZones();
  if (zones.length) out(`  ${ok} cert store: ${zones.join(", ")}`);
  else out(`  ${pc.dim("·")} cert store empty`);

  // Each stored cert must actually be for the zone it's filed under.
  for (const zone of zones) {
    const actual = await certZoneName(certPathForZone(zone));
    if (actual && actual !== zone) {
      out(
        `  ${bad} ${zone}.pem is really a cert for ${actual} — fix with \`cfld login --reauth --zone ${zone}\``,
      );
    }
  }

  // Registry
  const entries = listEntries();
  out(`  ${ok} registry: ${entries.length} tunnel(s)`);
  out("");
}
