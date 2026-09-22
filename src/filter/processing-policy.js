// A link explicitly sent to the bot is a user command, not a feed candidate.
// Keep the feed/channel rules intact while making the manual override complete.
export function createArticleProcessingPolicy({
  bypassFilters = false,
  bypassSimilarity = false,
  forceManual = false,
} = {}) {
  return {
    checkSeenUrl: !forceManual,
    checkMinimumContent: !forceManual,
    checkPublishedToday: !forceManual,
    checkKeywords: !forceManual && !bypassFilters,
    checkForeignRelevance: !forceManual && !bypassFilters,
    checkArticleSimilarity: !forceManual && !bypassFilters && !bypassSimilarity,
  };
}
