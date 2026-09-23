export function isVerifiedPersonImageAllowed({ hasReference, identityByName, samePerson, hasText }) {
  return (hasReference === true || identityByName === true) && samePerson === true && hasText !== true;
}

export function isArticleImageCandidate({ speaker, imageUrl }) {
  // Only consider an article thumbnail when a named speaker exists; callers
  // must still verify the face against that person's reference before posting.
  return typeof speaker === "string" && speaker.trim().length > 0 &&
    typeof imageUrl === "string" && /^https?:\/\//i.test(imageUrl);
}
