Judge candidate offline-tarteel experiment branches by evidence, not vibes.

Accept only if:
- v3 full-corpus finalSequence median ExactSetAcc reaches the configured target.
- finalSequence precision stays above the configured floor.
- v2 transfer is neutral or positive within tolerance.
- rawCommits precision/recall/ExactSet/OrderedSeq do not hide bad verse_match emissions; treat them as engineering guardrails, not product acceptance.
- regressions are explainable and smaller than improvements.
- the diff contains no per-sample, per-surah, per-source, or corpus-specific runtime hacks.

Mark "promising" only when:
- v3 Final ExactSet improves materially, and
- v2 does not regress, but
- the target has not been reached.

Otherwise reject and preserve the artifacts as a falsified experiment.
