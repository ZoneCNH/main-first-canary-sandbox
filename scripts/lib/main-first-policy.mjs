import {
  existsSync,
  lstatSync,
  readFileSync,
  realpathSync,
  statSync,
} from "node:fs";
import { resolve, relative, sep } from "node:path";
import { execFileSync } from "node:child_process";
import { githubPaginate, githubRequest } from "./github-api.mjs";

export const loadMainFirstPolicy = (root) => {
  const policyPath = resolve(root, ".github/ai-native/main-first.json");
  const policy = JSON.parse(readFileSync(policyPath, "utf8"));
  if (policy.schema_version !== 1 || policy.policy_id !== "MAIN-FIRST-001") {
    throw new Error("unsupported Main First policy schema");
  }
  const schemaPath = policy.pull_request?.contract?.schema_path;
  if (!schemaPath) throw new Error("Main First Change Contract schema path is missing");
  const absoluteSchemaPath = resolve(root, schemaPath);
  if (!existsSync(absoluteSchemaPath)) throw new Error(`Change Contract schema does not exist: ${schemaPath}`);
  policy.change_contract_schema = JSON.parse(readFileSync(absoluteSchemaPath, "utf8"));
  return policy;
};

export const isRepoRelativePath = (value) => {
  if (!value || value.startsWith("/") || /^[A-Za-z]:[\\/]/u.test(value)) return false;
  const normalized = value.replaceAll("\\", "/");
  return !normalized.split("/").includes("..") && !normalized.includes("\0");
};

export const pathUnderAnyRoot = (value, roots) => {
  const normalized = value.replaceAll("\\", "/");
  return roots.some((prefix) => normalized.startsWith(prefix));
};

const staysInsideRoot = (root, candidate) => {
  const rel = relative(resolve(root), resolve(candidate));
  return rel !== ".." && !rel.startsWith(`..${sep}`);
};

export const validateReference = (root, value, roots) => {
  if (!isRepoRelativePath(value)) return `reference is not a safe repository-relative path: ${value}`;
  if (!pathUnderAnyRoot(value, roots)) return `reference is outside approved roots: ${value}`;
  const repositoryRoot = realpathSync(resolve(root));
  const absolute = resolve(repositoryRoot, value);
  if (!staysInsideRoot(repositoryRoot, absolute)) return `reference escapes repository root: ${value}`;
  if (!existsSync(absolute)) return `referenced file does not exist: ${value}`;
  if (lstatSync(absolute).isSymbolicLink()) return `referenced file must not be a symbolic link: ${value}`;
  if (!statSync(absolute).isFile()) return `referenced path is not a regular file: ${value}`;
  const real = realpathSync(absolute);
  if (!staysInsideRoot(repositoryRoot, real)) return `reference resolves outside repository root: ${value}`;
  return null;
};

export const validateTreeReference = (value, roots, treeByPath) => {
  if (!isRepoRelativePath(value)) return `reference is not a safe repository-relative path: ${value}`;
  if (!pathUnderAnyRoot(value, roots)) return `reference is outside approved roots: ${value}`;
  const entry = treeByPath.get(value.replaceAll("\\", "/"));
  if (!entry) return `referenced file does not exist in PR head: ${value}`;
  if (entry.type !== "blob") return `referenced path is not a file in PR head: ${value}`;
  if (entry.mode === "120000") return `referenced file must not be a symbolic link: ${value}`;
  if (entry.mode !== "100644" && entry.mode !== "100755") {
    return `referenced file has unsupported git mode ${entry.mode}: ${value}`;
  }
  return null;
};

export const isChangeContractPath = (value, policy) => {
  const config = policy.pull_request.contract;
  return (
    isRepoRelativePath(value) &&
    pathUnderAnyRoot(value, config.roots) &&
    value.replaceAll("\\", "/").endsWith(config.suffix)
  );
};

/** True when current path or previous_filename is a Change Contract path. */
export const recordTouchesChangeContract = (record, policy) => {
  if (!record || typeof record !== "object") return false;
  if (record.path && isChangeContractPath(record.path, policy)) return true;
  if (record.previous_filename && isChangeContractPath(record.previous_filename, policy)) return true;
  return false;
};

/**
 * Map GitHub pull-request files API rows to normalized change records.
 * Preserves previous_filename so rename cannot hide historical Contracts.
 */
export const pullRequestFileRecords = (files) =>
  (files ?? []).map((file) => ({
    path: file.filename,
    status: file.status,
    ...(file.previous_filename
      ? { previous_filename: file.previous_filename }
      : {}),
  }));

/**
 * Select the single append-only Change Contract for a PR.
 *
 * Any record whose current path OR previous_filename matches `*.contract.json`
 * under approved roots counts. Only `status=added` with empty previous_filename
 * is allowed; modified/removed/renamed/copied and any previous_filename fail closed.
 */
export const selectChangedContract = (records, policy) => {
  const errors = [];
  const candidates = records.filter((record) => recordTouchesChangeContract(record, policy));
  if (candidates.length !== 1) {
    errors.push(
      `PR must change exactly one ${policy.pull_request.contract.suffix} file; found ${candidates.length}`,
    );
    return { contractRecord: null, errors };
  }
  const contractRecord = candidates[0];
  if (contractRecord.previous_filename) {
    errors.push(
      `Change Contract must be append-only newly added; rename/move from ${contractRecord.previous_filename} is forbidden`,
    );
  }
  if (policy.pull_request.contract.require_added && contractRecord.status !== "added") {
    errors.push(
      `Change Contract must be append-only and newly added; got status ${contractRecord.status}`,
    );
  }
  if (
    contractRecord.path &&
    !isChangeContractPath(contractRecord.path, policy) &&
    contractRecord.previous_filename &&
    isChangeContractPath(contractRecord.previous_filename, policy)
  ) {
    errors.push(
      `Change Contract path must remain a contract file; historical path ${contractRecord.previous_filename} was renamed away`,
    );
  }
  return { contractRecord, errors };
};

const canonicalJson = (value) => `${JSON.stringify(value, null, 2)}\n`;

export const parseChangeContract = (text, policy) => {
  const errors = [];
  const normalized = String(text).replace(/\r\n?/gu, "\n");
  if (Buffer.byteLength(normalized, "utf8") > policy.pull_request.contract.max_bytes) {
    errors.push(`Change Contract exceeds ${policy.pull_request.contract.max_bytes} bytes`);
  }

  let contract = null;
  try {
    contract = JSON.parse(normalized);
  } catch (error) {
    return { contract: null, errors: [`Change Contract is not valid JSON: ${error.message}`] };
  }
  if (!contract || typeof contract !== "object" || Array.isArray(contract)) {
    return { contract: null, errors: ["Change Contract root must be one JSON object"] };
  }
  if (normalized !== canonicalJson(contract)) {
    errors.push("Change Contract must use canonical two-space JSON with one trailing newline");
  }

  const schema = policy.change_contract_schema;
  const properties = schema?.properties ?? {};
  const allowed = new Set(Object.keys(properties));
  for (const key of Object.keys(contract)) {
    if (!allowed.has(key)) errors.push(`Change Contract contains unsupported key: ${key}`);
  }
  for (const key of schema?.required ?? []) {
    if (!Object.hasOwn(contract, key)) errors.push(`Change Contract is missing required key: ${key}`);
  }

  if (contract.schema_version !== properties.schema_version?.const) {
    errors.push(`unsupported Change Contract schema_version: ${String(contract.schema_version)}`);
  }
  const changeIdPattern = properties.change_id?.pattern;
  if (
    typeof contract.change_id !== "string" ||
    typeof changeIdPattern !== "string" ||
    !(new RegExp(changeIdPattern, "u")).test(contract.change_id)
  ) {
    errors.push("Change Contract change_id is invalid");
  }
  for (const key of ["goal", "spec"]) {
    if (typeof contract[key] !== "string" || contract[key].length < 1) {
      errors.push(`Change Contract ${key} must be a non-empty string`);
    }
  }
  if (!Array.isArray(contract.evidence) || contract.evidence.length < 1) {
    errors.push("Change Contract evidence must be a non-empty array");
  } else {
    if (contract.evidence.some((value) => typeof value !== "string" || value.length < 1)) {
      errors.push("Change Contract evidence entries must be non-empty strings");
    }
    if (new Set(contract.evidence).size !== contract.evidence.length) {
      errors.push("Change Contract evidence entries must be unique");
    }
  }
  if (!properties.change_type?.enum?.includes(contract.change_type)) {
    errors.push(`unsupported Change Contract change_type: ${String(contract.change_type)}`);
  }
  return { contract, errors };
};

const git = (root, args) =>
  execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();

const normalizeGitStatus = (status) => {
  const code = String(status)[0];
  if (code === "R") return "renamed";
  if (code === "C") return "copied";
  return ({ A: "added", M: "modified", D: "removed", T: "modified", U: "modified" })[code] ?? "unknown";
};

/**
 * Parse `git diff --name-status -z` tokens, including rename/copy triples.
 * Exported for unit tests of the shipped parser path.
 */
export const parseNameStatusTokens = (parts) => {
  const records = [];
  let index = 0;
  while (index < parts.length) {
    const statusField = parts[index];
    if (statusField === undefined) break;
    const code = String(statusField)[0];
    if (code === "R" || code === "C") {
      const previous = parts[index + 1];
      const path = parts[index + 2];
      if (previous === undefined || path === undefined) {
        throw new Error("unexpected git rename/copy --name-status -z output");
      }
      records.push({
        status: normalizeGitStatus(statusField),
        path,
        previous_filename: previous,
      });
      index += 3;
      continue;
    }
    const path = parts[index + 1];
    if (path === undefined) throw new Error("unexpected git --name-status -z output");
    records.push({ status: normalizeGitStatus(statusField), path });
    index += 2;
  }
  return records;
};

export const changedFileRecords = (root, baseSha, headSha) => {
  const raw = execFileSync(
    "git",
    ["diff", "--name-status", "--find-renames", "-z", `${baseSha}...${headSha}`],
    { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
  );
  const parts = raw.split("\0").filter(Boolean);
  return parseNameStatusTokens(parts);
};

export const mergeCommits = (root, baseSha, headSha) => {
  const output = git(root, ["rev-list", "--min-parents=2", `${baseSha}..${headSha}`]);
  return output ? output.split("\n").filter(Boolean) : [];
};

const introducedCommitCount = (root, baseSha, headSha) =>
  Number.parseInt(git(root, ["rev-list", "--count", `${baseSha}..${headSha}`]), 10);

export const classifyPrAge = (createdAt, nowMs, policy) => {
  const ageHours = (nowMs - Date.parse(createdAt)) / 3_600_000;
  if (!Number.isFinite(ageHours)) return { state: "invalid", ageHours: Number.NaN };
  if (ageHours >= policy.pull_request.max_open_hours) return { state: "expired", ageHours };
  if (ageHours >= policy.pull_request.warning_open_hours) return { state: "warning", ageHours };
  return { state: "fresh", ageHours };
};

const validateAge = (pr, policy, nowMs, errors, warnings) => {
  const age = classifyPrAge(pr.created_at, nowMs, policy);
  if (age.state === "invalid") errors.push("PR created_at is invalid");
  if (age.state === "warning") {
    warnings.push(`PR age is ${age.ageHours.toFixed(1)}h; close or merge before ${policy.pull_request.max_open_hours}h`);
  }
  if (age.state === "expired") {
    errors.push(`PR age ${age.ageHours.toFixed(1)}h exceeds ${policy.pull_request.max_open_hours}h maximum`);
  }
};

const validatePrBase = (pr, policy, errors) => {
  if (pr.base?.ref !== policy.pull_request.required_base) {
    errors.push(`PR base must be ${policy.pull_request.required_base}, got ${pr.base?.ref ?? "unknown"}`);
  }
};

const fetchBaseMainState = async ({ repository, baseSha, token, context }) => {
  const payload = await githubRequest(`/repos/${repository}/commits/${baseSha}/status`, { token });
  const match = payload.statuses?.find((status) => status.context === context);
  return match?.state ?? null;
};

const enforceFrozenBase = async ({ repository, baseSha, token, policy, changeType, errors }) => {
  try {
    const baseState = await fetchBaseMainState({
      repository,
      baseSha,
      token,
      context: policy.main_state.context,
    });
    if (!baseState) {
      errors.push(`base main is missing required status ${policy.main_state.context}`);
    } else if (baseState === "failure" && changeType !== policy.main_state.frozen_allows_change_type) {
      errors.push(`main is FROZEN; only Change-Type: ${policy.main_state.frozen_allows_change_type} is allowed`);
    }
  } catch (error) {
    errors.push(`could not verify base main state: ${error.message}`);
  }
};

const validateLocalContractReferences = ({ root, contractPath, contract, records, policy, errors }) => {
  const references = [
    ["Goal", contract.goal, policy.pull_request.goal_roots],
    ["Spec", contract.spec, policy.pull_request.spec_roots],
    ...contract.evidence.map((value) => ["Evidence", value, policy.pull_request.evidence_roots]),
  ];
  for (const [kind, value, roots] of references) {
    const violation = validateReference(root, value, roots);
    if (violation) errors.push(`${kind}: ${violation}`);
  }
  if (contract.evidence.includes(contractPath)) {
    errors.push("Change Contract cannot cite itself as Evidence");
  }
  if (policy.pull_request.require_changed_evidence) {
    const changed = new Set(records.filter((record) => record.status !== "removed").map((record) => record.path));
    if (!contract.evidence.some((path) => changed.has(path))) {
      errors.push("at least one referenced Evidence file must be changed by this PR");
    }
  }
};

const validateTreeContractReferences = ({ contractPath, contract, records, policy, treeByPath, errors }) => {
  const references = [
    ["Goal", contract.goal, policy.pull_request.goal_roots],
    ["Spec", contract.spec, policy.pull_request.spec_roots],
    ...contract.evidence.map((value) => ["Evidence", value, policy.pull_request.evidence_roots]),
  ];
  for (const [kind, value, roots] of references) {
    const violation = validateTreeReference(value, roots, treeByPath);
    if (violation) errors.push(`${kind}: ${violation}`);
  }
  if (contract.evidence.includes(contractPath)) {
    errors.push("Change Contract cannot cite itself as Evidence");
  }
  if (policy.pull_request.require_changed_evidence) {
    const changed = new Set(records.filter((record) => record.status !== "removed").map((record) => record.path));
    if (!contract.evidence.some((path) => changed.has(path))) {
      errors.push("at least one referenced Evidence file must be changed by this PR");
    }
  }
};

export const validatePullRequest = async ({
  root,
  event,
  policy,
  token,
  repository,
  nowMs = Date.now(),
}) => {
  const errors = [];
  const warnings = [];
  const pr = event.pull_request;
  if (!pr) return { errors: ["pull_request payload is missing"], warnings };
  validatePrBase(pr, policy, errors);
  validateAge(pr, policy, nowMs, errors, warnings);

  const baseSha = pr.base?.sha;
  const headSha = pr.head?.sha;
  let changeType = null;
  if (!baseSha || !headSha) {
    errors.push("PR base/head SHA is missing");
  } else {
    try {
      const records = changedFileRecords(root, baseSha, headSha);
      const selected = selectChangedContract(records, policy);
      errors.push(...selected.errors);
      if (selected.contractRecord) {
        const contractPath = selected.contractRecord.path;
        const pathViolation = validateReference(root, contractPath, policy.pull_request.contract.roots);
        if (pathViolation) {
          errors.push(`Change Contract: ${pathViolation}`);
        } else {
          const parsed = parseChangeContract(readFileSync(resolve(root, contractPath), "utf8"), policy);
          errors.push(...parsed.errors);
          if (parsed.contract) {
            changeType = parsed.contract.change_type;
            validateLocalContractReferences({
              root,
              contractPath,
              contract: parsed.contract,
              records,
              policy,
              errors,
            });
          }
        }
      }
      if (policy.pull_request.forbid_merge_commits) {
        const merges = mergeCommits(root, baseSha, headSha);
        if (merges.length > 0) errors.push(`PR branch contains merge commits: ${merges.join(", ")}`);
      }
    } catch (error) {
      errors.push(`git Change Contract validation failed: ${error.message}`);
    }
  }
  await enforceFrozenBase({ repository, baseSha, token, policy, changeType, errors });
  return { errors, warnings };
};

const decodeGitBlob = (blob, maxBytes) => {
  if (blob?.encoding !== "base64" || typeof blob.content !== "string") {
    throw new Error("Git blob must use base64 encoding");
  }
  if (!Number.isInteger(blob.size) || blob.size > maxBytes) {
    throw new Error(`Git blob exceeds ${maxBytes} bytes or has invalid size`);
  }
  const bytes = Buffer.from(blob.content.replace(/\s+/gu, ""), "base64");
  if (bytes.length !== blob.size) throw new Error("Git blob decoded size mismatch");
  return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
};

export const validatePullRequestTarget = async ({
  event,
  policy,
  token,
  repository,
  nowMs = Date.now(),
}) => {
  const errors = [];
  const warnings = [];
  const pr = event.pull_request;
  if (!pr) return { errors: ["pull_request_target payload is missing"], warnings };
  if (!token || !repository) return { errors: ["trusted contract gate requires GITHUB_TOKEN and repository"], warnings };
  validatePrBase(pr, policy, errors);
  validateAge(pr, policy, nowMs, errors, warnings);

  const baseSha = pr.base?.sha;
  const headSha = pr.head?.sha;
  const number = pr.number;
  let changeType = null;
  if (!baseSha || !headSha || !number) {
    errors.push("PR number or base/head SHA is missing");
    return { errors, warnings };
  }

  try {
    const [tree, files, commits] = await Promise.all([
      githubRequest(`/repos/${repository}/git/trees/${headSha}?recursive=1`, { token }),
      githubPaginate(`/repos/${repository}/pulls/${number}/files`, { token }),
      githubPaginate(`/repos/${repository}/pulls/${number}/commits`, { token }),
    ]);
    if (tree.truncated === true) throw new Error("PR head tree is truncated; cannot validate fail-closed");
    const treeByPath = new Map((tree.tree ?? []).map((entry) => [entry.path, entry]));
    const records = pullRequestFileRecords(files);
    const selected = selectChangedContract(records, policy);
    errors.push(...selected.errors);

    if (selected.contractRecord) {
      const contractPath = selected.contractRecord.path;
      const pathViolation = validateTreeReference(contractPath, policy.pull_request.contract.roots, treeByPath);
      if (pathViolation) {
        errors.push(`Change Contract: ${pathViolation}`);
      } else {
        const entry = treeByPath.get(contractPath);
        const blob = await githubRequest(`/repos/${repository}/git/blobs/${entry.sha}`, { token });
        const parsed = parseChangeContract(
          decodeGitBlob(blob, policy.pull_request.contract.max_bytes),
          policy,
        );
        errors.push(...parsed.errors);
        if (parsed.contract) {
          changeType = parsed.contract.change_type;
          validateTreeContractReferences({
            contractPath,
            contract: parsed.contract,
            records,
            policy,
            treeByPath,
            errors,
          });
        }
      }
    }

    if (policy.pull_request.forbid_merge_commits) {
      const merges = commits.filter((commit) => (commit.parents ?? []).length > 1).map((commit) => commit.sha);
      if (merges.length > 0) errors.push(`PR branch contains merge commits: ${merges.join(", ")}`);
    }
  } catch (error) {
    errors.push(`trusted Change Contract API validation failed: ${error.message}`);
  }

  await enforceFrozenBase({ repository, baseSha, token, policy, changeType, errors });
  return { errors, warnings };
};

const sleep = (milliseconds) => new Promise((resolvePromise) => setTimeout(resolvePromise, milliseconds));

const commitHasMergedMainPullRequest = async ({ repository, sha, token, main }) => {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const pulls = await githubRequest(`/repos/${repository}/commits/${sha}/pulls`, { token });
    if (Array.isArray(pulls) && pulls.some((pr) => pr.merged_at && pr.base?.ref === main)) return true;
    if (attempt < 4) await sleep(2 ** attempt * 1000);
  }
  return false;
};

export const validateMainPush = async ({ root, event, policy, token, repository }) => {
  const errors = [];
  const warnings = [];
  const after = event.after;
  const before = event.before;

  if (event.ref !== `refs/heads/${policy.default_branch}`) return { errors, warnings };
  if (event.forced === true) errors.push("force push to main is forbidden");
  if (event.created === true || event.deleted === true) errors.push("main creation/deletion push is forbidden");
  if (!after) errors.push("push after SHA is missing");

  if (before && after && !/^0+$/u.test(before)) {
    try {
      const count = introducedCommitCount(root, before, after);
      if (count !== 1) errors.push(`main push must introduce exactly one squash commit; got ${count}`);
      const merges = mergeCommits(root, before, after);
      if (merges.length > 0) errors.push(`main range contains merge commits: ${merges.join(", ")}`);
    } catch (error) {
      errors.push(`main history validation failed: ${error.message}`);
    }
  }

  if (!token || !repository || !after) {
    errors.push("cannot verify main push provenance without GITHUB_TOKEN, repository, and after SHA");
    return { errors, warnings };
  }

  try {
    const mergedToMain = await commitHasMergedMainPullRequest({
      repository,
      sha: after,
      token,
      main: policy.default_branch,
    });
    if (!mergedToMain) errors.push("main commit is not associated with a merged pull request");
  } catch (error) {
    errors.push(`main push provenance API failed: ${error.message}`);
  }

  return { errors, warnings };
};

export const validateEvent = async (options) => {
  const name = options.eventName;
  if (name === "pull_request_target") return validatePullRequestTarget(options);
  if (name === "pull_request") return validatePullRequest(options);
  if (name === "push") return validateMainPush(options);
  return { errors: [], warnings: [`event ${name} is not governed by the Main First entry gate`] };
};
