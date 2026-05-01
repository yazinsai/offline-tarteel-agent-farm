You are planning experiments for offline-tarteel.

Goal: get Browser/RN final sequence ExactSet accuracy above {{TARGET_SEQACC}} on corpus v3 without overfitting, sample-specific hacks, or magic constants.

Repo path: {{TARGET_REPO_PATH}}

Previous attempts and lessons:

{{ATTEMPT_HISTORY}}

Read EXPERIMENTS.md and the streaming tracker code before proposing work. Return only JSON:

[
  {
    "track": "short-kebab-name",
    "hypothesis": "One controlled change, with the invariant it tests and why it could improve v3 Final ExactSet while transferring to v2.",
    "mechanism": "The concrete code-level mechanism to try.",
    "failureMode": "The observed failure cluster or product failure this targets.",
    "expectedMetricMovement": "Example: raise recall without precision loss; reduce false visible jumps; improve long-prefix exact-stable-fail."
  }
]

Rules:
- Prefer structural changes: acoustic evidence, beam/trie evidence, bounded correction, streaming-aware training, diagnostics that classify failure modes.
- Do not propose threshold sweeps as standalone work.
- Do not repeat rejected hypotheses unless the new version changes the mechanism, not just constants.
- Use optimizer score, v2/v3 deltas, worker mechanisms, and failure/regression clusters from attempt history to decide what to try next.
- Reallocate effort toward tracks with positive score or useful dev evidence; avoid tracks where the same mechanism repeatedly regressed v2 or precision.
- Do not propose per-sample, per-surah, reciter-specific, source-specific, or corpus-specific hacks.
- Each hypothesis must be independently falsifiable in one branch.
- Optimize the product contract: finalSequence ExactSetAcc. Raw verse_match commits are guardrails for diagnosing bad streaming emissions, not the primary acceptance metric.
