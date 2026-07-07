import { join } from "node:path";
import type { CliFlags } from "../cli.js";
import { reconcile } from "../core/state-machine.js";
import { listStoredZones } from "../core/cert-store.js";
import {
  buildHostname,
  deriveSlug,
  slugify,
  tunnelNameForSlug,
  zoneForHostname,
} from "../core/hostname.js";
import type { IngressRoute } from "../core/config-file.js";
import { detectDevPorts } from "../core/port.js";
import { findFreePort } from "../core/port.js";
import { readProjectConfig, writeProjectConfig } from "../core/project-config.js";
import { listEntries } from "../core/registry.js";
import { upsertEnv } from "../core/env-writer.js";
import { startRunner } from "../process/runner.js";
import { waitForReady, scrapeMetrics } from "../process/ready.js";
import { formatLogLine } from "../process/logs.js";
import type { DashboardHandle } from "../ui/dashboard.js";
import { ensureCert } from "./login.js";
import { CfldError } from "../util/errors.js";
import { ensureGitignored } from "../util/gitignore.js";
import { askConfirm, askSelect, askText } from "../ui/prompts.js";
import {
  done,
  info,
  isInteractive,
  note,
  step,
  summaryBox,
  warn,
} from "../ui/output.js";

export async function runCommand(flags: CliFlags): Promise<void> {
  const cwd = process.cwd();
  const interactive = isInteractive();
  const config = readProjectConfig(cwd);

  const slug = deriveSlug(cwd, flags.name ?? config?.name);
  const tunnelName = tunnelNameForSlug(slug);
  const knownZones = Array.from(
    new Set([...listStoredZones(), ...listEntries().map((e) => e.zone)]),
  );

  const zone = await resolveZone(flags, config?.zone, knownZones, interactive);
  const envKey = flags.envKey ?? config?.envKey ?? "PUBLIC_URL";

  // Build the route list — multiple from an authored `routes` config, else one.
  let routes: IngressRoute[];
  if (config?.routes?.length && !flags.host && !flags.port) {
    routes = config.routes.map((r) => ({
      hostname: r.host ?? buildHostname(r.name ? slugify(r.name) : slug, zone),
      port: r.port,
      path: r.path,
    }));
  } else {
    const port = await resolvePort(flags, config?.port, interactive);
    const hostname = flags.host ?? config?.hostname ?? buildHostname(slug, zone);
    routes = [{ hostname, port }];
  }
  const primary = routes[0]!;

  // Ensure a per-zone cert (may trigger browser login on first use).
  const certPath = await ensureCert(zone, { interactive });

  // Reconcile Cloudflare + local state — reuse or create, never tear down.
  const result = await reconcile(
    { slug, tunnelName, zone, certPath, routes, projectDir: cwd, force: flags.force },
    {
      onStep: (s) => step(s),
      confirmOverwrite: interactive
        ? (h, t) => askConfirm(`${h} already points to ${t}. Repoint it to this tunnel?`)
        : undefined,
    },
  );
  done(result.created ? `Created tunnel ${tunnelName}` : `Reusing tunnel ${tunnelName}`);
  for (const r of routes) done(`DNS ${r.hostname} → :${r.port}`);

  // Persist the project pointer, and keep the machine-local cache out of git.
  writeProjectConfig(cwd, {
    name: slug,
    zone,
    uuid: result.uuid,
    hostname: primary.hostname,
    port: primary.port,
    envKey,
  });
  if (ensureGitignored(cwd, ".cfld.json")) info("Added .cfld.json to .gitignore.");

  await launch(result, { cwd, envKey, noEnv: flags.noEnv, port: primary.port });
}

export async function launch(
  result: Awaited<ReturnType<typeof reconcile>>,
  ctx: { cwd: string; envKey: string; noEnv?: boolean; port: number },
): Promise<void> {
  const metricsPort = await findFreePort();
  const url = `https://${result.hostname}`;
  const target = `localhost:${ctx.port}`;
  const interactive = isInteractive();

  // Interactive → mount the ink dashboard (lazy chunk). Non-TTY → linear.
  let dashboard: DashboardHandle | undefined;
  if (interactive) {
    const { startDashboard } = await import("../ui/dashboard.js");
    dashboard = startDashboard({
      url,
      target,
      tunnelName: result.tunnelName,
      status: "connecting",
      connections: 0,
      requests: 0,
      logs: [],
    });
  } else {
    step("Connecting to Cloudflare edge…");
  }

  const emitLine = (line: string) => {
    const formatted = formatLogLine(line);
    if (!formatted) return;
    if (dashboard) dashboard.log(formatted);
    else process.stderr.write(formatted + "\n");
  };

  let stopping = false;
  const runner = await startRunner({
    configPath: result.configPath,
    tunnelName: result.tunnelName,
    certPath: result.certPath,
    metricsPort,
    onLine: (line) => emitLine(line),
    onStatus: (status) => {
      if (status === "reconnecting") dashboard?.update({ status: "reconnecting" });
      else if (status === "connecting" && !dashboard) note("Reconnecting…");
    },
    onFatal: (message) => {
      dashboard?.stop();
      warn(message);
      process.exit(1);
    },
  });

  const stop = (reason: string) => {
    if (stopping) return;
    stopping = true;
    runner.stop();
    dashboard?.stop();
    note(`\n${reason}`);
    setTimeout(() => process.exit(0), 100).unref();
  };

  // Non-TTY: our own SIGINT handler. TTY: ink owns Ctrl-C (see waitUntilExit).
  if (!dashboard) {
    process.once("SIGINT", () => stop("Stopping — your URL is preserved. Re-run `cfld`."));
    process.once("SIGTERM", () => stop("Stopping — your URL is preserved."));
  }

  const ready = await waitForReady(metricsPort).catch((err) => {
    runner.stop();
    dashboard?.stop();
    throw new CfldError(
      "The tunnel did not connect.",
      err instanceof Error ? err.message : undefined,
    );
  });

  if (!ctx.noEnv) {
    const { changed } = upsertEnv(join(ctx.cwd, ".env"), ctx.envKey, url);
    if (changed && !dashboard) info(`Wrote ${ctx.envKey}=${url} to .env`);
  }

  if (dashboard) {
    dashboard.update({ status: "live", connections: ready.connections });
  } else {
    summaryBox({ url, target, tunnelName: result.tunnelName, connections: ready.connections });
  }

  // Poll metrics to keep the live counters fresh (fast in the dashboard).
  const poll = setInterval(async () => {
    const m = await scrapeMetrics(metricsPort);
    if (m && dashboard) {
      dashboard.update({
        connections: m.connections || ready.connections,
        requests: m.requests,
        avgLatencyMs: m.avgLatencyMs,
      });
    }
  }, dashboard ? 1000 : 15_000);
  poll.unref();

  // In the dashboard, ink resolves waitUntilExit on Ctrl-C — then we stop
  // gracefully, preserving the tunnel + DNS.
  if (dashboard) {
    await dashboard.waitUntilExit();
    clearInterval(poll);
    stop("Stopping — your URL is preserved. Re-run `cfld` to resume.");
  }
}

async function resolveZone(
  flags: CliFlags,
  configZone: string | undefined,
  knownZones: string[],
  interactive: boolean,
): Promise<string> {
  const fromHost = flags.host
    ? zoneForHostname(flags.host, knownZones)
    : undefined;
  const zone =
    flags.zone ??
    fromHost ??
    configZone ??
    (knownZones.length === 1 ? knownZones[0] : undefined);
  if (zone) return zone;

  if (!interactive) {
    throw new CfldError(
      "Could not determine which Cloudflare domain to use.",
      "Pass --zone example.com (or --host app.example.com).",
    );
  }
  const answer = await askText(
    "Which domain on Cloudflare should cfld use?",
    "example.com",
  );
  return answer.trim().replace(/^https?:\/\//, "").replace(/\/.*$/, "");
}

async function resolvePort(
  flags: CliFlags,
  configPort: number | undefined,
  interactive: boolean,
): Promise<number> {
  if (flags.port) return flags.port;
  if (configPort) return configPort;

  const detected = await detectDevPorts();
  if (detected.length === 1) {
    info(`Detected a local server on port ${detected[0]}.`);
    return detected[0]!;
  }
  if (detected.length > 1 && interactive) {
    return askSelect(
      "Multiple local servers detected — which port?",
      detected.map((p) => ({ value: p, label: String(p) })),
    );
  }
  if (interactive) {
    const answer = await askText("Which local port is your dev server on?", "3000");
    const n = Number(answer.trim());
    if (!Number.isInteger(n) || n <= 0) {
      throw new CfldError(`"${answer}" is not a valid port.`);
    }
    return n;
  }
  throw new CfldError(
    "No local port specified and none could be detected.",
    "Pass a port, e.g. `cfld 3000`.",
  );
}
