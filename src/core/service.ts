import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir, platform } from "node:os";
import { join } from "node:path";
import { resolveBinaryAbsolute } from "./cloudflared.js";
import { exec } from "../util/exec.js";
import { cfldDir } from "../util/paths.js";
import { CfldError } from "../util/errors.js";

/**
 * Always-on service management: register a tunnel as a macOS LaunchAgent or a
 * Linux systemd *user* service so it survives logout/reboot. This is the opt-in
 * "v1" persistence — the foreground `cfld` run remains the dev default.
 *
 * The unit-file renderers are pure (and unit-tested); only install/uninstall/
 * start/stop/status touch the system.
 */
export interface ServiceSpec {
  /** Tunnel name, e.g. cfld-myapp. */
  name: string;
  binPath: string;
  certPath: string;
  configPath: string;
}

/** The short slug (cfld-myapp → myapp) used in labels/filenames. */
export function serviceSlug(name: string): string {
  return name.replace(/^cfld-/, "");
}

export function launchAgentLabel(name: string): string {
  return `com.cfld.${serviceSlug(name)}`;
}

function launchAgentPath(name: string): string {
  return join(homedir(), "Library", "LaunchAgents", `${launchAgentLabel(name)}.plist`);
}

function systemdUnitName(name: string): string {
  return `cfld-${serviceSlug(name)}.service`;
}

function systemdUnitPath(name: string): string {
  return join(homedir(), ".config", "systemd", "user", systemdUnitName(name));
}

function logDir(): string {
  return join(cfldDir(), "logs");
}

// ---------- pure renderers ----------

export function renderLaunchAgent(spec: ServiceSpec): string {
  const args = [
    spec.binPath,
    "tunnel",
    "--origincert",
    spec.certPath,
    "--config",
    spec.configPath,
    "run",
    spec.name,
  ];
  const argsXml = args.map((a) => `    <string>${escapeXml(a)}</string>`).join("\n");
  const out = join(logDir(), `${serviceSlug(spec.name)}.out.log`);
  const err = join(logDir(), `${serviceSlug(spec.name)}.err.log`);
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${launchAgentLabel(spec.name)}</string>
  <key>ProgramArguments</key>
  <array>
${argsXml}
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>TUNNEL_ORIGIN_CERT</key>
    <string>${escapeXml(spec.certPath)}</string>
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>${escapeXml(out)}</string>
  <key>StandardErrorPath</key>
  <string>${escapeXml(err)}</string>
</dict>
</plist>
`;
}

export function renderSystemdUnit(spec: ServiceSpec): string {
  const execStart = [
    spec.binPath,
    "tunnel",
    "--origincert",
    spec.certPath,
    "--config",
    spec.configPath,
    "run",
    spec.name,
  ].join(" ");
  return `[Unit]
Description=cfld tunnel ${spec.name}
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
Environment=TUNNEL_ORIGIN_CERT=${spec.certPath}
ExecStart=${execStart}
Restart=always
RestartSec=5

[Install]
WantedBy=default.target
`;
}

// ---------- platform operations ----------

export type ServiceState = "running" | "installed" | "not-installed";

function assertSupported(): "darwin" | "linux" {
  const p = platform();
  if (p === "darwin" || p === "linux") return p;
  throw new CfldError(
    `Service install is not supported on ${p}.`,
    "Run `cfld` in the foreground, or use a process manager of your choice.",
  );
}

export async function installService(spec: ServiceSpec): Promise<void> {
  const p = assertSupported();
  mkdirSync(logDir(), { recursive: true });
  if (p === "darwin") {
    const path = launchAgentPath(spec.name);
    mkdirSync(join(homedir(), "Library", "LaunchAgents"), { recursive: true });
    writeFileSync(path, renderLaunchAgent(spec), "utf8");
    // Reload cleanly if already present.
    await exec("launchctl", ["unload", path]);
    const res = await exec("launchctl", ["load", "-w", path]);
    if (res.code !== 0) {
      throw new CfldError(
        "Failed to load the LaunchAgent.",
        res.stderr.trim() || undefined,
      );
    }
  } else {
    const path = systemdUnitPath(spec.name);
    mkdirSync(join(homedir(), ".config", "systemd", "user"), { recursive: true });
    writeFileSync(path, renderSystemdUnit(spec), "utf8");
    await exec("systemctl", ["--user", "daemon-reload"]);
    const res = await exec("systemctl", [
      "--user",
      "enable",
      "--now",
      systemdUnitName(spec.name),
    ]);
    if (res.code !== 0) {
      throw new CfldError(
        "Failed to enable the systemd user service.",
        res.stderr.trim() ||
          "You may need `loginctl enable-linger $USER` so it runs without an active login.",
      );
    }
  }
}

export async function uninstallService(name: string): Promise<void> {
  const p = assertSupported();
  if (p === "darwin") {
    const path = launchAgentPath(name);
    if (existsSync(path)) {
      await exec("launchctl", ["unload", "-w", path]);
      rmSync(path, { force: true });
    }
  } else {
    const unit = systemdUnitName(name);
    await exec("systemctl", ["--user", "disable", "--now", unit]);
    const path = systemdUnitPath(name);
    if (existsSync(path)) rmSync(path, { force: true });
    await exec("systemctl", ["--user", "daemon-reload"]);
  }
}

export async function serviceControl(name: string, action: "start" | "stop"): Promise<void> {
  const p = assertSupported();
  if (p === "darwin") {
    await exec("launchctl", [action, launchAgentLabel(name)]);
  } else {
    await exec("systemctl", ["--user", action, systemdUnitName(name)]);
  }
}

export async function serviceState(name: string): Promise<ServiceState> {
  const p = assertSupported();
  if (p === "darwin") {
    if (!existsSync(launchAgentPath(name))) return "not-installed";
    const res = await exec("launchctl", ["list", launchAgentLabel(name)]);
    if (res.code !== 0) return "installed";
    // A numeric "PID" key present and non-zero means it's running.
    return /"PID"\s*=\s*\d+/.test(res.stdout) ? "running" : "installed";
  } else {
    if (!existsSync(systemdUnitPath(name))) return "not-installed";
    const res = await exec("systemctl", ["--user", "is-active", systemdUnitName(name)]);
    return res.stdout.trim() === "active" ? "running" : "installed";
  }
}

/** Convenience: build a spec from resolved paths. */
export async function buildSpec(
  name: string,
  certPath: string,
  configPath: string,
): Promise<ServiceSpec> {
  return { name, certPath, configPath, binPath: await resolveBinaryAbsolute() };
}

function escapeXml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}
