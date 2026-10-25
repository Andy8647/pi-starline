/**
 * A comic-style speech bubble that points at a pill.
 *
 * This is the popover every pill action gets, not the queue's private panel: an
 * action hands over its content and the anchor the footer recorded for the pill,
 * and gets a bubble in the pill's own colour, sitting above the footer with a
 * tail aimed at the pill.
 *
 * The shape is a filled block, not an outlined box: a terminal can only colour
 * whole cells, so an outline leaves the corners square while the curve hides
 * inside them. Cutting the four corner cells with quadrant glyphs and drawing the
 * tail as a filled triangle makes the silhouette itself rounded.
 *
 * Pi's overlay positioning is what makes the placement possible without layout
 * work: `anchor: "bottom-left"` + `offsetX` puts the bubble at a column we choose,
 * and `offsetY: -1` lifts it off the footer row so the last line can carry the
 * tail.
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
import { resolveBackgroundSgr, type ThemeLike, toForegroundSgr } from "./style";

const RESET = "\x1b[0m";
const BOLD = "\x1b[1m";
const DIM = "\x1b[2m";
const UNDERLINE = "\x1b[4m";
/** Ends bold, dim and underline (SGR 22 + 24) without touching the colours. */
const STYLE_OFF = "\x1b[22m\x1b[24m";
const DEFAULT_BG = "\x1b[49m";

/** Quadrants that keep the inside of each corner, leaving the outside cut away. */
const CORNERS = { topLeft: "▗", topRight: "▖", bottomLeft: "▝", bottomRight: "▘" };
const TAIL = "▼";

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

/**
 * A body line. A plain string is information; an object with `onSelect` is a
 * target: it renders underlined and runs the callback when clicked.
 */
export type PillBubbleLine = string | { text: string; onSelect: () => void };

export type PillBubbleContent = {
	/** Bold first line, optional. */
	title?: string;
	/** Body lines, wrapped to the bubble. */
	body: PillBubbleLine[];
	/** Muted last line, e.g. the key that dismisses it. */
	hint?: string;
};

/** A click target's row range in the rendered bubble. */
type BubbleTarget = { startLine: number; endLine: number; onSelect: () => void };

type BubbleMouseEvent = {
	type?: string;
	x: number;
	y: number;
	width?: number;
};

type BubbleMouseResult = { handled?: boolean };

function clamp(value: number, min: number, max: number): number {
	return Math.max(min, Math.min(max, value));
}

/**
 * The bubble's width: its longest line plus the padding, kept between the bounds
 * so a one-word pill still gets a readable bubble and a wall of text does not
 * become a full-width panel.
 */
export function pillBubbleWidth(content: PillBubbleContent, terminalWidth: number): number {
	const body = content.body.map((line) => (typeof line === "string" ? line : line.text));
	const longest = Math.max(
		0,
		...[content.title ?? "", ...body, content.hint ?? ""].map((line) => visibleWidth(line)),
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
 * Build the bubble's lines and the click targets that go with them, in one pass
 * so a target can never describe a row the renderer did not draw.
 */
function buildBubble(input: {
	content: PillBubbleContent;
	width: number;
	background: string;
	foreground?: string;
	tailColumn?: number;
}): { lines: string[]; targets: BubbleTarget[] } {
	const width = Math.max(6, Math.floor(input.width));
	const innerWidth = Math.max(1, width - 4);
	const background = input.background;
	const foreground = input.foreground || contrastTextSgr(background);
	// The corner glyphs are the fill colour drawn as a foreground, on the
	// terminal's own background, so the cell outside the curve stays empty.
	const fillFg = toForegroundSgr(background) ?? "";

	const corner = (glyph: string) => `${DEFAULT_BG}${fillFg}${glyph}${RESET}`;
	const fill = (count: number) => (count > 0 ? `${background}${" ".repeat(count)}${RESET}` : "");
	const row = (text: string, style = "") =>
		`${background}${foreground}${style}  ${text}${STYLE_OFF}${" ".repeat(
			Math.max(0, innerWidth - visibleWidth(text)),
		)}  ${RESET}`;

	const lines: string[] = [
		`${corner(CORNERS.topLeft)}${fill(width - 2)}${corner(CORNERS.topRight)}`,
	];
	const targets: BubbleTarget[] = [];

	if (input.content.title) lines.push(row(input.content.title, BOLD));

	for (const entry of input.content.body) {
		const text = typeof entry === "string" ? entry : entry.text;
		const startLine = lines.length;
		// A clickable line is underlined so it reads as a target. Padding is
		// appended after the style is switched off, or the spaces get underlined too.
		for (const wrapped of wrapTextWithAnsi(text, innerWidth)) {
			lines.push(row(wrapped, typeof entry === "string" ? "" : UNDERLINE));
		}
		if (typeof entry !== "string" && lines.length > startLine) {
			targets.push({ startLine, endLine: lines.length - 1, onSelect: entry.onSelect });
		}
	}

	if (input.content.hint) lines.push(row(input.content.hint, DIM));

	lines.push(`${corner(CORNERS.bottomLeft)}${fill(width - 2)}${corner(CORNERS.bottomRight)}`);

	if (input.tailColumn !== undefined) {
		const column = clamp(Math.round(input.tailColumn), 2, width - 3);
		lines.push(
			`${" ".repeat(column)}${corner(TAIL)}${" ".repeat(Math.max(0, width - column - 1))}`,
		);
	}

	return { lines, targets };
}

/**
 * Render the bubble's lines. Kept as a plain string[] because that is what a
 * component's `render` returns; `showPillBubble` uses the internal build so the
 * click targets line up with the rows.
 */
export function renderPillBubble(input: {
	content: PillBubbleContent;
	width: number;
	background: string;
	foreground?: string;
	tailColumn?: number;
}): string[] {
	return buildBubble(input).lines;
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
				let targets: BubbleTarget[] = [];
				const close = () => {
					if (!mounted) return;
					mounted = false;
					if (closeActiveBubble === close) closeActiveBubble = undefined;
					done(undefined);
				};
				closeActiveBubble = close;

				return {
					render(renderWidth: number): string[] {
						const built = buildBubble({
							content,
							width: renderWidth,
							background:
								anchor?.background ??
								resolveBackgroundSgr(theme as ThemeLike, "theme", "borderMuted") ??
								"",
							foreground: anchor?.foreground,
							tailColumn: placement.tailColumn,
						});
						// Only the rows the last render drew can be clicked.
						targets = built.targets;
						return built.lines;
					},
					invalidate() {},
					handleInput(data: string): void {
						if (matchesKey(data, Key.escape) || matchesKey(data, Key.enter)) close();
					},
					/**
					 * Overlays get mouse events with coordinates local to the overlay, so a
					 * target is just a row range. A press is claimed and the callback runs on
					 * the click, the same split the footer uses.
					 */
					handleMouse(event: BubbleMouseEvent): BubbleMouseResult | undefined {
						if (!Number.isFinite(event.x) || !Number.isFinite(event.y)) return undefined;
						const target = targets.find(
							(entry) => event.y >= entry.startLine && event.y <= entry.endLine,
						);
						if (!target) return undefined;
						if (event.type === "click") {
							close();
							target.onSelect();
						}
						return { handled: true };
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
