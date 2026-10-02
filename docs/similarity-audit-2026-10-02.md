# Low-probability manual similarity audit — 2 October 2026

Goal: https://github.com/MAlexCCBC/news-monitor-bot/issues/4

The new user log attachment could not be downloaded: local execution remains
environment_offline. This report does not claim to have identified the exact
30% pair from that log.

## Verified code causes

A raw negative Gemini verdict may be downgraded to uncertain by evidence
validation even at 30% probability. The negative validator required every fact
field and correct paragraph IDs. Then applySimilarityAiReview promoted every
uncertain candidate into isDuplicate=true, even unanchored recent backfill.
The old UI called the comparison an already similar story although the decision
was only unresolved evidence. Percentage is a model estimate, not calibrated
proof, and does not itself override verified duplicate evidence.

## Changes

- Negative validation requires one grounded central difference, not all four
  unrelated fields. Positive duplicate evidence requirements remain intact.
- Wrong negative evidence IDs can be recovered from literal quotes found in
  each respective article body; title-only, invented and cross-article quotes
  cannot repair a result.
- Different concrete objects require distinctive terms grounded on each side;
  sharing only a generic word such as TVA cannot validate invented differences.
  Singular/plural combustibil forms share a concept.
- An unresolved estimate below 50% with a negative/abstention model suggestion
  cannot promote an unanchored candidate into a manual alarm. Existing local
  duplicate evidence, lexical evidence, canonical same-URL identity and raw
  positive model suggestions remain eligible for human review.
- Clearing a weak candidate cannot hide another confirmed duplicate.
- Remaining review cards say verification of evidence and article compared from
  history, with probability of duplicate explicitly labelled. They do not claim
  the comparison is already a similar story.

## Verification

31 synchronous existing/new similarity-policy tests passed in the orchestration
runtime, including the literal 30% regressions. Full Node 22 CI remains required.
The opt-in [similarity-audit] workflow marker runs four Gemini-only full pipeline
arbitration/application cases using the existing secure GitHub secret: duplicate,
different concrete object, unrelated recent story, and proposal versus decision.
The script does not import rewriting/OpenAI and logs no credential.

## Operations

No active Actions job stopped/cancelled/toggled; existing serialization preserved.
No data-branch write, migration or deletion of pending approvals. Existing saved
cards retain their evidence rather than being rewritten blindly without sources.
The active old process keeps its SHA; the new commit waits in the deployment
queue. Exact attachment-pair diagnosis and actual production deployment remain
separate verification tasks.
