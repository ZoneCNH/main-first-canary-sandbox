import { execFileSync } from "node:child_process";
import { githubPaginate, githubRequest, setOutput, appendSummary } from "./github-api.mjs";
import { loadMainFirstPolicy } from "./main-first-policy.mjs";

const OPTIONAL_FAILURE_CONCLUSIONS = new Set([
  "failure",
  "cancelled",
  "timed_out",
  "action_required",
  "stale",
  "startup_failure",
]);

/** Fixed labels on Main FROZEN Incidents so recovery can close stale SHAs. */
export const MAIN_FIRST_INCIDENT_LABELS = ["main-first-incident", "main-frozen"];

const formatCheckSource = (check) => {
  const parts = [
    check.name,
    check.html_url || check.details_url || null,
    check.app?.slug || check.app_slug || null,
    check.completed_at || check.started_at || null,
    check.id != null ? `id=${check.id}` : null,
  ].filter(Boolean);
  return parts.join(" ");
};

/**
 * Classify main health from required check names and check-run rows.
 *
 * Duplicate required names (more than one row for the same name) fail closed
 * as FROZEN; diagnosis lists source fields when present.
 */
export const classifyMainState = ({ requiredNames, checkRuns, releaseTagged = false }) => {
  const byName = new Map();
  for (const check of checkRuns) {
    if (!check?.name) continue;
    const list = byName.get(check.name) ?? [];
    list.push(check);
    byName.set(check.name, list);
  }

  const requiredFailures = [];
  const requiredPending = [];
  const duplicateSources = [];

  for (const name of requiredNames) {
    const runs = byName.get(name) ?? [];
    if (runs.length > 1) {
      const sources = runs.map((run) => formatCheckSource(run));
      duplicateSources.push({ name, count: runs.length, sources });
      requiredFailures.push(`${name}:duplicate_sources(${runs.length})`);
      continue;
    }
    const check = runs[0];
    if (!check || check.status !== "completed" || !check.conclusion) {
      requiredPending.push(name);
    } else if (check.conclusion !== "success") {
      requiredFailures.push(`${name}:${check.conclusion}`);
    }
  }

  const nonBlockingFailures = [...byName.entries()]
    .filter(([name]) => !requiredNames.includes(name))
    .flatMap(([, runs]) => runs)
    .filter(
      (check) =>
        check.status === "completed" && OPTIONAL_FAILURE_CONCLUSIONS.has(check.conclusion),
    )
    .map((check) => `${check.name}:${check.conclusion}`);

  if (requiredFailures.length > 0) {
    return {
      state: "FROZEN",
      requiredFailures,
      requiredPending,
      nonBlockingFailures,
      duplicateSources,
    };
  }
  if (requiredPending.length > 0 || nonBlockingFailures.length > 0) {
    return {
      state: "YELLOW",
      requiredFailures,
      requiredPending,
      nonBlockingFailures,
      duplicateSources,
    };
  }
  return {
    state: releaseTagged ? "RELEASED" : "GREEN",
    requiredFailures,
    requiredPending,
    nonBlockingFailures,
    duplicateSources,
  };
};

const tagsPointingAt = (root, sha) => {
  try {
    const output = execFileSync("git", ["tag", "--points-at", sha], {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
    return output ? output.split("\n").filter(Boolean) : [];
  } catch {
    return [];
  }
};

/** Extract a full or short SHA bound to a FROZEN Incident title/body. */
export const parseFrozenIncidentSha = (issue) => {
  const title = issue?.title ?? "";
  const body = issue?.body ?? "";
  const titleMatch = title.match(/Main FROZEN:\s*([0-9a-f]{7,40})/iu);
  if (titleMatch) return titleMatch[1].toLowerCase();
  const bodyMatch = body.match(/Commit:\s*`([0-9a-f]{7,40})`/iu);
  if (bodyMatch) return bodyMatch[1].toLowerCase();
  return null;
};

const shaMatches = (bound, currentSha) => {
  if (!bound || !currentSha) return false;
  const a = bound.toLowerCase();
  const b = currentSha.toLowerCase();
  return a === b || b.startsWith(a) || a.startsWith(b);
};

/**
 * Open labeled FROZEN Incidents to close when main is GREEN/RELEASED.
 *
 * Closes every open labeled incident: stale SHAs (bound ≠ current), the recovering
 * SHA if present, and labeled leftovers without a parseable SHA. `currentSha` is
 * retained for callers that build recovery comments and for regression tests that
 * assert old-SHA incidents are included in the close set.
 */
export const selectIncidentsToClose = (openIncidents, currentSha) => {
  void currentSha;
  return Array.isArray(openIncidents) ? [...openIncidents] : [];
};

/** True when an incident is bound to a SHA other than the recovering main tip. */
export const isStaleFrozenIncident = (issue, currentSha) => {
  const bound = parseFrozenIncidentSha(issue);
  if (!bound) return true;
  return !shaMatches(bound, currentSha);
};

export const buildRecoveryCommentBody = ({
  recoverySha,
  recoveryPr = null,
  recoveryEvidence = null,
  closedAt = new Date().toISOString(),
}) =>
  [
    "Main First recovery: closing stale FROZEN Incident.",
    "",
    `- Recovery commit: \`${recoverySha}\``,
    recoveryPr ? `- Recovery PR: ${recoveryPr}` : "- Recovery PR: (not recorded)",
    recoveryEvidence ? `- Recovery Evidence: ${recoveryEvidence}` : "- Recovery Evidence: (not recorded)",
    `- Closed at: ${closedAt}`,
  ].join("\n");

const listOpenFrozenIncidents = async ({ repository, token }) => {
  const primary = MAIN_FIRST_INCIDENT_LABELS[0];
  const items = await githubPaginate(
    `/repos/${repository}/issues?state=open&labels=${encodeURIComponent(primary)}`,
    { token },
  );
  // github issues API returns PRs too when labeled; keep issues only
  return items.filter((item) => !item.pull_request);
};

const createFrozenIncident = async ({ repository, sha, token, details }) => {
  await githubRequest(`/repos/${repository}/issues`, {
    token,
    method: "POST",
    body: {
      title: `🚨 Main FROZEN: ${sha.slice(0, 12)}`,
      labels: [...MAIN_FIRST_INCIDENT_LABELS],
      body: [
        "Main First 状态机检测到 required context 失败。",
        "",
        `Commit: \`${sha}\``,
        `Required failures: ${details.requiredFailures.join(", ") || "none"}`,
        details.duplicateSources?.length
          ? `Duplicate required sources: ${details.duplicateSources
              .map((entry) => `${entry.name}×${entry.count}`)
              .join("; ")}`
          : null,
        "",
        "在恢复 GREEN 前，只允许 `change_type: recovery` 的 Change Contract。",
        "",
        `Labels: ${MAIN_FIRST_INCIDENT_LABELS.join(", ")}`,
      ]
        .filter((line) => line !== null)
        .join("\n"),
    },
  });
};

const closeIncidentWithRecovery = async ({
  repository,
  token,
  issue,
  recoverySha,
  recoveryPr,
  recoveryEvidence,
}) => {
  const closedAt = new Date().toISOString();
  await githubRequest(`/repos/${repository}/issues/${issue.number}/comments`, {
    token,
    method: "POST",
    body: {
      body: buildRecoveryCommentBody({
        recoverySha,
        recoveryPr,
        recoveryEvidence,
        closedAt,
      }),
    },
  });
  await githubRequest(`/repos/${repository}/issues/${issue.number}`, {
    token,
    method: "PATCH",
    body: { state: "closed", state_reason: "completed" },
  });
};

/**
 * Sync FROZEN Incidents with main state.
 * - FROZEN: create labeled Incident for current SHA if none open for this short SHA.
 * - GREEN/RELEASED: close all open labeled Incidents whose bound SHA ≠ current
 *   (and any unlabeled-title labeled leftovers), writing a recovery comment first.
 */
export const syncIncident = async ({
  repository,
  sha,
  token,
  state,
  details,
  recoveryPr = null,
  recoveryEvidence = null,
}) => {
  if (state === "FROZEN") {
    const open = await listOpenFrozenIncidents({ repository, token });
    const already = open.some((issue) => shaMatches(parseFrozenIncidentSha(issue), sha));
    if (!already) {
      await createFrozenIncident({ repository, sha, token, details });
    }
    return { created: !already, closed: [] };
  }

  if (state === "GREEN" || state === "RELEASED") {
    const open = await listOpenFrozenIncidents({ repository, token });
    const toClose = selectIncidentsToClose(open, sha);
    const closed = [];
    for (const issue of toClose) {
      await closeIncidentWithRecovery({
        repository,
        token,
        issue,
        recoverySha: sha,
        recoveryPr,
        recoveryEvidence,
      });
      closed.push(issue.number);
    }
    return { created: false, closed };
  }

  return { created: false, closed: [] };
};

export const runMainState = async ({
  root,
  repository,
  sha,
  token,
}) => {
  const policy = loadMainFirstPolicy(root);
  const ref = await githubRequest(`/repos/${repository}/git/ref/heads/${policy.default_branch}`, { token });
  const currentMainSha = ref?.object?.sha;
  if (!currentMainSha) throw new Error(`could not resolve ${policy.default_branch} head SHA`);
  if (currentMainSha !== sha) {
    setOutput("state", "STALE");
    appendSummary(`
## Main First state evaluation skipped

- Requested commit: \`${sha}\`
- Current ${policy.default_branch}: \`${currentMainSha}\`
- Reason: stale workflow completion; no status or Incident was written.
`);
    return {
      state: "STALE",
      skipped: true,
      currentMainSha,
      requiredFailures: [],
      requiredPending: [],
      nonBlockingFailures: [],
      duplicateSources: [],
    };
  }

  const requiredNames = policy.main_state.required_checks;
  if (!Array.isArray(requiredNames) || requiredNames.length === 0 || new Set(requiredNames).size !== requiredNames.length) {
    throw new Error("main_state.required_checks must be a non-empty unique array");
  }
  const checkRuns = await githubPaginate(`/repos/${repository}/commits/${sha}/check-runs`, {
    token,
    itemKey: "check_runs",
  });
  const releasePattern = new RegExp(policy.main_state.release_tag_pattern, "u");
  const tags = tagsPointingAt(root, sha);
  const result = classifyMainState({
    requiredNames,
    checkRuns,
    releaseTagged: tags.some((tag) => releasePattern.test(tag)),
  });

  const statusState =
    result.state === "FROZEN" ? "failure" : result.state === "YELLOW" ? "pending" : "success";
  const description = {
    GREEN: "all main-required checks passed",
    YELLOW: "pending or non-blocking risk exists",
    FROZEN: "main-required check failed; recovery only",
    RELEASED: "green commit has a formal release tag",
  }[result.state];

  await githubRequest(`/repos/${repository}/statuses/${sha}`, {
    token,
    method: "POST",
    body: {
      state: statusState,
      context: policy.main_state.context,
      description,
    },
  });
  await syncIncident({ repository, sha, token, state: result.state, details: result });

  setOutput("state", result.state);
  appendSummary(`
## Main First state: ${result.state}

- Commit: \`${sha}\`
- Main-required checks: ${requiredNames.join(", ")}
- Required failures: ${result.requiredFailures.join(", ") || "none"}
- Required pending/missing: ${result.requiredPending.join(", ") || "none"}
- Non-blocking failures: ${result.nonBlockingFailures.join(", ") || "none"}
- Duplicate required sources: ${
    result.duplicateSources?.length
      ? result.duplicateSources.map((entry) => `${entry.name}×${entry.count}`).join("; ")
      : "none"
  }
- Release tags: ${tags.join(", ") || "none"}
`);
  return result;
};
