# Agent instructions (offline-tarteel-agent-farm)

Use this doc when touching **Dokku**, **deploys**, or **orchestrator control** so operations are consistent.

## Environment

| Item | Value |
|------|--------|
| Dokku SSH host | `dokku-server` (git remote: `dokku@dokku-server:offline-tarteel-agent-farm`) |
| Dokku app name | `offline-tarteel-agent-farm` |
| Config inside container | `config.dokku.json` |
| Persisted state | `/data/agent-farm/state.json` |
| Pause sentinel (in container) | `/data/agent-farm/PAUSED` (empty file = paused) |
| Pause sentinel (on Dokku host) | `/var/lib/dokku/data/storage/offline-tarteel-agent-farm/agent-farm/PAUSED` |

Optional override in `FarmConfig`: `pauseFilePath`. Env kill-switch (requires redeploy/restart): `AGENT_FARM_PAUSED=1` (or `true` / `yes`).

## One-off commands (always pass config on Dokku)

Pattern:

```bash
ssh dokku-server 'dokku run offline-tarteel-agent-farm npm run <script> -- --config config.dokku.json [extra args]'
```

Working directory in those containers is the app root; `statePath` in dokku config is absolute (`/data/agent-farm/state.json`), so pause/enqueue/status hit the **same** state the daemon uses.

## Pause (before `git push dokku` or risky ops)

**Preferred** (writes PAUSED on the shared volume):

```bash
ssh dokku-server 'dokku run offline-tarteel-agent-farm npm run pause -- --config config.dokku.json'
```

**Equivalent** on the host (no app code needed):

```bash
ssh dokku-server 'touch /var/lib/dokku/data/storage/offline-tarteel-agent-farm/agent-farm/PAUSED'
```

**Behavior when paused:** the daemon / `runLoop` **skips `plan` and starting new workers**. It **still** processes tasks in **`needs-eval`** (Modal eval + judge) so completed worker runs are not stranded.

**Not paused:** long in-flight **worker** runs can still be cut off when Dokku replaces the container; recovery uses existing `evaluating` / stale-worker logic in code.

## Resume

```bash
ssh dokku-server 'dokku run offline-tarteel-agent-farm npm run resume -- --config config.dokku.json'
```

Or on the host: `rm` the `PAUSED` file above.

## Status

```bash
ssh dokku-server 'dokku run offline-tarteel-agent-farm npm run status -- --config config.dokku.json'
```

If paused, the first lines call out **`Farm: PAUSED`** and the pause file path.

## Deploy farm repo to Dokku

From a clone that has the `dokku` git remote:

```bash
git push dokku main
```

**Suggested workflow:** `pause` → confirm backlog/running if needed (`status`) → `git push dokku main` → when stable, `resume`.

## Queue a single task (bypass planner seeds)

```bash
ssh dokku-server 'dokku run offline-tarteel-agent-farm npm run enqueue -- --config config.dokku.json --track <slug> --hypothesis '"'"'<one shell-quoted string>'"'"' [--force]'
```

`--force` bypasses duplicate `track`+`hypothesis` detection.

## Planner / seeds

- `npm run plan` — non-AI: uses `src/planner.ts` `seedHypotheses` (dedupes against all tasks in state).
- `npm run plan -- --ai` — Cursor planner; daemon on Dokku may already use `--ai` (check `Procfile` / start command).

Daemon refills the queue when `queued < minQueuedTasks` (see `config.dokku.json` `minQueuedTasks`) **only if not paused**.

## Reading live state as JSON (advanced)

```bash
ssh dokku-server 'dokku run offline-tarteel-agent-farm cat /data/agent-farm/state.json' | head -c 200000
```

Use sparingly (large file). Prefer `status` first.
