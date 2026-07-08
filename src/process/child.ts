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
  /** SIGINT the whole tree — the signal supervisors treat as "stop, don't restart". */
  stop: () => void;
  /** SIGKILL every process group the tree spans, now. */
  kill: () => void;
  /** True while any process group the tree spanned still has a live member. */
  treeAlive: () => boolean;
  /** Resolves when the leader process has exited (for graceful teardown). */
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

  // Every process group the child's tree has ever spanned. Seeded with the
  // leader's own group and grown by polling while the tree is alive+traceable,
  // so we can still reach workers that later reparent to init or setsid into
  // their own group (see the file header). Our own group is never added, so we
  // can't signal cfld itself.
  const ownPgid = getpgid(process.pid);
  const trackedPgids = new Set<number>();
  const track = (g: number) => {
    if (g > 1 && g !== process.pid && g !== ownPgid) trackedPgids.add(g);
  };
  if (child.pid !== undefined) track(child.pid); // the detached leader's group
  const trackTree = () => {
    if (child.pid === undefined) return;
    for (const g of descendantPgids(child.pid)) track(g);
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

  // Signal every group the tree has ever spanned. Refresh tracking first so a
  // teardown racing the poll — or a supervisor that just respawned a child into
  // its group — still sees the current tree.
  const signalTree = (signal: NodeJS.Signals) => {
    trackTree();
    for (const g of trackedPgids) trySignalGroup(g, signal);
  };

  return {
    exited,
    get pid() {
      return child.pid;
    },
    treeAlive() {
      if (trackedPgids.size === 0) return false;
      const live = livePgids();
      for (const g of trackedPgids) if (live.has(g)) return true;
      return false;
    },
    stop() {
      stopped = true;
      signalTree("SIGINT");
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

/** The process-group id of `pid`, or undefined if it can't be read. */
function getpgid(pid: number): number | undefined {
  try {
    const n = Number(execSync(`ps -o pgid= -p ${pid}`, { encoding: "utf8" }).trim());
    return Number.isInteger(n) ? n : undefined;
  } catch {
    return undefined;
  }
}

/** Every process-group id with at least one live process, from the process table. */
function livePgids(): Set<number> {
  const live = new Set<number>();
  try {
    for (const line of execSync("ps -A -o pgid=", { encoding: "utf8" }).split("\n")) {
      const n = Number(line.trim());
      if (Number.isInteger(n) && n > 0) live.add(n);
    }
  } catch {
    /* if ps fails, treat as empty — better to exit than hang */
  }
  return live;
}

const delay = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * Teardown for shutdown, resilient to supervisors that respawn their children.
 *
 * A one-shot "SIGINT then SIGKILL" loses two races: the process can exit before
 * the SIGKILL lands (orphaning the tree), and a supervisor like `concurrently`
 * / `nodemon` / `pm2` restarts any child that dies with a non-zero code on a
 * timer. So we (1) SIGINT the whole tree — the signal `concurrently` treats as
 * a clean, no-restart stop — then (2) SIGKILL every group the tree spans,
 * re-scanning and repeating until nothing is left or we hit the deadline.
 *
 * The awaited delays keep the event loop alive, so the caller can wait for this
 * to finish before exiting rather than orphaning children mid-reap.
 */
export async function reapChild(child: ManagedChild, graceMs = 3000): Promise<void> {
  // 1. Graceful: SIGINT lets the dev server flush and tells supervisors to stop
  //    (and, for SIGINT specifically, NOT to restart their children).
  child.stop();
  await Promise.race([child.exited, delay(Math.min(graceMs, 1200))]);

  // 2. Decisive: SIGKILL every group in the tree, re-scanning each pass so we
  //    also catch any child a supervisor respawned, until the tree is empty.
  const deadline = Date.now() + graceMs + 5000;
  for (;;) {
    child.kill();
    if (!child.treeAlive()) return;
    if (Date.now() >= deadline) return; // give up rather than hang forever
    await delay(200);
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
