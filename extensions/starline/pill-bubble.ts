/**
 * A comic-style speech bubble that points at a pill.
 *
 * This is the popover every pill action gets, not the queue's private panel: an
 * action hands over its content and the anchor the footer recorded for the pill,
 * and gets a bubble in the pill's own colour, sitting above the footer with a
 * tail aimed at the pill.
 *
 * Pi's overlay positioning is what makes this possible without layout work:
 * `anchor: "bottom-left"` + `offsetX` puts the bubble at a column we choose, and
 * `offsetY: -1` lifts it off the footer row so the last line can carry the tail.
 */

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
	Key,
	matchesKey,
	type OverlayOptions,
	visibleWidth,
	wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import { contrastTextSgr } from "./pill";
import { resolveBackgroundSgr, type ThemeLike } from "./style";

const RESET = "\x1b[0m";
const BOLD = "\x1b[1m";
const DIM = "\x1b[2m";
/** Ends both bold and dim (SGR 22), without resetting colour. */
const ATTR_OFF = "\x1b[22m";

/** A bubble narrow enough to read as a bubble, wide enough for a sentence. */
const MIN_BUBBLE_WIDTH = 24;
const MAX_BUBBLE_WIDTH = 64;

/**
 * What the bubble needs to know about the pill it points at. The footer records
 * one of these per pill span, so any action can ask for "the bubble that belongs
 * to my pill" without knowing anything about the footer.
 */
export type PillAnchor = {
	/** Column of the pill's centre on the footer line. */
	centerColumn: number;
	/** Width the footer was rendered at, which is the terminal width. */
	terminalWidth: number;
	/** Background SGR the pill was painted with. */
	background: string;
	/** Foreground SGR of the pill; "" derives a legible one from the background. */
	foreground: string;
};

export type PillBubbleContent = {
	/** Bold heading, optional. */
	title?: string;
	/** Body paragraphs, wrapped to the bubble. */
	body: string[];
	/** Muted last line, e.g. the key that dismisses it. */
	hint?: string;
};

function clamp(value: number, min: number, max: number): number {
	return Math.max(min, Math.min(max, value));
}

/**
 * The bubble's width: its longest line plus the two borders and their padding,
 * kept between the bounds so a one-word pill still gets a readable bubble and a
 * wall of text does not become a full-width panel.
 */
export function pillBubbleWidth(content: PillBubbleContent, terminalWidth: number): number {
	const longest = Math.max(
		0,
		...[content.title ?? "", ...content.body, content.hint ?? ""].map((line) => visibleWidth(line)),
	);
	const ceiling = Math.max(8, Math.min(MAX_BUBBLE_WIDTH, terminalWidth - 4));
	return Math.min(Math.max(MIN_BUBBLE_WIDTH, longest + 4), ceiling);
}

/**
 * Where to put the bubble, and which column inside it the tail belongs on.
 *
 * The bubble is centred over the pill but clamped to stay on screen, so the tail
 * sits at the pill's centre and may end up off-centre in a clamped bubble. With
 * no anchor (a `/starline` command, or a pill that is not in the segment list)
 * the bubble is centred and has no tail.
 */
export function pillBubblePlacement(
	anchor: PillAnchor | undefined,
	width: number,
	fallbackWidth: number,
): { leftColumn: number; options: OverlayOptions; tailColumn?: number } {
	const terminalWidth = Math.max(1, Math.floor(anchor?.terminalWidth ?? fallbackWidth));
	const leftColumn = anchor
		? clamp(Math.round(anchor.centerColumn - width / 2), 1, Math.max(1, terminalWidth - width - 1))
		: Math.max(1, Math.floor((terminalWidth - width) / 2));
	return {
		leftColumn,
		// Bottom-left anchors the row to the bottom; the -1 keeps the footer row
		// free so the tail's last line can sit directly above the pill.
		options: {
			width,
			anchor: "bottom-left",
			offsetX: leftColumn,
			offsetY: -1,
		},
		tailColumn: anchor ? Math.round(anchor.centerColumn) - leftColumn : undefined,
	};
}

/**
 * Render the bubble: rounded box in the pill's colours, body wrapped to fit, and
 * a `▽` cut into the bottom border where the tail points.
 */
export function renderPillBubble(input: {
	content: PillBubbleContent;
	width: number;
	background: string;
	foreground?: string;
	tailColumn?: number;
}): string[] {
	const width = Math.max(6, Math.floor(input.width));
	const innerWidth = Math.max(1, width - 4);
	const background = input.background;
	const foreground = input.foreground || contrastTextSgr(background);

	// Every line is painted edge to edge, padding included, so the bubble reads as
	// one solid block instead of text floating over the transcript.
	const paint = (text: string) => {
		const padding = Math.max(0, width - visibleWidth(text));
		return `${background}${foreground}${text}${" ".repeat(padding)}${RESET}`;
	};
	const row = (text: string) =>
		paint(`│ ${text}${" ".repeat(Math.max(0, innerWidth - visibleWidth(text)))} │`);

	const lines: string[] = [];
	const heading = input.content.title;
	if (heading) {
		const label = `${BOLD} ${heading} ${ATTR_OFF}`;
		const rule = Math.max(0, width - 3 - visibleWidth(label));
		lines.push(paint(`╭─${label}${"─".repeat(rule)}╮`));
	} else {
		lines.push(paint(`╭${"─".repeat(Math.max(0, width - 2))}╮`));
	}

	for (const paragraph of input.content.body) {
		for (const line of wrapTextWithAnsi(paragraph, innerWidth)) lines.push(row(line));
	}
	if (input.content.hint) lines.push(row(`${DIM}${input.content.hint}${ATTR_OFF}`));

	const bottom: string[] = Array.from({ length: width }, (_, column) =>
		column === 0 ? "╰" : column === width - 1 ? "╯" : "─",
	);
	if (input.tailColumn !== undefined) {
		// Kept inside the border: the corners and the corner-adjacent dash stay.
		bottom[clamp(Math.round(input.tailColumn), 2, width - 3)] = "▽";
	}
	lines.push(paint(bottom.join("")));

	return lines;
}

/**
 * The open bubble's close function, so opening another one replaces it rather
 * than stacking two overlays on the same footer.
 */
let closeActiveBubble: (() => void) | undefined;

/** Dismiss the open bubble, if any. */
export function closePillBubble(): void {
	closeActiveBubble?.();
}

/**
 * Open the bubble for a pill action. Resolves when the bubble is dismissed
 * (Escape or Enter), which is why callers fire-and-forget it.
 */
export function showPillBubble(
	ctx: ExtensionContext,
	content: PillBubbleContent,
	anchor?: PillAnchor,
): void {
	if (!ctx.hasUI) return;
	// One bubble at a time: clicking a second pill swaps the popover instead of
	// leaving the first one underneath it.
	closePillBubble();

	const fallbackWidth = process.stdout.columns ?? 80;
	const width = pillBubbleWidth(content, anchor?.terminalWidth ?? fallbackWidth);
	const placement = pillBubblePlacement(anchor, width, fallbackWidth);

	void ctx.ui
		.custom<void>(
			(_tui, theme, _keybindings, done) => {
				let mounted = true;
				const close = () => {
					if (!mounted) return;
					mounted = false;
					if (closeActiveBubble === close) closeActiveBubble = undefined;
					done(undefined);
				};
				closeActiveBubble = close;

				return {
					render(renderWidth: number): string[] {
						return renderPillBubble({
							content,
							width: renderWidth,
							background:
								anchor?.background ??
								resolveBackgroundSgr(theme as ThemeLike, "theme", "borderMuted") ??
								"",
							foreground: anchor?.foreground,
							tailColumn: placement.tailColumn,
						});
					},
					invalidate() {},
					handleInput(data: string): void {
						if (matchesKey(data, Key.escape) || matchesKey(data, Key.enter)) close();
					},
					dispose(): void {
						mounted = false;
						if (closeActiveBubble === close) closeActiveBubble = undefined;
					},
				};
			},
			{ overlay: true, overlayOptions: placement.options },
		)
		.catch(() => {});
}
