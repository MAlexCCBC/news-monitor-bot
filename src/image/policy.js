export function isVerifiedPersonImageAllowed({ hasReference, samePerson, hasText }) {
  return hasReference === true && samePerson === true && hasText !== true;
}

export function shouldUseArticleThumbnail({ speaker, imageUrl, title = "" }) {
  // og:image is often a document, infographic, archive scan, or unrelated
  // stock photo. Without a separate article-image relevance check, fail closed.
  return false;
}
