# Fire-admission audit — 2 October 2026

Goal: https://github.com/MAlexCCBC/news-monitor-bot/issues/3

## Evidence

The user's new log attachment could not be downloaded because the execution
environment is offline. Logs for active bot job 110696853907 are unavailable
through the connector until completion. This checkpoint therefore does not
claim to have identified the exact offending record in that attachment.

Direct code inspection confirmed independent admission paths:
1. A title mentioning a minister/prime minister/mayor/government could trigger
   the political fast path even when its subject was a local fire.
2. The major-emergency helper accepted burned hectares as exceptional
   deployment and did not require a domestic, multi-region/national response.
3. Digi24's generic article/body fallback could read page furniture when the
   known story container was absent. Related-story layouts outside the known
   carousel selectors were not explicitly excluded.

## Changes

- Incident headlines always require grounded relevance review. Political fast
  paths cannot skip that review merely because an official is named.
- Incident review uses Gemini JSON categories with source quotes. Positive
  decisions require matching evidence in title/excerpt, Romanian context,
  and additional category-specific checks. Routine local firefighting,
  RO-Alert, local Planul Rosu, casualties and official notifications remain
  OTHER. Missing, malformed or invented evidence fails closed.
- Political relevance requires a policy/accountability development in the
  headline, not an incidental official notification. National security remains
  eligible when the principal event involves attacks/drones/defence and a
  demonstrated Romanian connection.
- Major vegetation-fire exceptions require Romanian context, multi-county or
  national emergency evidence, and exceptional aircraft/personnel resources.
  Burned area alone is not personnel deployment.
- Digi24 prefers its body over the wrapper; nested articles/cards/related
  blocks/captions are removed. Missing known story containers fail extraction
  rather than scrape the whole page. Other publishers' fallback behavior is
  unchanged.
- Explicit user-sent manual links and intentionally configured bypass channels
  retain existing overrides; these are not automatic editorial approvals.

## Validation and live benchmark

Seven pure evidence-policy examples passed in the orchestration runtime.
Additional Node 22 regressions cover unsupported positive categories, fabricated
quotes, malformed JSON, fire headlines naming officials, legitimate political
accountability, Romanian drone security, national mobilization, and Digi24
alternate recommendation/missing-container layouts.

A bounded opt-in step runs only on push commits marked [fire-audit], inside the
existing validation job. It passes only GEMINI_API_KEY from GitHub Secrets to
scripts/audit-fire-gemini.js; no OpenAI secret, rewrite import or GPT call is
used. It tests seven labelled synthetic cases and two real public Digi24 pages
(Nantes 3972755 and Sibiu 3973937), reporting publisher extraction separately.
Publisher/model outages are blockers, not counted as successful tests.
The marker avoids repeated live calls on normal future pushes.

## Operations and limits

No Actions run stopped/cancelled/toggled; concurrency and run job unchanged.
No data branch edit. Validation uses an ephemeral checkout database only.
Existing active job keeps SHA a9ae1a1 until it exits naturally; pushes queue
the new bot behind it. This is a tested hardening checkpoint, not a guarantee
that an arbitrary future publisher layout or model output cannot fail.
