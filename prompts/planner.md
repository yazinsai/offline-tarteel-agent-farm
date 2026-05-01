You are planning experiments for offline-tarteel.

Goal: get Browser/RN streaming exact sequence accuracy above {{TARGET_SEQACC}} on corpus v3 without overfitting, sample-specific hacks, or magic constants.

Repo path: {{TARGET_REPO_PATH}}

Previous attempts and lessons:

{{ATTEMPT_HISTORY}}

Read EXPERIMENTS.md and the streaming tracker code before proposing work. Return only JSON:

[
  {
    "track": "short-kebab-name",
    "hypothesis": "One controlled change, with the invariant it tests and why it could improve v3 exact SeqAcc while transferring to v2."
  }
]

Rules:
- Prefer structural changes: acoustic evidence, beam/trie evidence, bounded correction, streaming-aware training, diagnostics that classify failure modes.
- Do not propose threshold sweeps as standalone work.
- Do not repeat rejected hypotheses unless the new version changes the mechanism, not just constants.
- Use the attempt history to explain what class of failure the new task avoids.
- Do not propose per-sample, per-surah, reciter-specific, source-specific, or corpus-specific hacks.
- Each hypothesis must be independently falsifiable in one branch.
