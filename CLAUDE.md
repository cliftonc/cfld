# cfld

**`cfld` = cloudflare local dev.** A zero-token, persistent Cloudflare tunnel CLI
for local development — the same public HTTPS URL every run, authorized with a
browser login (no API tokens), wrapping `cloudflared`.

## Layout

- `src/cli.ts` — entry point, arg parsing, subcommand dispatch.
- `src/commands/` — one file per command (`setup`, `run`, `quick`, `login`, `init`,
  `list`, `status`, `up`, `destroy`, `service`, `doctor`).
- `src/core/` — the domain logic: `cloudflared.ts` (the single `cloudflared` wrapper),
  `state-machine.ts` (`reconcile` — Cloudflare is the source of truth), `cert*.ts`
  (per-zone cert store), `config-file.ts`, `registry.ts`, `project-config.ts`.
- `src/process/` — long-lived process supervision (`runner`, `quick`, `child`).
- `src/ui/` — `dashboard.tsx` (ink), `output.ts` (linear renderer), `prompts.ts`.
- `test/` — vitest; pure helpers use temp dirs, cert/registry paths are redirected
  via `CFLD_HOME` / `CLOUDFLARED_HOME`.

## Dev

```bash
npm run typecheck   # tsc --noEmit
npm test            # vitest run
npm run build       # tsup → dist/
```

## Releasing

Publishing is gated to a **GitHub Release** (see `.github/workflows/publish.yml`,
which runs on `release: published` and does `npm publish --provenance`). Do **not**
`npm publish` by hand — it needs a 2FA OTP and bypasses CI. The flow is:

1. `npm version patch` (or `minor` / `major`) — bumps `package.json`, commits, and
   tags `vX.Y.Z`. Commit your feature work first (the tree must be clean).
2. `git push origin main && git push origin vX.Y.Z` — push the commit and the tag.
3. `gh release create vX.Y.Z --title "…" --notes "…"` — creating the Release is the
   deliberate trigger that runs the publish workflow. A bare tag push does not publish.

## Conventions

- Every `cloudflared` invocation goes through `src/core/cloudflared.ts` /
  `src/util/exec.ts` (the single choke point — mock `exec` to test).
- Zero-token by design: authority comes from `cloudflared`'s `cert.pem`, never an API
  token. Account signup can't be scripted (browser + ToS + email), so onboarding
  sets expectations and deep-links instead.
