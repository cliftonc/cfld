import type { CliFlags } from "../cli.js";
import { detectDevPorts, findFreePort, waitForPort } from "../core/port.js";
import { startQuickTunnel, type QuickTunnel } from "../process/quick.js";
import {
  startChild,
  describeCommand,
  reapChild,
  type ManagedChild,
} from "../process/child.js";
import { scrapeMetrics } from "../process/ready.js";
import { formatLogLine } from "../process/logs.js";
import type { DashboardHandle } from "../ui/dashboard.js";
import { CfldError } from "../util/errors.js";
import { info, isInteractive, note, step, summaryBox, warn } from "../ui/output.js";

/**
 * Ephemeral quick tunnel — no cert, no domain, random URL. Shares the same live
 * ink dashboard as a persistent run (with background logs + live counters); the
 * only difference is an honest "temporary URL" framing.
 *
 * With `-- <cmd>` it also supervises your dev server, exactly like `cfld run`:
 * one lifecycle, one Ctrl-C, LIVE held until the port is actually listening.
 */
export async function quickCommand(flags: CliFlags): Promise<void> {
  const port = await resolvePort(flags);
  const target = `localhost:${port}`;
  const interactive = isInteractive() && !flags.noUi;
  const metricsPort = await findFreePort();
  const envKey = flags.envKey ?? "PUBLIC_URL";

  if (!interactive) step(`Starting an ephemeral tunnel to ${target}…`);

  let dashboard: DashboardHandle | undefined;
  let tunnel: QuickTunnel | undefined;
  let child: ManagedChild | undefined;
  let poll: ReturnType<typeof setInterval> | undefined;
  let shuttingDown = false;
  const childAbort = new AbortController();

  // Logs may arrive before the dashboard mounts (we need the URL first), so
  // buffer each stream and flush on mount — same pattern as the persistent run.
  const tunnelBuffer: string[] = [];
  const devBuffer: string[] = [];
  const emitLine = (line: string) => {
    const formatted = formatLogLine(line);
    if (!formatted) return;
    tunnelBuffer.push(formatted);
    if (dashboard) dashboard.log(formatted, "tunnel");
    else if (!interactive) process.stderr.write(formatted + "\n");
  };
  // Dev-server output is already the developer's own formatting — pass through.
  const emitDevLine = (line: string) => {
    if (line.trim() === "") return;
    devBuffer.push(line);
    if (dashboard) dashboard.log(line, "dev");
    else if (!interactive) process.stderr.write(line + "\n");
  };

  // Single teardown choke point — stops the dev server AND the tunnel, waiting
  // for the dev server's whole process group to die so nothing is orphaned.
  const shutdown = (opts: { reason?: string; code?: number } = {}) => {
    if (shuttingDown) return;
    shuttingDown = true;
    if (poll) clearInterval(poll);
    tunnel?.stop();
    dashboard?.stop();
    note(`\n${opts.reason ?? "Stopped ephemeral tunnel."}`);
    // Wait for the dev-server tree to be fully reaped before exiting.
    const finish = () => process.exit(opts.code ?? 0);
    if (child) reapChild(child).then(finish, finish);
    else finish();
  };

  tunnel = await startQuickTunnel(port, { metricsPort, onLine: emitLine });
  const url = tunnel.url;

  // Start the supervised dev server (if any), with the public URL in its env.
  if (flags.exec) {
    if (!interactive) step(`Starting \`${describeCommand(flags.exec)}\`…`);
    child = startChild({
      command: flags.exec,
      cwd: process.cwd(),
      env: flags.noEnv ? undefined : { [envKey]: url },
      onLine: (line) => emitDevLine(line),
      onExit: (code, signal) => {
        childAbort.abort();
        const how =
          code !== null ? `exited (code ${code})` : `was terminated${signal ? ` (${signal})` : ""}`;
        shutdown({
          reason: `Your dev command ${how} — stopping the ephemeral tunnel.`,
          code: code ?? 1,
        });
      },
    });
  }

  if (interactive) {
    const { startDashboard } = await import("../ui/dashboard.js");
    dashboard = startDashboard({
      url,
      target,
      tunnelName: "quick (ephemeral)",
      // Hold at WAITING until the dev server opens the port (if we're running one).
      status: child ? "waiting" : "live",
      connections: child ? 0 : 1,
      requests: 0,
      split: Boolean(flags.exec),
      devLabel: flags.exec ? describeCommand(flags.exec) : undefined,
      tunnelLogs: tunnelBuffer.slice(-200),
      devLogs: devBuffer.slice(-200),
      ephemeral: true,
    });
  }

  // Always own the shutdown signals (even under ink) so a real SIGINT/SIGTERM
  // routes through graceful teardown instead of terminating cfld and orphaning
  // the dev-server tree.
  process.once("SIGINT", () => shutdown());
  process.once("SIGTERM", () => shutdown());
  process.once("SIGHUP", () => shutdown());

  // Hold LIVE until the dev server is actually accepting connections.
  if (child) {
    if (!dashboard) step(`Waiting for your dev server on :${port}…`);
    const up = await waitForPort(port, { signal: childAbort.signal });
    if (shuttingDown) return; // the child died while we waited
    if (!up) warn(`Nothing is listening on :${port} yet — going live anyway.`);
    dashboard?.update({ status: "live", connections: 1 });
  }

  if (!dashboard) {
    summaryBox({
      url,
      target,
      tunnelName: "quick (ephemeral)",
      connections: 1,
      ephemeral: true,
    });
  }

  poll = setInterval(async () => {
    const m = await scrapeMetrics(metricsPort);
    if (m && dashboard) {
      dashboard.update({
        connections: m.connections || 1,
        requests: m.requests,
        avgLatencyMs: m.avgLatencyMs,
      });
    }
  }, dashboard ? 1000 : 15_000);
  poll.unref();

  if (dashboard) {
    await dashboard.waitUntilExit();
    shutdown();
  }
}

async function resolvePort(flags: CliFlags): Promise<number> {
  if (flags.port) return flags.port;
  // A supervised dev server isn't listening yet, so it can't be auto-detected.
  if (flags.exec) {
    throw new CfldError(
      "Specify the port your dev command will listen on.",
      "e.g. `cfld --quick 3000 -- next dev`",
    );
  }
  const detected = await detectDevPorts();
  if (detected.length >= 1) {
    info(`Detected a local server on port ${detected[0]}.`);
    return detected[0]!;
  }
  throw new CfldError(
    "No port specified and none detected.",
    "Pass a port, e.g. `cfld --quick 3000`.",
  );
}
