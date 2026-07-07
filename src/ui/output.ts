import boxen from "boxen";
import pc from "picocolors";
import { CfldError } from "../util/errors.js";

/**
 * The linear (non-TTY / fallback) renderer. The ink live dashboard (v0.2) layers
 * on top of the same events; this module is always safe and dependency-light.
 */

export function isInteractive(): boolean {
  return Boolean(process.stdout.isTTY) && !process.env.CI;
}

export function step(message: string): void {
  process.stderr.write(`${pc.cyan("›")} ${message}\n`);
}

export function done(message: string): void {
  process.stderr.write(`${pc.green("✔")} ${message}\n`);
}

export function info(message: string): void {
  process.stderr.write(`  ${message}\n`);
}

export function warn(message: string): void {
  process.stderr.write(`${pc.yellow("!")} ${message}\n`);
}

export function note(message: string): void {
  process.stderr.write(`${pc.dim(message)}\n`);
}

export interface LiveSummary {
  url: string;
  target: string;
  tunnelName: string;
  connections: number;
  /** Quick/ephemeral tunnels get a different, honest footer. */
  ephemeral?: boolean;
}

/** The boxed "your tunnel is live" summary printed on ready. */
export function summaryBox(s: LiveSummary): void {
  const footer = s.ephemeral
    ? `ephemeral · URL changes each run · run \`cfld\` for a persistent URL`
    : `URL preserved on Ctrl-C · re-run to resume · cfld destroy to remove`;
  const lines = [
    `${pc.green("● LIVE")}   ${pc.bold(pc.cyan(s.url))}`,
    `${pc.dim("→")} ${s.target}   ${pc.dim(`${s.connections} edge conns`)}`,
    ``,
    pc.dim(`tunnel: ${s.tunnelName}`),
    pc.dim(footer),
  ];
  process.stdout.write(
    boxen(lines.join("\n"), {
      padding: { top: 0, bottom: 0, left: 1, right: 1 },
      borderColor: "cyan",
      borderStyle: "round",
      title: "cfld",
      titleAlignment: "left",
    }) + "\n",
  );
}

/** Render a CfldError (or any error) with an actionable hint. */
export function printError(err: unknown): void {
  if (err instanceof CfldError) {
    process.stderr.write(`\n${pc.red("✖")} ${err.message}\n`);
    if (err.hint) process.stderr.write(`${pc.dim("  " + err.hint)}\n`);
  } else if (err instanceof Error) {
    process.stderr.write(`\n${pc.red("✖")} ${err.message}\n`);
  } else {
    process.stderr.write(`\n${pc.red("✖")} ${String(err)}\n`);
  }
}
