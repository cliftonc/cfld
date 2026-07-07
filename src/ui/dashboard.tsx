import React from "react";
import { Box, render, Text } from "ink";

/**
 * The ink live run dashboard — a header panel over a tailing log pane. This
 * whole module is dynamically imported (a lazy chunk), so ink/react never load
 * on the `--quick`/CI paths.
 *
 * State lives outside React in a plain object; every update re-renders via
 * ink's `rerender`. Simpler than hooks for an externally-driven view.
 */
export type Status = "connecting" | "live" | "reconnecting";

export interface DashboardState {
  url: string;
  target: string;
  tunnelName: string;
  status: Status;
  connections: number;
  requests: number;
  avgLatencyMs?: number;
  logs: string[];
  /** Ephemeral (quick) tunnels get an honest placeholder/footer. */
  ephemeral?: boolean;
}

const MAX_LOGS = 12;

function statusDot(status: Status): React.ReactElement {
  switch (status) {
    case "live":
      return <Text color="green">● LIVE</Text>;
    case "reconnecting":
      return <Text color="yellow">◌ RECONNECTING</Text>;
    default:
      return <Text color="cyan">◌ CONNECTING</Text>;
  }
}

function Dashboard(state: DashboardState): React.ReactElement {
  const latency =
    state.avgLatencyMs !== undefined ? `  ⚡ ${state.avgLatencyMs}ms avg` : "";
  return (
    <Box flexDirection="column">
      <Box
        flexDirection="column"
        borderStyle="round"
        borderColor="cyan"
        paddingX={1}
      >
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
        </Box>
      </Box>
      <Box flexDirection="column" paddingX={1}>
        {state.logs.length === 0 ? (
          <Text dimColor>
            {state.ephemeral
              ? "waiting for traffic… (Ctrl-C stops; this URL is temporary)"
              : "waiting for traffic… (Ctrl-C stops; your URL is preserved)"}
          </Text>
        ) : (
          state.logs.map((line, i) => (
            <Text key={i} dimColor wrap="truncate-end">
              {line}
            </Text>
          ))
        )}
      </Box>
    </Box>
  );
}

export interface DashboardHandle {
  update(partial: Partial<DashboardState>): void;
  log(line: string): void;
  /** Resolves when the user exits (Ctrl-C). */
  waitUntilExit(): Promise<void>;
  stop(): void;
}

export function startDashboard(initial: DashboardState): DashboardHandle {
  const state: DashboardState = { ...initial, logs: [...initial.logs] };
  const instance = render(<Dashboard {...state} />, {
    stdout: process.stdout,
    // We drive graceful shutdown ourselves; ink's Ctrl-C simply resolves
    // waitUntilExit, and the caller then stops the runner (preserving state).
    exitOnCtrlC: true,
  });
  const rerender = () => instance.rerender(<Dashboard {...state} />);

  return {
    update(partial) {
      Object.assign(state, partial);
      rerender();
    },
    log(line) {
      state.logs = [...state.logs, line].slice(-MAX_LOGS);
      rerender();
    },
    waitUntilExit() {
      return instance.waitUntilExit();
    },
    stop() {
      instance.unmount();
    },
  };
}
