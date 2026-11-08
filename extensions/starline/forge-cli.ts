/**
 * What the forge says about the current branch, read through its own CLI.
 *
 * `gh` and `glab` are already the user's door to GitHub and GitLab: they carry
 * the auth, the self-hosted host config and the enterprise certificates, none of
 * which this extension could reproduce with a bare HTTP call. Every read here is
 * one process, hard-timeboxed, and `undefined` on any failure so the caller can
 * keep the last good answer instead of blanking the pill.
 *
 * The mapping from each CLI's JSON is pure and exported: the shapes differ
 * between the two forges and they are the part worth testing.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { GitRemote } from "./git";
import {
	type ForgeLists,
	ISSUE_LIST_THRESHOLD,
	type Issue,
	type IssueGroup,
	type IssueLists,
	PULL_GROUPS,
	type Pull,
	type PullChecks,
	type PullLists,
	type PullReview,
	type PullState,
} from "./pull";

const execFileAsync = promisify(execFile);

/** Network reads are slower than git's, and the pill keeps its last answer meanwhile. */
const FORGE_TIMEOUT_MS = 4_000;
const MAX_BUFFER = 4 * 1024 * 1024;

/** How many pulls each bubble group lists. */
export const PULL_LIST_LIMIT = 8;

/** Run a forge CLI and return its stdout, or undefined when it fails or times out. */
export type ForgeRun = (
	command: string,
	args: string[],
	cwd: string,
) => Promise<string | undefined>;

const runForge: ForgeRun = async (command, args, cwd) => {
	try {
		const { stdout } = await execFileAsync(command, args, {
			cwd,
			timeout: FORGE_TIMEOUT_MS,
			maxBuffer: MAX_BUFFER,
		});
		return typeof stdout === "string" ? stdout : String(stdout);
	} catch {
		return undefined;
	}
};

/** Forges this module can ask, by their own CLI. */
export function forgeSupported(host: string): boolean {
	return host === "github" || host === "gitlab";
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
	return typeof value === "object" && value !== null && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: undefined;
}

function asArray(value: unknown): unknown[] {
	return Array.isArray(value) ? value : [];
}

function asNumber(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function asString(value: unknown): string | undefined {
	return typeof value === "string" ? value : undefined;
}

function parseJson(text: string | undefined): unknown {
	if (!text) return undefined;
	try {
		return JSON.parse(text);
	} catch {
		return undefined;
	}
}

/** GitHub's state strings plus the draft flag. */
export function pullStateFromGithub(state: unknown, draft: unknown): PullState {
	if (state === "MERGED") return "merged";
	if (state === "CLOSED") return "closed";
	return draft === true ? "draft" : "open";
}

/** GitLab's state strings plus the draft flag. */
export function pullStateFromGitlab(state: unknown, draft: unknown): PullState {
	if (state === "merged") return "merged";
	if (state === "closed" || state === "locked") return "closed";
	return draft === true ? "draft" : "open";
}

const FAILING_CHECK_CONCLUSIONS = new Set([
	"FAILURE",
	"ERROR",
	"TIMED_OUT",
	"CANCELLED",
	"ACTION_REQUIRED",
	"STARTUP_FAILURE",
	"STALE",
]);
const SUCCESSFUL_CHECK_CONCLUSIONS = new Set(["SUCCESS", "NEUTRAL", "SKIPPED"]);

/**
 * Roll GitHub's `statusCheckRollup` up to one word.
 *
 * The array mixes check runs (`conclusion`/`status`) with legacy commit statuses
 * (`state`), and a run that has not finished reports `conclusion: null`, so both
 * fields are read. No checks at all leaves the pill without a check mark rather
 * than claiming the pull passed.
 */
export function checksFromGithubRollup(rollup: unknown): PullChecks | undefined {
	const entries = asArray(rollup);
	if (entries.length === 0) return undefined;
	let pending = false;
	for (const entry of entries) {
		const record = asRecord(entry);
		if (!record) continue;
		const conclusion = asString(record.conclusion)?.toUpperCase();
		const state = asString(record.state)?.toUpperCase();
		const verdict = conclusion ?? state;
		if (verdict && FAILING_CHECK_CONCLUSIONS.has(verdict)) return "failing";
		if (!verdict || !SUCCESSFUL_CHECK_CONCLUSIONS.has(verdict)) pending = true;
	}
	return pending ? "pending" : "passing";
}

/** GitHub's review decision, as the pill names it. */
export function reviewFromGithub(decision: unknown): PullReview | undefined {
	switch (asString(decision)) {
		case "APPROVED":
			return "approved";
		case "CHANGES_REQUESTED":
			return "changes";
		case "REVIEW_REQUIRED":
			return "required";
		default:
			return undefined;
	}
}

/** One pull out of GitHub's `gh pr list --json` output. */
export function pullFromGithub(raw: unknown, withChecks = false): Pull | undefined {
	const record = asRecord(raw);
	if (!record) return undefined;
	const number = asNumber(record.number);
	const url = asString(record.url);
	if (number === undefined || !url) return undefined;
	return {
		number,
		state: pullStateFromGithub(record.state, record.isDraft),
		url,
		title: asString(record.title),
		...(withChecks ? { checks: checksFromGithubRollup(record.statusCheckRollup) } : {}),
		...(withChecks ? { review: reviewFromGithub(record.reviewDecision) } : {}),
	};
}

/** One pull out of GitLab's `glab mr list --output json`. */
export function pullFromGitlab(raw: unknown): Pull | undefined {
	const record = asRecord(raw);
	if (!record) return undefined;
	const number = asNumber(record.iid) ?? asNumber(record.number);
	const url = asString(record.web_url) ?? asString(record.url);
	if (number === undefined || !url) return undefined;
	return {
		number,
		state: pullStateFromGitlab(record.state, record.draft ?? record.work_in_progress),
		url,
		title: asString(record.title),
	};
}

/**
 * Pick the pull a branch leads with: the open one, or the newest of whatever else
 * the branch had. A merged or closed pull still answers "this branch has #123".
 */
export function pickBranchPull(pulls: Pull[]): Pull | undefined {
	const live = pulls.find((pull) => pull.state === "open" || pull.state === "draft");
	return live ?? pulls[0];
}

/** GitHub's repo open count out of the GraphQL answer. */
export function openCountFromGithubGraphql(json: unknown): number | undefined {
	const data = asRecord(asRecord(json)?.data);
	const repository = asRecord(data?.repository);
	return asNumber(asRecord(repository?.pullRequests)?.totalCount);
}

/** GitLab's project open count out of the GraphQL answer. */
export function openCountFromGitlabGraphql(json: unknown): number | undefined {
	const data = asRecord(asRecord(json)?.data);
	const project = asRecord(data?.project);
	return asNumber(asRecord(project?.mergeRequests)?.count);
}

/** GitHub's three search groups out of the one GraphQL answer. */
export function pullListsFromGithubGraphql(json: unknown): PullLists {
	const data = asRecord(asRecord(json)?.data);
	const group = (name: string): Pull[] =>
		asArray(asRecord(data?.[name])?.nodes)
			.map((node) => pullFromGithub(node))
			.filter((pull): pull is Pull => pull !== undefined);
	return {
		authored: group("authored"),
		reviewing: group("reviewing"),
		involved: group("involved"),
	};
}

export type BranchPullRead = {
	/** The pull the branch has, when it has one. */
	pull?: Pull;
	/** Open pulls on the repository, read only when the branch has none. */
	openCount?: number;
};

/** The GitHub owner, which is always the last namespace segment. */
function githubOwner(remote: GitRemote): string {
	const parts = remote.namespace.split("/").filter(Boolean);
	return parts[parts.length - 1] ?? remote.namespace;
}

function graphqlCountQuery(remote: GitRemote): string {
	if (remote.host === "gitlab") {
		const fullPath = `${remote.namespace}/${remote.name}`;
		return `query{project(fullPath:"${fullPath}"){mergeRequests(state:opened){count}}}`;
	}
	const owner = githubOwner(remote);
	return `query{repository(owner:"${owner}",name:"${remote.name}"){pullRequests(states:OPEN){totalCount}}}`;
}

const GITHUB_LIST_FIELDS = "number title state isDraft url";
const GITHUB_ISSUE_FIELDS = "number title url";

function githubIssuesQuery(remote: GitRemote): string {
	const repo = `${githubOwner(remote)}/${remote.name}`;
	const alias = (name: string, filters: string) =>
		`${name}:search(query:"repo:${repo} is:issue is:open ${filters}",type:ISSUE,first:${PULL_LIST_LIMIT})` +
		`{issueCount nodes{... on Issue{${GITHUB_ISSUE_FIELDS}}}}`;
	// `issuesAll` is a search rather than `repository.issues` because GitHub's
	// `issues` connection counts pull requests too, which would report a busy repo
	// as having hundreds more issues than it does.
	return [
		alias("issuesAll", ""),
		alias("issuesAssigned", "assignee:@me"),
		alias("issuesAuthored", "author:@me"),
		alias("issuesOther", "-assignee:@me -author:@me"),
		`repository(owner:"${githubOwner(remote)}",name:"${remote.name}"){hasIssuesEnabled}`,
	].join(" ");
}

function githubListsQuery(remote: GitRemote, issues = false): string {
	const repo = `${githubOwner(remote)}/${remote.name}`;
	const alias = (name: string, query: string) =>
		`${name}:search(query:"repo:${repo} is:pr is:open ${query} sort:updated-desc",type:ISSUE,first:${PULL_LIST_LIMIT})` +
		`{nodes{... on PullRequest{${GITHUB_LIST_FIELDS}}}}`;
	// `involves` already covers authored and review-requested pulls, so the two
	// are excluded from it; otherwise one pull shows up in two groups.
	const pulls = `${alias("authored", "author:@me")} ${alias("reviewing", "review-requested:@me")} ${alias(
		"involved",
		"involves:@me -author:@me -review-requested:@me",
	)}`;
	return `query{${pulls}${issues ? ` ${githubIssuesQuery(remote)}` : ""}}`;
}

function branchPullArgs(remote: GitRemote, branch: string): { command: string; args: string[] } {
	if (remote.host === "gitlab") {
		return {
			command: "glab",
			args: [
				"mr",
				"list",
				"--source-branch",
				branch,
				"--all",
				"--output",
				"json",
				"--per-page",
				"5",
			],
		};
	}
	return {
		command: "gh",
		args: [
			"pr",
			"list",
			"--head",
			branch,
			"--state",
			"all",
			"--limit",
			"5",
			"--json",
			"number,state,isDraft,title,url,reviewDecision,statusCheckRollup",
		],
	};
}

/**
 * Read the branch's pull, and — only when the branch has none — how many pulls
 * the repository has open. `undefined` means the read failed and the caller
 * should keep what it had.
 */
export async function readBranchPull(
	cwd: string,
	remote: GitRemote,
	branch: string,
	run: ForgeRun = runForge,
): Promise<BranchPullRead | undefined> {
	if (!forgeSupported(remote.host)) return undefined;
	const { command, args } = branchPullArgs(remote, branch);
	const output = await run(command, args, cwd);
	if (output === undefined) return undefined;

	const parsed = parseJson(output);
	const pulls = asArray(parsed)
		.map((raw) => (remote.host === "gitlab" ? pullFromGitlab(raw) : pullFromGithub(raw, true)))
		.filter((pull): pull is Pull => pull !== undefined);
	const pull = pickBranchPull(pulls);
	if (pull) return { pull };
	return { openCount: await readOpenPullCount(cwd, remote, run) };
}

/** How many pulls the repository has open, or undefined when the read failed. */
export async function readOpenPullCount(
	cwd: string,
	remote: GitRemote,
	run: ForgeRun = runForge,
): Promise<number | undefined> {
	if (!forgeSupported(remote.host)) return undefined;
	const command = remote.host === "gitlab" ? "glab" : "gh";
	const output = await run(
		command,
		["api", "graphql", "-f", `query=${graphqlCountQuery(remote)}`],
		cwd,
	);
	const parsed = parseJson(output);
	return remote.host === "gitlab"
		? openCountFromGitlabGraphql(parsed)
		: openCountFromGithubGraphql(parsed);
}

const GITLAB_LIST_ARGS: Record<keyof PullLists, string[]> = {
	authored: ["--author", "@me"],
	reviewing: ["--reviewer", "@me"],
	// GitLab has no `involves`; an assignment is the closest "I am on this one".
	involved: ["--assignee", "@me"],
};

/** Open and draft pulls are the rows worth listing: a merged one is not actionable. */
function isOpenPull(pull: Pull | undefined): pull is Pull {
	return pull !== undefined && (pull.state === "open" || pull.state === "draft");
}

/**
 * List each pull once, under its strongest claim.
 *
 * The searches are not disjoint in practice: GitLab's reviewer and assignee
 * lists overlap, and GitHub's `-author:@me -review-requested:@me` can be ignored
 * by the search. A pull in two groups reads as two pulls and inflates both
 * headings, so the first group to claim a URL keeps it.
 */
export function dedupePullLists(lists: PullLists): PullLists {
	const seen = new Set<string>();
	const out = {} as PullLists;
	for (const group of PULL_GROUPS) {
		out[group] = lists[group].filter((pull) => {
			if (seen.has(pull.url)) return false;
			seen.add(pull.url);
			return true;
		});
	}
	return out;
}

/** One issue out of GitHub's search nodes or GitLab's `glab issue list`. */
export function issueFromRaw(raw: unknown, forge: "github" | "gitlab"): Issue | undefined {
	const record = asRecord(raw);
	if (!record) return undefined;
	const number =
		forge === "gitlab"
			? (asNumber(record.iid) ?? asNumber(record.number))
			: asNumber(record.number);
	const url =
		forge === "gitlab" ? (asString(record.web_url) ?? asString(record.url)) : asString(record.url);
	if (number === undefined || !url) return undefined;
	return { number, url, title: asString(record.title) };
}

function isIssue(issue: Issue | undefined): issue is Issue {
	return issue !== undefined;
}

/** One issue group out of a GitHub search alias: its rows and its own count. */
function issueGroupFromGithub(data: Record<string, unknown> | undefined, name: string): IssueGroup {
	const search = asRecord(data?.[name]);
	return {
		items: asArray(search?.nodes)
			.map((raw) => issueFromRaw(raw, "github"))
			.filter(isIssue),
		total: asNumber(search?.issueCount) ?? 0,
	};
}

/**
 * GitHub's issues, out of the same GraphQL response that carries the pulls.
 *
 * `other` keeps its rows only while the repository is small enough for a list to
 * mean something; above `ISSUE_LIST_THRESHOLD` the bubble draws one counted row
 * instead, and the eight rows the search returned go unused. They are dropped
 * here so nothing downstream has to know the threshold.
 */
export function issueListsFromGithubGraphql(json: unknown): IssueLists | undefined {
	const data = asRecord(asRecord(json)?.data);
	if (!data) return undefined;

	const assigned = issueGroupFromGithub(data, "issuesAssigned");
	const authored = issueGroupFromGithub(data, "issuesAuthored");
	const other = issueGroupFromGithub(data, "issuesOther");
	const openCount = issueGroupFromGithub(data, "issuesAll").total;

	const seen = new Set<string>();
	const once = (group: IssueGroup): IssueGroup => ({
		total: group.total,
		items: group.items.filter((issue) => {
			if (seen.has(issue.url)) return false;
			seen.add(issue.url);
			return true;
		}),
	});

	return {
		// A fork usually has issues turned off; the section hides instead of
		// claiming the repository has none.
		enabled: asRecord(data.repository)?.hasIssuesEnabled !== false,
		openCount,
		assigned: once(assigned),
		authored: once(authored),
		other: openCount <= ISSUE_LIST_THRESHOLD ? once(other) : { total: other.total, items: [] },
	};
}

/** The repository's issue state and open count, out of a GitLab GraphQL answer. */
export function issueCountFromGitlabGraphql(
	json: unknown,
): { enabled: boolean; openCount: number } | undefined {
	const data = asRecord(asRecord(json)?.data);
	const project = asRecord(data?.project);
	if (!project) return undefined;
	return {
		enabled: project.issuesEnabled !== false,
		openCount: asNumber(asRecord(project.issues)?.count) ?? 0,
	};
}

const NO_ISSUES = (): IssueLists => ({
	enabled: true,
	openCount: 0,
	assigned: { items: [], total: 0 },
	authored: { items: [], total: 0 },
	other: { items: [], total: 0 },
});

/** GitLab has no combined issue search, so each group is its own list call. */
async function readGitlabIssueGroup(
	cwd: string,
	filters: string[],
	run: ForgeRun,
): Promise<{ group: IssueGroup; ok: boolean }> {
	const output = await run(
		"glab",
		["issue", "list", "--output", "json", "--per-page", String(PULL_LIST_LIMIT), ...filters],
		cwd,
	);
	const items = asArray(parseJson(output))
		.map((raw) => issueFromRaw(raw, "gitlab"))
		.filter(isIssue);
	return { group: { items, total: items.length }, ok: output !== undefined };
}

/**
 * GitLab's issues: the count first, then the groups it is worth asking for.
 *
 * The count decides whether the backlog is listed at all, which is why it is a
 * separate call here: one more process on a small repository buys not fetching
 * rows nobody would read on a large one.
 */
async function readGitlabIssues(
	cwd: string,
	remote: GitRemote,
	run: ForgeRun,
): Promise<IssueLists | "failed"> {
	const fullPath = `${remote.namespace}/${remote.name}`;
	const counted = issueCountFromGitlabGraphql(
		parseJson(
			await run(
				"glab",
				[
					"api",
					"graphql",
					"-f",
					`query=query{project(fullPath:"${fullPath}"){issuesEnabled issues(states:opened){count}}}`,
				],
				cwd,
			),
		),
	);
	if (!counted) return "failed";
	if (!counted.enabled) return { ...NO_ISSUES(), openCount: 0 };

	const wantsBacklog = counted.openCount <= ISSUE_LIST_THRESHOLD;
	const [assigned, authored, backlog] = await Promise.all([
		readGitlabIssueGroup(cwd, ["--assignee", "@me"], run),
		readGitlabIssueGroup(cwd, ["--author", "@me"], run),
		wantsBacklog ? readGitlabIssueGroup(cwd, [], run) : Promise.resolve(undefined),
	]);
	if (!assigned.ok && !authored.ok) return "failed";

	const seen = new Set<string>();
	const once = (group: IssueGroup): IssueGroup => ({
		total: group.total,
		items: group.items.filter((issue) => {
			if (seen.has(issue.url)) return false;
			seen.add(issue.url);
			return true;
		}),
	});
	/** A group GitLab gave no total for: its count is the rows that survived. */
	const byRows = (group: IssueGroup): IssueGroup => ({
		items: group.items,
		total: group.items.length,
	});

	return {
		enabled: true,
		openCount: counted.openCount,
		assigned: once(assigned.group),
		authored: once(authored.group),
		// The backlog is one unfiltered page, so its count is the rows that survive
		// deduplication against the two groups above; the forge reported no total.
		other: backlog ? byRows(once(backlog.group)) : { items: [], total: 0 },
	};
}

/**
 * The current user's pulls in the three groups the bubble lists, and — when the
 * config asks for them — the repository's issues.
 *
 * One request on GitHub carries both: the issue searches ride along with the pull
 * searches, so listing issues costs no extra round trip there. GitLab has no
 * combined search, so its issues are their own calls, and the count that decides
 * whether the backlog is listed at all is one more.
 *
 * Undefined means the pulls could not be read and the bubble should keep what it
 * had; issues that failed on their own are reported as "failed" instead, since
 * the pulls are still worth showing.
 */
export async function readForgeLists(
	cwd: string,
	remote: GitRemote,
	options: { issues?: boolean } = {},
	run: ForgeRun = runForge,
): Promise<ForgeLists | undefined> {
	if (!forgeSupported(remote.host)) return undefined;
	const wantsIssues = options.issues === true;

	if (remote.host === "gitlab") {
		const [pulls, issues] = await Promise.all([
			readGitlabPulls(cwd, run),
			wantsIssues ? readGitlabIssues(cwd, remote, run) : Promise.resolve(undefined),
		]);
		if (!pulls) return undefined;
		return issues === undefined ? { pulls } : { pulls, issues };
	}

	const output = await run(
		"gh",
		["api", "graphql", "-f", `query=${githubListsQuery(remote, wantsIssues)}`],
		cwd,
	);
	const parsed = parseJson(output);
	if (parsed === undefined) return undefined;
	// The search already asks for open pulls; this keeps one the forge returned
	// anyway (a state that changed mid-request) off the list.
	const pulls = pullsFromGithubGraphql(parsed);
	if (!wantsIssues) return { pulls };
	return { pulls, issues: issueListsFromGithubGraphql(parsed) ?? "failed" };
}

/** GitLab's three pull groups as three list calls, or undefined if all failed. */
async function readGitlabPulls(cwd: string, run: ForgeRun): Promise<PullLists | undefined> {
	const groups = await Promise.all(
		(Object.keys(GITLAB_LIST_ARGS) as Array<keyof PullLists>).map(async (group) => {
			const output = await run(
				"glab",
				[
					"mr",
					"list",
					"--output",
					"json",
					"--per-page",
					String(PULL_LIST_LIMIT),
					...GITLAB_LIST_ARGS[group],
				],
				cwd,
			);
			const pulls = asArray(parseJson(output))
				.map((raw) => pullFromGitlab(raw))
				.filter(isOpenPull);
			return [group, pulls, output !== undefined] as const;
		}),
	);
	// Every call failed: the bubble keeps its last answer instead of showing three
	// empty groups, which would read as "you have nothing".
	if (groups.every(([, , succeeded]) => !succeeded)) return undefined;
	return dedupePullLists(
		Object.fromEntries(groups.map(([group, pulls]) => [group, pulls])) as PullLists,
	);
}

/** The pulls in a GitHub GraphQL answer, deduped and with closed ones dropped. */
function pullsFromGithubGraphql(parsed: unknown): PullLists {
	const lists = pullListsFromGithubGraphql(parsed);
	return dedupePullLists({
		authored: lists.authored.filter(isOpenPull),
		reviewing: lists.reviewing.filter(isOpenPull),
		involved: lists.involved.filter(isOpenPull),
	});
}

/**
 * The current user's pulls, without the issue reads. Kept as its own name because
 * the pull snapshot and most callers only ever want this.
 */
export async function readUserPulls(
	cwd: string,
	remote: GitRemote,
	run: ForgeRun = runForge,
): Promise<PullLists | undefined> {
	return (await readForgeLists(cwd, remote, {}, run))?.pulls;
}
