# offline-tarteel-agent-farm

Cursor SDK harness for running long-lived experiment agents against `offline-tarteel`.

This repo is intentionally separate from the target repo. It stores orchestration state, prompts, logs, and agent metadata here, while workers create branches/worktrees inside `offline-tarteel`.

## Setup

```bash
cd /Users/yazin/projects/offline-tarteel-agent-farm
npm install
cp config.example.json config.json
```

Edit `config.json`:

- `targetRepoPath`: local path to `offline-tarteel`
- `targetRepoUrl`: Git URL for cloud agents
- `mode`: `local` for local Cursor SDK agents, `cloud` for Cursor cloud agents
- `model`: Cursor model id

Set your Cursor key:

```bash
export CURSOR_API_KEY=...
```

## First Run

Build deterministic v3 dev/holdout corpora in the target repo:

```bash
npm run build-splits
```

Seed the task queue:

```bash
npm run plan
```

Use AI planning instead:

```bash
npm run plan -- --ai
```

Run one local worker:

```bash
npm run work
```

Evaluate the task it produced:

```bash
npm run status
npm run eval -- --task task-YYYYMMDDHHMMSS-xxxxx
npm run judge -- --task task-YYYYMMDDHHMMSS-xxxxx
```

Run a full sequential cycle:

```bash
npm run loop -- --cycles 1
```

Run continuously:

```bash
npm run daemon -- --sleep-seconds 60
```

## Dokku

This app is intended to run as a worker-only Dokku app. Persistent state and the target repo live under `/data`, mounted from Dokku storage.

Server setup:

```bash
dokku apps:create offline-tarteel-agent-farm
dokku storage:ensure-directory offline-tarteel-agent-farm
dokku storage:mount offline-tarteel-agent-farm /var/lib/dokku/data/storage/offline-tarteel-agent-farm:/data
dokku config:set offline-tarteel-agent-farm CURSOR_API_KEY=...
dokku ps:scale offline-tarteel-agent-farm web=0 worker=1
```

Sync the target repo into the mounted storage:

```bash
rsync -a --delete \
  --exclude node_modules \
  --exclude .venv \
  --exclude .worktrees \
  /Users/yazin/projects/offline-tarteel/ \
  dokku-server:/var/lib/dokku/data/storage/offline-tarteel-agent-farm/offline-tarteel/
```

Deploy the farm:

```bash
git remote add dokku dokku-server:offline-tarteel-agent-farm
git push dokku main
```

One-off commands:

```bash
ssh dokku-server 'dokku run offline-tarteel-agent-farm npm run status -- --config config.dokku.json'
ssh dokku-server 'dokku run offline-tarteel-agent-farm npm run build-splits -- --config config.dokku.json'
```

Dokku evals default to one shard and `cpuLimitPercent: 70` so ONNX stability runs do not monopolize the box. Override temporarily if you want a faster burn:

```bash
ssh dokku-server 'dokku run offline-tarteel-agent-farm env EVAL_PARALLEL_SHARDS=4 EVAL_CPU_LIMIT_PERCENT=100 npm run eval -- --config config.dokku.json --task <task-id>'
```

## Modal Evaluation

Stability shards can run on Modal instead of the local/Dokku host:

```bash
modal setup
EVAL_REMOTE=modal EVAL_PARALLEL_SHARDS=8 EVAL_MODAL_CPU=4 EVAL_MODAL_MEMORY_MB=8192 npm run eval -- --task <task-id>
```

The evaluator creates one tarball per shard, runs it through a Modal Sandbox wrapper, prints the shard JSON artifact back to the coordinator, then merges reports locally. GPU is not used by default; the current ONNX runner is CPU-bound via `onnxruntime-node`.

## Cloud Mode

Set this in `config.json`:

```json
{
  "mode": "cloud",
  "targetRepoUrl": "git@github.com:YOUR_ORG/offline-tarteel.git"
}
```

Then:

```bash
npm run work
```

Cloud mode starts a Cursor cloud run and records `cursorRunId` / `cursorAgentId` in `runs/state.json`. Pull the resulting branch locally before running `eval` if the worker pushed changes from cloud.

## Planning Memory

`runs/state.json` stores every task, run, metric, and judge decision. AI planning (`npm run plan -- --ai`) includes the last 30 attempts and their lessons in the planner prompt, and the planner skips exact duplicate hypotheses. Seed planning (`npm run plan`) only queues the built-in seed tracks that have not already been queued.

## Analysis

Compare any two stability reports:

```bash
npm run analyze -- \
  --baseline /Users/yazin/projects/offline-tarteel/web/frontend/test/stab-gate-on-v3.json \
  --candidate /Users/yazin/projects/offline-tarteel/.worktrees/<branch>/web/frontend/test/agent-farm/<task>/test_corpus_v3-r5.json
```

## State

State lives in:

```txt
runs/state.json
runs/<task-id>.log
```

Target repo artifacts are written under:

```txt
offline-tarteel/web/frontend/test/agent-farm/<task-id>/
```

## Acceptance Policy

The judge accepts only when:

- full v3 median exact SeqAcc reaches `evaluation.targetSeqAcc`
- v3 median precision is above `evaluation.minPrecision`
- v2 does not regress beyond `evaluation.v2SeqAccRegressionTolerance`
- sample regressions are not broad or suspicious

Everything else is either `promising` or `rejected`; both keep raw artifacts.
