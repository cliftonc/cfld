import React from "react";
import { Box, render, Text } from "ink";

/**
 * The ink live run dashboard — a full-height view: a status panel pinned to the
 * top, log panes filling the rest. When a dev command is being supervised the
 * logs split into two columns (your dev server on the left, the tunnel on the
 * right) so the two streams stop interleaving.
 *
 * This whole module is dynamically imported (a lazy chunk), so ink/react never
 * load on the `--quick`/CI paths. State lives outside React in a plain object;
 * every update re-renders via ink's `rerender`.
 */
export type Status = "connecting" | "waiting" | "live" | "reconnecting";

export type LogSource = "tunnel" | "dev";

export interface DashboardState {
  url: string;
  target: string;
  tunnelName: string;
  status: Status;
  connections: number;
  requests: number;
  avgLatencyMs?: number;
  /** Ephemeral (quick) tunnels get an honest placeholder/footer. */
  ephemeral?: boolean;
  /** True when a dev command is supervised — splits the logs into two columns. */
  split?: boolean;
  /** Label for the dev-server column (the command being run). */
  devLabel?: string;
  tunnelLogs: string[];
  devLogs: string[];
}

/** Keep plenty of scrollback in memory; render only what fits. */
const MAX_BUFFER = 1000;
/** Rows consumed by the bordered status panel (3 lines + 2 borders). */
const HEADER_ROWS = 5;

function statusDot(status: Status): React.ReactElement {
  switch (status) {
    case "live":
      return <Text color="green">● LIVE</Text>;
    case "waiting":
      return <Text color="yellow">◌ WAITING</Text>;
    case "reconnecting":
      return <Text color="yellow">◌ RECONNECTING</Text>;
    default:
      return <Text color="cyan">◌ CONNECTING</Text>;
  }
}

function Header(state: DashboardState): React.ReactElement {
  const latency =
    state.avgLatencyMs !== undefined ? `  ⚡ ${state.avgLatencyMs}ms avg` : "";
  return (
    <Box flexDirection="column" borderStyle="round" borderColor="cyan" paddingX={1}>
      <Box>
        {statusDot(state.status)}
        <Text> </Text>
        <Text color="cyan" bold>
          {state.url}
        </Text>
      </Box>
      <Box>
        <Text dimColor>→ {state.target}</Text>
        <Text dimColor>
          {"   "}
          {state.connections} edge conns
        </Text>
      </Box>
      <Box>
        <Text dimColor>
          ↑ {state.requests} reqs{latency}
        </Text>
        <Text dimColor>
          {"   "}
          {state.ephemeral ? "ephemeral · Ctrl-C stops" : "Ctrl-C stops · URL preserved"}
        </Text>
      </Box>
    </Box>
  );
}

function LogColumn({
  title,
  titleColor,
  lines,
  rows,
  placeholder,
  divider,
}: {
  title?: string;
  titleColor?: string;
  lines: string[];
  rows: number;
  placeholder: string;
  divider?: boolean;
}): React.ReactElement {
  return (
    <Box
      flexDirection="column"
      flexGrow={1}
      flexShrink={1}
      flexBasis={0}
      paddingLeft={divider ? 1 : 0}
      borderStyle={divider ? "single" : undefined}
      borderColor="gray"
      borderTop={false}
      borderBottom={false}
      borderRight={false}
      borderLeft={Boolean(divider)}
    >
      {title ? (
        <Text color={titleColor} bold wrap="truncate-end">
          {title}
        </Text>
      ) : null}
      {/* Pin logs to the bottom so newest lines rise like a real tail. */}
      <Box flexDirection="column" flexGrow={1} justifyContent="flex-end" overflow="hidden">
        {lines.length === 0 ? (
          <Text dimColor>{placeholder}</Text>
        ) : (
          lines.slice(-rows).map((line, i) => (
            <Text key={i} wrap="truncate-end">
              {line}
            </Text>
          ))
        )}
      </Box>
    </Box>
  );
}

function Dashboard(state: DashboardState): React.ReactElement {
  const termRows = process.stdout.rows || 24;
  const titleRows = state.split ? 1 : 0;
  const logRows = Math.max(3, termRows - HEADER_ROWS - titleRows - 1);

  return (
    <Box flexDirection="column" height={termRows} overflow="hidden">
      <Header {...state} />
      {state.split ? (
        <Box flexGrow={1} flexDirection="row" paddingX={1} paddingTop={1}>
          <LogColumn
            title={state.devLabel ?? "dev server"}
            titleColor="cyan"
            lines={state.devLogs}
            rows={logRows}
            placeholder="waiting for dev-server output…"
          />
          <LogColumn
            title="tunnel"
            titleColor="blue"
            lines={state.tunnelLogs}
            rows={logRows}
            placeholder="waiting for tunnel activity…"
            divider
          />
        </Box>
      ) : (
        <Box flexGrow={1} paddingX={1} paddingTop={1}>
          <LogColumn
            lines={state.tunnelLogs}
            rows={logRows}
            placeholder={
              state.ephemeral
                ? "waiting for traffic… (Ctrl-C stops; this URL is temporary)"
                : "waiting for traffic… (Ctrl-C stops; your URL is preserved)"
            }
          />
        </Box>
      )}
    </Box>
  );
}

export interface DashboardHandle {
  update(partial: Partial<DashboardState>): void;
  log(line: string, source?: LogSource): void;
  /** Resolves when the user exits (Ctrl-C). */
  waitUntilExit(): Promise<void>;
  stop(): void;
}

// Alternate screen buffer — a separate, scrollback-free canvas (like vim/less).
// A full-height view in the *normal* buffer leaves artifacts on resize because
// ink's frame diff is computed against a now-stale line count; on the alt screen
// we own the whole canvas and can clear it outright, so resizes stay clean.
const ENTER_ALT_SCREEN = "\x1b[?1049h";
const LEAVE_ALT_SCREEN = "\x1b[?1049l";

export function startDashboard(initial: DashboardState): DashboardHandle {
  const state: DashboardState = {
    ...initial,
    tunnelLogs: [...initial.tunnelLogs],
    devLogs: [...initial.devLogs],
  };

  process.stdout.write(ENTER_ALT_SCREEN);
  const instance = render(<Dashboard {...state} />, {
    stdout: process.stdout,
    // We drive graceful shutdown ourselves; ink's Ctrl-C simply resolves
    // waitUntilExit, and the caller then stops the runner (preserving state).
    exitOnCtrlC: true,
  });
  const rerender = () => instance.rerender(<Dashboard {...state} />);

  let altActive = true;
  const leaveAltScreen = () => {
    if (!altActive) return;
    altActive = false;
    process.stdout.write(LEAVE_ALT_SCREEN);
  };

  // On resize, wipe ink's stale frame before repainting at the new dimensions.
  const onResize = () => {
    instance.clear();
    rerender();
  };
  process.stdout.on("resize", onResize);
  // Belt-and-braces: restore the normal buffer even on a hard exit.
  process.once("exit", leaveAltScreen);

  return {
    update(partial) {
      Object.assign(state, partial);
      rerender();
    },
    log(line, source = "tunnel") {
      if (source === "dev") {
        state.devLogs = [...state.devLogs, line].slice(-MAX_BUFFER);
      } else {
        state.tunnelLogs = [...state.tunnelLogs, line].slice(-MAX_BUFFER);
      }
      rerender();
    },
    waitUntilExit() {
      return instance.waitUntilExit();
    },
    stop() {
      process.stdout.off("resize", onResize);
      process.removeListener("exit", leaveAltScreen);
      instance.unmount();
      leaveAltScreen();
    },
  };
}
