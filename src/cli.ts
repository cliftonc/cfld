import { parseArgs } from "node:util";
import pc from "picocolors";
import { runCommand } from "./commands/run.js";
import { quickCommand } from "./commands/quick.js";
import { loginCommand } from "./commands/login.js";
import { initCommand } from "./commands/init.js";
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
}

const SUBCOMMANDS = new Set([
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
  cfld [port]              Ensure + run a persistent tunnel (reuses the same URL)
  cfld --quick [port]      Ephemeral trycloudflare.com URL (no domain needed)
  cfld login [--reauth]    Authorize with Cloudflare in your browser
  cfld init                Interactive setup wizard (configure, don't run)
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
  --force           Skip confirmation (destroy)
  -h, --help        Show this help
  -v, --version     Show version
`;

async function main(argv: string[]): Promise<void> {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      name: { type: "string" },
      host: { type: "string" },
      zone: { type: "string" },
      env: { type: "string" },
      "no-env": { type: "boolean" },
      quick: { type: "boolean" },
      force: { type: "boolean" },
      reauth: { type: "boolean" },
      help: { type: "boolean", short: "h" },
      version: { type: "boolean", short: "v" },
    },
  });

  if (values.version) {
    process.stdout.write("cfld 0.1.0\n");
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
  };

  const [first, ...rest] = positionals;

  // Subcommand dispatch.
  if (first && SUBCOMMANDS.has(first)) {
    switch (first) {
      case "help":
        process.stdout.write(HELP);
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
  } else {
    await runCommand(flags);
  }
}

main(process.argv.slice(2)).catch((err) => {
  printError(err);
  process.exit(1);
});
