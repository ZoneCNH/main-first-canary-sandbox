import { appendFileSync } from "node:fs";

export const githubRequest = async (path, { token, method = "GET", body } = {}) => {
  if (!token) throw new Error("GITHUB_TOKEN is required");
  const response = await fetch(`https://api.github.com${path}`, {
    method,
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${token}`,
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "xhyper-main-first",
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  let payload = null;
  if (text) {
    try {
      payload = JSON.parse(text);
    } catch {
      payload = text;
    }
  }
  if (!response.ok) {
    const detail = typeof payload === "string" ? payload : JSON.stringify(payload);
    throw new Error(`GitHub API ${method} ${path} failed: ${response.status} ${detail}`);
  }
  return payload;
};

export const githubPaginate = async (path, { token, itemKey, maxPages = 30 } = {}) => {
  const items = [];
  for (let page = 1; page <= maxPages; page += 1) {
    const separator = path.includes("?") ? "&" : "?";
    const payload = await githubRequest(`${path}${separator}per_page=100&page=${page}`, { token });
    const pageItems = itemKey ? payload?.[itemKey] : payload;
    if (!Array.isArray(pageItems)) throw new Error(`GitHub API pagination expected array at ${path}`);
    items.push(...pageItems);
    if (pageItems.length < 100) return items;
  }
  throw new Error(`GitHub API pagination exceeded ${maxPages} pages at ${path}`);
};

export const setOutput = (name, value) => {
  const file = process.env.GITHUB_OUTPUT;
  if (!file) return;
  appendFileSync(file, `${name}=${String(value)}\n`);
};

export const appendSummary = (markdown) => {
  const file = process.env.GITHUB_STEP_SUMMARY;
  if (!file) return;
  appendFileSync(file, `${markdown.trim()}\n`);
};
