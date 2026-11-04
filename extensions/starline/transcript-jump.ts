/**
 * Where the transcript is scrolled to, and the one place Pi draws a shortcut for it.
 *
 * Pi composites a `↓ Jump to latest message` label over the last row of the
 * transcript viewport whenever the view has been scrolled away from the end. That
 * label is a filled block, it covers the bottom line of the transcript, and it
 * only ever offers one direction. Starline draws the same two moves as pills in
 * the footer instead — `previousPrompt` and `latest` — so the label is not drawn
 * here at all, and its click rectangle is cleared with it: a stale rectangle would
 * still answer a pointer that happened to land on the hidden row.
 *
 * `compositeScrollToEndIndicator` is also the one method every frame runs with the
 * live renderer and its layout in hand, which is what makes it the capture point
 * for both jumps: the scroll view is read from the same call that suppresses the
 * label, so the pills act on the renderer that is on screen right now rather than
 * one captured at session start (fullscreen mode swaps the renderer).
 *
 * Both methods this module patches are `private` in Pi's typings but ordinary
 * properties on the prototype at runtime. A Pi that renames or drops them leaves
 * the label on screen and the pills inert; nothing else breaks.
 */

import * as piCodingAgent from "@earendil-works/pi-coding-agent";
import { TuiAltScreen } from "@earendil-works/pi-tui";
import { installPrototypePatch } from "./prototype-patch-registry";

/** The slice of `ScrollView` this module reads. */
type TranscriptView = {
	children?: readonly unknown[];
	scrollTop: number;
	scrollTo(scrollTop: number): void;
	scrollToEnd?: () => void;
	getContentWidth(width: number): number;
};

/** The slice of `LayoutFrame` the indicator call carries. */
type LayoutLike = { primaryScrollView?: TranscriptView };

/** The slice of `TuiAltScreen` used to repaint after a jump. */
type RenderHost = { requestRender(force?: boolean): void };

/** Anything in the component tree: `Container`s have `children`, leaves render rows. */
type TranscriptNode = { children?: readonly unknown[]; render?: (width: number) => string[] };

/**
 * Pi's user-message component. Read off the namespace rather than destructured:
 * a Pi that stops exporting it should leave this module inert, not fail to load.
 */
const promptComponent = (piCodingAgent as { UserMessageComponent?: unknown }).UserMessageComponent;

let activeView: { scrollView: TranscriptView; width: number; host: RenderHost } | undefined;

function isPrompt(node: unknown): boolean {
	if (typeof promptComponent !== "function") return false;
	return node instanceof (promptComponent as new (...args: never[]) => object);
}

/**
 * Rows one component occupies at this width, or 0 when it cannot be measured.
 *
 * Rendering is how Pi's own containers measure their children, so this agrees
 * with the rows the layout actually produced. It is only ever run on a click:
 * measuring the whole transcript is too much to do per frame, and nothing else
 * here needs row numbers.
 */
function measuredRows(node: unknown, width: number): number {
	const render = (node as TranscriptNode | undefined)?.render;
	if (typeof render !== "function") return 0;
	try {
		const lines = render.call(node, width);
		return Array.isArray(lines) ? lines.length : 0;
	} catch {
		return 0;
	}
}

/**
 * Content rows where each prompt starts, top to bottom.
 *
 * The document container holds the header, the loaded-resources block and the
 * chat, and the chat is the only one of them with message components inside, so
 * the offsets are the header's measured rows plus each message block's. Only that
 * middle level is walked: descending into every `Box` would drop the padding rows
 * a `Box` adds around its children and put the offsets off by exactly that.
 */
export function promptRows(view: TranscriptView, width: number): number[] {
	const document = view.children?.[0] as TranscriptNode | undefined;
	const groups = document?.children;
	if (!Array.isArray(groups)) return [];

	const rows: number[] = [];
	let offset = 0;
	for (const group of groups) {
		const groupRows = measuredRows(group, width);
		const messages = (group as TranscriptNode).children;
		if (Array.isArray(messages) && messages.some(isPrompt)) {
			let inner = 0;
			for (const message of messages) {
				const messageRows = measuredRows(message, width);
				if (isPrompt(message)) rows.push(offset + inner);
				inner += messageRows;
			}
		}
		offset += groupRows;
	}
	return rows;
}

/**
 * The prompt to jump to: the last one that starts above the viewport top.
 *
 * Strictly above, so a pill pressed while a prompt fills the top row moves on to
 * the one before it instead of standing still. `rows` is ascending; the first
 * prompt already on or below the top means there is nothing above to offer, which
 * is the case the pill is inert in.
 */
export function previousPromptRow(rows: readonly number[], scrollTop: number): number | undefined {
	let found: number | undefined;
	for (const row of rows) {
		if (row >= scrollTop) break;
		found = row;
	}
	return found;
}

/** Back to the end of the transcript, where Pi resumes following new output. */
export function jumpToLatestMessage(): void {
	const view = activeView;
	if (!view) return;
	if (typeof view.scrollView.scrollToEnd !== "function") return;
	view.scrollView.scrollToEnd();
	view.host.requestRender();
}

/** Up to the previous prompt's first row, aligned to the top of the viewport. */
export function jumpToPreviousPrompt(): void {
	const view = activeView;
	if (!view) return;
	const width = view.scrollView.getContentWidth(view.width);
	const target = previousPromptRow(promptRows(view.scrollView, width), view.scrollView.scrollTop);
	if (target === undefined) return;
	view.scrollView.scrollTo(target);
	view.host.requestRender();
}

/**
 * Suppress Pi's own label and keep hold of the renderer, for as long as Starline
 * is installed. Returns a disposer; a Pi without the method gets a no-op one.
 */
export function installTranscriptJump(): () => void {
	if (!TuiAltScreen) return () => {};
	try {
		const cleanup = installPrototypePatch(
			TuiAltScreen.prototype,
			"compositeScrollToEndIndicator",
			"scroll-to-end-indicator-hide",
			({ receiver, args }) => {
				const [screen, layout, width] = args as [string[], LayoutLike | undefined, number];
				const scrollView = layout?.primaryScrollView;
				activeView =
					scrollView && Number.isFinite(width)
						? { scrollView, width, host: receiver as RenderHost }
						: undefined;
				// The label is not drawn, so nothing should answer a click on the row it
				// used to occupy. Pi clears this itself before compositing, which cannot
				// happen for a method that never composites.
				(receiver as { scrollToEndIndicatorRect?: unknown }).scrollToEndIndicatorRect = undefined;
				return screen;
			},
		);
		// Both, in one disposer: a jump must never act on a renderer whose patch is gone.
		return () => {
			cleanup();
			activeView = undefined;
		};
	} catch (error) {
		console.warn(
			"starline: this Pi no longer draws its scroll-to-end indicator the way Starline expects " +
				`(${error instanceof Error ? error.message : String(error)}). The previousPrompt and ` +
				"latest pills stay inert.",
		);
		return () => {};
	}
}

/** Forget the renderer without uninstalling, for a session that is being torn down. */
export function forgetTranscriptJump(): void {
	activeView = undefined;
}
