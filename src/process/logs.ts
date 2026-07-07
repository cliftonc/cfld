import pc from "picocolors";

/**
 * Prettify cloudflared's structured log lines into something calm and
 * dev-friendly. cloudflared writes level=... msg=... key=val pairs to stderr.
 */

export interface ParsedLog {
  level: string;
  message: string;
}

const LEVEL_RE = /level=(\w+)/;
const MSG_RE = /msg="([^"]*)"|msg=(\S+)/;

export function parseLogLine(line: string): ParsedLog | undefined {
  const trimmed = line.trim();
  if (!trimmed) return undefined;
  const level = trimmed.match(LEVEL_RE)?.[1] ?? "info";
  const msgMatch = trimmed.match(MSG_RE);
  const message = msgMatch?.[1] ?? msgMatch?.[2] ?? trimmed;
  return { level, message };
}

/** Format a parsed log line with a colored level tag. */
export function formatLogLine(line: string): string | undefined {
  const parsed = parseLogLine(line);
  if (!parsed) return undefined;

  // Suppress the noisy per-connection registration chatter once running.
  if (/Registered tunnel connection|Unregistered tunnel connection/.test(parsed.message)) {
    return undefined;
  }

  const tag = colorLevel(parsed.level);
  return `${tag} ${parsed.message}`;
}

function colorLevel(level: string): string {
  switch (level.toLowerCase()) {
    case "error":
    case "fatal":
      return pc.red("✖");
    case "warn":
      return pc.yellow("!");
    case "debug":
      return pc.dim("·");
    default:
      return pc.dim("›");
  }
}
