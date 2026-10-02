# Image audit — 2 October 2026

Goal: https://github.com/MAlexCCBC/news-monitor-bot/issues/2

Code evidence: history filtered/expired by first insertion rather than last use;
Wikipedia detection failure bypassed the history entirely; explicit LRU and
Wikipedia repeat fallbacks allowed recent duplicates. Eight identity checks
could all be consumed by the first provider.

Changes:
- History reads and cleanup use last_used with legacy created_at fallback.
- Commons original/thumbnail and WordPress size/query variants share identity.
- Recently used photographs are excluded in every fallback path. If no new
  verified photo exists, existing delivery sends the story with its manual
  image warning rather than automatically repeating one.
- Publisher image remains first and requires positive Gemini identity.
- Search starts with the current year, then exact name; six providers run
  concurrently and round-robin candidates share a bounded twelve-check budget,
  with at most six candidates per query to leave room for another search.
- Commons retrieves twenty files and ranks parseable DateTimeOriginal metadata,
  never claiming upload timestamps prove a recent photo. Non-photo MIME types
  and tiny images are excluded; downloads require at least 320px each side.
- Removed misleading unreachable logs about accepting unverified identity.
  Wikipedia fallback also passes positive identity/text verification.

Limitations: canonical URL identity does not detect the same photo reuploaded
under unrelated URLs or modified crops. Current-year search is a preference,
not proof of capture date; Commons capture metadata is contributor supplied.
Existing publisher rights/attribution requirements still apply. This change
does not promise a photograph for every story.

Validation: regression cases cover URL identity, round-robin budgets, Commons
capture-date ranking, and last-use SQLite retention. Full Node 22 validation
runs in the existing Actions workflow. Local execution environment is offline,
so no local shell test or secure credential availability check was possible.
No live GPT/OpenAI or Gemini call was made in this image audit.

Operations: no workflow cancelled, disabled, enabled or modified. No data-branch
write. A running process keeps its previous SHA; the new deployment waits in
the existing serialized Actions group.
