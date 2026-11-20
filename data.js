"use strict";

// Data files (entries.jsonl, people.jsonl, presence.jsonl) are read live from
// the GitHub REST API, not from the Pages copy. Capture commits therefore show
// up immediately and do not need (or trigger) a Pages redeploy — the Pages
// workflow only runs when viewer files change (see DECISIONS 36).
//
// Repo is derived from the Pages URL: https://<owner>.github.io/<repo>/...
// Anywhere else (local server, custom domain) it is null and we read "./<path>".
const IDEAFLOW_REPO = (() => {
  const m = location.hostname.match(/^([^.]+)\.github\.io$/i);
  const seg = location.pathname.split("/").filter(Boolean)[0];
  return m && seg && !seg.includes(".") ? m[1] + "/" + seg : null;
})();

// Text of a file in the data repo ("" if it does not exist). Unauthenticated
// API reads are limited to 60/hour per IP, but `cache: "no-cache"` revalidates
// with the ETag and GitHub does not count 304s, so normal refreshing is cheap.
// On any API failure (rate limit, offline) fall back to the Pages snapshot.
async function fetchRepoText(path, repo) {
  repo = repo || IDEAFLOW_REPO;
  if (repo) {
    try {
      const r = await fetch(`https://api.github.com/repos/${repo}/contents/${path}?ref=main`, {
        headers: { Accept: "application/vnd.github.raw" },
        cache: "no-cache",
      });
      if (r.ok) return await r.text();
      if (r.status === 404) return "";
    } catch { /* fall through to the Pages copy */ }
  }
  const r = await fetch("./" + path, { cache: "no-cache" });
  if (r.status === 404) return "";
  if (!r.ok) throw new Error(`${path}: HTTP ${r.status}`);
  return r.text();
}
