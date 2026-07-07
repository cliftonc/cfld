# cfld

**`cfld` = cloudflare local dev.**

**One command to give your localhost a permanent public HTTPS URL — no API tokens, no teardown.**

`cfld` wraps [`cloudflared`](https://github.com/cloudflare/cloudflared) into a frictionless dev experience: the **same** custom URL every run (not a random `trycloudflare.com` one), authorized with a **browser login** (zero API tokens), reusing the same named tunnel and DNS record across restarts instead of churning them. It runs a **live dashboard** (URL, connection count, request/latency counters, tailing logs), **auto-reconnects** on edge blips, and **guards** against stealing a DNS record that belongs to another tunnel.

## Getting started

**New here? Just run this — it walks you through everything, no account or config needed to start:**

```bash
npx @cliftonc/cfld setup
```

`setup` is the front door. It checks `cloudflared` for you, then lets you pick:

1. **A public URL right now** — free, no account, no domain (a temporary `trycloudflare.com` URL). Great for a webhook, a demo, or just trying it.
2. **A persistent custom URL** — opens the browser to sign in (or **sign up** — it's free), then wires up the same URL for every future run.

You don't even have to remember `setup`: the **first time you run bare `cfld`** in a fresh project, it drops you into this same guided flow so you're never stuck guessing.

Already know what you want? Skip straight to it:

```bash
# instant public URL in seconds — no account, no config
npx @cliftonc/cfld --quick 3000   # temporary trycloudflare.com URL

# the everyday command — reuse-or-create your persistent tunnel and go live
npx @cliftonc/cfld            # detect your dev port, go live on the same URL
npx @cliftonc/cfld 3000       # explicit port

# or install once and use the short `cfld` command everywhere
npm i -g @cliftonc/cfld
cfld setup
```

### What it costs

`cfld` is built to get you going at zero → near-zero cost, and it's honest about the one thing it can't automate:

- **Instant URL** — `cfld --quick`: **free**, no account, no domain. The URL is temporary and changes each run.
- **Cloudflare account** — **free**. `cfld` opens the browser to sign in (the same page has a **Sign up** link); there's no API token to create. Account signup itself can't be scripted — Cloudflare requires a browser, terms acceptance, and email verification.
- **Persistent custom URL** — needs a **domain on Cloudflare**. Free if you already own one (just add the site); otherwise a domain is a few dollars/year via [Cloudflare Registrar](https://dash.cloudflare.com/?to=/:account/domains/register). No account has a free permanent subdomain.

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
| `cfld --quick [port]` | Instant `trycloudflare.com` URL — no account, no cert/domain (temporary). |
| `cfld setup` | Guided first-run — pick the instant free URL or set up a persistent one. |
| `cfld [port]` | Ensure + run a persistent tunnel (reuses the same URL). |
| `cfld login [--reauth]` | Authorize with Cloudflare in your browser. `--reauth` adds another domain. |
| `cfld init` | Configure a persistent tunnel without running it. |
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

## Running alongside your dev server

Give `cfld` your dev command after a `--` and it runs both as one managed unit:

```bash
cfld 3000 -- next dev
```

`cfld` will:

- **boot your dev server** as a managed child, with `PUBLIC_URL` already in its environment (so it can read its own public URL for webhooks/OAuth callbacks — no `.env` round-trip needed);
- **wait for `:3000` to actually listen** before flipping to `● LIVE`, so the URL never serves a 502 the moment you reveal it;
- **stream your dev server's logs** into the same dashboard as the tunnel — one unified view;
- **stop both on a single Ctrl-C**, gracefully, leaving the tunnel + DNS intact so the next run reuses the same URL;
- **exit if your dev server exits**, propagating its exit code (the tunnel is still preserved).

The pass-through form (`-- <cmd>`) runs your command directly. If you need shell features (pipes, `&&`, globs), use the string form instead:

```bash
cfld 5173 --exec "npm run dev"
```

This works with `--quick` too, when you don't have a domain set up yet:

```bash
cfld --quick 3000 -- next dev
```

Wire it into `package.json` so the whole team gets the same public URL:

```jsonc
{
  "scripts": {
    "dev": "next dev",
    "dev:tunnel": "cfld 3000 -- next dev"
  }
}
```

> **Tip:** commit a `"cfld": { "zone": "example.com", "name": "myapp" }` block to `package.json` so the URL is deterministic for the whole team — everyone's `dev:tunnel` maps to `myapp.example.com`.

<details>
<summary>Prefer to keep the two processes separate?</summary>

`cfld` also works fine standalone — it only needs the port, and tolerates the app not being up yet (502 until it starts, then recovers). Run them with [`concurrently`](https://www.npmjs.com/package/concurrently):

```jsonc
"dev:tunnel": "concurrently -k -n app,cfld -c blue,magenta \"npm:dev\" \"cfld 3000\""
```

or plain shell: `cfld 3000 & next dev`.

</details>

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
