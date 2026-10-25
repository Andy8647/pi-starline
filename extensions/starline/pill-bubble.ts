/**
 * The popover a pill opens: a block in the pill's own colour that grows up out
 * of the pill, the way a menu drops out of a menu bar.
 *
 * This is the popover every pill action gets, not the queue's private panel: an
 * action hands over its content and the anchor the footer recorded for the pill,
 * and gets a block aligned to the pill's left edge, sitting directly on the
 * footer row. Same colour and no gap is what says which pill it belongs to.
 *
 * Deliberately square. A terminal colours whole cells, so a rounded corner or a
 * tail has to be faked with glyphs, and every attempt (box-drawing corners over a
 * fill, quadrant-cut corners, a separate `▼`) left visible seams at the cell
 * edges. The only shaping left is a half-block top row, which halves the top
 * padding without drawing anything that can misalign.
 *
 * Pi's overlay positioning is what makes the placement possible without layout
 * work: `anchor: "bottom-left"` + `offsetX` puts the block at a column we choose,
 * and `offsetY: -1` keeps it off the footer row, so its last line sits right
 * above the pill.
 */

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
	Key,
	matchesKey,
	type OverlayOptions,
	visibleWidth,
	wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import { requestPointerShape } from "./mouse/pointer-shape";
import { contrastTextSgr } from "./pill";
import { resolveBackgroundSgr, type ThemeLike, toForegroundSgr } from "./style";

const RESET = "\x1b[0m";
const BOLD = "\x1b[1m";
const DIM = "\x1b[2m";
const UNDERLINE = "\x1b[4m";
/** Ends bold, dim and underline (SGR 22 + 24) without touching the colours. */
const STYLE_OFF = "\x1b[22m\x1b[24m";
const DEFAULT_BG = "\x1b[49m";

/** Half blocks that pad the block by half a row on the open sides. */
const TOP_EDGE = "▄";
const BOTTOM_EDGE = "▀";

/** A bubble narrow enough to read as a bubble, wide enough for a sentence. */
const MIN_BUBBLE_WIDTH = 24;
const MAX_BUBBLE_WIDTH = 64;

import type {
	PillAnchor,
	PillBubbleContent,
	PillBubbleHandle,
	PillBubbleSource,
} from "../../types/pill-api";

// The public shapes live in the published types file, so the protocol other
// extensions compile against and the one Starline implements cannot drift.
export type {
	PillAnchor,
	PillBubbleContent,
	PillBubbleHandle,
	PillBubbleLine,
	PillBubbleSource,
} from "../../types/pill-api";

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
 * Where to put the bubble, and whether it sits on its pill.
 *
 * With an anchor the bubble starts at the pill's left edge and is only pushed
 * left when it would run off the screen; it stays on the footer row either way,
 * so it still reads as coming out of the pill. With no anchor (a `/starline`
 * command while the pill is not on screen) it is centred and floats, closed off
 * at the bottom like it is at the top.
 */
export function pillBubblePlacement(
	anchor: PillAnchor | undefined,
	width: number,
	fallbackWidth: number,
): { leftColumn: number; options: OverlayOptions; attached: boolean } {
	const terminalWidth = Math.max(1, Math.floor(anchor?.terminalWidth ?? fallbackWidth));
	const rightmost = Math.max(0, terminalWidth - width);
	const leftColumn = anchor
		? clamp(Math.round(anchor.startColumn ?? anchor.centerColumn - width / 2), 0, rightmost)
		: Math.floor(rightmost / 2);
	return {
		leftColumn,
		// Bottom-left anchors the row to the bottom; the -1 keeps the footer row
		// itself visible, so the bubble's last line lands right on top of the pill.
		options: {
			width,
			anchor: "bottom-left",
			offsetX: leftColumn,
			offsetY: -1,
		},
		attached: anchor !== undefined,
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
	/** Sitting on its pill: the bottom stays open so the colour runs into it. */
	attached?: boolean;
}): { lines: string[]; targets: BubbleTarget[] } {
	const width = Math.max(6, Math.floor(input.width));
	const innerWidth = Math.max(1, width - 4);
	const background = input.background;
	const foreground = input.foreground || contrastTextSgr(background);
	// The half-block edges are the fill colour drawn as a foreground on the
	// terminal's own background, so the other half of the row stays empty.
	const fillFg = toForegroundSgr(background) ?? "";

	const edge = (glyph: string) => `${DEFAULT_BG}${fillFg}${glyph.repeat(width)}${RESET}`;
	const row = (text: string, style = "") =>
		// The style starts after the left padding and ends before the right, so an
		// underline covers the words and not the margin around them.
		`${background}${foreground}  ${style}${text}${STYLE_OFF}${" ".repeat(
			Math.max(0, innerWidth - visibleWidth(text)),
		)}  ${RESET}`;

	const lines: string[] = [edge(TOP_EDGE)];
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

	if (!input.attached) lines.push(edge(BOTTOM_EDGE));

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
	attached?: boolean;
}): string[] {
	return buildBubble(input).lines;
}

/**
 * The open bubble, so opening another one replaces it rather than stacking two
 * overlays on the same footer.
 */
let activeBubble: { handle: PillBubbleHandle; key?: string } | undefined;

/** Dismiss the open bubble, if any. */
export function closePillBubble(): void {
	activeBubble?.handle.close();
}

/** Whether the open bubble is the one the pill `key` opened. */
export function isPillBubbleOpenFor(key: string): boolean {
	return activeBubble !== undefined && activeBubble.key === key;
}

function closedHandle(): PillBubbleHandle {
	return {
		refresh() {},
		close() {},
		isOpen: () => false,
		onClose(callback) {
			callback();
		},
	};
}

/**
 * Open the bubble for a pill action and return its handle.
 *
 * `content` may be a function, read again on every `refresh()`, so a bubble can
 * show numbers that change while it is open. Pi fixes an overlay's width when it
 * opens, so a refresh whose content no longer fits reopens the overlay wider in
 * the same place; it never narrows while open, which would make it jitter.
 * Everything that ends the bubble — Escape, a click on a target, a second click on
 * its pill, another bubble replacing it, the session ending — runs the `onClose`
 * callbacks exactly once.
 */
export function showPillBubble(
	ctx: ExtensionContext,
	source: PillBubbleSource,
	anchor?: PillAnchor,
): PillBubbleHandle {
	if (!ctx.hasUI) return closedHandle();
	// One bubble at a time: clicking a second pill swaps the popover instead of
	// leaving the first one underneath it.
	closePillBubble();

	const read = (): PillBubbleContent => (typeof source === "function" ? source() : source);
	const fallbackWidth = process.stdout.columns ?? 80;
	const terminalWidth = anchor?.terminalWidth ?? fallbackWidth;

	let content = read();
	let width = pillBubbleWidth(content, terminalWidth);
	let open = true;
	const closeCallbacks: Array<() => void> = [];
	/** The overlay on screen now; replaced when a refresh needs a wider one. */
	let overlay: { dismiss: () => void; requestRender: () => void } | undefined;

	const finish = () => {
		if (!open) return;
		open = false;
		if (activeBubble?.handle === handle) activeBubble = undefined;
		for (const callback of closeCallbacks.splice(0)) {
			try {
				callback();
			} catch {
				// One bridge's cleanup failing must not stop the others.
			}
		}
	};

	const handle: PillBubbleHandle = {
		refresh() {
			if (!open) return;
			try {
				content = read();
			} catch {
				return;
			}
			const needed = pillBubbleWidth(content, terminalWidth);
			if (needed > width) {
				width = needed;
				mount();
			} else {
				overlay?.requestRender();
			}
		},
		close() {
			if (!open) return;
			const current = overlay;
			overlay = undefined;
			finish();
			current?.dismiss();
		},
		isOpen: () => open,
		onClose(callback) {
			if (open) closeCallbacks.push(callback);
			else callback();
		},
	};
	activeBubble = { handle, key: anchor?.key };

	function mount(): void {
		const previous = overlay;
		const placement = pillBubblePlacement(anchor, width, fallbackWidth);
		let instance: { dismiss: () => void; requestRender: () => void } | undefined;

		void ctx.ui
			.custom<void>(
				(tui, theme, _keybindings, done) => {
					let mounted = true;
					let targets: BubbleTarget[] = [];
					instance = {
						dismiss: () => {
							if (!mounted) return;
							mounted = false;
							done(undefined);
						},
						requestRender: () => {
							if (mounted) (tui as { requestRender?: () => void }).requestRender?.();
						},
					};
					overlay = instance;
					// The new overlay is up; only now take the narrower one down, so a
					// refresh never shows a frame with no bubble at all.
					previous?.dismiss();

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
								attached: placement.attached,
							});
							// Only the rows the last render drew can be clicked.
							targets = built.targets;
							return built.lines;
						},
						invalidate() {},
						handleInput(data: string): void {
							if (matchesKey(data, Key.escape) || matchesKey(data, Key.enter)) handle.close();
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
							if (event.type === "move") {
								requestPointerShape("pointer");
								return { handled: true };
							}
							if (event.type === "click") {
								handle.close();
								target.onSelect();
							}
							return { handled: true };
						},
						dispose(): void {
							mounted = false;
							// Pi took this overlay down without us asking (the session ended,
							// the UI was torn down). A replaced overlay is not the bubble closing.
							if (overlay === instance) {
								overlay = undefined;
								finish();
							}
						},
					};
				},
				{ overlay: true, overlayOptions: placement.options },
			)
			.catch(() => {
				if (overlay === instance || instance === undefined) finish();
			});
	}

	mount();
	return handle;
}
