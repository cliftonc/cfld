# cfld

**One command to give your localhost a permanent public HTTPS URL — no API tokens, no teardown.**

`cfld` wraps [`cloudflared`](https://github.com/cloudflare/cloudflared) into a frictionless dev experience: the **same** custom URL every run (not a random `trycloudflare.com` one), authorized with a **browser login** (zero API tokens), reusing the same named tunnel and DNS record across restarts instead of churning them. It runs a **live dashboard** (URL, connection count, request/latency counters, tailing logs), **auto-reconnects** on edge blips, and **guards** against stealing a DNS record that belongs to another tunnel.

```bash
# one-off, no install
npx @cliftonc/cfld            # detect your dev port, reuse-or-create a tunnel, go live
npx @cliftonc/cfld 3000       # explicit port
npx @cliftonc/cfld --quick    # ephemeral trycloudflare.com URL — no domain needed

# or install once and use the short `cfld` command everywhere
npm i -g @cliftonc/cfld
cfld
```

## Why not just `cloudflared`?

The persistent-tunnel flow normally means: create an API token in the dashboard, find your zone/account IDs, `tunnel create`, hand-write a `config.yml`, `route dns`, and remember not to delete anything. `cfld` collapses all of that into one idempotent command and adds the dev niceties (auto port detection, deterministic hostname, `.env` write-back, a live status view).

Compared to the alternatives:

- **[untun](https://github.com/unjs/untun)** — random URLs only (quick tunnels). `cfld` gives you a stable one.
- **[cf-tunnel](https://github.com/jasenmichael/cf-tunnel)** — needs an API token and **tears the tunnel + DNS down on exit**. `cfld` uses browser login and **preserves** resources so the URL is truly persistent.
- **[@agencyhandy/tunneler](https://github.com/AgencyHandy/tunneler)** — global install + API token + zone id. `cfld` is `npx`-first and zero-token.

## Requirements

- **Node.js ≥ 18**
- **A domain on Cloudflare** (nameservers pointed at Cloudflare) for a persistent custom URL. Don't have one yet? `cfld` guides you, and `cfld --quick` works immediately with an ephemeral URL.
- `cloudflared` — used from your `PATH` if present, otherwise auto-downloaded via the optional [`cloudflared`](https://www.npmjs.com/package/cloudflared) npm package.

## How it works

Every run reconciles four things, treating **Cloudflare as the source of truth** and local files as a cache:

1. **Cert** — per-domain cert stored at `~/.cfld/certs/<zone>.pem`, obtained once via `cloudflared tunnel login` (browser, no token) and selected with `--origincert` so **multiple domains coexist** on one machine.
2. **Tunnel** — reused by name (`cfld-<slug>`) if it exists, created only if absent. Never deleted on exit.
3. **DNS** — `route dns --overwrite-dns` points `<slug>.<zone>` at the tunnel (idempotent).
4. **Config** — a generated ingress file + your public URL written into `./.env` (`PUBLIC_URL` by default).

A machine-wide registry at `~/.cfld/registry.json` indexes every tunnel, so you can manage them from anywhere.

## Commands

| Command | What it does |
|---|---|
| `cfld [port]` | Ensure + run a persistent tunnel (reuses the same URL). |
| `cfld --quick [port]` | Ephemeral `trycloudflare.com` URL — no cert/domain. |
| `cfld login [--reauth]` | Authorize with Cloudflare in your browser. `--reauth` adds another domain. |
| `cfld init` | Interactive setup wizard — configure a project without running it. |
| `cfld list` | List all tunnels across projects/domains. |
| `cfld status [name]` | Show details for a tunnel. |
| `cfld up <name>` | Run a registered tunnel by name from anywhere. |
| `cfld destroy [name]` | Delete a tunnel (explicit, opt-in). |
| `cfld service <action> [name]` | Always-on background service: `install`/`uninstall`/`start`/`stop`/`status`. |
| `cfld doctor` | Diagnose your setup. |

### Options

```
--name <slug>     Override the project name (default: package.json name / dir)
--host <fqdn>     Explicit public hostname (e.g. api.example.com)
--zone <domain>   Cloudflare domain to use (e.g. example.com)
--env <KEY>       .env key to write the URL to (default: PUBLIC_URL)
--no-env          Don't write the URL to .env
--force           Skip confirmation (destroy)
```

## Configuration (optional)

Everything is inferred by default, but you can commit intent to `package.json` under a `"cfld"` key. Authored values win over the machine-local `.cfld.json` cache (so edits take effect immediately); only the resolved tunnel UUID comes from the cache.

```jsonc
{
  "cfld": {
    "zone": "example.com",
    "name": "myapp",          // → myapp.example.com
    "envKey": "PUBLIC_URL"
  }
}
```

### Multiple services from one tunnel (multi-ingress)

Expose an API and a web app at once with a `routes` array:

```jsonc
{
  "cfld": {
    "zone": "example.com",
    "routes": [
      { "name": "app", "port": 3000 },                 // app.example.com → :3000
      { "name": "api", "port": 8080, "path": "/v1" },  // api.example.com/v1 → :8080
      { "host": "hooks.example.com", "port": 4000 }    // explicit hostname
    ]
  }
}
```

The first route is the primary (used for the dashboard and `.env`). Every hostname is routed and DNS-guarded.

## Always-on service

The foreground `cfld` is the dev default. To keep a tunnel up across logout/reboot, install it as a background service (macOS **LaunchAgent** / Linux **systemd user** unit):

```bash
cfld service install      # register + start
cfld service status
cfld service uninstall    # stop + remove (tunnel + DNS preserved)
```

Windows service management is not supported — run `cfld` in the foreground there.

## Development

```bash
npm install
npm run build      # tsup → dist/
npm test           # vitest unit + integration tests
npm run typecheck  # tsc --noEmit
```

The primary end-to-end check needs no domain or paid plan: `cfld --quick` against a local server, then fetch the resulting URL and assert the response round-trips through Cloudflare's edge.

## License

MIT
