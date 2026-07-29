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

export type PillInput = {
	/** Segment name, for diagnostics. */
	key: string;
	/** Segment text. Any styling it carries is stripped unless `keepStyling`. */
	text: string;
	/** ColorSpec the pill background is resolved from. */
	spec: ColorSpec;
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
		inputs.push({ key: segment, text: renderVariable(variable), spec: specFor(segment) });
	}

	return inputs;
}

type PreparedPill = {
	text: string;
	bg: string;
	fg: string;
	bold: boolean;
};

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
		if (!text || visibleWidth(text) === 0) continue;

		if (input.keepStyling) {
			pills.push({ text, bg: neutral, fg: "", bold: false });
			continue;
		}

		const resolved = resolveColorSpec(theme, source, input.spec);
		const bg = resolved.bg ?? resolveBackgroundSgr(theme, source, input.spec) ?? neutral;
		// An explicit fg: in the spec wins; otherwise pick for legibility.
		pills.push({
			text,
			bg,
			fg: resolved.bg && resolved.fg ? resolved.fg : contrastTextSgr(bg),
			bold: config.bold || resolved.bold,
		});
	}

	return pills;
}

/**
 * Render the pill bar. Returns "" when nothing has content, so the caller can
 * fall back rather than emit a lone pair of caps.
 */
export function renderPillBar(
	inputs: PillInput[],
	theme: ThemeLike,
	source: ColorSource,
	config: PillConfig,
	width: number,
	options: { ascii?: boolean } = {},
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

	let out = "";

	const firstBg = pills[0]?.bg;
	if (leftCap && firstBg) {
		const capFg = toForegroundSgr(firstBg);
		if (capFg) out += `${DEFAULT_BG}${capFg}${leftCap}${RESET}`;
	}

	pills.forEach((pill, index) => {
		out += `${pill.bg}${pill.fg}${pill.bold ? BOLD : ""} ${pill.text} ${RESET}`;

		const next = pills[index + 1];
		if (next) {
			if (!separator) return;

			// A solid arrow works by being the left colour on the right colour, so
			// it vanishes when the two pills share a background — several segments
			// default to the same theme colour, which merged them into one blob.
			// Fall back to the thin divider in the text colour, which stays visible.
			if (pill.bg === next.bg) {
				out += `${pill.bg}${pill.fg || contrastTextSgr(pill.bg)}${THIN_SEPARATOR}${RESET}`;
				return;
			}

			const arrowFg = toForegroundSgr(pill.bg);
			// Without a usable foreground the arrow would be invisible; letting the
			// backgrounds abut is better than drawing a glyph in the wrong colour.
			out += arrowFg ? `${next.bg}${arrowFg}${separator}${RESET}` : "";
			return;
		}

		if (rightCap) {
			const capFg = toForegroundSgr(pill.bg);
			if (capFg) out += `${DEFAULT_BG}${capFg}${rightCap}${RESET}`;
		}
	});

	return width > 0 ? truncateToWidth(out, width, "") : out;
}
