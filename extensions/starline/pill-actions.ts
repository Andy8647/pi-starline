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
import { cycleThinkingLevel, readPendingMessages } from "./live-session";
import { type PillAnchor, type PillBubbleContent, showPillBubble } from "./pill-bubble";
import { PILL_SEGMENT_VARIABLES } from "./pill-config";

/** What an action gets: the session, and where the pill is if a click found it. */
export type PillActionContext = {
	ctx: ExtensionContext;
	/**
	 * Geometry and colours of the pill this action belongs to. Absent when the
	 * command path runs while the pill is not on screen (text footer, or the
	 * segment removed from `pill.segments`); bubbles then fall back to centred.
	 */
	pill?: PillAnchor;
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

/**
 * Step the thinking level and say where it landed.
 *
 * The pill is the read-out, so the bubble only has to report the step; the footer
 * re-renders from `thinking_level_select` and shows the new level in place.
 */
function showThinkingLevel({ ctx, pill }: PillActionContext): void {
	const cycled = cycleThinkingLevel();
	if (!cycled) {
		const current = ctx.thinkingLevel ?? "";
		showPillBubble(
			ctx,
			{
				title: "Thinking",
				body: current
					? [`Current level: ${current}.`, "This session cannot change it from here."]
					: ["This model has no thinking level to cycle."],
				hint: "esc to close",
			},
			pill,
		);
		return;
	}
	showPillBubble(
		ctx,
		{
			title: "Thinking",
			body: [`${cycled.from} → ${cycled.to}`],
			hint: "esc to close",
		},
		pill,
	);
}

/**
 * Segment key → action. Segments with no entry are labels: a click on one is not
 * handled, so nothing is swallowed.
 */
export const PILL_ACTIONS: Readonly<Partial<Record<string, PillAction>>> = {
	queue: showQueuedMessages,
	thinking: showThinkingLevel,
};

/**
 * The action for a pill span's key, if it names a builtin segment.
 *
 * Extension statuses share the key space (their spans carry the status key), so
 * the builtin-segment test keeps a third-party status named `queue` from opening
 * our bubble. Status actions get their own hook when they exist.
 */
export function pillActionFor(key: string): PillAction | undefined {
	if (!(key in PILL_SEGMENT_VARIABLES)) return undefined;
	return PILL_ACTIONS[key];
}

/**
 * Run an action from the mouse or from `/starline`, swallowing failure: a
 * throwing action must not take down the render loop that dispatched the click,
 * and the keyboard path is still available.
 */
export function runPillAction(action: PillAction, ctx: ExtensionContext, pill?: PillAnchor): void {
	try {
		const pending = action({ ctx, pill });
		if (pending) void pending.catch(() => {});
	} catch {
		// Nothing to report: the action's own guards are what keep this rare.
	}
}
