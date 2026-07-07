/**
 * A user-facing error that carries an actionable hint. The CLI top-level
 * handler prints `message` and, when present, the `hint` on a dimmed line —
 * so failures read as "here's what went wrong and what to do" rather than a
 * stack trace.
 */
export class CfldError extends Error {
  readonly hint?: string;

  constructor(message: string, hint?: string) {
    super(message);
    this.name = "CfldError";
    this.hint = hint;
  }
}

/** Narrow an unknown thrown value to a readable message. */
export function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}
