import type { CliFlags } from "../cli.js";
import { detectDevPorts, findFreePort } from "../core/port.js";
import { startQuickTunnel } from "../process/quick.js";
import { scrapeMetrics } from "../process/ready.js";
import { formatLogLine } from "../process/logs.js";
import type { DashboardHandle } from "../ui/dashboard.js";
import { CfldError } from "../util/errors.js";
import { info, isInteractive, note, step, summaryBox } from "../ui/output.js";

/**
 * Ephemeral quick tunnel — no cert, no domain, random URL. Shares the same live
 * ink dashboard as a persistent run (with background logs + live counters); the
 * only difference is an honest "temporary URL" framing.
 */
export async function quickCommand(flags: CliFlags): Promise<void> {
  const port = await resolvePort(flags);
  const target = `localhost:${port}`;
  const interactive = isInteractive();
  const metricsPort = await findFreePort();

  if (!interactive) step(`Starting an ephemeral tunnel to ${target}…`);

  // Logs may arrive before the dashboard mounts (we need the URL first), so
  // buffer them and flush on mount — same pattern as the persistent run.
  let dashboard: DashboardHandle | undefined;
  const logBuffer: string[] = [];
  const emitLine = (line: string) => {
    const formatted = formatLogLine(line);
    if (!formatted) return;
    logBuffer.push(formatted);
    if (dashboard) dashboard.log(formatted);
    else if (!interactive) process.stderr.write(formatted + "\n");
  };

  const tunnel = await startQuickTunnel(port, { metricsPort, onLine: emitLine });

  if (interactive) {
    const { startDashboard } = await import("../ui/dashboard.js");
    dashboard = startDashboard({
      url: tunnel.url,
      target,
      tunnelName: "quick (ephemeral)",
      status: "live",
      connections: 1,
      requests: 0,
      logs: logBuffer.slice(-12),
      ephemeral: true,
    });
  } else {
    summaryBox({
      url: tunnel.url,
      target,
      tunnelName: "quick (ephemeral)",
      connections: 1,
      ephemeral: true,
    });
  }

  const poll = setInterval(async () => {
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

  const stop = () => {
    clearInterval(poll);
    tunnel.stop();
    dashboard?.stop();
    note("\nStopped ephemeral tunnel.");
    setTimeout(() => process.exit(0), 100).unref();
  };

  if (dashboard) {
    await dashboard.waitUntilExit();
    stop();
  } else {
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
  }
}

async function resolvePort(flags: CliFlags): Promise<number> {
  if (flags.port) return flags.port;
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
