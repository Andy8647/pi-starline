/**
 * The pull pill's bubble: the current user's pulls in three groups, each row a
 * link that opens in the browser.
 *
 * The list is read when the bubble opens, not on the refresh timer: three search
 * results are worth having when someone asks for them and worth nothing in a
 * footer. The answer is kept for a minute, so reopening the bubble does not cost
 * another round trip, and a failed read leaves the previous list in place instead
 * of claiming the user has nothing.
 */

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { truncateToWidth } from "@earendil-works/pi-tui";
import { readUserPulls } from "./forge-cli";
import { readGitRemote } from "./git";
import { openExternalUrl } from "./open-url";
import {
	type PillAnchor,
	type PillBubbleContent,
	type PillBubbleHandle,
	type PillBubbleLine,
	showPillBubble,
} from "./pill-bubble";
import { type Pull, type PullGroup, type PullLists, type PullState, pullMarker } from "./pull";
import { activePull } from "./pull-live";

const LIST_TTL_MS = 60_000;
const MAX_TITLE_COLUMNS = 44;

/** The groups in the order the bubble lists them, with the heading each gets. */
const GROUPS: Array<{ group: PullGroup; heading: string }> = [
	{ group: "authored", heading: "Yours" },
	{ group: "reviewing", heading: "Waiting on your review" },
	{ group: "involved", heading: "Also involved" },
];

const STATE_WORDS: Record<PullState, string> = {
	open: "open",
	draft: "draft",
	merged: "merged",
	closed: "closed",
};

type ListCache = { cwd: string; lists: PullLists; readAt: number };

let cached: ListCache | undefined;
let inFlight: { cwd: string; pending: Promise<PullLists | undefined> } | undefined;

function relativeAge(readAt: number, now: number): string {
	const seconds = Math.max(0, Math.round((now - readAt) / 1000));
	if (seconds < 90) return "just now";
	const minutes = Math.round(seconds / 60);
	return `${minutes} min ago`;
}

function pullRow(pull: Pull, marker: string): PillBubbleLine {
	const title = pull.title ? truncateToWidth(pull.title, MAX_TITLE_COLUMNS, "…") : "(no title)";
	return {
		text: `${marker}${pull.number} ${title} · ${STATE_WORDS[pull.state]}`,
		onSelect: () => openExternalUrl(pull.url),
	};
}

/**
 * The bubble's content, from whatever the last read left behind.
 *
 * Read synchronously on every refresh, so the bubble can be opened before the
 * forge answers and fill in when it does.
 */
export function pullBubbleContent(now = Date.now()): PillBubbleContent {
	const snapshot = activePull();
	const marker = pullMarker(snapshot?.host ?? "github");

	if (!cached) {
		return {
			title: "Pull requests",
			body: ["Reading from the forge…"],
			hint: "esc closes",
		};
	}

	const body: PillBubbleLine[] = [];
	let total = 0;
	for (const { group, heading } of GROUPS) {
		const pulls = cached.lists[group];
		if (pulls.length === 0) continue;
		total += pulls.length;
		body.push(`${heading} · ${pulls.length}`);
		for (const pull of pulls) body.push(pullRow(pull, marker));
	}

	if (total === 0) {
		return {
			title: "Pull requests",
			body: ["Nothing authored, requested for review, or involved."],
			hint: `read ${relativeAge(cached.readAt, now)}`,
		};
	}
	return { title: "Pull requests", body, hint: `enter opens · ${relativeAge(cached.readAt, now)}` };
}

/**
 * Read the lists, reusing the last answer for a minute. Resolves with the lists
 * the bubble should draw, or undefined when the read failed and there is nothing
 * cached to fall back on.
 */
async function refreshPullLists(cwd: string, now = Date.now()): Promise<PullLists | undefined> {
	if (cached && cached.cwd === cwd && now - cached.readAt < LIST_TTL_MS) return cached.lists;
	if (inFlight && inFlight.cwd === cwd) return inFlight.pending;

	const remote = await readGitRemote(cwd);
	const pending = remote ? readUserPulls(cwd, remote) : Promise.resolve(undefined);
	inFlight = { cwd, pending };
	try {
		const lists = await pending;
		if (lists) cached = { cwd, lists, readAt: Date.now() };
		return lists;
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
	const handle = showPillBubble(ctx, () => pullBubbleContent(), pill);
	void refreshPullLists(ctx.cwd)
		.then(() => {
			if (handle.isOpen()) handle.refresh();
		})
		.catch(() => undefined);
	return handle;
}
