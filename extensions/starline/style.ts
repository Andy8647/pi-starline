import type { ThemeColor } from "@earendil-works/pi-coding-agent";
import type { ColorSource, ColorSpec } from "./config";

type ThemeLike = {
	fg(color: string, text: string): string;
	bold?: (text: string) => string;
	italic?: (text: string) => string;
	underline?: (text: string) => string;
	/**
	 * Pi's `Theme.getFgAnsi` — returns the resolved SGR sequence for a theme color
	 * without wrapping any text. Optional because test fixtures and older Pi
	 * versions may not provide it; `themeColorToFgSgr` falls back to probing
	 * `fg()` with an empty string.
	 */
	getFgAnsi?(color: string): string;
};

export type { ThemeLike };

export const EDITOR_ACCENT_STYLE = "blue";
export const EDITOR_BORDER_STYLE = "bright-black";

export type SourceStyleFallback = {
	theme: ColorSpec;
	terminal: ColorSpec;
};

export const EDITOR_ACCENT_FALLBACK: SourceStyleFallback = {
	theme: "accent",
	terminal: EDITOR_ACCENT_STYLE,
};

export const EDITOR_BORDER_FALLBACK: SourceStyleFallback = {
	theme: "borderMuted",
	terminal: EDITOR_BORDER_STYLE,
};

function isHexColor(value: string): boolean {
	return /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.test(value);
}

function expandHexColor(hex: string): string {
	const body = hex.slice(1);
	if (body.length === 3) {
		return body
			.split("")
			.map((ch) => ch + ch)
			.join("");
	}
	return body;
}

function hexToAnsi(hex: string, isBackground = false): string {
	const normalized = expandHexColor(hex);
	const r = Number.parseInt(normalized.slice(0, 2), 16);
	const g = Number.parseInt(normalized.slice(2, 4), 16);
	const b = Number.parseInt(normalized.slice(4, 6), 16);
	return `\x1b[${isBackground ? 48 : 38};2;${r};${g};${b}m`;
}

const terminalColorCodes = new Map([
	["black", 30],
	["red", 31],
	["green", 32],
	["yellow", 33],
	["blue", 34],
	["purple", 35],
	["cyan", 36],
	["white", 37],
	["bright-black", 90],
	["bright-red", 91],
	["bright-green", 92],
	["bright-yellow", 93],
	["bright-blue", 94],
	["bright-purple", 95],
	["bright-cyan", 96],
	["bright-white", 97],
]);

const terminalStyleModifiers = new Map([
	["bold", 1],
	["dim", 2],
	["dimmed", 2],
	["italic", 3],
	["underline", 4],
]);

const themeColorNameMap = new Map([
	["red", "error"],
	["bright-red", "error"],
	["green", "success"],
	["bright-green", "success"],
	["yellow", "warning"],
	["bright-yellow", "warning"],
	["blue", "syntaxFunction"],
	["bright-blue", "syntaxFunction"],
	["cyan", "syntaxFunction"],
	["bright-cyan", "syntaxFunction"],
	["purple", "syntaxKeyword"],
	["bright-purple", "syntaxKeyword"],
	["black", "muted"],
	["bright-black", "muted"],
	["white", "text"],
	["bright-white", "text"],
]);

const themeStyleModifiers = new Set(["bold", "italic", "underline"]);

const themeColorTokens = new Set<ThemeColor>([
	"accent",
	"border",
	"borderAccent",
	"borderMuted",
	"success",
	"error",
	"warning",
	"muted",
	"dim",
	"text",
	"thinkingText",
	"userMessageText",
	"customMessageText",
	"customMessageLabel",
	"toolTitle",
	"toolOutput",
	"mdHeading",
	"mdLink",
	"mdLinkUrl",
	"mdCode",
	"mdCodeBlock",
	"mdCodeBlockBorder",
	"mdQuote",
	"mdQuoteBorder",
	"mdHr",
	"mdListBullet",
	"toolDiffAdded",
	"toolDiffRemoved",
	"toolDiffContext",
	"syntaxComment",
	"syntaxKeyword",
	"syntaxFunction",
	"syntaxVariable",
	"syntaxString",
	"syntaxNumber",
	"syntaxType",
	"syntaxOperator",
	"syntaxPunctuation",
	"thinkingOff",
	"thinkingMinimal",
	"thinkingLow",
	"thinkingMedium",
	"thinkingHigh",
	"thinkingXhigh",
	"bashMode",
]);

function terminalColorToAnsi(color: string, isBackground = false): string | undefined {
	const normalized = color.toLowerCase();
	const colorCode = terminalColorCodes.get(normalized);
	if (colorCode !== undefined) return `${isBackground ? colorCode + 10 : colorCode}`;

	if (/^(?:[0-9]|[1-9][0-9]|1[0-9]{2}|2[0-4][0-9]|25[0-5])$/.test(normalized)) {
		return `${isBackground ? 48 : 38};5;${normalized}`;
	}

	if (isHexColor(normalized)) return hexToAnsi(normalized, isBackground).slice(2, -1);
	return undefined;
}

function isExplicitTerminalColorToken(token: string): boolean {
	const normalized = token.toLowerCase();
	if (normalized.startsWith("fg:") || normalized.startsWith("bg:")) return true;
	if (isHexColor(normalized)) return true;
	return /^(?:[0-9]|[1-9][0-9]|1[0-9]{2}|2[0-4][0-9]|25[0-5])$/.test(normalized);
}

function isSupportedStyleToken(token: string): boolean {
	const normalized = token.toLowerCase();
	if (terminalStyleModifiers.has(normalized)) return true;
	if (terminalColorToAnsi(normalized) !== undefined) return true;

	const isForeground = normalized.startsWith("fg:");
	const isBackground = normalized.startsWith("bg:");
	if (isForeground || isBackground) {
		return terminalColorToAnsi(normalized.slice(3), isBackground) !== undefined;
	}

	return themeColorTokens.has(token as ThemeColor);
}

export function isSupportedColorSpec(style: ColorSpec): boolean {
	const trimmed = style.trim();
	if (trimmed === "") return true;
	return trimmed.split(/\s+/).every(isSupportedStyleToken);
}

function applyThemeModifiers(theme: ThemeLike, styleTokens: string[], text: string): string {
	let rendered = text;
	for (const token of styleTokens) {
		const normalized = token.toLowerCase();
		if (normalized === "bold") rendered = theme.bold?.(rendered) ?? rendered;
		if (normalized === "italic") rendered = theme.italic?.(rendered) ?? rendered;
		if (normalized === "underline") rendered = theme.underline?.(rendered) ?? rendered;
	}
	return rendered;
}

export function safeThemeFg(theme: ThemeLike, color: string, text: string): string {
	try {
		return theme.fg(color, text);
	} catch {
		return text;
	}
}

function mapThemeColor(styleTokens: string[]): string | undefined {
	let fallback: string | undefined;
	for (const token of styleTokens) {
		const normalized = token.toLowerCase();
		if (themeStyleModifiers.has(normalized)) continue;
		if (normalized === "dim" || normalized === "dimmed") {
			fallback = "muted";
			continue;
		}

		const mapped = themeColorNameMap.get(normalized);
		if (mapped) return mapped;
		return token;
	}
	return fallback;
}

/**
 * Colorize text using a theme color token or hex color.
 * Non-hex values are passed directly to `theme.fg()`; invalid tokens fall back
 * to unstyled text so a config typo does not break rendering.
 */
export function colorize(theme: ThemeLike, color: ColorSpec, text: string): string {
	if (isHexColor(color)) {
		return `${hexToAnsi(color)}${text}\x1b[39m`;
	}
	return safeThemeFg(theme, color, text);
}

/**
 * Render text with Starship-style terminal styling strings (e.g. "bold red", "fg:202",
 * "bg:blue", "underline bg:#bf5700").
 */
export function renderTerminalStyle(style: string, text: string): string {
	const codes: string[] = [];
	for (const token of style.trim().split(/\s+/)) {
		if (!token) continue;

		const normalized = token.toLowerCase();
		const modifier = terminalStyleModifiers.get(normalized);
		if (modifier !== undefined) {
			codes.push(`${modifier}`);
			continue;
		}

		const isForeground = normalized.startsWith("fg:");
		const isBackground = normalized.startsWith("bg:");
		const colorName = isForeground || isBackground ? normalized.slice(3) : normalized;
		const color = terminalColorToAnsi(colorName, isBackground);
		if (color) codes.push(color);
	}

	return codes.length ? `\x1b[${codes.join(";")}m${text}\x1b[0m` : text;
}

/**
 * Apply Starship-style terminal styling first, falling back to Pi theme tokens for
 * legacy config values such as "accent" or "syntaxKeyword".
 */
export function renderStyle(theme: ThemeLike, style: ColorSpec, text: string): string {
	if (style.trim() === "") return text;
	const styled = renderTerminalStyle(style, text);
	return styled === text ? colorize(theme, style, text) : styled;
}

export function renderThemeStyle(theme: ThemeLike, style: ColorSpec, text: string): string {
	const trimmed = style.trim();
	if (trimmed === "") return text;

	const tokens = trimmed.split(/\s+/).filter(Boolean);
	if (tokens.some(isExplicitTerminalColorToken)) return renderTerminalStyle(style, text);

	const color = mapThemeColor(tokens) ?? "text";
	return safeThemeFg(theme, color, applyThemeModifiers(theme, tokens, text));
}

export function renderStyleForSource(
	theme: ThemeLike,
	source: ColorSource,
	style: ColorSpec,
	text: string,
): string {
	return source === "terminal"
		? renderStyle(theme, style, text)
		: renderThemeStyle(theme, style, text);
}

export function renderStyleForSourceOrFallback(
	theme: ThemeLike,
	source: ColorSource,
	style: ColorSpec | undefined,
	fallback: ColorSpec | SourceStyleFallback,
	text: string,
): string {
	const fallbackStyle = typeof fallback === "string" ? fallback : fallback[source];
	return renderStyleForSource(theme, source, style ?? fallbackStyle, text);
}

export function renderEditorAccent(text: string): string {
	return renderTerminalStyle(EDITOR_ACCENT_STYLE, text);
}

export function renderEditorBorder(text: string): string {
	return renderTerminalStyle(EDITOR_BORDER_STYLE, text);
}

export function renderAccentLine(theme: ThemeLike, source: ColorSource, text: string): string {
	return renderStyleForSourceOrFallback(theme, source, undefined, EDITOR_ACCENT_FALLBACK, text);
}

export function renderChromeBorder(
	theme: ThemeLike,
	source: ColorSource,
	terminalFallbackStyle: ColorSpec,
	text: string,
): string {
	return renderStyleForSourceOrFallback(
		theme,
		source,
		undefined,
		{ theme: "borderMuted", terminal: terminalFallbackStyle },
		text,
	);
}

/* -------------------------------------------------------------------------
 * Structured ColorSpec resolution
 *
 * The `render*` functions above return ready-wrapped strings, which is all the
 * text footer needs. The pill footer needs the foreground and background as
 * separate SGR sequences, because the arrow joining two pills draws the left
 * pill's background as its foreground and the right pill's background as its
 * background.
 *
 * These resolvers are additive: they mirror the token semantics of
 * `renderStyle` / `renderThemeStyle` but never feed back into them, so text
 * mode output stays byte-identical to upstream. In particular they cannot
 * replace the theme path, which styles via chalk (`\x1b[1m..\x1b[22m`) and
 * closes with `\x1b[39m` rather than `\x1b[0m`.
 * ---------------------------------------------------------------------- */

const FG_RESET = "\x1b[39m";

export type ResolvedStyle = {
	/** Full SGR sequence for the foreground, e.g. `\x1b[38;2;203;166;247m`. */
	fg?: string;
	/** Full SGR sequence for the background, only set by an explicit `bg:` token. */
	bg?: string;
	bold: boolean;
	italic: boolean;
	underline: boolean;
	dim: boolean;
};

function emptyResolvedStyle(): ResolvedStyle {
	return { bold: false, italic: false, underline: false, dim: false };
}

function hasAnyStyle(resolved: ResolvedStyle): boolean {
	return Boolean(
		resolved.fg ||
			resolved.bg ||
			resolved.bold ||
			resolved.italic ||
			resolved.underline ||
			resolved.dim,
	);
}

/**
 * Resolve a Pi theme color key to its foreground SGR sequence.
 *
 * Prefers Pi's public `Theme.getFgAnsi`, which has already picked the right
 * encoding for the terminal (truecolor `38;2;r;g;b` vs 256-colour `38;5;n`).
 * Falls back to probing `fg(color, "")`, whose result is the same sequence
 * followed by `\x1b[39m`. Returns undefined for themes that do neither —
 * notably test fixtures — so callers can degrade instead of emitting garbage.
 */
export function themeColorToFgSgr(theme: ThemeLike, color: string): string | undefined {
	if (typeof theme.getFgAnsi === "function") {
		try {
			const ansi = theme.getFgAnsi(color);
			if (typeof ansi === "string" && ansi.startsWith("\x1b[")) return ansi;
		} catch {
			// Unknown key for this theme — fall through to the probe.
		}
	}
	try {
		const probe = theme.fg(color, "");
		if (typeof probe !== "string" || !probe.endsWith(FG_RESET)) return undefined;
		const ansi = probe.slice(0, -FG_RESET.length);
		return ansi.startsWith("\x1b[") ? ansi : undefined;
	} catch {
		return undefined;
	}
}

function shiftSgr(sgr: string, from: string, to: string, namedDelta: number): string | undefined {
	const match = /^\x1b\[([0-9;:]*)m$/.exec(sgr);
	if (!match) return undefined;
	const parts = (match[1] ?? "").split(";");
	const head = parts[0] ?? "";
	if (head === from) return `\x1b[${[to, ...parts.slice(1)].join(";")}m`;

	const code = Number(head);
	if (!Number.isInteger(code) || parts.length !== 1) return undefined;
	const shifted = code + namedDelta;
	const lowBase = namedDelta > 0 ? 30 : 40;
	const brightBase = namedDelta > 0 ? 90 : 100;
	const inLow = code >= lowBase && code <= lowBase + 9;
	const inBright = code >= brightBase && code <= brightBase + 9;
	return inLow || inBright ? `\x1b[${shifted}m` : undefined;
}

/**
 * Convert a foreground SGR sequence to the same colour as a background.
 * Handles `38;2;r;g;b`, `38;5;n`, the 30-37/90-97 named codes, and the `39`
 * default. This is how a theme colour becomes a pill background without ever
 * extracting RGB — whatever encoding Pi chose is preserved.
 */
export function toBackgroundSgr(fgSgr: string): string | undefined {
	if (fgSgr === FG_RESET) return "\x1b[49m";
	return shiftSgr(fgSgr, "38", "48", 10);
}

/** Inverse of {@link toBackgroundSgr}, used to draw a pill's arrow. */
export function toForegroundSgr(bgSgr: string): string | undefined {
	if (bgSgr === "\x1b[49m") return FG_RESET;
	return shiftSgr(bgSgr, "48", "38", -10);
}

function resolveTerminalTokens(tokens: string[]): ResolvedStyle {
	const resolved = emptyResolvedStyle();
	for (const token of tokens) {
		const normalized = token.toLowerCase();

		const modifier = terminalStyleModifiers.get(normalized);
		if (modifier !== undefined) {
			if (modifier === 1) resolved.bold = true;
			if (modifier === 2) resolved.dim = true;
			if (modifier === 3) resolved.italic = true;
			if (modifier === 4) resolved.underline = true;
			continue;
		}

		const isForeground = normalized.startsWith("fg:");
		const isBackground = normalized.startsWith("bg:");
		const colorName = isForeground || isBackground ? normalized.slice(3) : normalized;
		const fragment = terminalColorToAnsi(colorName, isBackground);
		if (!fragment) continue;
		if (isBackground) resolved.bg = `\x1b[${fragment}m`;
		else resolved.fg = `\x1b[${fragment}m`;
	}
	return resolved;
}

function resolveThemeTokens(theme: ThemeLike, tokens: string[]): ResolvedStyle {
	const resolved = emptyResolvedStyle();
	for (const token of tokens) {
		const normalized = token.toLowerCase();
		if (normalized === "bold") resolved.bold = true;
		if (normalized === "italic") resolved.italic = true;
		if (normalized === "underline") resolved.underline = true;
	}
	resolved.fg = themeColorToFgSgr(theme, mapThemeColor(tokens) ?? "text");
	return resolved;
}

/**
 * Resolve a ColorSpec into separate foreground/background SGR sequences plus
 * text attributes.
 *
 * Token precedence mirrors the `render*` functions exactly: an explicit
 * terminal colour token (`fg:`/`bg:`, hex, or a 256 index) anywhere in the spec
 * routes the whole spec down the terminal path regardless of `source`, which is
 * what lets a literal `#cba6f7` override the theme per key.
 */
export function resolveColorSpec(
	theme: ThemeLike,
	source: ColorSource,
	spec: ColorSpec,
): ResolvedStyle {
	const trimmed = spec.trim();
	if (trimmed === "") return emptyResolvedStyle();

	const tokens = trimmed.split(/\s+/).filter(Boolean);
	if (source !== "terminal" && !tokens.some(isExplicitTerminalColorToken)) {
		return resolveThemeTokens(theme, tokens);
	}

	const resolved = resolveTerminalTokens(tokens);
	if (hasAnyStyle(resolved)) return resolved;

	// Nothing matched the terminal vocabulary. `renderStyle` falls back to
	// `colorize` here, which treats the whole spec as a theme key.
	resolved.fg = themeColorToFgSgr(theme, trimmed);
	return resolved;
}

/**
 * The background a pill should paint for this spec: an explicit `bg:` when
 * given, otherwise the spec's foreground colour promoted to a background. Undefined
 * when the spec names no colour at all, leaving the caller to pick a neutral.
 */
export function resolveBackgroundSgr(
	theme: ThemeLike,
	source: ColorSource,
	spec: ColorSpec,
): string | undefined {
	const resolved = resolveColorSpec(theme, source, spec);
	if (resolved.bg) return resolved.bg;
	return resolved.fg ? toBackgroundSgr(resolved.fg) : undefined;
}
