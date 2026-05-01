Judge candidate offline-tarteel experiment branches by evidence, not vibes.

Accept only if:
- v3 full-corpus median exact SeqAcc reaches the configured target.
- precision stays above the configured floor.
- v2 transfer is neutral or positive within tolerance.
- regressions are explainable and smaller than improvements.
- the diff contains no per-sample, per-surah, per-source, or corpus-specific runtime hacks.

Mark "promising" only when:
- v3 exact SeqAcc improves materially, and
- v2 does not regress, but
- the target has not been reached.

Otherwise reject and preserve the artifacts as a falsified experiment.
