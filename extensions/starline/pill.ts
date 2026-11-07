/**
 * Pill footer rendering.
 *
 * Draws segments as coloured blocks joined by seamless powerline arrows. The
 * arrow between two pills takes the left pill's background as its foreground
 * and the right pill's as its background, so the colours meet with no gap. All
 * colours come from the resolved SGR sequences, never from re-extracted RGB, so
 * whichever encoding Pi picked for the terminal survives intact.
 */

import { stripVTControlCharacters } from "node:util";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

import type { ColorSource, ColorSpec } from "./config";
import type { ExtensionStatusSegment } from "./extension-status";
import { truncateMiddle } from "./format";
import {
	EXTENSION_STATUS_PREFIX,
	EXTENSION_STATUS_SEGMENT,
	PILL_SEGMENT_VARIABLES,
	type PillConfig,
} from "./pill-config";
import { resolveBackgroundSgr, resolveColorSpec, type ThemeLike, toForegroundSgr } from "./style";

const RESET = "\x1b[0m";
const BOLD = "\x1b[1m";
const DEFAULT_BG = "\x1b[49m";

/** Text colours are the basic named codes, which every terminal renders correctly. */
const TEXT_DARK = "\x1b[30m";
const TEXT_LIGHT = "\x1b[97m";

/** Catppuccin surface1 — the neutral for segments whose spec names no colour. */
const NEUTRAL_BG = "\x1b[48;2;69;71;90m";

const SEPARATOR_GLYPHS: Record<PillConfig["separator"], string> = {
	powerline: "",
	"powerline-thin": "",
	none: "",
};

const CAP_GLYPHS = { left: "", right: "" };

/** Divider used where a solid arrow would be invisible. */
const THIN_SEPARATOR = SEPARATOR_GLYPHS["powerline-thin"];

/**
 * Where one pill ended up in a rendered bar, in visible columns.
 *
 * `startColumn` is inclusive, `endColumn` exclusive. Columns count what the
 * terminal draws, so a CJK pill spans two cells per character and a pill that
 * `width` cut in half still reports the cells it kept.
 *
 * A span covers everything the pill visually owns: its own padding, the
 * separator that points out of it, and — on the two ends of the bar — the cap.
 * That leaves no dead cells between two pills for a click to fall into.
 */
export type PillSpan = {
	/** `PillInput.key` of the segment this span belongs to. */
	key: string;
	startColumn: number;
	endColumn: number;
	/**
	 * First column painted solid in the pill's colour. The hit area starts earlier
	 * on the first pill, whose round cap is the colour drawn on the terminal's own
	 * background; anything that has to line up with the pill's edge uses this.
	 */
	bodyStartColumn: number;
	/** First column after the pill's own colour: where its arrow or cap starts. */
	bodyEndColumn: number;
	/** Background SGR the pill was painted with, for anything that has to match it. */
	bg: string;
	/** Foreground SGR, or "" when the text carried its own styling. */
	fg: string;
};

export type PillRenderOptions = {
	ascii?: boolean;
	/** Called once per pill that survived truncation, in left-to-right order. */
	onSpan?: (span: PillSpan) => void;
	/**
	 * The pills that did not fit, in bar order.
	 *
	 * The bar never draws part of a pill: when it runs out of room it drops whole
	 * pills from its right end and stands a `+N` counter in their place, so what is
	 * missing is still countable and still reachable through that pill's bubble.
	 * Dropping from the right makes `pill.segments` its own priority list — what is
	 * leftmost survives longest — which is the one ordering the user already owns.
	 */
	onOverflow?: (dropped: readonly PillOverflow[]) => void;
};

/** A pill that did not fit, as its bubble lists it. */
export type PillOverflow = { key: string; text: string };

/** Key of the counter that stands in for the pills that did not fit. */
export const OVERFLOW_PILL_KEY = "overflow";

export type PillInput = {
	/** Segment name, for diagnostics. */
	key: string;
	/** Segment text. Any styling it carries is stripped unless `keepStyling`. */
	text: string;
	/** ColorSpec the pill background is resolved from. */
	spec: ColorSpec;
	/**
	 * Columns at the tail of this pill's text that a shrink must not cut. A git
	 * pill puts its dirty counts and in-progress operation there, and those are
	 * the part a truncated branch name must not take with it.
	 */
	keepTailColumns?: number;
	/**
	 * Keep the text's own SGR instead of recolouring it. Used for extension
	 * statuses configured with `colorMode: "original"`, whose foreground the
	 * extension chose. Those get the neutral background so the extension's
	 * colours stay legible instead of fighting a segment colour.
	 */
	keepStyling?: boolean;
};

function statusInput(
	status: ExtensionStatusSegment,
	statusSpec: (key: string) => ColorSpec,
	statusIcon: (key: string) => string,
): PillInput {
	// colorMode "original" keeps the extension's own styling, so leave its text
	// exactly as it arrived rather than splicing an icon into styled output.
	if (status.colorMode === "original") {
		return { key: status.key, text: status.text, spec: "", keepStyling: true };
	}
	const icon = statusIcon(status.key);
	return {
		key: status.key,
		text: icon ? `${icon} ${status.text}` : status.text,
		spec: statusSpec(status.key),
	};
}

/**
 * Turn the configured segment list into pill inputs.
 *
 * `extensionStatus` is not one segment but however many other extensions have
 * registered, so it expands in place — minus any status already placed
 * explicitly as `extensionStatus:<key>`, which would otherwise appear twice.
 */
export function collectPillInputs(
	segments: string[],
	statuses: ExtensionStatusSegment[],
	renderVariable: (name: string) => string,
	specFor: (segment: string) => ColorSpec,
	statusSpec: (key: string) => ColorSpec,
	statusIcon: (key: string) => string = () => "",
	/** Columns at a built-in segment's tail that a shrink must keep. */
	tailColumnsFor: (segment: string) => number = () => 0,
): PillInput[] {
	const placedKeys = new Set(
		segments
			.filter((name) => name.startsWith(EXTENSION_STATUS_PREFIX))
			.map((name) => name.slice(EXTENSION_STATUS_PREFIX.length)),
	);

	const inputs: PillInput[] = [];
	for (const segment of segments) {
		if (segment === EXTENSION_STATUS_SEGMENT) {
			for (const status of statuses) {
				if (!placedKeys.has(status.key)) inputs.push(statusInput(status, statusSpec, statusIcon));
			}
			continue;
		}

		if (segment.startsWith(EXTENSION_STATUS_PREFIX)) {
			const key = segment.slice(EXTENSION_STATUS_PREFIX.length);
			const status = statuses.find((candidate) => candidate.key === key);
			if (status) inputs.push(statusInput(status, statusSpec, statusIcon));
			continue;
		}

		const variable = PILL_SEGMENT_VARIABLES[segment];
		if (!variable) continue;
		const keepTailColumns = tailColumnsFor(segment);
		inputs.push({
			key: segment,
			text: renderVariable(variable),
			spec: specFor(segment),
			// Only present when there is something to protect, so a plain segment
			// stays a two-field input.
			...(keepTailColumns > 0 ? { keepTailColumns } : {}),
		});
	}

	return inputs;
}

type PreparedPill = {
	key: string;
	text: string;
	bg: string;
	fg: string;
	bold: boolean;
	/** Visible columns of `text`, measured once. */
	width: number;
	/** The narrowest this pill may be compressed to, in visible columns. */
	floor: number;
	/** Tail columns a shrink keeps verbatim. */
	keepTailColumns: number;
};

/**
 * How narrow a pill may get before the bar drops it instead.
 *
 * Two words and an ellipsis: below this a pill no longer says what it is, and the
 * `+N` counter is the more honest thing to draw. Not configurable — there is one
 * caller, and a knob here would be another number to get wrong.
 */
const SHRINK_FLOOR = 24;

const XTERM_CUBE_LEVELS = [0, 95, 135, 175, 215, 255];

const XTERM_BASE_RGB: ReadonlyArray<[number, number, number]> = [
	[0, 0, 0],
	[128, 0, 0],
	[0, 128, 0],
	[128, 128, 0],
	[0, 0, 128],
	[128, 0, 128],
	[0, 128, 128],
	[192, 192, 192],
	[128, 128, 128],
	[255, 0, 0],
	[0, 255, 0],
	[255, 255, 0],
	[0, 0, 255],
	[255, 0, 255],
	[0, 255, 255],
	[255, 255, 255],
];

function xterm256ToRgb(index: number): [number, number, number] | undefined {
	if (index < 0 || index > 255) return undefined;
	if (index < 16) return XTERM_BASE_RGB[index];
	if (index < 232) {
		const offset = index - 16;
		return [
			XTERM_CUBE_LEVELS[Math.floor(offset / 36)] ?? 0,
			XTERM_CUBE_LEVELS[Math.floor((offset % 36) / 6)] ?? 0,
			XTERM_CUBE_LEVELS[offset % 6] ?? 0,
		];
	}
	const gray = 8 + (index - 232) * 10;
	return [gray, gray, gray];
}

/** Recover the RGB a background SGR stands for, when it is knowable. */
export function backgroundSgrToRgb(bg: string): [number, number, number] | undefined {
	const truecolor = /^\x1b\[48;2;(\d{1,3});(\d{1,3});(\d{1,3})m$/.exec(bg);
	if (truecolor) {
		return [Number(truecolor[1]), Number(truecolor[2]), Number(truecolor[3])];
	}
	const palette = /^\x1b\[48;5;(\d{1,3})m$/.exec(bg);
	if (palette) return xterm256ToRgb(Number(palette[1]));

	const named = /^\x1b\[(4[0-7]|10[0-7])m$/.exec(bg);
	if (named) {
		const code = Number(named[1]);
		return XTERM_BASE_RGB[code >= 100 ? code - 100 + 8 : code - 40];
	}
	return undefined;
}

/**
 * Pick a legible text colour for a background. Falls back to dark text when the
 * background's colour cannot be recovered — the case for `\x1b[49m`, where the
 * terminal's own default background is in play and either choice is a guess.
 */
export function contrastTextSgr(bg: string): string {
	const rgb = backgroundSgrToRgb(bg);
	if (!rgb) return TEXT_DARK;
	const [r, g, b] = rgb;
	const luminance = 0.299 * r + 0.587 * g + 0.114 * b;
	return luminance >= 128 ? TEXT_DARK : TEXT_LIGHT;
}

function neutralBackground(theme: ThemeLike, source: ColorSource): string {
	return resolveBackgroundSgr(theme, source, "borderMuted") ?? NEUTRAL_BG;
}

function prepare(
	inputs: PillInput[],
	theme: ThemeLike,
	source: ColorSource,
	config: PillConfig,
): PreparedPill[] {
	const neutral = neutralBackground(theme, source);
	const pills: PreparedPill[] = [];

	for (const input of inputs) {
		const text = input.keepStyling ? input.text : stripVTControlCharacters(input.text).trim();
		const width = visibleWidth(text);
		if (!text || width === 0) continue;

		const keepTailColumns = input.keepTailColumns ?? 0;
		// Styling this module did not choose carries ANSI it cannot re-measure, so
		// those pills are never compressed.
		const floor = input.keepStyling ? width : Math.min(width, SHRINK_FLOOR + keepTailColumns);

		if (input.keepStyling) {
			pills.push({
				key: input.key,
				text,
				bg: neutral,
				fg: "",
				bold: false,
				width,
				floor,
				keepTailColumns,
			});
			continue;
		}

		const resolved = resolveColorSpec(theme, source, input.spec);
		const bg = resolved.bg ?? resolveBackgroundSgr(theme, source, input.spec) ?? neutral;
		// An explicit fg: in the spec wins; otherwise pick for legibility.
		pills.push({
			key: input.key,
			text,
			bg,
			fg: resolved.bg && resolved.fg ? resolved.fg : contrastTextSgr(bg),
			bold: config.bold || resolved.bold,
			width,
			floor,
			keepTailColumns,
		});
	}

	return pills;
}

/**
 * Render the pill bar. Returns "" when nothing has content, so the caller can
 * fall back rather than emit a lone pair of caps.
 *
 * `options.onSpan` receives the hit area of every pill the terminal will
 * actually show, measured in the bar's own visible columns. Recording the spans
 * here rather than recomputing them later keeps them in step with the render:
 * colour, caps, separators and truncation are all already accounted for.
 */
export function renderPillBar(
	inputs: PillInput[],
	theme: ThemeLike,
	source: ColorSource,
	config: PillConfig,
	width: number,
	options: PillRenderOptions = {},
): string {
	const pills = prepare(inputs, theme, source, config);
	if (pills.length === 0) return "";

	// Nerd Font glyphs are the whole point of the shape; without them the
	// background transitions alone delineate the segments.
	const ascii = options.ascii === true;
	const separator = ascii ? "" : SEPARATOR_GLYPHS[config.separator];
	const wantsCaps = !ascii && config.caps !== "none";
	const leftCap = wantsCaps && config.caps === "round" ? CAP_GLYPHS.left : "";
	const rightCap = wantsCaps ? CAP_GLYPHS.right : "";

	const limit = width > 0 ? width : Number.POSITIVE_INFINITY;
	const separatorWidth = visibleWidth(separator);
	const capsWidth = visibleWidth(leftCap) + visibleWidth(rightCap);
	/**
	 * Width of `kept` pills, plus an optional counter standing in for the rest.
	 *
	 * `size` decides what a pill costs, which is what lets the same arithmetic
	 * answer two questions: what fits at full width, and what fits once every pill
	 * is squeezed to its floor.
	 */
	const lineWidth = (
		kept: number,
		counter: string | undefined,
		size: (pill: PreparedPill) => number = (pill) => pill.width,
	): number => {
		let total = capsWidth;
		for (let index = 0; index < kept; index++) {
			const pill = pills[index];
			total += (index > 0 ? separatorWidth : 0) + (pill ? size(pill) : 0) + 2;
		}
		if (counter !== undefined) {
			total += (kept > 0 ? separatorWidth : 0) + visibleWidth(counter) + 2;
		}
		return total;
	};
	/** A pill at its floor, or narrower when it was never that wide. */
	const floored = (pill: PreparedPill) => Math.min(pill.width, pill.floor);
	/** A pill squeezed to a uniform cap, never above its natural width. */
	const capped = (pill: PreparedPill, level: number) =>
		Math.min(pill.width, Math.max(level, pill.floor));
	const counterText = (dropped: number) => `+${dropped}`;

	// Everything fits until proven otherwise, which is the common case.
	let kept = pills.length;
	let showCounter = false;
	let truncateFirstTo = 0;

	if (lineWidth(kept, undefined) > limit) {
		kept = 0;
		// Compressing may be enough to keep everything, and that is the case this
		// exists for: one wide pill should not cost the pills behind it. Judge it
		// before anything is dropped, at each pill's floor.
		if (lineWidth(pills.length, undefined, floored) <= limit) {
			kept = pills.length;
		} else {
			// Pills are placed in order, so what does not fit comes off the right end.
			for (let candidate = pills.length - 1; candidate >= 1; candidate--) {
				if (lineWidth(candidate, counterText(pills.length - candidate), floored) <= limit) {
					kept = candidate;
					showCounter = true;
					break;
				}
			}
		}

		if (kept === 0) {
			// No pill plus the counter fits. Whole pills still count for more than
			// the counter does, so fill with those first; only when not even one fits
			// does the first pill lose part of its label (`Long…` rather than `+8`).
			for (let candidate = pills.length - 1; candidate >= 1; candidate--) {
				if (lineWidth(candidate, undefined, floored) <= limit) {
					kept = candidate;
					break;
				}
			}

			if (kept === 0) {
				const room = limit - capsWidth - 2;
				if (room >= 1) {
					kept = 1;
					truncateFirstTo = room;
				} else if (lineWidth(0, counterText(pills.length)) <= limit) {
					showCounter = true;
				}
			}
		}
	}

	const dropped = pills.slice(kept);
	const counterPill: PreparedPill | undefined =
		showCounter && dropped.length > 0
			? (() => {
					const bg = neutralBackground(theme, source);
					const text = counterText(dropped.length);
					const size = visibleWidth(text);
					return {
						key: OVERFLOW_PILL_KEY,
						text,
						bg,
						fg: contrastTextSgr(bg),
						bold: config.bold,
						// The counter is never compressed: it is the one pill whose whole
						// message is its number.
						width: size,
						floor: size,
						keepTailColumns: 0,
					};
				})()
			: undefined;

	const line: PreparedPill[] = pills.slice(0, kept);
	if (counterPill) line.push(counterPill);
	if (truncateFirstTo > 0 && line[0]) {
		line[0] = { ...line[0], text: truncateToWidth(line[0].text, truncateFirstTo, "…") };
	} else if (kept > 0) {
		const counter = counterPill ? counterText(dropped.length) : undefined;
		if (lineWidth(kept, counter) > limit) {
			// The pills that were kept fit at their floors, but not at full width: give
			// the width to the pills instead of dropping the ones behind a wide one.
			// The level is the widest cap every kept pill accepts, so the widest are
			// compressed and two wide pills come out even; a pill already narrower
			// than the cap is left alone.
			const fits = (level: number) =>
				lineWidth(kept, counter, (pill) => capped(pill, level)) <= limit;
			let low = 0;
			let high = Math.max(...pills.slice(0, kept).map((pill) => pill.width));
			while (low < high) {
				const middle = Math.ceil((low + high) / 2);
				if (fits(middle)) low = middle;
				else high = middle - 1;
			}
			for (let index = 0; index < kept; index++) {
				const pill = pills[index];
				if (!pill) continue;
				const cap = Math.max(low, pill.floor);
				if (pill.width > cap) {
					line[index] = {
						...pill,
						text: truncateMiddle(pill.text, cap, pill.keepTailColumns),
					};
				}
			}
		}
	}
	if (line.length === 0) return "";

	let out = "";
	// Columns the terminal will draw so far. Getting this from `visibleWidth`
	// rather than string length is what makes CJK segment text hit the right cells.
	let column = 0;
	const emit = (piece: string) => {
		out += piece;
		column += visibleWidth(piece);
	};

	const capStart = column;
	const firstBg = line[0]?.bg;
	if (leftCap && firstBg) {
		const capFg = toForegroundSgr(firstBg);
		if (capFg) emit(`${DEFAULT_BG}${capFg}${leftCap}${RESET}`);
	}

	line.forEach((pill, index) => {
		// The left cap opens the bar in the first pill's colour, so it belongs to it.
		const startColumn = index === 0 ? capStart : column;
		const bodyStartColumn = column;
		emit(`${pill.bg}${pill.fg}${pill.bold ? BOLD : ""} ${pill.text} ${RESET}`);
		const bodyEndColumn = column;

		const next = line[index + 1];
		if (next) {
			// A solid arrow works by being the left colour on the right colour, so
			// it vanishes when the two pills share a background — several segments
			// default to the same theme colour, which merged them into one blob.
			// Fall back to the thin divider in the text colour, which stays visible.
			if (separator && pill.bg === next.bg) {
				emit(`${pill.bg}${pill.fg || contrastTextSgr(pill.bg)}${THIN_SEPARATOR}${RESET}`);
			} else if (separator) {
				const arrowFg = toForegroundSgr(pill.bg);
				// Without a usable foreground the arrow would be invisible; letting the
				// backgrounds abut is better than drawing a glyph in the wrong colour.
				if (arrowFg) emit(`${next.bg}${arrowFg}${separator}${RESET}`);
			}
		} else if (rightCap) {
			const capFg = toForegroundSgr(pill.bg);
			if (capFg) emit(`${DEFAULT_BG}${capFg}${rightCap}${RESET}`);
		}

		// The arrow (or cap) is emitted before the span closes, so it belongs to
		// the pill that points out of itself.
		options.onSpan?.({
			key: pill.key,
			startColumn,
			endColumn: column,
			bodyStartColumn,
			bodyEndColumn,
			bg: pill.bg,
			fg: pill.fg,
		});
	});

	// The last line of defence: a pill whose own text is wider than the terminal
	// still cannot be allowed to wrap the footer.
	const rendered = width > 0 ? truncateToWidth(out, width, "") : out;
	if (options.onOverflow && dropped.length > 0) {
		options.onOverflow(
			dropped.map((pill) => ({
				key: pill.key,
				text: stripVTControlCharacters(pill.text).trim(),
			})),
		);
	}

	return rendered;
}
