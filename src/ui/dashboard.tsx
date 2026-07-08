import { spawn } from "node:child_process";
import React from "react";
import { Box, render, Text, useApp, useInput } from "ink";

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

/** Which log pane(s) fill the body. `‹ ›` cycles dev → split → tunnel. */
export type ColumnView = "dev" | "split" | "tunnel";
const VIEW_ORDER: ColumnView[] = ["dev", "split", "tunnel"];

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
  /** True when a dev command is supervised — enables the two-column view. */
  split?: boolean;
  /** Label for the dev-server column (the command being run). */
  devLabel?: string;
  /** Current column layout (only meaningful when `split`). */
  view?: ColumnView;
  /** Whether the restart hotkeys are wired — drives the legend. */
  canRestart?: boolean;
  tunnelLogs: string[];
  devLogs: string[];
}

/** Actions the hotkeys drive back into the run supervisor. */
export interface DashboardActions {
  restartAll?: () => void;
  restartDev?: () => void;
  restartTunnel?: () => void;
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

/** The three right-aligned hotkey rows, tailored to what's actually wired. */
function hotkeyHints(state: DashboardState): [string, string, string] {
  const dev = Boolean(state.split);
  const row1 = state.canRestart ? "r restart all" : "";
  const row2 = state.canRestart
    ? dev
      ? "d restart dev · t restart tunnel"
      : "t restart tunnel"
    : "";
  const row3 = [dev ? "‹ › cols" : "", "o open", "^C quit"].filter(Boolean).join(" · ");
  return [row1, row2, row3];
}

function Header(state: DashboardState): React.ReactElement {
  const latency =
    state.avgLatencyMs !== undefined ? `  ⚡ ${state.avgLatencyMs}ms avg` : "";
  const [h1, h2, h3] = hotkeyHints(state);
  return (
    <Box flexDirection="column" borderStyle="round" borderColor="cyan" paddingX={1}>
      <Box justifyContent="space-between">
        <Box>
          {statusDot(state.status)}
          <Text> </Text>
          <Text color="cyan" bold>
            {state.url}
          </Text>
        </Box>
        {h1 ? <Text dimColor>  {h1}</Text> : null}
      </Box>
      <Box justifyContent="space-between">
        <Text dimColor>
          → {state.target}
          {"   "}
          {state.connections} edge conns
          {state.ephemeral ? " · ephemeral" : ""}
        </Text>
        {h2 ? <Text dimColor>  {h2}</Text> : null}
      </Box>
      <Box justifyContent="space-between">
        <Text dimColor>
          ↑ {state.requests} reqs{latency}
        </Text>
        {h3 ? <Text dimColor>  {h3}</Text> : null}
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
  // Only a dev server gives us a second pane to toggle between.
  const view: ColumnView = state.split ? state.view ?? "split" : "tunnel";
  // A single-column dev/tunnel view still shows a title so the toggle is legible.
  const titleRows = state.split ? 1 : 0;
  const logRows = Math.max(3, termRows - HEADER_ROWS - titleRows - 1);

  const devColumn = (divider?: boolean) => (
    <LogColumn
      title={state.devLabel ?? "dev server"}
      titleColor="cyan"
      lines={state.devLogs}
      rows={logRows}
      placeholder="waiting for dev-server output…"
      divider={divider}
    />
  );
  const tunnelColumn = (divider?: boolean) => (
    <LogColumn
      title={state.split ? "tunnel" : undefined}
      titleColor="blue"
      lines={state.tunnelLogs}
      rows={logRows}
      placeholder={
        state.split
          ? "waiting for tunnel activity…"
          : state.ephemeral
            ? "waiting for traffic… (Ctrl-C stops; this URL is temporary)"
            : "waiting for traffic… (Ctrl-C stops; your URL is preserved)"
      }
      divider={divider}
    />
  );

  let body: React.ReactElement;
  if (view === "split") {
    body = (
      <Box flexGrow={1} flexDirection="row" paddingX={1} paddingTop={1}>
        {devColumn()}
        {tunnelColumn(true)}
      </Box>
    );
  } else {
    body = (
      <Box flexGrow={1} paddingX={1} paddingTop={1}>
        {view === "dev" ? devColumn() : tunnelColumn()}
      </Box>
    );
  }

  return (
    <Box flexDirection="column" height={termRows} overflow="hidden">
      <Header {...state} />
      {body}
    </Box>
  );
}

/**
 * Thin wrapper that owns keyboard input. Hooks must live inside the ink tree, so
 * this component translates keystrokes into view changes / supervisor actions,
 * then renders the (externally-managed) dashboard state.
 */
function App({
  state,
  actions,
  onCycleView,
  onOpen,
}: {
  state: DashboardState;
  actions: DashboardActions;
  onCycleView: (delta: number) => void;
  onOpen: () => void;
}): React.ReactElement {
  const { exit } = useApp();
  useInput((input, key) => {
    if (key.leftArrow || input === "<" || input === ",") return onCycleView(-1);
    if (key.rightArrow || input === ">" || input === ".") return onCycleView(1);
    switch (input.toLowerCase()) {
      case "r":
        return actions.restartAll?.();
      case "d":
        return actions.restartDev?.();
      case "t":
        return actions.restartTunnel?.();
      case "o":
        return onOpen();
      case "q":
        return exit();
    }
  });
  return <Dashboard {...state} />;
}

/** Best-effort "open this URL in the default browser" across platforms. */
function openInBrowser(url: string): void {
  const cmd =
    process.platform === "darwin"
      ? "open"
      : process.platform === "win32"
        ? "start"
        : "xdg-open";
  try {
    spawn(cmd, [url], {
      stdio: "ignore",
      detached: true,
      shell: process.platform === "win32",
    }).unref();
  } catch {
    /* best-effort — a missing opener shouldn't disturb the dashboard */
  }
}

export interface DashboardHandle {
  update(partial: Partial<DashboardState>): void;
  log(line: string, source?: LogSource): void;
  /**
   * Temporarily tear down the live view to run an interactive prompt on the
   * normal screen (ink's raw-mode render and a prompt can't share the tty), then
   * restore the dashboard. Used for the rare DNS-overwrite confirmation.
   */
  suspend<T>(fn: () => Promise<T>): Promise<T>;
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

export function startDashboard(
  initial: DashboardState,
  actions: DashboardActions = {},
): DashboardHandle {
  const state: DashboardState = {
    ...initial,
    view: initial.view ?? (initial.split ? "split" : "tunnel"),
    canRestart: Boolean(actions.restartAll || actions.restartTunnel),
    tunnelLogs: [...initial.tunnelLogs],
    devLogs: [...initial.devLogs],
  };

  // Slide the column view along dev → split → tunnel (clamped, not wrapped) —
  // only meaningful when a dev server gives us a second pane.
  const cycleView = (delta: number) => {
    if (!state.split) return;
    const i = VIEW_ORDER.indexOf(state.view ?? "split");
    const next = VIEW_ORDER[Math.min(VIEW_ORDER.length - 1, Math.max(0, i + delta))]!;
    if (next !== state.view) {
      state.view = next;
      rerender();
    }
  };

  const element = () => (
    <App
      state={state}
      actions={actions}
      onCycleView={cycleView}
      onOpen={() => openInBrowser(state.url)}
    />
  );

  // `instance` is reassignable: suspend() unmounts and remounts a fresh render
  // around an interactive prompt, so every method reads the current instance.
  const mount = () =>
    render(element(), {
      stdout: process.stdout,
      // We drive graceful shutdown ourselves; ink's Ctrl-C simply resolves
      // waitUntilExit, and the caller then stops the runner (preserving state).
      exitOnCtrlC: true,
    });

  process.stdout.write(ENTER_ALT_SCREEN);
  let instance = mount();
  // While suspended the view is unmounted; buffer state changes without painting.
  let paused = false;
  const rerender = () => {
    if (!paused) instance.rerender(element());
  };

  let altActive = true;
  const leaveAltScreen = () => {
    if (!altActive) return;
    altActive = false;
    process.stdout.write(LEAVE_ALT_SCREEN);
  };

  // On resize, wipe ink's stale frame before repainting at the new dimensions.
  const onResize = () => {
    if (paused) return;
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
    async suspend(fn) {
      paused = true;
      instance.unmount();
      leaveAltScreen();
      try {
        return await fn();
      } finally {
        process.stdout.write(ENTER_ALT_SCREEN);
        altActive = true;
        instance = mount();
        paused = false;
        rerender();
      }
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
