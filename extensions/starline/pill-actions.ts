/**
 * What clicking a pill does.
 *
 * One table, keyed by segment. A segment with no entry stays a label:
 * `handleMouse` returns undefined for it and the click falls through to Pi, so an
 * inert pill swallows nothing. Every entry also answers to a `/starline`
 * subcommand of the same name, which is what makes the keyboard path real rather
 * than aspirational.
 *
 * An action receives the anchor of the pill it was called for, so anything it
 * shows can be placed against that pill. The bubble itself lives in
 * `pill-bubble.ts` and is shared: this file only decides what goes in it.
 */

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { truncateToWidth } from "@earendil-works/pi-tui";
import {
	cycleThinkingLevel,
	readPendingMessages,
	readThinkingLevels,
	setThinkingLevel,
} from "./live-session";
import { externalPillAction } from "./pill-api";
import { type PillAnchor, type PillBubbleContent, showPillBubble } from "./pill-bubble";
import { PILL_SEGMENT_VARIABLES } from "./pill-config";
import { type FleetSnapshot, getActiveSubagentFleet } from "./subagent-fleet";

/** What an action gets: the session, and where the pill is if a click found it. */
export type PillActionContext = {
	ctx: ExtensionContext;
	/**
	 * Geometry and colours of the pill this action belongs to. Absent when the
	 * command path runs while the pill is not on screen (text footer, or the
	 * segment removed from `pill.segments`); bubbles then fall back to centred.
	 */
	pill?: PillAnchor;
	/**
	 * How the action was reached. A click can offer a choice in the bubble; the
	 * `/starline` command has no pointer to make one with, so an action that
	 * offers choices does something direct instead.
	 */
	via: "click" | "command";
};

export type PillAction = (context: PillActionContext) => void | Promise<void>;

/**
 * Whether the session is holding messages for the running turn.
 *
 * The public surface is a boolean. Guarded rather than assumed: a build without
 * it, or a context that has gone stale after a session swap, must leave the pill
 * out instead of taking the footer's render down with it.
 */
export function hasQueuedMessages(ctx: ExtensionContext): boolean {
	try {
		const read = (ctx as ExtensionContext & { hasPendingMessages?: () => boolean })
			.hasPendingMessages;
		return typeof read === "function" && read.call(ctx) === true;
	} catch {
		return false;
	}
}

/**
 * The queue pill's text: a word, never a number — the pill is the signal, the
 * bubble is where the detail goes.
 */
export function queuedSegmentText(ctx: ExtensionContext): string {
	return hasQueuedMessages(ctx) ? "queued" : "";
}

/**
 * Cap on listed messages. More than a few turns a bubble into a wall, and the
 * count in the title already says how many there are.
 */
const MAX_LISTED_MESSAGES = 3;
/** Roughly what fits in the widest bubble, bullet included, before wrapping. */
const MAX_MESSAGE_COLUMNS = 58;

function oneLine(message: string): string {
	const collapsed = message.replace(/\s+/gu, " ").trim();
	return truncateToWidth(collapsed, MAX_MESSAGE_COLUMNS, "…");
}

/**
 * What the queue bubble says: the count and the messages when the live session
 * is readable, and the behaviour when it is not.
 */
export function queuedBubbleContent(): PillBubbleContent {
	const pending = readPendingMessages();
	if (!pending) {
		return {
			title: "Queued messages",
			body: [
				"Messages you send while the agent is working wait until the current turn ends, then get delivered.",
				"This build of Pi does not expose them to the extension, so the count and the text are unknown.",
			],
			hint: "esc to close",
		};
	}

	const messages = [...pending.steering, ...pending.followUp];
	const listed = messages.slice(0, MAX_LISTED_MESSAGES).map((message) => `· ${oneLine(message)}`);
	if (messages.length > listed.length) {
		listed.push(`· +${messages.length - listed.length} more`);
	}
	return {
		title: `${messages.length} message${messages.length === 1 ? "" : "s"} queued`,
		body: listed,
		hint: "esc to close",
	};
}

function showQueuedMessages({ ctx, pill }: PillActionContext): void {
	if (!hasQueuedMessages(ctx)) {
		// The pill only exists while something is queued; the command does not.
		if (ctx.hasUI) ctx.ui.notify("No messages are queued", "info");
		return;
	}
	showPillBubble(ctx, queuedBubbleContent(), pill);
}

function thinkingUnavailable(ctx: ExtensionContext): PillBubbleContent {
	const current = ctx.thinkingLevel ?? "";
	return {
		title: "Thinking",
		body: current
			? [`Current level: ${current}.`, "This session cannot change it from here."]
			: ["This model has no thinking level to change."],
		hint: "esc to close",
	};
}

/**
 * What the thinking pill's bubble offers: every level the model supports, the
 * current one marked and the others clickable. Picking one closes the bubble;
 * the footer re-renders from `thinking_level_select`, so the pill itself is the
 * confirmation.
 */
export function thinkingPickerContent(ctx: ExtensionContext): PillBubbleContent {
	const read = readThinkingLevels();
	if (!read) return thinkingUnavailable(ctx);
	return {
		title: "Thinking",
		body: read.levels.map((level) =>
			level === read.current
				? `● ${level}`
				: {
						text: `○ ${level}`,
						onSelect: () => {
							if (!setThinkingLevel(level) && ctx.hasUI) {
								ctx.ui.notify(`Could not switch thinking to ${level}`, "error");
							}
						},
					},
		),
		hint: "click a level · esc to close",
	};
}

/**
 * A click opens the level list; it changes nothing until a level is picked, so
 * looking is free. The command has no pointer to pick with, so it steps to the
 * next level and says where it landed.
 */
function showThinkingLevel({ ctx, pill, via }: PillActionContext): void {
	if (via === "click") {
		showPillBubble(ctx, thinkingPickerContent(ctx), pill);
		return;
	}
	const cycled = cycleThinkingLevel();
	showPillBubble(
		ctx,
		cycled
			? { title: "Thinking", body: [`${cycled.from} → ${cycled.to}`], hint: "esc to close" }
			: thinkingUnavailable(ctx),
		pill,
	);
}

/** `45s`, `3m 12s`, `1h 05m`: what a glance at a running agent needs. */
export function formatElapsed(milliseconds: number): string {
	const seconds = Math.max(0, Math.floor(milliseconds / 1000));
	if (seconds < 60) return `${seconds}s`;
	const minutes = Math.floor(seconds / 60);
	if (minutes < 60) return `${minutes}m ${String(seconds % 60).padStart(2, "0")}s`;
	return `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, "0")}m`;
}

function formatTokens(tokens: number): string {
	return tokens >= 1000 ? `${Math.round(tokens / 1000)}k tok` : `${tokens} tok`;
}

/**
 * One line per running agent: who, on what model, for how long, at what cost.
 * The model's provider prefix is dropped; the bubble is narrow and the name is
 * what tells two runs apart.
 */
export function subagentsBubbleContent(fleet: FleetSnapshot, now = Date.now()): PillBubbleContent {
	const listed = fleet.entries.map((entry) => {
		const name = entry.role ? `${entry.role} (${entry.agent})` : entry.agent;
		const parts = [name];
		if (entry.model) parts.push(entry.model.split("/").at(-1) ?? entry.model);
		parts.push(formatElapsed(now - entry.startedAt));
		if (entry.tokens > 0) parts.push(formatTokens(entry.tokens));
		return `· ${truncateToWidth(parts.join(" · "), MAX_MESSAGE_COLUMNS, "…")}`;
	});
	const unlisted = Math.max(fleet.omitted, fleet.totalActive - fleet.entries.length);
	if (unlisted > 0) listed.push(`· +${unlisted} more`);
	const total = fleet.totalActive;
	return {
		title: total > 0 ? `${total} subagent${total === 1 ? "" : "s"} running` : "Subagents",
		body: total > 0 ? listed : ["Nothing is running."],
		hint: "/subagents-fleet for details · esc to close",
	};
}

/** How long a click waits for fresh numbers before showing the ones it has. */
const FLEET_FETCH_TIMEOUT_MS = 400;

/**
 * Ask pi-subagents for the current fleet, then show it. The pill's count may be
 * a moment old and the elapsed times always are, so the bubble asks again; a
 * slow answer falls back to the last one rather than keeping the click waiting.
 */
async function showSubagents({ ctx, pill }: PillActionContext): Promise<void> {
	const fleet = getActiveSubagentFleet();
	if (!fleet) return;
	const fresh = await fleet.fetch(FLEET_FETCH_TIMEOUT_MS);
	if (!fresh && !fleet.available()) {
		if (ctx.hasUI) ctx.ui.notify("pi-subagents is not installed or not answering", "info");
		return;
	}
	showPillBubble(ctx, subagentsBubbleContent(fresh ?? fleet.snapshot()), pill);
}

/**
 * Segment key → action. Segments with no entry are labels: a click on one is not
 * handled, so nothing is swallowed.
 */
export const PILL_ACTIONS: Readonly<Partial<Record<string, PillAction>>> = {
	queue: showQueuedMessages,
	subagents: showSubagents,
	thinking: showThinkingLevel,
};

/**
 * The action for a pill span's key.
 *
 * A segment key Starline owns (a builtin segment) wins over a bridge, so a status
 * cannot hijack `queue`. Everything else is looked up in the published API, which
 * is how `extensionStatus:<key>` pills become clickable. No entry anywhere means
 * the pill is a label and the click falls through.
 */
export function pillActionFor(key: string): PillAction | undefined {
	if (key in PILL_SEGMENT_VARIABLES) return PILL_ACTIONS[key];
	return externalPillAction(key);
}

/**
 * Run an action from the mouse or from `/starline`, swallowing failure: a
 * throwing action must not take down the render loop that dispatched the click,
 * and the keyboard path is still available.
 */
export function runPillAction(
	action: PillAction,
	ctx: ExtensionContext,
	pill?: PillAnchor,
	via: PillActionContext["via"] = "click",
): void {
	try {
		const pending = action({ ctx, pill, via });
		if (pending) void pending.catch(() => {});
	} catch {
		// Nothing to report: the action's own guards are what keep this rare.
	}
}
