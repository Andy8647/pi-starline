/**
 * What clicking a pill does.
 *
 * One table, keyed by segment. A segment with no entry stays a label:
 * `handleMouse` returns undefined for it and the click falls through to Pi, so an
 * inert pill swallows nothing. Every entry also answers to a `/starline`
 * subcommand of the same name, which is what makes the keyboard path real rather
 * than aspirational.
 */

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
	Key,
	matchesKey,
	truncateToWidth,
	visibleWidth,
	wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import { PILL_SEGMENT_VARIABLES } from "./pill-config";
import { safeThemeFg } from "./style";

/** What an action gets. Deliberately small: an action is a UI verb, not a service. */
export type PillActionContext = {
	ctx: ExtensionContext;
};

export type PillAction = (context: PillActionContext) => void | Promise<void>;

/**
 * Whether the session is holding messages for the running turn.
 *
 * The public surface is a boolean: the count and the messages themselves live on
 * `AgentSession`, which interactive mode does not put on the extension context.
 * Guarded rather than assumed — a build without it, or a context that has gone
 * stale after a session swap, must leave the pill out instead of taking the
 * footer's render down with it.
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
 * The queue pill's text: a word, never a number. `2 queued` would need
 * `pendingMessageCount` on the context, which does not exist yet.
 */
export function queuedSegmentText(ctx: ExtensionContext): string {
	return hasQueuedMessages(ctx) ? "queued" : "";
}

/**
 * Explain the queue without inventing contents.
 *
 * Pi tells extensions that something is queued and nothing more, so the panel
 * states the behaviour instead of listing messages. When a count or the messages
 * land on the extension context, this is the one place to widen.
 */
function showQueuedMessages({ ctx }: PillActionContext): void {
	if (!hasQueuedMessages(ctx)) {
		// The pill only exists while something is queued; the command does not.
		if (ctx.hasUI) ctx.ui.notify("No messages are queued", "info");
		return;
	}
	if (!ctx.hasUI) return;

	const title = "Queued messages";
	const paragraphs = [
		"Messages you send while the agent is working wait here until the current turn ends, then get delivered.",
		"Pi does not tell extensions how many are queued or what they say yet, so this panel cannot list them.",
	];
	const hint = "esc to close";

	void ctx.ui
		.custom<void>(
			(_tui, theme, _keybindings, done) => {
				const border = (text: string) => safeThemeFg(theme, "borderMuted", text);
				const accent = (text: string) => safeThemeFg(theme, "accent", text);
				const muted = (text: string) => safeThemeFg(theme, "muted", text);
				const row = (text: string, innerWidth: number) =>
					`${border("│")} ${text}${" ".repeat(Math.max(0, innerWidth - visibleWidth(text)))} ${border("│")}`;

				return {
					render(width: number): string[] {
						const innerWidth = Math.max(1, width - 4);
						const heading = ` ${title} `;
						const lines = [
							`${border("┌─")}${accent(heading)}${border(
								`${"─".repeat(Math.max(0, width - 3 - visibleWidth(heading)))}┐`,
							)}`,
							...paragraphs.flatMap((paragraph) =>
								wrapTextWithAnsi(paragraph, innerWidth).map((line) => row(line, innerWidth)),
							),
							row("", innerWidth),
							row(muted(hint), innerWidth),
							`${border("└")}${border("─".repeat(Math.max(0, width - 2)))}${border("┘")}`,
						];
						return lines.map((line) => truncateToWidth(line, width, ""));
					},
					invalidate() {},
					handleInput(data: string): void {
						if (matchesKey(data, Key.escape) || matchesKey(data, Key.enter)) {
							done(undefined);
						}
					},
				};
			},
			{ overlay: true },
		)
		.catch(() => {});
}

/**
 * Segment key → action. Segments with no entry are labels: a click on one is not
 * handled, so nothing is swallowed.
 */
export const PILL_ACTIONS: Readonly<Partial<Record<string, PillAction>>> = {
	queue: showQueuedMessages,
};

/**
 * The action for a pill span's key, if it names a builtin segment.
 *
 * Extension statuses share the key space (their spans carry the status key), so
 * the builtin-segment test keeps a third-party status named `queue` from opening
 * our panel. Status actions get their own hook when they exist.
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
export function runPillAction(action: PillAction, ctx: ExtensionContext): void {
	try {
		const pending = action({ ctx });
		if (pending) void pending.catch(() => {});
	} catch {
		// Nothing to report: the action's own guards are what keep this rare.
	}
}
