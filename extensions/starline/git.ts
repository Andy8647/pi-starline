import { execFile } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const GIT_COMMAND_TIMEOUT_MS = 2_000;

/**
 * Read the repository without writing to it.
 *
 * `status` and `diff` refresh the index's stat information as a side effect,
 * which means taking `.git/index.lock` and rewriting `.git/index`. From a footer
 * that polls every thirty seconds that is churn on the user's repository, and a
 * lock that can collide with their own `git commit`. `GIT_OPTIONAL_LOCKS=0` tells
 * git to skip every lock it does not need to answer the question (git 2.15+).
 *
 * An environment variable rather than `--no-optional-locks`: an older git ignores
 * a variable it does not know, and fails on a flag it does not know.
 */
const GIT_READ_ENV: NodeJS.ProcessEnv = { ...process.env, GIT_OPTIONAL_LOCKS: "0" };

export type GitOperationState =
	| "REBASING"
	| "MERGING"
	| "CHERRY-PICKING"
	| "REVERTING"
	| "BISECTING";

/**
 * Starship `git_commit`-style info derived from the existing porcelain probe.
 *
 * `oid` is the full `branch.oid` from `git status --porcelain=2 --branch`
 * (free — no extra git call). `detached` mirrors `branch.head === "(detached)"`.
 * `tag` is populated only when the caller opts into the exact-tag probe
 * (`readGitStatus({ readExactTag: true })`); `null` means no exact-match tag
 * or the probe was skipped.
 */
export type GitCommitInfo = {
	oid: string | null;
	detached: boolean;
	tag: string | null;
};

/**
 * Starship `git_metrics`-style aggregate line-change counts.
 * See https://starship.rs/config/#git-metrics
 */
export type GitMetricsInfo = {
	added: number;
	deleted: number;
};

/**
 * One changed path, as `git status` reports it.
 *
 * `code` is a single letter for the pill's bubble: the index side when there is
 * one (`M` staged), the worktree side otherwise. `?` untracked, `U` conflicted.
 */
export type GitChange = {
	code: string;
	path: string;
};

export type GitStatusSummary = {
	branch?: string;
	dirty: boolean;
	ahead: number;
	behind: number;
	conflicted: number;
	untracked: number;
	stashed: number;
	modified: number;
	staged: number;
	renamed: number;
	deleted: number;
	typechanged: number;
	gitState?: GitOperationState;
	gitStateLabel?: string;
	commit?: GitCommitInfo;
	metrics?: GitMetricsInfo | null;
	/**
	 * Changed paths, in `git status` order, capped at `MAX_TRACKED_CHANGES`. Only
	 * the bubble reads them; the pill itself is drawn from the counts.
	 */
	changes: GitChange[];
};

export type GitReadResult =
	| { kind: "ok"; status: GitStatusSummary }
	| { kind: "not_a_repo" }
	| { kind: "error" };

export type GitStatePaths = {
	rebaseMerge?: string;
	rebaseApply?: string;
	mergeHead?: string;
	cherryPickHead?: string;
	revertHead?: string;
	bisectLog?: string;
	rebaseMsgnum?: string;
	rebaseEnd?: string;
};

export function emptyGitStatus(): GitStatusSummary {
	return {
		branch: undefined,
		dirty: false,
		ahead: 0,
		behind: 0,
		conflicted: 0,
		untracked: 0,
		stashed: 0,
		modified: 0,
		staged: 0,
		renamed: 0,
		deleted: 0,
		typechanged: 0,
		gitState: undefined,
		gitStateLabel: undefined,
		commit: undefined,
		metrics: undefined,
		changes: [],
	};
}

/** Cap on remembered paths: the bubble shows a dozen, the rest is `+N more`. */
const MAX_TRACKED_CHANGES = 200;

/**
 * The rest of a porcelain v2 line after its fixed fields.
 *
 * The path is whatever follows the last space-separated field, so paths with
 * spaces survive: `1 .M N... 100644 100644 100644 abc def my file.txt` keeps
 * `my file.txt` whole.
 */
function porcelainPath(line: string, fields: number): string {
	let index = 0;
	for (let field = 0; field < fields; field += 1) {
		index = line.indexOf(" ", index);
		if (index < 0) return "";
		index += 1;
	}
	return line.slice(index);
}

function addChange(status: GitStatusSummary, code: string, path: string): void {
	const trimmed = path.trim();
	if (!trimmed || status.changes.length >= MAX_TRACKED_CHANGES) return;
	status.changes.push({ code: code === "." || code === " " ? "M" : code, path: trimmed });
}

export function parseGitStatusPorcelain(stdoutText: string, stashCount: number): GitStatusSummary {
	const status = emptyGitStatus();
	status.stashed = stashCount;

	let oid: string | null = null;
	let sawBranchHead = false;
	let detached = false;

	for (const line of stdoutText.split(/\r?\n/)) {
		if (!line) continue;
		if (line.startsWith("# branch.oid ")) {
			const value = line.slice("# branch.oid ".length).trim();
			if (value && value !== "(initial)") oid = value;
			continue;
		}
		if (line.startsWith("# branch.head ")) {
			sawBranchHead = true;
			const branch = line.slice("# branch.head ".length).trim();
			if (branch === "(detached)") {
				detached = true;
				status.branch = undefined;
			} else if (branch) {
				status.branch = branch;
			}
			continue;
		}
		if (line.startsWith("# branch.ab ")) {
			const match = line.match(/\+(\d+)\s+-(\d+)/);
			if (match) {
				status.ahead = Number(match[1] ?? 0);
				status.behind = Number(match[2] ?? 0);
			}
			continue;
		}
		if (line.startsWith("#")) continue;

		status.dirty = true;

		if (line.startsWith("? ")) {
			status.untracked += 1;
			addChange(status, "?", line.slice(2));
			continue;
		}
		if (line.startsWith("u ")) {
			status.conflicted += 1;
			addChange(status, "U", porcelainPath(line, 10));
			continue;
		}
		if (!(line.startsWith("1 ") || line.startsWith("2 "))) continue;

		const xy = line.split(" ")[1] ?? "..";
		const x = xy[0] ?? ".";
		const y = xy[1] ?? ".";

		if (x === "R") status.renamed += 1;
		else if (x === "D") status.deleted += 1;
		else if (x === "T") status.typechanged += 1;
		else if (x !== "." && x !== " ") status.staged += 1;

		if (y === "M") status.modified += 1;
		else if (y === "D") status.deleted += 1;
		else if (y === "T") status.typechanged += 1;

		// `2` lines carry an extra score field before the path, and a rename adds
		// `<tab>original` to it; the new name is what the bubble lists.
		const path = porcelainPath(line, line.startsWith("2 ") ? 9 : 8).split("\t")[0] ?? "";
		addChange(status, x !== "." ? x : y, path);
	}

	// Only populate commit info when we actually saw branch headers (inside
	// a repo with commits). An unborn branch has no oid.
	if (sawBranchHead) {
		status.commit = { oid, detached, tag: null };
	}

	return status;
}

/**
 * Parse `git diff --numstat` output into aggregate added/deleted counts.
 *
 * Each line is `added\tdeleted\tpath` (or `added\tdeleted\told\tnew` for
 * renames). Binary rows carry `-` in both numeric columns and are skipped.
 * Malformed/unparseable lines are ignored rather than aborting the sum.
 *
 * See https://git-scm.com/docs/git-diff#Documentation/git-diff.txt---numstat
 */
export function parseGitNumstat(stdoutText: string): GitMetricsInfo {
	let added = 0;
	let deleted = 0;
	for (const line of stdoutText.split(/\r?\n/)) {
		if (!line) continue;
		const parts = line.split("\t");
		// `added\tdeleted\tpath...` — need at least 3 tab-delimited fields.
		if (parts.length < 3) continue;
		const a = parts[0];
		const d = parts[1];
		// Binary files report `-` for both; skip.
		if (a === "-" || d === "-") continue;
		const na = Number(a);
		const nd = Number(d);
		if (!Number.isFinite(na) || !Number.isFinite(nd)) continue;
		if (na < 0 || nd < 0) continue;
		added += na;
		deleted += nd;
	}
	return { added, deleted };
}

function readOptionalText(path: string | undefined): string | undefined {
	if (!path || !existsSync(path)) return undefined;
	try {
		return readFileSync(path, "utf8").trim();
	} catch {
		return undefined;
	}
}

/**
 * Pure git operation-state detector. Paths that exist (truthy strings that
 * callers verified with `existsSync`) select the active state in Starship order.
 */
export function detectGitState(paths: GitStatePaths): {
	gitState?: GitOperationState;
	gitStateLabel?: string;
} {
	if (paths.rebaseMerge || paths.rebaseApply) {
		const msgnum = readOptionalText(paths.rebaseMsgnum);
		const end = readOptionalText(paths.rebaseEnd);
		if (msgnum && end) {
			return { gitState: "REBASING", gitStateLabel: `REBASING ${msgnum}/${end}` };
		}
		return { gitState: "REBASING", gitStateLabel: "REBASING" };
	}
	if (paths.mergeHead) return { gitState: "MERGING", gitStateLabel: "MERGING" };
	if (paths.cherryPickHead) {
		return { gitState: "CHERRY-PICKING", gitStateLabel: "CHERRY-PICKING" };
	}
	if (paths.revertHead) return { gitState: "REVERTING", gitStateLabel: "REVERTING" };
	if (paths.bisectLog) return { gitState: "BISECTING", gitStateLabel: "BISECTING" };
	return {};
}

async function resolveGitPath(cwd: string, pathSpec: string): Promise<string | undefined> {
	try {
		const { stdout } = await execFileAsync("git", ["rev-parse", "--git-path", pathSpec], {
			cwd,
			env: GIT_READ_ENV,
			timeout: GIT_COMMAND_TIMEOUT_MS,
		});
		const resolved = (typeof stdout === "string" ? stdout : String(stdout)).trim();
		if (!resolved) return undefined;
		return resolved.startsWith("/") ? resolved : join(cwd, resolved);
	} catch {
		return undefined;
	}
}

async function readGitOperationState(cwd: string): Promise<{
	gitState?: GitOperationState;
	gitStateLabel?: string;
}> {
	const [rebaseMerge, rebaseApply, mergeHead, cherryPickHead, revertHead, bisectLog] =
		await Promise.all([
			resolveGitPath(cwd, "rebase-merge"),
			resolveGitPath(cwd, "rebase-apply"),
			resolveGitPath(cwd, "MERGE_HEAD"),
			resolveGitPath(cwd, "CHERRY_PICK_HEAD"),
			resolveGitPath(cwd, "REVERT_HEAD"),
			resolveGitPath(cwd, "BISECT_LOG"),
		]);

	const existing = (path: string | undefined) => (path && existsSync(path) ? path : undefined);
	const rebaseDir = existing(rebaseMerge) ?? existing(rebaseApply);

	return detectGitState({
		rebaseMerge: existing(rebaseMerge),
		rebaseApply: existing(rebaseApply),
		mergeHead: existing(mergeHead),
		cherryPickHead: existing(cherryPickHead),
		revertHead: existing(revertHead),
		bisectLog: existing(bisectLog),
		rebaseMsgnum: rebaseDir ? join(rebaseDir, "msgnum") : undefined,
		rebaseEnd: rebaseDir ? join(rebaseDir, "end") : undefined,
	});
}

function isNotARepoError(error: unknown): boolean {
	const message =
		error instanceof Error
			? `${error.message}\n${"stderr" in error ? String((error as { stderr?: unknown }).stderr ?? "") : ""}`
			: String(error);
	return /not a git repository|outside repository|not a git repo/i.test(message);
}

/**
 * Options for the optional probes that piggyback on the existing git refresh.
 * Both default to `false` so no extra git process is spawned unless a segment
 * is enabled and needs the data.
 */
export type ReadGitStatusOptions = {
	/** Run `git describe --tags --exact-match HEAD` for the git_commit segment. */
	readExactTag?: boolean;
	/**
	 * Run `git diff HEAD --numstat` for the git_metrics segment. Uses the
	 * Starship-like “total dirty” view (staged + unstaged combined).
	 */
	readMetrics?: boolean;
	/** Add `--ignore-submodules=all` to the metrics diff when requested. */
	ignoreSubmodules?: boolean;
};

export async function readGitStatus(
	cwd: string,
	options: ReadGitStatusOptions = {},
): Promise<GitReadResult> {
	const readExactTag = options.readExactTag === true;
	const readMetrics = options.readMetrics === true;
	try {
		const numstatArgs = ["diff", "HEAD", "--numstat"];
		if (options.ignoreSubmodules) numstatArgs.push("--ignore-submodules=all");
		const [{ stdout: statusStdout }, stashResult, tagResult, metricsResult] = await Promise.all([
			execFileAsync("git", ["status", "--porcelain=2", "--branch"], {
				cwd,
				env: GIT_READ_ENV,
				timeout: GIT_COMMAND_TIMEOUT_MS,
			}),
			execFileAsync("git", ["stash", "list"], {
				cwd,
				env: GIT_READ_ENV,
				timeout: GIT_COMMAND_TIMEOUT_MS,
			}).catch(() => ({ stdout: "" })),
			readExactTag
				? execFileAsync("git", ["describe", "--tags", "--exact-match", "HEAD"], {
						cwd,
						env: GIT_READ_ENV,
						timeout: GIT_COMMAND_TIMEOUT_MS,
					}).then(
						(r) => ({ stdout: typeof r.stdout === "string" ? r.stdout : String(r.stdout) }),
						() => ({ stdout: "" }),
					)
				: Promise.resolve({ stdout: "" }),
			readMetrics
				? execFileAsync("git", numstatArgs, {
						cwd,
						env: GIT_READ_ENV,
						timeout: GIT_COMMAND_TIMEOUT_MS,
					}).then(
						(r) => ({ stdout: typeof r.stdout === "string" ? r.stdout : String(r.stdout) }),
						() => ({ stdout: "", failed: true as const }),
					)
				: Promise.resolve({ stdout: "", failed: true as const }),
		]);
		const stdoutText = typeof statusStdout === "string" ? statusStdout : String(statusStdout);
		const stashStdout =
			typeof stashResult.stdout === "string" ? stashResult.stdout : String(stashResult.stdout);
		const stashCount = stashStdout.split(/\r?\n/).filter((line) => line.trim().length > 0).length;
		const status = parseGitStatusPorcelain(stdoutText, stashCount);
		if (status.commit) {
			const tagStdout =
				typeof tagResult.stdout === "string" ? tagResult.stdout : String(tagResult.stdout);
			const tag = tagStdout.trim();
			status.commit = { ...status.commit, tag: tag || null };
		}
		if (readMetrics) {
			if ("failed" in metricsResult && metricsResult.failed) {
				status.metrics = null;
			} else {
				const metricsStdout =
					typeof metricsResult.stdout === "string"
						? metricsResult.stdout
						: String(metricsResult.stdout);
				status.metrics = parseGitNumstat(metricsStdout);
			}
		}
		const operation = await readGitOperationState(cwd);
		return {
			kind: "ok",
			status: {
				...status,
				...operation,
			},
		};
	} catch (error) {
		if (isNotARepoError(error)) return { kind: "not_a_repo" };

		// Distinguish not-a-repo vs transient with a cheap rev-parse on the error path.
		try {
			const { stdout } = await execFileAsync("git", ["rev-parse", "--is-inside-work-tree"], {
				cwd,
				env: GIT_READ_ENV,
				timeout: GIT_COMMAND_TIMEOUT_MS,
			});
			const inside = (typeof stdout === "string" ? stdout : String(stdout)).trim();
			if (inside !== "true") return { kind: "not_a_repo" };
			return { kind: "error" };
		} catch (inner) {
			if (isNotARepoError(inner)) return { kind: "not_a_repo" };
			return { kind: "error" };
		}
	}
}

/**
 * Which forge an `origin` remote points at, for the branch segment's icon.
 * `generic` covers self-hosted and unrecognised forges.
 */
export type GitHost = "github" | "gitlab" | "bitbucket" | "generic";

/** Cached for minutes: a repo's origin remote effectively never changes mid-session. */
const GIT_HOST_TTL_MS = 10 * 60_000;

const gitHostCache = new Map<string, { host: GitHost | undefined; expiresAt: number }>();

/** Classify a remote URL. Handles scp-style (`git@host:path`) and URL forms. */
export function parseGitRemoteHost(url: string): GitHost | undefined {
	const trimmed = url.trim();
	if (!trimmed) return undefined;

	let hostname: string | undefined;
	const scpLike = /^[A-Za-z0-9._-]+@([^:/\s]+):/.exec(trimmed);
	if (scpLike) {
		hostname = scpLike[1];
	} else {
		try {
			hostname = new URL(trimmed).hostname;
		} catch {
			return undefined;
		}
	}
	if (!hostname) return undefined;

	const host = hostname.toLowerCase();
	// Subdomain prefixes catch the usual self-hosted naming (gitlab.acme.com).
	if (host === "github.com" || host.endsWith(".github.com") || host.startsWith("github."))
		return "github";
	if (host === "gitlab.com" || host.endsWith(".gitlab.com") || host.startsWith("gitlab."))
		return "gitlab";
	if (host === "bitbucket.org" || host.endsWith(".bitbucket.org") || host.startsWith("bitbucket."))
		return "bitbucket";
	return "generic";
}

/**
 * Resolve the forge behind `origin`, or undefined when there is no origin
 * remote or git is unavailable. Cached so the icon costs nothing per frame.
 */
export async function readGitHost(cwd: string): Promise<GitHost | undefined> {
	const cached = gitHostCache.get(cwd);
	if (cached && cached.expiresAt > Date.now()) return cached.host;

	let host: GitHost | undefined;
	try {
		const { stdout } = await execFileAsync("git", ["remote", "get-url", "origin"], {
			cwd,
			env: GIT_READ_ENV,
			timeout: GIT_COMMAND_TIMEOUT_MS,
		});
		host = parseGitRemoteHost(typeof stdout === "string" ? stdout : String(stdout));
	} catch {
		host = undefined;
	}

	gitHostCache.set(cwd, { host, expiresAt: Date.now() + GIT_HOST_TTL_MS });
	return host;
}

export function __resetGitHostCacheForTests(): void {
	gitHostCache.clear();
}
