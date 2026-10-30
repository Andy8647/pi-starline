/**
 * The popover a pill opens: a rounded outline in the pill's colour, sitting on
 * the pill, its bottom edge opening over the pill like a folder tab.
 *
 * This is the popover every pill action gets, not the queue's private panel: an
 * action hands over its content and the anchor the footer recorded for the pill,
 * and gets an outline whose bottom edge breaks exactly over that pill, so the pill
 * reads as the bubble's handle. The title sits in the top edge.
 *
 * An outline, not a filled block. A terminal colours whole cells, so a rounded
 * corner drawn over a fill leaves the fill's square corner showing around the
 * curve. With nothing filled the box-drawing corners are simply round, and the
 * inside keeps the terminal's own background — which on a translucent terminal
 * shows the blurred window behind it. Colour is spent on the outline, the title,
 * and the selected row, which is filled with the pill's colour like a menu
 * highlight.
 *
 * Pi's overlay positioning is what makes the placement possible without layout
 * work: `anchor: "bottom-left"` + `offsetX` puts the box at a column we choose,
 * and `offsetY: -1` keeps it off the footer row, so its bottom edge sits right
 * above the pill.
 */

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
	Key,
	matchesKey,
	type OverlayOptions,
	truncateToWidth,
	visibleWidth,
	wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import type {
	PillAnchor,
	PillBubbleContent,
	PillBubbleHandle,
	PillBubbleSource,
} from "../../types/pill-api";
import { requestPointerShape } from "./mouse/pointer-shape";
import { contrastTextSgr } from "./pill";
import { resolveBackgroundSgr, type ThemeLike, toForegroundSgr } from "./style";

// The public shapes live in the published types file, so the protocol other
// extensions compile against and the one Starline implements cannot drift.
export type {
	PillAnchor,
	PillBubbleContent,
	PillBubbleHandle,
	PillBubbleLine,
	PillBubbleSource,
} from "../../types/pill-api";

const RESET = "\x1b[0m";
const BOLD = "\x1b[1m";
const DIM = "\x1b[2m";
const UNDERLINE = "\x1b[4m";
/** Ends bold, dim and underline (SGR 22 + 24) without touching the colours. */
const STYLE_OFF = "\x1b[22m\x1b[24m";
const DEFAULT_BG = "\x1b[49m";

const BOX = {
	topLeft: "╭",
	topRight: "╮",
	bottomLeft: "╰",
	bottomRight: "╯",
	horizontal: "─",
	vertical: "│",
	/** The edge turning down into the opening over the pill, on each side. */
	openLeft: "┘",
	openRight: "└",
};

/** A bubble narrow enough to read as a bubble, wide enough for a sentence. */
const MIN_BUBBLE_WIDTH = 24;
const MAX_BUBBLE_WIDTH = 64;
/**
 * Columns of edge kept left of the opening, so the tab shape reads as a tab and
 * not as a box with a missing corner.
 */
const TAB_INSET = 3;

/** A click target's row range in the rendered bubble. */
type BubbleTarget = { startLine: number; endLine: number; onSelect: () => void };

/**
 * The target a bubble opens with selected: the first one marked `current`, as an
 * index into the targets (the object lines, in order).
 */
export function currentTargetIndex(content: PillBubbleContent): number | undefined {
	let index = 0;
	for (const line of content.body) {
		if (typeof line === "string") continue;
		if (line.current) return index;
		index += 1;
	}
	return undefined;
}

type BubbleMouseEvent = {
	type?: string;
	x: number;
	y: number;
	width?: number;
};

type BubbleMouseResult = { handled?: boolean };

/** Where the bottom edge opens, in columns of the bubble: [start, end). */
export type BubbleTab = { start: number; end: number };

function clamp(value: number, min: number, max: number): number {
	return Math.max(min, Math.min(max, value));
}

/**
 * The bubble's width: its longest line plus the border and padding, kept between
 * the bounds so a one-word pill still gets a readable bubble and a wall of text
 * does not become a full-width panel. The title rides in the top edge, which
 * needs two more columns than a body line (`╭─ title ─╮`). With a pill to sit on
 * it is at least wide enough for the opening over that pill.
 */
export function pillBubbleWidth(
	content: PillBubbleContent,
	terminalWidth: number,
	anchor?: PillAnchor,
): number {
	const body = content.body.map((line) => (typeof line === "string" ? line : line.text));
	const longest = Math.max(
		0,
		...[...body, content.hint ?? ""].map((line) => visibleWidth(line) + 4),
		content.title ? visibleWidth(content.title) + 6 : 0,
	);
	const pill =
		anchor?.startColumn !== undefined && anchor.endColumn !== undefined
			? anchor.endColumn - anchor.startColumn + TAB_INSET * 2 + 2
			: 0;
	// Content laid out in columns (the context grid) asks for more than the default
	// ceiling; the terminal is still the hard limit.
	const ceiling = Math.max(8, Math.min(MAX_BUBBLE_WIDTH, terminalWidth - 4));
	return Math.min(Math.max(MIN_BUBBLE_WIDTH, longest, pill), ceiling);
}

/**
 * Where to put the bubble, whether it sits on its pill, and where its bottom
 * edge opens.
 *
 * With an anchor the bubble starts a few columns left of the pill and is pushed
 * left only when it would run off the screen; it stays on the footer row either
 * way. The opening is the pill's own columns, and is dropped when the pill is too
 * close to the bubble's edge for the tab to have a side, leaving a closed bottom.
 * With no anchor (a `/starline` command while the pill is not on screen) it is
 * centred and closed.
 */
export function pillBubblePlacement(
	anchor: PillAnchor | undefined,
	width: number,
	fallbackWidth: number,
): { leftColumn: number; options: OverlayOptions; attached: boolean; tab?: BubbleTab } {
	const terminalWidth = Math.max(1, Math.floor(anchor?.terminalWidth ?? fallbackWidth));
	const rightmost = Math.max(0, terminalWidth - width);
	const start = anchor?.startColumn;
	const leftColumn = anchor
		? clamp(
				Math.round(start !== undefined ? start - TAB_INSET : anchor.centerColumn - width / 2),
				0,
				rightmost,
			)
		: Math.floor(rightmost / 2);

	let tab: BubbleTab | undefined;
	if (start !== undefined && anchor?.endColumn !== undefined) {
		const opening = { start: start - leftColumn, end: anchor.endColumn - leftColumn };
		// The edge needs a corner and a turn on each side of the opening.
		if (opening.start >= 2 && opening.end <= width - 2 && opening.end > opening.start) {
			tab = opening;
		}
	}

	return {
		leftColumn,
		// Bottom-left anchors the row to the bottom; the -1 keeps the footer row
		// itself visible, so the bubble's bottom edge lands right on top of the pill.
		options: {
			width,
			anchor: "bottom-left",
			offsetX: leftColumn,
			offsetY: -1,
		},
		attached: anchor !== undefined,
		tab,
	};
}

/**
 * Build the bubble's lines and the click targets that go with them, in one pass
 * so a target can never describe a row the renderer did not draw.
 *
 * This is the only function that decides what the bubble looks like; placement,
 * targets, refresh and the protocol do not depend on any of it.
 */
function buildBubble(input: {
	content: PillBubbleContent;
	width: number;
	background: string;
	foreground?: string;
	/** Sitting on its pill. Kept for callers; the opening is what shows it. */
	attached?: boolean;
	/** Columns of the bottom edge left open over the pill. */
	tab?: BubbleTab;
	/** Index into the targets of the row drawn as selected. */
	selected?: number;
}): { lines: string[]; targets: BubbleTarget[] } {
	const width = Math.max(8, Math.floor(input.width));
	const innerWidth = Math.max(1, width - 4);
	const background = input.background;
	const foreground = input.foreground || contrastTextSgr(background);
	// The outline is the pill's colour as a foreground on the terminal's own
	// background; nothing inside the box is filled.
	const line = `${DEFAULT_BG}${toForegroundSgr(background) ?? ""}`;
	const side = `${line}${BOX.vertical}${RESET}`;

	const row = (text: string, style = "") =>
		// The style starts after the left padding and ends before the right, so an
		// underline covers the words and not the margin around them.
		`${side} ${style}${text}${STYLE_OFF}${" ".repeat(Math.max(0, innerWidth - visibleWidth(text)))} ${side}`;
	const selectedRow = (text: string) =>
		`${side}${background}${foreground} ${text}${" ".repeat(
			Math.max(0, innerWidth - visibleWidth(text)),
		)} ${RESET}${side}`;

	const title = input.content.title
		? truncateToWidth(input.content.title, Math.max(1, width - 6), "…")
		: "";
	const lines: string[] = [
		title
			? `${line}${BOX.topLeft}${BOX.horizontal} ${BOLD}${title}${STYLE_OFF} ${BOX.horizontal.repeat(
					Math.max(0, width - visibleWidth(title) - 5),
				)}${BOX.topRight}${RESET}`
			: `${line}${BOX.topLeft}${BOX.horizontal.repeat(width - 2)}${BOX.topRight}${RESET}`,
	];
	const targets: BubbleTarget[] = [];

	for (const entry of input.content.body) {
		const text = typeof entry === "string" ? entry : entry.text;
		const startLine = lines.length;
		const isSelected = typeof entry !== "string" && targets.length === input.selected;
		// A clickable line is underlined so it reads as a target, and filled in the
		// pill's colour while it is the selected one.
		for (const wrapped of wrapTextWithAnsi(text, innerWidth)) {
			if (isSelected) lines.push(selectedRow(wrapped));
			else lines.push(row(wrapped, typeof entry === "string" ? "" : UNDERLINE));
		}
		if (typeof entry !== "string" && lines.length > startLine) {
			targets.push({ startLine, endLine: lines.length - 1, onSelect: entry.onSelect });
		}
	}

	if (input.content.hint) lines.push(row(input.content.hint, DIM));

	const tab = input.tab;
	let bottom = BOX.bottomLeft;
	for (let column = 1; column < width - 1; column += 1) {
		if (tab && column === tab.start - 1) bottom += BOX.openLeft;
		else if (tab && column >= tab.start && column < tab.end) bottom += " ";
		else if (tab && column === tab.end) bottom += BOX.openRight;
		else bottom += BOX.horizontal;
	}
	lines.push(`${line}${bottom}${BOX.bottomRight}${RESET}`);

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
	tab?: BubbleTab;
	selected?: number;
}): string[] {
	return buildBubble(input).lines;
}

/**
 * The open bubble, so opening another one replaces it rather than stacking two
 * overlays on the same footer.
 */
let activeBubble: { handle: PillBubbleHandle; key?: string } | undefined;

/**
 * Where the open bubble drew itself, in screen cells. A bubble is dismissed by a
 * click outside it, and "outside" needs its rectangle: Pi's overlay placement puts
 * it on the footer row whatever the content, so the rectangle is the only thing
 * that says which cells belong to it.
 */
export type PillBubbleGeometry = {
	/** First column the bubble covers, 0-based. */
	leftColumn: number;
	/** Columns it covers. */
	width: number;
	/** Rows it drew, which is what the overlay was handed. */
	height: number;
	/** Rows between the bubble's last row and the terminal's last row (the footer). */
	bottomOffset: number;
};

let activeBubbleGeometry: PillBubbleGeometry | undefined;

/** Geometry of the bubble on screen now, or undefined when none is open. */
export function activePillBubbleGeometry(): PillBubbleGeometry | undefined {
	return activeBubbleGeometry;
}

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
 * How long a bubble takes to unfold from its pill, in milliseconds. 0 opens it
 * at once. Set from the extension's config; tests leave it at 0 so a bubble is
 * whole on its first render.
 */
let openAnimationMs = 0;

export function setPillBubbleAnimation(milliseconds: number): void {
	openAnimationMs = Math.max(0, Math.floor(milliseconds));
}

/** About one frame at 60 Hz. */
const ANIMATION_FRAME_MS = 16;

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
 *
 * Targets can be chosen with the mouse or the keyboard, and both move the same
 * selection: hovering a target selects it, ↑/↓ step through the targets, and
 * Enter runs the selected one (or closes the bubble when none is selected).
 *
 * The first overlay unfolds upward from the pill over `openAnimationMs`: the
 * overlay is anchored at its bottom, so drawing only its last rows and adding one
 * per frame grows it out of the pill. A reopen for width is not animated.
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
	let width = pillBubbleWidth(content, terminalWidth, anchor);
	/** Placement of the overlay on screen now, kept for the geometry a click reads. */
	let leftColumn = 0;
	let bottomOffset = 1;
	let open = true;
	/**
	 * Index of the selected target, shared by the mouse and the keyboard. It
	 * starts on the target marked `current`, and follows that mark through
	 * refreshes until the user moves it.
	 */
	let selected = currentTargetIndex(content);
	let selectionMoved = false;
	let mounts = 0;
	const closeCallbacks: Array<() => void> = [];
	/** The overlay on screen now; replaced when a refresh needs a wider one. */
	let overlay: { dismiss: () => void; requestRender: () => void } | undefined;

	const finish = () => {
		if (!open) return;
		open = false;
		activeBubbleGeometry = undefined;
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
			if (!selectionMoved) selected = currentTargetIndex(content);
			const needed = pillBubbleWidth(content, terminalWidth, anchor);
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
		// Where the overlay lands is the placement's to decide, and its own rows are
		// whatever it draws; a click expects both, so record them as they happen.
		leftColumn = placement.leftColumn;
		bottomOffset = Math.max(0, -(placement.options.offsetY ?? 0));
		const animate = mounts === 0 && openAnimationMs > 0;
		mounts += 1;
		let instance: { dismiss: () => void; requestRender: () => void } | undefined;

		void ctx.ui
			.custom<void>(
				(tui, theme, _keybindings, done) => {
					let mounted = true;
					let targets: BubbleTarget[] = [];
					const repaint = () => {
						if (mounted) (tui as { requestRender?: () => void }).requestRender?.();
					};
					const openedAt = Date.now();
					let frames: ReturnType<typeof setInterval> | undefined;
					const stopFrames = () => {
						if (frames !== undefined) clearInterval(frames);
						frames = undefined;
					};
					if (animate && typeof (tui as { requestRender?: unknown }).requestRender === "function") {
						frames = setInterval(() => {
							repaint();
							if (Date.now() - openedAt >= openAnimationMs) stopFrames();
						}, ANIMATION_FRAME_MS);
						frames.unref?.();
					}

					instance = {
						dismiss: () => {
							if (!mounted) return;
							mounted = false;
							stopFrames();
							done(undefined);
						},
						requestRender: repaint,
					};
					overlay = instance;
					// The new overlay is up; only now take the narrower one down, so a
					// refresh never shows a frame with no bubble at all.
					previous?.dismiss();

					const select = (index: number | undefined) => {
						selectionMoved = true;
						if (index === selected) return;
						selected = index;
						repaint();
					};
					const runSelected = () => {
						const target = selected === undefined ? undefined : targets[selected];
						handle.close();
						target?.onSelect();
					};

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
								tab: placement.tab,
								selected,
							});
							let lines = built.lines;
							let shift = 0;
							if (frames !== undefined) {
								const progress = Math.min(1, (Date.now() - openedAt) / openAnimationMs);
								const shown = Math.max(1, Math.ceil(lines.length * progress));
								shift = lines.length - shown;
								lines = lines.slice(shift);
							}
							// In the overlay's own rows. Rows not drawn yet land above row 0,
							// where no pointer can reach them, and every target keeps its
							// index, so the keyboard's selection means the same row throughout.
							targets = built.targets.map((target) => ({
								...target,
								startLine: target.startLine - shift,
								endLine: target.endLine - shift,
							}));
							// The rows that will be on screen, not the ones the content would draw:
							// during the unfold the overlay is shorter than its content.
							if (overlay === instance) {
								activeBubbleGeometry = {
									leftColumn,
									width: Math.max(0, Math.floor(renderWidth)),
									height: lines.length,
									bottomOffset,
								};
							}
							return lines;
						},
						invalidate() {},
						handleInput(data: string): void {
							if (matchesKey(data, Key.escape)) {
								handle.close();
							} else if (matchesKey(data, Key.enter)) {
								runSelected();
							} else if (matchesKey(data, Key.down) || matchesKey(data, Key.up)) {
								if (targets.length === 0) return;
								const step = matchesKey(data, Key.down) ? 1 : -1;
								const from = selected ?? (step > 0 ? -1 : 0);
								select((from + step + targets.length) % targets.length);
							}
						},
						/**
						 * Overlays get mouse events with coordinates local to the overlay, so a
						 * target is just a row range. Hovering selects, a press is claimed and
						 * the callback runs on the click, the same split the footer uses.
						 */
						handleMouse(event: BubbleMouseEvent): BubbleMouseResult | undefined {
							if (!Number.isFinite(event.x) || !Number.isFinite(event.y)) return undefined;
							const index = targets.findIndex(
								(entry) => event.y >= entry.startLine && event.y <= entry.endLine,
							);
							if (index < 0) return undefined;
							if (event.type === "move") {
								requestPointerShape("pointer");
								select(index);
								return { handled: true };
							}
							if (event.type === "click") {
								selected = index;
								runSelected();
							}
							return { handled: true };
						},
						dispose(): void {
							mounted = false;
							stopFrames();
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
