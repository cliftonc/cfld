import { CfldError } from "../util/errors.js";

/**
 * Lazy wrappers around @clack/prompts so the heavy prompt UI is only loaded on
 * interactive paths (never on `--quick`/CI). Each throws a clean CfldError on
 * cancel.
 */

type ClackModule = typeof import("@clack/prompts");

async function clack(): Promise<ClackModule> {
  return import("@clack/prompts");
}

function ensure<T>(value: T | symbol, p: ClackModule): T {
  if (p.isCancel(value)) throw new CfldError("Cancelled.");
  return value as T;
}

export async function askText(
  message: string,
  placeholder?: string,
): Promise<string> {
  const p = await clack();
  const value = await p.text({ message, placeholder });
  return ensure(value, p);
}

export async function askSelect<T extends string | number>(
  message: string,
  options: { value: T; label: string }[],
): Promise<T> {
  const p = await clack();
  // clack's Option typing is stricter than we need; the shape is correct.
  const select = p.select as (args: {
    message: string;
    options: { value: T; label: string }[];
  }) => Promise<T | symbol>;
  const value = await select({ message, options });
  return ensure(value, p);
}

export async function askConfirm(message: string): Promise<boolean> {
  const p = await clack();
  const value = await p.confirm({ message });
  return ensure(value, p);
}
