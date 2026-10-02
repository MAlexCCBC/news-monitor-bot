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
- Explicit user-sent manual links retain their override. Automatic Digi24
  incidents require review even if their channel is configured to bypass normal
  editorial filters; unrelated bypass channels retain their behavior.

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

## Regression caught before deployment

The first Node 22 validation rejected checkpoint fc4e762 because the negative
fixture's phrase "no military aircraft or national emergency" still matched
emergency vocabulary. The benchmark and bot job did not run for that failed
validation. The next checkpoint excludes clauses explicitly negating resources,
mobilization or emergency facts; this is tested rather than removing the case.
Incident detection now also covers the clean lead, so a headline about an
official's announcement cannot hide a fire described only in the opening body.

## Validated live checkpoint

Commit 72e0510 passed 232/232 offline tests and syntax validation in Node 22:
run 36995027590, validation job 110799681991. On 2 October 2026 at
10:21:49–10:21:55 UTC, gemini-3.5-flash-lite passed all seven labelled synthetic
cases and both real-article reviews (nine live Gemini classifications total).
No GPT/OpenAI live test was called.

Real publisher extraction: Nantes yielded 1,236 characters, Sibiu 1,045,
both containing the incident and neither containing the checked political
contaminants. Both received OTHER/false relevance. Political accountability,
Romanian drone security, and coordinated national firefighting were accepted.

Final route follow-up: automatic Digi24 incident review now survives a
channel-level bypass, while explicit manual links remain user overrides.
This route is covered by offline regressions; classification behavior is
unchanged from the live validated checkpoint.

The specific new uploaded log remains unreadable because its download requires
the disconnected execution environment. Active production process still runs
the old SHA; the validated bot deployment is pending rather than already live.
