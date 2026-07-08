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
import { findFreePort, waitForPort } from "../core/port.js";
import { readProjectConfig, writeProjectConfig } from "../core/project-config.js";
import { listEntries } from "../core/registry.js";
import { upsertEnv } from "../core/env-writer.js";
import { startRunner, type Runner } from "../process/runner.js";
import {
  startChild,
  describeCommand,
  reapChild,
  type ManagedChild,
  type DevCommand,
} from "../process/child.js";
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

  // With a supervised dev command the port isn't listening yet, so it can't be
  // auto-detected — require it up front.
  if (
    flags.exec &&
    flags.port === undefined &&
    config?.port === undefined &&
    !config?.routes?.length
  ) {
    throw new CfldError(
      "Specify the port your dev command will listen on.",
      "e.g. `cfld 3000 -- next dev`",
    );
  }

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

  await launch(result, {
    cwd,
    envKey,
    noEnv: flags.noEnv,
    noUi: flags.noUi,
    port: primary.port,
    exec: flags.exec,
  });
}

export async function launch(
  result: Awaited<ReturnType<typeof reconcile>>,
  ctx: {
    cwd: string;
    envKey: string;
    noEnv?: boolean;
    noUi?: boolean;
    port: number;
    exec?: DevCommand;
  },
): Promise<void> {
  const metricsPort = await findFreePort();
  const url = `https://${result.hostname}`;
  const target = `localhost:${ctx.port}`;
  const interactive = isInteractive() && !ctx.noUi;

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
      split: Boolean(ctx.exec),
      devLabel: ctx.exec ? describeCommand(ctx.exec) : undefined,
      tunnelLogs: [],
      devLogs: [],
    });
  } else {
    step("Connecting to Cloudflare edge…");
  }

  const emitLine = (line: string) => {
    const formatted = formatLogLine(line);
    if (!formatted) return;
    if (dashboard) dashboard.log(formatted, "tunnel");
    else process.stderr.write(formatted + "\n");
  };

  // Dev-server output is already the developer's own formatting — pass it
  // through verbatim (unlike cloudflared's structured lines) into its own pane.
  const emitDevLine = (line: string) => {
    if (line.trim() === "") return;
    if (dashboard) dashboard.log(line, "dev");
    else process.stderr.write(line + "\n");
  };

  let runner: Runner | undefined;
  let child: ManagedChild | undefined;
  let poll: ReturnType<typeof setInterval> | undefined;
  let shuttingDown = false;
  const childAbort = new AbortController();

  // Single choke point for teardown — stops the dev server AND the tunnel, but
  // never deletes the tunnel/DNS. `code` propagates a crashed child's status.
  // We wait for the dev server's whole process group to actually die before
  // exiting, so no workers are left orphaned.
  const shutdown = (opts: { reason?: string; code?: number } = {}) => {
    if (shuttingDown) return;
    shuttingDown = true;
    if (poll) clearInterval(poll);
    runner?.stop();
    dashboard?.stop();
    if (opts.reason) note(`\n${opts.reason}`);
    // Wait for the dev-server tree to be fully reaped BEFORE exiting — reapChild
    // keeps the event loop alive until it's gone, so we never orphan workers.
    const finish = () => process.exit(opts.code ?? 0);
    if (child) reapChild(child).then(finish, finish);
    else finish();
  };

  runner = await startRunner({
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
      warn(message);
      shutdown({ code: 1 });
    },
  });

  // Start the supervised dev server (if any) so it boots while the tunnel
  // connects. It gets the public URL in its environment immediately.
  if (ctx.exec) {
    if (!dashboard) step(`Starting \`${describeCommand(ctx.exec)}\`…`);
    child = startChild({
      command: ctx.exec,
      cwd: ctx.cwd,
      env: ctx.noEnv ? undefined : { [ctx.envKey]: url },
      onLine: (line) => emitDevLine(line),
      onExit: (code, signal) => {
        childAbort.abort();
        const how =
          code !== null ? `exited (code ${code})` : `was terminated${signal ? ` (${signal})` : ""}`;
        shutdown({
          reason: `Your dev command ${how} — stopping. Your tunnel URL is preserved.`,
          code: code ?? 1,
        });
      },
    });
  }

  // Always own the shutdown signals — even in the dashboard, where ink's raw
  // mode usually turns Ctrl-C into a keypress. If a real SIGINT/SIGTERM ever
  // reaches us (some terminals, `kill`, an editor's stop button), the default
  // action would terminate cfld instantly and orphan the whole dev-server tree.
  // Installing a handler routes it through the same graceful teardown instead.
  process.once("SIGINT", () =>
    shutdown({ reason: "Stopping — your URL is preserved. Re-run `cfld`." }),
  );
  process.once("SIGTERM", () =>
    shutdown({ reason: "Stopping — your URL is preserved." }),
  );
  // SIGHUP: the terminal window was closed. Reap the dev tree too, don't orphan.
  process.once("SIGHUP", () => shutdown({ reason: "Terminal closed — stopping." }));

  const ready = await waitForReady(metricsPort).catch((err) => {
    child?.stop();
    runner?.stop();
    dashboard?.stop();
    throw new CfldError(
      "The tunnel did not connect.",
      err instanceof Error ? err.message : undefined,
    );
  });

  // Hold LIVE until the dev server is actually accepting connections, so the
  // URL never shows a 502 the moment it's revealed.
  if (child && !shuttingDown) {
    if (dashboard) dashboard.update({ status: "waiting", connections: ready.connections });
    else step(`Waiting for your dev server on :${ctx.port}…`);
    const up = await waitForPort(ctx.port, { signal: childAbort.signal });
    if (shuttingDown) return; // the child died while we waited
    if (!up) warn(`Nothing is listening on :${ctx.port} yet — going live anyway.`);
  }

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
  poll = setInterval(async () => {
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
    shutdown({ reason: "Stopping — your URL is preserved. Re-run `cfld` to resume." });
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
