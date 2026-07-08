import { describe, expect, it } from "vitest";
import { createServer } from "node:net";
import { splitAtDoubleDash, resolveExec } from "../src/cli.js";
import { waitForPort, findFreePort } from "../src/core/port.js";
import { startChild, describeCommand, reapChild } from "../src/process/child.js";

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("splitAtDoubleDash", () => {
  it("returns everything unchanged when there's no `--`", () => {
    expect(splitAtDoubleDash(["3000", "--zone", "x.com"])).toEqual({
      argv: ["3000", "--zone", "x.com"],
      afterDash: [],
    });
  });

  it("splits the dev command off at the first `--`", () => {
    // The dev command's own flags must NOT leak into cfld's parser.
    expect(splitAtDoubleDash(["3000", "--", "vite", "--port", "3000"])).toEqual({
      argv: ["3000"],
      afterDash: ["vite", "--port", "3000"],
    });
  });

  it("treats a trailing bare `--` as an empty command", () => {
    expect(splitAtDoubleDash(["3000", "--"])).toEqual({
      argv: ["3000"],
      afterDash: [],
    });
  });
});

describe("resolveExec", () => {
  it("builds a no-shell argv command from `-- <cmd>`", () => {
    expect(resolveExec(["next", "dev"], undefined)).toEqual({
      shell: false,
      argv: ["next", "dev"],
    });
  });

  it("builds a shell command from --exec, trimming whitespace", () => {
    expect(resolveExec([], "  npm run dev  ")).toEqual({
      shell: true,
      command: "npm run dev",
    });
  });

  it("is undefined when neither form is given (or --exec is blank)", () => {
    expect(resolveExec([], undefined)).toBeUndefined();
    expect(resolveExec([], "   ")).toBeUndefined();
  });

  it("rejects using both forms at once", () => {
    expect(() => resolveExec(["next", "dev"], "next dev")).toThrow(/not both/);
  });
});

describe("describeCommand", () => {
  it("renders both forms readably", () => {
    expect(describeCommand({ shell: false, argv: ["next", "dev"] })).toBe("next dev");
    expect(describeCommand({ shell: true, command: "npm run dev" })).toBe("npm run dev");
  });
});

describe("waitForPort", () => {
  it("resolves true once something is listening", async () => {
    const port = await findFreePort();
    const server = createServer().listen(port, "127.0.0.1");
    try {
      expect(await waitForPort(port, { timeoutMs: 2000, intervalMs: 20 })).toBe(true);
    } finally {
      server.close();
    }
  });

  it("resolves false when the port never opens (timeout)", async () => {
    const port = await findFreePort(); // free → nothing listening
    expect(await waitForPort(port, { timeoutMs: 150, intervalMs: 30 })).toBe(false);
  });

  it("resolves false promptly when the signal is already aborted", async () => {
    const port = await findFreePort();
    expect(
      await waitForPort(port, { timeoutMs: 5000, signal: AbortSignal.abort() }),
    ).toBe(false);
  });
});

describe("startChild", () => {
  it("streams stdout lines and reports the exit code", async () => {
    const lines: string[] = [];
    const exit = await new Promise<{ code: number | null }>((resolve) => {
      startChild({
        command: { shell: false, argv: [process.execPath, "-e", "console.log('one');console.log('two');process.exit(3)"] },
        cwd: process.cwd(),
        onLine: (line, stream) => {
          if (stream === "stdout") lines.push(line);
        },
        onExit: (code) => resolve({ code }),
      });
    });
    expect(lines).toEqual(["one", "two"]);
    expect(exit.code).toBe(3);
  });

  it("passes extra env through to the child", async () => {
    const out = await new Promise<string>((resolve) => {
      let captured = "";
      startChild({
        command: { shell: false, argv: [process.execPath, "-e", "process.stdout.write(process.env.PUBLIC_URL||'')"] },
        cwd: process.cwd(),
        env: { PUBLIC_URL: "https://x.example.com" },
        onLine: (line) => (captured += line),
        onExit: () => resolve(captured),
      });
    });
    expect(out).toBe("https://x.example.com");
  });

  it("reports a missing command via onExit instead of throwing", async () => {
    const code = await new Promise<number | null>((resolve) => {
      startChild({
        command: { shell: false, argv: ["this-binary-does-not-exist-cfld"] },
        cwd: process.cwd(),
        onExit: (c) => resolve(c),
      });
    });
    expect(code).toBeNull();
  });
});

describe("reapChild", () => {
  it("reaps a descendant that escaped into its own process group", async () => {
    // The parent spawns a DETACHED grandchild — a new session/process group,
    // exactly how `pnpm`/`concurrently`/`wrangler` sub-trees escape. A plain
    // group-kill would miss it; the tree walk must not.
    const script = [
      "const cp = require('node:child_process');",
      "const gc = cp.spawn(process.execPath, ['-e','setInterval(()=>{},1e9)'], { detached: true, stdio: 'ignore' });",
      "gc.unref();",
      "process.stdout.write('GC ' + gc.pid + '\\n');",
      "setInterval(()=>{},1e9);",
    ].join("\n");

    let gcPid = 0;
    const child = startChild({
      command: { shell: false, argv: [process.execPath, "-e", script] },
      cwd: process.cwd(),
      onLine: (line) => {
        const m = line.match(/GC (\d+)/);
        if (m) gcPid = Number(m[1]);
      },
    });

    for (let i = 0; i < 100 && gcPid === 0; i++) await wait(20);
    expect(gcPid).toBeGreaterThan(0);
    expect(alive(gcPid)).toBe(true);

    await reapChild(child, 1000);
    await wait(150);

    expect(alive(child.pid!)).toBe(false);
    expect(alive(gcPid)).toBe(false); // the escaped grandchild is gone too
  });

  it("reaps a worker whose parent already exited (reparented to init)", async () => {
    // The real `pnpm → vite → workerd/esbuild` failure: an intermediate wrapper
    // spawns a worker in its own group, then EXITS — the worker reparents to
    // init (PPID 1), so a PPID walk at teardown can no longer reach it from our
    // leader. It survives ONLY if we recorded its group while the wrapper was
    // still traceable. Fast poll so the snapshot lands before the wrapper dies.
    const worker =
      "const cp=require('node:child_process');" +
      "const w=cp.spawn(process.execPath,['-e','setInterval(()=>{},1e9)'],{detached:true,stdio:'ignore'});" +
      "w.unref();" +
      "process.stdout.write('W '+w.pid+'\\n');" +
      "setTimeout(()=>process.exit(0),400);"; // wrapper exits → worker reparents to init

    let workerPid = 0;
    const child = startChild({
      command: { shell: false, argv: [process.execPath, "-e", worker] },
      cwd: process.cwd(),
      pollTreeMs: 50, // capture the worker's group before the wrapper exits
      onLine: (line) => {
        const m = line.match(/W (\d+)/);
        if (m) workerPid = Number(m[1]);
      },
    });

    for (let i = 0; i < 100 && workerPid === 0; i++) await wait(20);
    expect(workerPid).toBeGreaterThan(0);
    // Let the poll snapshot the tree, then let the wrapper exit so the worker
    // reparents to init — its PPID chain from our leader is now broken.
    await wait(250);
    await child.exited; // wrapper process gone
    expect(alive(workerPid)).toBe(true); // still alive, now orphaned to init

    await reapChild(child, 1000);
    await wait(150);

    expect(alive(workerPid)).toBe(false); // reached via its recorded process group
  });

  it("reaps a supervisor that ignores SIGINT and respawns its worker", async () => {
    // Models `concurrently --restart-tries`: a supervisor that keeps a worker
    // alive by respawning it, and does not stop on a plain SIGINT. Only the
    // escalate-to-SIGKILL-and-repeat loop can take the whole tree down; a
    // one-shot SIGINT would leave it running.
    const script = [
      "const cp=require('node:child_process');",
      "process.on('SIGINT',()=>{});", // stubborn: ignore SIGINT
      "function spawnW(){",
      "  const w=cp.spawn(process.execPath,['-e','setInterval(()=>{},1e9)'],{stdio:'ignore'});",
      "  process.stdout.write('W '+w.pid+'\\n');",
      "  w.on('exit',()=>setTimeout(spawnW,50));", // respawn on death
      "}",
      "spawnW();",
      "setInterval(()=>{},1e9);",
    ].join("\n");

    let workerPid = 0;
    const child = startChild({
      command: { shell: false, argv: [process.execPath, "-e", script] },
      cwd: process.cwd(),
      pollTreeMs: 50,
      onLine: (line) => {
        const m = line.match(/W (\d+)/);
        if (m) workerPid = Number(m[1]);
      },
    });

    for (let i = 0; i < 100 && workerPid === 0; i++) await wait(20);
    expect(workerPid).toBeGreaterThan(0);
    await wait(200); // let a poll record the group

    await reapChild(child, 1000);
    await wait(200);

    expect(alive(child.pid!)).toBe(false); // leader killed despite ignoring SIGINT
    expect(child.treeAlive()).toBe(false); // and no respawned worker survives
  });
});
