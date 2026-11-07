/**
 * The pull pill's bubble: the current user's pulls in three groups, each row a
 * link that opens in the browser, plus — when `git.issues` is on — the
 * repository's open issues.
 *
 * The list is read when the bubble opens, not on the refresh timer: three search
 * results are worth having when someone asks for them and worth nothing in a
 * footer. The answer is kept for a minute, so reopening the bubble does not cost
 * another round trip, and a failed read leaves the previous list in place instead
 * of claiming the user has nothing.
 */

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { truncateToWidth } from "@earendil-works/pi-tui";
import { readForgeLists } from "./forge-cli";
import { readGitRemote } from "./git";
import { openExternalUrl } from "./open-url";
import {
	type PillAnchor,
	type PillBubbleContent,
	type PillBubbleHandle,
	type PillBubbleLine,
	showPillBubble,
} from "./pill-bubble";
import {
	type ForgeLists,
	ISSUE_LIST_THRESHOLD,
	type Issue,
	type IssueGroup,
	type IssueLists,
	PULL_GROUPS,
	type Pull,
	type PullGroup,
	type PullLists,
	type PullState,
	pullMarker,
} from "./pull";
import { activePull } from "./pull-live";

const LIST_TTL_MS = 60_000;
const MAX_TITLE_COLUMNS = 44;
/** Always the last row: the way out of the list and into the repository. */
const REPO_ROW_TEXT = "↗ Open repository";
/** A terminal whose height cannot be read still needs a number. */
const ASSUMED_ROWS = 24;
/** Rows the bubble and the footer around it need on screen. */
const ROW_RESERVE = 6;

/** The groups the bubble lists, in the order it lists them, with each heading. */
const GROUPS: Array<{ group: PullGroup; heading: string }> = [
	{ group: "authored", heading: "Yours" },
	{ group: "reviewing", heading: "Waiting on your review" },
	{ group: "involved", heading: "Also involved" },
];

/** The issue groups, strongest claim first. */
const ISSUE_GROUPS: Array<{ group: "assigned" | "authored" | "other"; heading: string }> = [
	{ group: "assigned", heading: "Assigned to you" },
	{ group: "authored", heading: "You opened" },
	{ group: "other", heading: "Other open issues" },
];

const STATE_WORDS: Record<PullState, string> = {
	open: "open",
	draft: "draft",
	merged: "merged",
	closed: "closed",
};

/**
 * What the bubble knows right now: nothing yet, a failed read, or the lists.
 *
 * `"failed"` is its own state rather than an empty list, because "Reading from the
 * forge…" forever and "you have nothing" are both lies after a read that failed.
 */
type ListsState = PullLists | "failed" | undefined;

type ListCache = {
	cwd: string;
	state: ListsState;
	lists: ForgeLists | undefined;
	readAt: number;
	webUrl?: string;
};

let cached: ListCache | undefined;
/** Kept apart from the lists so a failed read still leaves the repository row. */
let cachedWebUrl: string | undefined;
/** The last read that failed, so the reading row can become an honest one. */
let failedRead: { cwd: string; at: number } | undefined;
let inFlight: { cwd: string; pending: Promise<ListCache> } | undefined;
/** `git.issues`, registered by the extension entry. */
let issuesEnabled = false;

/** Turn the issue section on or off for the next bubble. */
export function setPullBubbleIssues(on: boolean): void {
	issuesEnabled = on;
}

function relativeAge(readAt: number, now: number): string {
	const seconds = Math.max(0, Math.round((now - readAt) / 1000));
	if (seconds < 90) return "just now";
	const minutes = Math.round(seconds / 60);
	return `${minutes} min ago`;
}

/** Rows the terminal can give the bubble without pushing its bottom off screen. */
function availableRows(): number {
	const rows = process.stdout.rows;
	return Math.max(6, (typeof rows === "number" && rows > 0 ? rows : ASSUMED_ROWS) - ROW_RESERVE);
}

function pullRow(pull: Pull, marker: string): PillBubbleLine {
	const title = pull.title ? truncateToWidth(pull.title, MAX_TITLE_COLUMNS, "…") : "(no title)";
	return {
		text: `${marker}${pull.number} ${title} · ${STATE_WORDS[pull.state]}`,
		onSelect: () => openExternalUrl(pull.url),
	};
}

function issueRow(issue: Issue): PillBubbleLine {
	const title = issue.title ? truncateToWidth(issue.title, MAX_TITLE_COLUMNS, "…") : "(no title)";
	return { text: `#${issue.number} ${title}`, onSelect: () => openExternalUrl(issue.url) };
}

/** The repository's own page, as a row whose URL stays out of the bubble. */
function repoRow(webUrl: string | undefined): PillBubbleLine[] {
	return webUrl ? [{ text: REPO_ROW_TEXT, onSelect: () => openExternalUrl(webUrl) }] : [];
}

/** Where the forge's issue list lives. GitHub and GitLab disagree about the path. */
function issuesUrl(webUrl: string | undefined, gitlab: boolean): string | undefined {
	if (!webUrl) return undefined;
	return `${webUrl}${gitlab ? "/-/issues" : "/issues"}`;
}

type Section = { heading: string; total: number; rows: PillBubbleLine[] };

/** Rows a section draws: its heading plus the rows it has room for. */
function sectionsHeight(sections: ReadonlyArray<Section & { shown: number }>): number {
	return sections.reduce((total, section) => total + 1 + section.shown, 0);
}

/**
 * Fit the sections into `maxRows`, taking rows from the end of the list.
 *
 * A section that lost rows says so in its heading (`Yours · 5 of 40`), which is
 * the difference between a shortened list and a short one. Nothing is taken from
 * the rows after the sections — those are the ways out of the bubble.
 */
function fitSections(sections: Section[], maxRows: number | undefined): PillBubbleLine[] {
	const trimmed = sections.map((section) => ({ ...section, shown: section.rows.length }));
	if (maxRows !== undefined) {
		while (sectionsHeight(trimmed) > maxRows) {
			const last = [...trimmed].reverse().find((section) => section.shown > 0);
			if (!last) break;
			last.shown -= 1;
		}
	}
	return trimmed.flatMap((section) => {
		// A section with no rows at all is a statement, not a group: "Issues
		// unavailable" has no count to give.
		const heading =
			section.rows.length === 0
				? section.heading
				: section.shown < section.rows.length
					? `${section.heading} · ${section.shown} of ${section.total}`
					: `${section.heading} · ${section.total}`;
		return [heading, ...section.rows.slice(0, section.shown)];
	});
}

export type PullBubbleOptions = {
	/** The repository's issues, or `"failed"` when that read did not answer. */
	issues?: IssueLists | "failed";
	/** Where the forge lists issues, for the counted row. */
	issuesUrl?: string;
	/** Rows the sections may use; the footer rows are added on top. */
	maxRows?: number;
};

/**
 * The rows for one answer: the pull groups, the issue groups when there are any,
 * and the way out. `undefined` is "still reading", `"failed"` is "could not read".
 */
export function pullBubbleBody(
	lists: ListsState,
	marker: string,
	webUrl: string | undefined,
	options: PullBubbleOptions = {},
): PillBubbleLine[] {
	const footer: PillBubbleLine[] = [];
	const issues = options.issues;

	if (issues !== undefined && issues !== "failed" && issues.enabled) {
		// Above the threshold the backlog is not something a bubble can list, so the
		// one row that still means something is the count and the way to it.
		if (issues.openCount > ISSUE_LIST_THRESHOLD && options.issuesUrl) {
			const url = options.issuesUrl;
			footer.push({
				text: `↗ All ${issues.openCount} open issues`,
				onSelect: () => openExternalUrl(url),
			});
		}
	}
	footer.push(...repoRow(webUrl));

	if (lists === undefined) {
		return ["Reading from the forge…", ...footer];
	}
	if (lists === "failed") {
		return ["Could not read from the forge.", ...footer];
	}

	const sections: Section[] = [];
	let total = 0;
	for (const { group, heading } of GROUPS) {
		const pulls = lists[group];
		if (pulls.length === 0) continue;
		total += pulls.length;
		sections.push({
			heading,
			total: pulls.length,
			rows: pulls.map((pull) => pullRow(pull, marker)),
		});
	}
	if (issues === "failed") {
		// The pulls answered, the issues did not: say so instead of showing an
		// empty section, which would read as "there are none".
		sections.push({ heading: "Issues unavailable", total: 0, rows: [] });
	} else if (issues !== undefined && issues.enabled) {
		for (const { group, heading } of ISSUE_GROUPS) {
			const issueGroup: IssueGroup = issues[group];
			if (issueGroup.items.length === 0) continue;
			sections.push({
				heading,
				total: issueGroup.total,
				rows: issueGroup.items.map((issue) => issueRow(issue)),
			});
		}
	}

	const body =
		sections.length === 0 && total === 0
			? [...["Nothing authored, requested for review, or involved."]]
			: [];
	return [...body, ...fitSections(sections, options.maxRows), ...footer];
}

/**
 * The bubble's content, from whatever the last read left behind.
 *
 * Read synchronously on every refresh, so the bubble can be opened before the
 * forge answers and fill in when it does. A cache from another directory is not
 * this session's answer: a `/cd` between two opens must not show the last repo.
 */
export function pullBubbleContent(now = Date.now(), cwd?: string): PillBubbleContent {
	const snapshot = activePull();
	const marker = pullMarker(snapshot?.host ?? "github");
	const usable = cached && (cwd === undefined || cached.cwd === cwd) ? cached : undefined;
	const failed =
		failedRead && (cwd === undefined || failedRead.cwd === cwd) ? failedRead : undefined;

	const issues = usable?.lists?.issues;
	const content: PillBubbleContent = {
		title: issuesEnabled ? "Pull requests & issues" : "Pull requests",
		body: pullBubbleBody(
			usable ? usable.state : failed ? "failed" : undefined,
			marker,
			usable?.webUrl ?? cachedWebUrl,
			{
				...(issuesEnabled ? { issues } : {}),
				...(issuesEnabled
					? { issuesUrl: issuesUrl(usable?.webUrl ?? cachedWebUrl, snapshot?.host === "gitlab") }
					: {}),
				// `availableRows` is what the bubble may draw; the rows outside the
				// sections are its two edges plus the two rows that lead out.
				maxRows: Math.max(1, availableRows() - 3),
			},
		),
		hint: usable
			? `enter opens · ${relativeAge(usable.readAt, now)}`
			: failed
				? "enter opens"
				: cachedWebUrl
					? "enter opens"
					: undefined,
	};
	return content;
}

/**
 * Read the lists, reusing the last answer for a minute.
 *
 * Resolves with the cache the bubble should draw from, so a failed read is
 * recorded as a failure rather than as an empty list.
 */
async function refreshLists(cwd: string, now = Date.now()): Promise<ListCache | undefined> {
	if (cached && cached.cwd === cwd && now - cached.readAt < LIST_TTL_MS) return cached;
	if (inFlight && inFlight.cwd === cwd) return inFlight.pending;

	const pending = (async (): Promise<ListCache> => {
		const remote = await readGitRemote(cwd);
		if (remote) cachedWebUrl = remote.webUrl;
		const lists = remote ? await readForgeLists(cwd, remote, { issues: issuesEnabled }) : undefined;
		if (!lists) {
			failedRead = { cwd, at: Date.now() };
			return { cwd, state: "failed", lists: undefined, readAt: Date.now(), webUrl: remote?.webUrl };
		}
		failedRead = undefined;
		return {
			cwd,
			state: lists.pulls,
			lists,
			readAt: Date.now(),
			webUrl: remote?.webUrl ?? cachedWebUrl,
		};
	})();

	inFlight = { cwd, pending };
	try {
		const result = await pending;
		if (result.lists) cached = result;
		return result;
	} finally {
		if (inFlight?.pending === pending) inFlight = undefined;
	}
}

/**
 * Open the bubble and fill it in.
 *
 * The read starts after the bubble is on screen, so the click never waits on a
 * network round trip; a refresh when it lands replaces "Reading from the forge…".
 */
export function showPulls(ctx: ExtensionContext, pill?: PillAnchor): PillBubbleHandle | undefined {
	if (!ctx.hasUI) return undefined;
	const cwd = ctx.cwd;
	const handle = showPillBubble(ctx, () => pullBubbleContent(Date.now(), cwd), pill);
	void refreshLists(cwd)
		.then(() => {
			if (handle.isOpen()) handle.refresh();
		})
		.catch(() => undefined);
	return handle;
}

/** Forget everything between tests; the cache outlives a session otherwise. */
export function __resetPullBubbleForTests(): void {
	cached = undefined;
	cachedWebUrl = undefined;
	failedRead = undefined;
	inFlight = undefined;
	issuesEnabled = false;
}
