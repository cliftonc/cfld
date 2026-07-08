import { spawn, execSync, type ChildProcess } from "node:child_process";

/**
 * Supervise the user's dev command (`cfld 3000 -- next dev`) as a managed
 * child. Unlike the cloudflared runner, this is NOT restarted on exit — a dev
 * server that dies is a signal to the developer, so we surface the exit and let
 * the caller shut everything down cleanly (leaving the tunnel + DNS intact).
 *
 * The child runs in its OWN process group (`detached`), so the terminal's
 * Ctrl-C does not reach it directly — cfld owns its lifecycle.
 *
 * Killing the whole tree is the hard part. Wrappers like `pnpm run dev` /
 * `dotenv-cli -- vite` / `concurrently` spawn workers (vite → workerd, esbuild)
 * that BOTH (a) reparent to init when their intermediate parent exits — so a
 * PPID walk done at teardown can no longer reach them from our leader — AND
 * (b) land in their own process groups, so signalling only the leader's group
 * misses them. Either escape hatch alone leaves workers orphaned (stuck on
 * :3000/workerd sockets), and you can't restart.
 *
 * The robust invariant we rely on: a process keeps its process-group id even
 * after it reparents to init. So while the child is alive we POLL its
 * descendant tree and accumulate every process-group id we ever see it span.
 * At teardown we signal all of those groups — reaching workers that have since
 * reparented or setsid'd away, because we recorded their group while their
 * parent was still traceable.
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
  /** How often to snapshot the descendant tree's process groups (ms). Test seam. */
  pollTreeMs?: number;
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

  // Every process group the child's tree has ever spanned. Populated by polling
  // while the tree is alive+traceable, so we can still reach workers that later
  // reparent to init or setsid into their own group (see the file header).
  const trackedPgids = new Set<number>();
  const trackTree = () => {
    const pid = child.pid;
    if (pid === undefined) return;
    for (const g of descendantPgids(pid)) {
      // Never signal our own group (would kill cfld) or init.
      if (g > 1 && g !== process.pid) trackedPgids.add(g);
    }
  };
  const poll = setInterval(trackTree, options.pollTreeMs ?? 1500);
  poll.unref();

  wireLines(child, "stdout", options.onLine);
  wireLines(child, "stderr", options.onLine);

  // ENOENT (command not found) arrives as an 'error' event, not an exit.
  child.on("error", (err) => {
    clearInterval(poll);
    markExited();
    if (stopped) return;
    stopped = true;
    options.onExit?.(null, null);
    // Surface a helpful line through the same log channel.
    options.onLine?.(String((err as NodeJS.ErrnoException).message ?? err), "stderr");
  });

  child.on("exit", (code, signal) => {
    clearInterval(poll);
    markExited();
    if (stopped) return;
    stopped = true;
    options.onExit?.(code, signal);
  });

  // Signal the child's own group plus every group its tree has ever spanned.
  // Refresh the tracking first so a teardown that races the poll still sees the
  // current tree.
  const signalTree = (signal: NodeJS.Signals) => {
    trackTree();
    const pid = child.pid;
    if (pid !== undefined) trySignalGroup(pid, signal);
    for (const g of trackedPgids) trySignalGroup(g, signal);
  };

  return {
    exited,
    get pid() {
      return child.pid;
    },
    stop() {
      if (stopped) return;
      stopped = true;
      clearInterval(poll);
      signalTree("SIGINT");
      const t = setTimeout(() => {
        if (child.exitCode === null && !child.signalCode) signalTree("SIGKILL");
      }, 4000);
      t.unref();
    },
    kill() {
      clearInterval(poll);
      signalTree("SIGKILL");
    },
  };
}

/**
 * The set of process-group ids spanned by `pid`'s descendant tree, read from
 * the live process table. Called repeatedly while the tree is alive so we
 * accumulate groups before their members reparent to init and the PPID chain
 * from `pid` breaks — a reparented process keeps its group, so the recorded
 * group id still reaches it at teardown.
 */
function descendantPgids(pid: number): number[] {
  let out = "";
  try {
    out = execSync("ps -A -o pid=,ppid=,pgid=", { encoding: "utf8" });
  } catch {
    return [];
  }
  const childrenOf = new Map<number, number[]>();
  const pgidOf = new Map<number, number>();
  for (const line of out.split("\n")) {
    const m = line.trim().match(/^(\d+)\s+(\d+)\s+(\d+)$/);
    if (!m) continue;
    const proc = Number(m[1]);
    const parent = Number(m[2]);
    pgidOf.set(proc, Number(m[3]));
    const list = childrenOf.get(parent);
    if (list) list.push(proc);
    else childrenOf.set(parent, [proc]);
  }
  const pgids = new Set<number>();
  const seen = new Set<number>();
  const stack = [pid];
  while (stack.length) {
    for (const child of childrenOf.get(stack.pop()!) ?? []) {
      if (seen.has(child)) continue;
      seen.add(child);
      stack.push(child);
      const g = pgidOf.get(child);
      if (g !== undefined) pgids.add(g);
    }
  }
  return [...pgids];
}

/**
 * Signal a whole process group (negative PID). Swallows ESRCH — a group whose
 * members have all exited is exactly what we want.
 */
function trySignalGroup(pgid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(-pgid, signal);
  } catch {
    /* already gone */
  }
}

/**
 * Graceful teardown for shutdown: SIGINT the child's group + every group its
 * tree spanned, wait for the leader to exit (up to `graceMs`), then SIGKILL the
 * lot — reaping workers that reparented or escaped into their own group.
 * Resolves once it's gone, so callers can wait before exiting rather than
 * orphaning children.
 */
export function reapChild(child: ManagedChild, graceMs = 3000): Promise<void> {
  child.stop(); // SIGINT the tracked groups (+ its own SIGKILL escalation)
  return new Promise<void>((resolve) => {
    const done = () => {
      clearTimeout(grace);
      child.kill(); // SIGKILL every group we recorded
      resolve();
    };
    const grace = setTimeout(done, graceMs);
    grace.unref();
    child.exited.then(done);
  });
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
