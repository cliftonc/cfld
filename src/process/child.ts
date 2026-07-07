import { spawn, execSync, type ChildProcess } from "node:child_process";

/**
 * Supervise the user's dev command (`cfld 3000 -- next dev`) as a managed
 * child. Unlike the cloudflared runner, this is NOT restarted on exit — a dev
 * server that dies is a signal to the developer, so we surface the exit and let
 * the caller shut everything down cleanly (leaving the tunnel + DNS intact).
 *
 * The child runs in its OWN process group (`detached`), so the terminal's
 * Ctrl-C does not reach it directly — cfld owns its lifecycle. On teardown we
 * signal both the process group AND every descendant we can find by walking the
 * process tree: wrappers like `pnpm run dev` / `concurrently` / `wrangler`
 * spawn sub-trees that call setsid and escape the original group, so a group
 * signal alone leaves them orphaned (workers stuck on :3000/:3001).
 */

/** How to launch the dev command: a pre-split argv, or a shell string. */
export type DevCommand =
  | { shell: false; argv: string[] }
  | { shell: true; command: string };

/** A human-readable rendering of the command, for logs/errors. */
export function describeCommand(cmd: DevCommand): string {
  return cmd.shell ? cmd.command : cmd.argv.join(" ");
}

export interface ChildOptions {
  command: DevCommand;
  cwd: string;
  /** Extra environment merged over process.env (e.g. PUBLIC_URL). */
  env?: Record<string, string | undefined>;
  onLine?: (line: string, stream: "stdout" | "stderr") => void;
  /** Called once when the child exits (for any reason other than our stop()). */
  onExit?: (code: number | null, signal: NodeJS.Signals | null) => void;
}

export interface ManagedChild {
  /** SIGINT the process group, escalating to SIGKILL if it lingers. */
  stop: () => void;
  /** Force-kill the whole process group now (SIGKILL) — reaps stragglers. */
  kill: () => void;
  /** Resolves when the process has actually exited (for graceful teardown). */
  readonly exited: Promise<void>;
  readonly pid: number | undefined;
}

export function startChild(options: ChildOptions): ManagedChild {
  const [command, args, useShell] = options.command.shell
    ? [options.command.command, [] as string[], true]
    : [options.command.argv[0]!, options.command.argv.slice(1), false];

  let stopped = false;
  const child: ChildProcess = spawn(command, args, {
    cwd: options.cwd,
    env: { ...process.env, ...options.env },
    // New process group so a terminal Ctrl-C doesn't race us to the child; we
    // stop the whole group ourselves.
    detached: true,
    shell: useShell,
    stdio: ["ignore", "pipe", "pipe"],
  });

  let markExited: () => void;
  const exited = new Promise<void>((resolve) => {
    markExited = resolve;
  });

  wireLines(child, "stdout", options.onLine);
  wireLines(child, "stderr", options.onLine);

  // ENOENT (command not found) arrives as an 'error' event, not an exit.
  child.on("error", (err) => {
    markExited();
    if (stopped) return;
    stopped = true;
    options.onExit?.(null, null);
    // Surface a helpful line through the same log channel.
    options.onLine?.(String((err as NodeJS.ErrnoException).message ?? err), "stderr");
  });

  child.on("exit", (code, signal) => {
    markExited();
    if (stopped) return;
    stopped = true;
    options.onExit?.(code, signal);
  });

  return {
    exited,
    get pid() {
      return child.pid;
    },
    stop() {
      if (stopped) return;
      stopped = true;
      killGroup(child, "SIGINT");
      const t = setTimeout(() => {
        if (child.exitCode === null && !child.signalCode) killGroup(child, "SIGKILL");
      }, 4000);
      t.unref();
    },
    kill() {
      killGroup(child, "SIGKILL");
    },
  };
}

/**
 * Snapshot every descendant PID of `pid` by walking the live process table.
 * MUST be captured while the tree is still alive — once the leader dies its
 * children reparent to init (PPID 1) and the chain from `pid` is lost.
 */
function descendantPids(pid: number): number[] {
  let out = "";
  try {
    out = execSync("ps -A -o pid=,ppid=", { encoding: "utf8" });
  } catch {
    return [];
  }
  const childrenOf = new Map<number, number[]>();
  for (const line of out.split("\n")) {
    const m = line.trim().match(/^(\d+)\s+(\d+)$/);
    if (!m) continue;
    const child = Number(m[1]);
    const parent = Number(m[2]);
    const list = childrenOf.get(parent);
    if (list) list.push(child);
    else childrenOf.set(parent, [child]);
  }
  const found: number[] = [];
  const stack = [pid];
  while (stack.length) {
    for (const child of childrenOf.get(stack.pop()!) ?? []) {
      if (!found.includes(child)) {
        found.push(child);
        stack.push(child);
      }
    }
  }
  return found;
}

function signalPids(pids: number[], signal: NodeJS.Signals): void {
  for (const pid of pids) {
    try {
      process.kill(pid, signal);
    } catch {
      /* already gone */
    }
  }
}

/**
 * Graceful teardown for shutdown: snapshot the whole descendant tree, SIGINT
 * the process group AND that tree, wait for the leader to exit (up to
 * `graceMs`), then SIGKILL both — reaping workers that escaped the group into
 * their own session. Resolves once it's gone, so callers can wait before
 * exiting rather than orphaning children.
 */
export function reapChild(child: ManagedChild, graceMs = 3000): Promise<void> {
  // Capture the tree NOW, while everything is still alive and reachable.
  const tree = child.pid ? descendantPids(child.pid) : [];
  child.stop(); // SIGINT the group (+ its own SIGKILL escalation)
  signalPids(tree, "SIGINT"); // reach any subtree that escaped the group
  return new Promise<void>((resolve) => {
    const done = () => {
      clearTimeout(grace);
      child.kill(); // SIGKILL the group
      signalPids(tree, "SIGKILL"); // and every descendant we snapshotted
      resolve();
    };
    const grace = setTimeout(done, graceMs);
    grace.unref();
    child.exited.then(done);
  });
}

/**
 * Signal the child's entire process group when possible (negative PID), so
 * spawned workers die with it; fall back to the single process.
 */
function killGroup(child: ChildProcess, signal: NodeJS.Signals): void {
  const pid = child.pid;
  if (pid === undefined) return;
  try {
    process.kill(-pid, signal);
  } catch {
    try {
      child.kill(signal);
    } catch {
      /* already gone */
    }
  }
}

function wireLines(
  child: ChildProcess,
  stream: "stdout" | "stderr",
  onLine?: (line: string, stream: "stdout" | "stderr") => void,
): void {
  const source = stream === "stdout" ? child.stdout : child.stderr;
  if (!source || !onLine) return;
  let buffer = "";
  source.setEncoding("utf8");
  source.on("data", (chunk: string) => {
    buffer += chunk;
    let idx: number;
    while ((idx = buffer.indexOf("\n")) !== -1) {
      onLine(buffer.slice(0, idx).replace(/\r$/, ""), stream);
      buffer = buffer.slice(idx + 1);
    }
  });
  source.on("end", () => {
    if (buffer.length > 0) onLine(buffer.replace(/\r$/, ""), stream);
  });
}
