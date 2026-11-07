/**
 * Pull and merge requests, as the git pill shows them.
 *
 * Types and pure formatting live here so the CLI reads in `forge-cli.ts` stay
 * about spawning and parsing, and so what the pill says can be tested without a
 * forge. Two shapes travel together:
 *
 * - the pull for the current branch, which is what the pill leads with;
 * - the repository's open count, shown instead when the branch has no pull of
 *   its own, and the current user's pulls, which only the bubble lists.
 */

import type { ColorSpec } from "./config";
import type { GitHost } from "./git";

/** What the forge says a pull is doing. `draft` is an open pull with a flag. */
export type PullState = "open" | "draft" | "merged" | "closed";

/** Rollup of a pull's checks. Absent when the forge reports none. */
export type PullChecks = "passing" | "failing" | "pending";

/** Review decision, as GitHub names it. GitLab reports none of these. */
export type PullReview = "approved" | "required" | "changes";

export type Pull = {
	number: number;
	state: PullState;
	url: string;
	title?: string;
	checks?: PullChecks;
	review?: PullReview;
};

/** The groups the bubble lists, in the order it lists them. */
export type PullGroup = "authored" | "reviewing" | "involved";

/**
 * The groups in the order the bubble lists them, strongest claim first. A pull
 * that answers more than one search belongs to the first of these.
 */
export const PULL_GROUPS: readonly PullGroup[] = ["authored", "reviewing", "involved"];

export type PullLists = Record<PullGroup, Pull[]>;

/** An open issue, as the bubble lists it. A row is a link and nothing more. */
export type Issue = { number: number; title?: string; url: string };

/** One issue group: the rows it lists, and how many the forge says exist. */
export type IssueGroup = { items: Issue[]; total: number };

/**
 * How many open issues still get a list.
 *
 * Above this the repository's backlog is not something a bubble can show, and
 * eight rows of it would be a sample dressed up as a list. The section collapses
 * to one row with the count and a link instead. A constant rather than a setting:
 * one number, no second real caller.
 */
export const ISSUE_LIST_THRESHOLD = 20;

/**
 * The repository's issues, for the bubble.
 *
 * Two scopes travel together. `assigned` and `authored` are "mine", which is
 * useful at any repository size; `other` is the rest of the backlog, which only
 * means anything on a repository small enough to read.
 */
export type IssueLists = {
	/** Open issues on the repository, from the forge's own count. */
	openCount: number;
	assigned: IssueGroup;
	authored: IssueGroup;
	/** The rest of the open issues; empty above `ISSUE_LIST_THRESHOLD`. */
	other: IssueGroup;
	/** False when the repository has no issue tracker, as many forks do. */
	enabled: boolean;
};

/**
 * Everything the pull bubble lists.
 *
 * `issues` is absent when the config is off, and `"failed"` when the forge
 * answered about pulls but not about issues: the pulls are still worth showing,
 * and claiming "no issues" would be a lie.
 */
export type ForgeLists = { pulls: PullLists; issues?: IssueLists | "failed" };

/** One refresh's answer about the current branch. */
export type PullSnapshot = {
	/** Which forge answered: decides the marker in front of the number. */
	host: GitHost;
	/** The pull open for the current branch, when there is one. */
	branch?: Pull;
	/** Open pulls on the repository; only read when the branch has none. */
	openCount?: number;
};

/** The marker each forge puts in front of a pull's number. */
export function pullMarker(host: GitHost): string {
	switch (host) {
		case "gitlab":
			return "!";
		default:
			// GitHub, Bitbucket and anything self-hosted that speaks pull requests.
			return "#";
	}
}

/** Glyph for a pull's state, from the configured icon set. */
export function pullStateIcon(state: PullState, icons: PullIconSet): string {
	switch (state) {
		case "draft":
			return icons.gitPrDraft;
		case "merged":
			return icons.gitPrMerged;
		case "closed":
			return icons.gitPrClosed;
		default:
			return icons.gitPrOpen;
	}
}

/** The state icons, a subset of the configured icons. */
export type PullIconSet = {
	gitPrOpen: string;
	gitPrDraft: string;
	gitPrMerged: string;
	gitPrClosed: string;
	gitPrList: string;
};

/** Marks for a pull's checks. Fixed glyphs, so ascii mode reads the same. */
const CHECK_MARKS: Record<PullChecks, string> = {
	passing: "✓",
	failing: "✗",
	pending: "⋯",
};

/**
 * What the pill says: the branch's pull when there is one, otherwise how many
 * pulls the repository has open.
 *
 * The two are told apart by the marker: `#123` is a pull, a bare `12` is a count.
 * An empty string means there is nothing to show, and the pill is dropped rather
 * than drawn empty.
 */
export function pullSegmentText(snapshot: PullSnapshot | undefined, icons: PullIconSet): string {
	if (!snapshot) return "";
	const marker = pullMarker(snapshot.host);
	const branch = snapshot.branch;
	if (branch) {
		const icon = pullStateIcon(branch.state, icons);
		const mark = branch.checks ? CHECK_MARKS[branch.checks] : "";
		return [icon ? `${icon} ${marker}${branch.number}` : `${marker}${branch.number}`, mark]
			.filter(Boolean)
			.join(" ");
	}
	if (snapshot.openCount === undefined) return "";
	return icons.gitPrList ? `${icons.gitPrList} ${snapshot.openCount}` : `${snapshot.openCount}`;
}

/**
 * The pill's background for the snapshot. A pull is coloured by its state; a
 * bare count stays neutral so it does not read as a pull in some state.
 */
export function pullColorSpec(
	snapshot: PullSnapshot | undefined,
	colors: {
		gitPrOpen: ColorSpec;
		gitPrDraft: ColorSpec;
		gitPrMerged: ColorSpec;
		gitPrClosed: ColorSpec;
		gitPrCount: ColorSpec;
	},
): ColorSpec {
	const state = snapshot?.branch?.state;
	if (!state) return colors.gitPrCount;
	switch (state) {
		case "draft":
			return colors.gitPrDraft;
		case "merged":
			return colors.gitPrMerged;
		case "closed":
			return colors.gitPrClosed;
		default:
			return colors.gitPrOpen;
	}
}
