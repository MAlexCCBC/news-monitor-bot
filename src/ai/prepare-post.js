import { rewriteArticle } from "./rewrite.js";

// Generated posts have no similarity gate and need no embedding. Old pending
// posts keep their saved text, avoiding another generation request on recovery.
export async function prepareArticlePost(article, { approvedPost, rewrite = rewriteArticle } = {}) {
  if (approvedPost) return approvedPost;
  return (await rewrite(article.fullTextForKeywordCheck)).text;
}
