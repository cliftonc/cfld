import { parseArgs } from "node:util";
import { readFileSync, realpathSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import pc from "picocolors";
import type { DevCommand } from "./process/child.js";
import { runCommand } from "./commands/run.js";
import { quickCommand } from "./commands/quick.js";
import { loginCommand } from "./commands/login.js";
import { initCommand } from "./commands/init.js";
import { setupCommand, isBlankFirstRun } from "./commands/setup.js";
import { listCommand } from "./commands/list.js";
import { statusCommand } from "./commands/status.js";
import { upCommand } from "./commands/up.js";
import { destroyCommand } from "./commands/destroy.js";
import { serviceCommand } from "./commands/service.js";
import { doctorCommand } from "./commands/doctor.js";
import { printError } from "./ui/output.js";

/** Flags shared across commands (parsed once in {@link main}). */
export interface CliFlags {
  port?: number;
  name?: string;
  host?: string;
  zone?: string;
  envKey?: string;
  noEnv?: boolean;
  quick?: boolean;
  force?: boolean;
  reauth?: boolean;
  /** A dev command to run + supervise alongside the tunnel (`-- <cmd>`). */
  exec?: DevCommand;
}

/** Best-effort version read from the published package.json (next to dist/). */
function readVersion(): string {
  try {
    const here = dirname(fileURLToPath(import.meta.url));
    const pkg = JSON.parse(readFileSync(join(here, "../package.json"), "utf8"));
    return typeof pkg.version === "string" ? pkg.version : "0.0.0";
  } catch {
    return "0.0.0";
  }
}

/** Split argv at the first bare `--`; everything after is the dev command. */
export function splitAtDoubleDash(rawArgv: string[]): {
  argv: string[];
  afterDash: string[];
} {
  const i = rawArgv.indexOf("--");
  if (i === -1) return { argv: rawArgv, afterDash: [] };
  return { argv: rawArgv.slice(0, i), afterDash: rawArgv.slice(i + 1) };
}

/**
 * Turn the two supported forms into a single {@link DevCommand}. The `-- <cmd>`
 * argv form runs directly (no shell, no quoting surprises); `--exec "<str>"`
 * runs through a shell for pipes/globs. They're mutually exclusive.
 */
export function resolveExec(
  afterDash: string[],
  execFlag: string | undefined,
): DevCommand | undefined {
  const hasArgv = afterDash.length > 0;
  const hasShell = execFlag !== undefined && execFlag.trim() !== "";
  if (hasArgv && hasShell) {
    throw new Error("Use either `-- <cmd>` or `--exec \"<cmd>\"`, not both.");
  }
  if (hasArgv) return { shell: false, argv: afterDash };
  if (hasShell) return { shell: true, command: execFlag!.trim() };
  return undefined;
}

const SUBCOMMANDS = new Set([
  "setup",
  "login",
  "init",
  "list",
  "status",
  "up",
  "destroy",
  "service",
  "doctor",
  "help",
]);

const HELP = `${pc.bold("cfld")} — persistent Cloudflare tunnels for local dev

${pc.bold("Usage")}
  cfld --quick [port]      Instant public URL, no account needed (temporary)
  cfld setup               Guided first-run: free instant URL, or persistent setup
  cfld [port]              Ensure + run a persistent tunnel (reuses the same URL)
  cfld [port] -- <cmd>     Run + supervise your dev server too (one lifecycle)
  cfld login [--reauth]    Authorize with Cloudflare in your browser
  cfld init                Configure a persistent tunnel (don't run)
  cfld list                List all tunnels across projects/domains
  cfld status [name]       Show details for a tunnel
  cfld up <name>           Run a registered tunnel by name from anywhere
  cfld destroy [name]      Delete a tunnel (explicit, opt-in)
  cfld service <action>    Always-on background service (install/uninstall/start/stop/status)
  cfld doctor              Diagnose your setup

${pc.bold("Options")}
  --name <slug>     Override the project name (default: package.json name / dir)
  --host <fqdn>     Explicit public hostname (e.g. api.example.com)
  --zone <domain>   Cloudflare domain to use (e.g. example.com)
  --env <KEY>       .env key to write the URL to (default: PUBLIC_URL)
  --no-env          Don't write the URL to .env
  --exec <cmd>      Dev command to run + supervise (shell form of \`-- <cmd>\`)
  --force           Skip confirmation (destroy)
  -h, --help        Show this help
  -v, --version     Show version

${pc.bold("Examples")}
  cfld 3000 -- next dev            Start Next.js + the tunnel; one Ctrl-C stops both
  cfld 5173 --exec "npm run dev"   Same, via a shell command string
`;

async function main(rawArgv: string[]): Promise<void> {
  // Everything after the first bare `--` is the user's dev command — split it
  // off before parseArgs so its own flags (e.g. `vite --port 3000`) are never
  // interpreted as cfld options.
  const { argv, afterDash } = splitAtDoubleDash(rawArgv);

  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      name: { type: "string" },
      host: { type: "string" },
      zone: { type: "string" },
      env: { type: "string" },
      "no-env": { type: "boolean" },
      exec: { type: "string" },
      quick: { type: "boolean" },
      force: { type: "boolean" },
      reauth: { type: "boolean" },
      help: { type: "boolean", short: "h" },
      version: { type: "boolean", short: "v" },
    },
  });

  if (values.version) {
    process.stdout.write(`cfld ${readVersion()}\n`);
    return;
  }
  if (values.help) {
    process.stdout.write(HELP);
    return;
  }

  const flags: CliFlags = {
    name: values.name,
    host: values.host,
    zone: values.zone,
    envKey: values.env,
    noEnv: values["no-env"],
    quick: values.quick,
    force: values.force,
    reauth: values.reauth,
    exec: resolveExec(afterDash, values.exec),
  };

  const [first, ...rest] = positionals;

  if (flags.exec && first && SUBCOMMANDS.has(first)) {
    throw new Error(
      `A dev command (\`-- …\` / --exec) can't be combined with \`cfld ${first}\`. Use \`cfld [port] -- <cmd>\`.`,
    );
  }

  // Subcommand dispatch.
  if (first && SUBCOMMANDS.has(first)) {
    switch (first) {
      case "help":
        process.stdout.write(HELP);
        return;
      case "setup":
        await setupCommand(flags);
        return;
      case "login":
        await loginCommand(flags);
        return;
      case "init":
        await initCommand(flags);
        return;
      case "list":
        await listCommand();
        return;
      case "status":
        await statusCommand(rest[0]);
        return;
      case "up":
        if (!rest[0]) throw new Error("Usage: cfld up <name>");
        await upCommand(rest[0]);
        return;
      case "destroy":
        await destroyCommand(rest[0], Boolean(flags.force));
        return;
      case "service":
        await serviceCommand(rest[0], rest[1]);
        return;
      case "doctor":
        await doctorCommand();
        return;
    }
  }

  // Default: run. A numeric first positional is the port.
  if (first !== undefined) {
    const port = Number(first);
    if (Number.isInteger(port) && port > 0) flags.port = port;
    else throw new Error(`Unknown command "${first}". Try \`cfld --help\`.`);
  }

  if (flags.quick) {
    await quickCommand(flags);
  } else if (isBlankFirstRun(flags, process.cwd())) {
    // Nothing configured and nothing authorized — guide the user instead of
    // dropping them into a lazy failure chain.
    await setupCommand(flags);
  } else {
    await runCommand(flags);
  }
}

/** True only when this module is the process entry point (not imported by a test). */
function invokedDirectly(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return realpathSync(entry) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (invokedDirectly()) {
  main(process.argv.slice(2)).catch((err) => {
    printError(err);
    process.exit(1);
  });
}
