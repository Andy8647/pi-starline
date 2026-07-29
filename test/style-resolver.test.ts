import { describe, expect, it } from "vitest";
import {
	renderStyle,
	renderStyleForSource,
	renderThemeStyle,
	resolveBackgroundSgr,
	resolveColorSpec,
	type ThemeLike,
	themeColorToFgSgr,
	toBackgroundSgr,
	toForegroundSgr,
} from "../extensions/starline/style";

/**
 * Mimics Pi's `Theme`: `fg()` wraps with the resolved sequence and closes with
 * `\x1b[39m`, and `getFgAnsi()` hands back that sequence directly.
 */
function makeTheme(
	colors: Record<string, string>,
	options: { withGetFgAnsi?: boolean } = {},
): ThemeLike {
	const { withGetFgAnsi = true } = options;
	const theme: ThemeLike = {
		fg(color: string, text: string): string {
			const ansi = colors[color];
			if (!ansi) throw new Error(`Unknown theme color: ${color}`);
			return `${ansi}${text}\x1b[39m`;
		},
		bold: (text: string) => `\x1b[1m${text}\x1b[22m`,
		italic: (text: string) => `\x1b[3m${text}\x1b[23m`,
		underline: (text: string) => `\x1b[4m${text}\x1b[24m`,
	};
	if (withGetFgAnsi) {
		theme.getFgAnsi = (color: string) => {
			const ansi = colors[color];
			if (!ansi) throw new Error(`Unknown theme color: ${color}`);
			return ansi;
		};
	}
	return theme;
}

// Values mirror catppuccin-mocha as resolved by Pi in truecolor mode.
const truecolorTheme = makeTheme({
	accent: "\x1b[38;2;137;220;235m", // sky
	syntaxKeyword: "\x1b[38;2;203;166;247m", // mauve
	syntaxFunction: "\x1b[38;2;137;180;250m", // blue
	success: "\x1b[38;2;166;227;161m", // green
	error: "\x1b[38;2;243;139;168m", // red
	warning: "\x1b[38;2;249;226;175m", // yellow
	muted: "\x1b[38;2;127;132;156m", // overlay1
	text: "\x1b[38;2;205;214;244m",
});

// The same theme as Pi would resolve it on a 256-colour terminal.
const paletteTheme = makeTheme({
	accent: "\x1b[38;5;117m",
	syntaxKeyword: "\x1b[38;5;183m",
	text: "\x1b[38;5;189m",
});

describe("themeColorToFgSgr", () => {
	it("prefers getFgAnsi", () => {
		expect(themeColorToFgSgr(truecolorTheme, "syntaxKeyword")).toBe("\x1b[38;2;203;166;247m");
	});

	it("falls back to probing fg() when getFgAnsi is absent", () => {
		const probeOnly = makeTheme({ accent: "\x1b[38;2;137;220;235m" }, { withGetFgAnsi: false });
		expect(themeColorToFgSgr(probeOnly, "accent")).toBe("\x1b[38;2;137;220;235m");
	});

	it("returns undefined for unknown keys rather than throwing", () => {
		expect(themeColorToFgSgr(truecolorTheme, "nope")).toBeUndefined();
	});

	it("returns undefined for themes that do not emit SGR at all", () => {
		const plain: ThemeLike = { fg: (_color, text) => text };
		expect(themeColorToFgSgr(plain, "accent")).toBeUndefined();
	});
});

describe("toBackgroundSgr / toForegroundSgr", () => {
	it("swaps truecolor foreground and background without touching the channels", () => {
		expect(toBackgroundSgr("\x1b[38;2;203;166;247m")).toBe("\x1b[48;2;203;166;247m");
		expect(toForegroundSgr("\x1b[48;2;203;166;247m")).toBe("\x1b[38;2;203;166;247m");
	});

	it("swaps 256-palette indexes", () => {
		expect(toBackgroundSgr("\x1b[38;5;183m")).toBe("\x1b[48;5;183m");
		expect(toForegroundSgr("\x1b[48;5;183m")).toBe("\x1b[38;5;183m");
	});

	it("shifts the named 30-37 and 90-97 codes by ten", () => {
		expect(toBackgroundSgr("\x1b[36m")).toBe("\x1b[46m");
		expect(toBackgroundSgr("\x1b[95m")).toBe("\x1b[105m");
		expect(toForegroundSgr("\x1b[46m")).toBe("\x1b[36m");
		expect(toForegroundSgr("\x1b[105m")).toBe("\x1b[95m");
	});

	it("maps the default-colour resets to each other", () => {
		expect(toBackgroundSgr("\x1b[39m")).toBe("\x1b[49m");
		expect(toForegroundSgr("\x1b[49m")).toBe("\x1b[39m");
	});

	it("round-trips", () => {
		for (const fg of ["\x1b[38;2;1;2;3m", "\x1b[38;5;42m", "\x1b[31m", "\x1b[97m", "\x1b[39m"]) {
			const bg = toBackgroundSgr(fg);
			expect(bg).toBeDefined();
			expect(toForegroundSgr(bg as string)).toBe(fg);
		}
	});

	it("rejects sequences that are not colours", () => {
		expect(toBackgroundSgr("\x1b[1m")).toBeUndefined();
		expect(toBackgroundSgr("not an sgr")).toBeUndefined();
		expect(toForegroundSgr("\x1b[4m")).toBeUndefined();
	});
});

describe("resolveColorSpec", () => {
	it("resolves an empty spec to no styling", () => {
		expect(resolveColorSpec(truecolorTheme, "theme", "")).toEqual({
			bold: false,
			italic: false,
			underline: false,
			dim: false,
		});
	});

	it("maps terminal colour names through the theme under the theme source", () => {
		const resolved = resolveColorSpec(truecolorTheme, "theme", "bold purple");
		expect(resolved.fg).toBe("\x1b[38;2;203;166;247m"); // purple -> syntaxKeyword -> mauve
		expect(resolved.bold).toBe(true);
		expect(resolved.bg).toBeUndefined();
	});

	it("uses raw terminal codes under the terminal source", () => {
		const resolved = resolveColorSpec(truecolorTheme, "terminal", "bold purple");
		expect(resolved.fg).toBe("\x1b[35m");
		expect(resolved.bold).toBe(true);
	});

	it("accepts theme keys by name", () => {
		expect(resolveColorSpec(truecolorTheme, "theme", "syntaxKeyword").fg).toBe(
			"\x1b[38;2;203;166;247m",
		);
	});

	it("lets a literal hex override the theme regardless of source", () => {
		for (const source of ["theme", "terminal"] as const) {
			const resolved = resolveColorSpec(truecolorTheme, source, "bold #cba6f7");
			expect(resolved.fg).toBe("\x1b[38;2;203;166;247m");
			expect(resolved.bold).toBe(true);
		}
	});

	it("expands three-digit hex", () => {
		expect(resolveColorSpec(truecolorTheme, "theme", "#abc").fg).toBe("\x1b[38;2;170;187;204m");
	});

	it("reads 256-palette indexes", () => {
		expect(resolveColorSpec(truecolorTheme, "theme", "208").fg).toBe("\x1b[38;5;208m");
	});

	it("separates fg: and bg: prefixes", () => {
		const resolved = resolveColorSpec(truecolorTheme, "theme", "bold bg:#cba6f7 fg:#1e1e2e");
		expect(resolved.bg).toBe("\x1b[48;2;203;166;247m");
		expect(resolved.fg).toBe("\x1b[38;2;30;30;46m");
		expect(resolved.bold).toBe(true);
	});

	it("supports bg: with named and indexed colours", () => {
		expect(resolveColorSpec(truecolorTheme, "theme", "bg:blue").bg).toBe("\x1b[44m");
		expect(resolveColorSpec(truecolorTheme, "theme", "bg:208").bg).toBe("\x1b[48;5;208m");
	});

	it("collects every text attribute on the terminal path", () => {
		const resolved = resolveColorSpec(truecolorTheme, "terminal", "bold dim italic underline");
		expect(resolved).toMatchObject({
			bold: true,
			dim: true,
			italic: true,
			underline: true,
		});
	});

	it("lets the last colour of each kind win, matching SGR application order", () => {
		const resolved = resolveColorSpec(truecolorTheme, "terminal", "red green bg:blue bg:yellow");
		expect(resolved.fg).toBe("\x1b[32m");
		expect(resolved.bg).toBe("\x1b[43m");
	});

	it("falls back to the theme when the terminal path matches nothing", () => {
		expect(resolveColorSpec(truecolorTheme, "terminal", "accent").fg).toBe(
			"\x1b[38;2;137;220;235m",
		);
	});

	it("degrades to no colour on an unresolvable spec instead of throwing", () => {
		expect(resolveColorSpec(truecolorTheme, "theme", "definitelyNotAColor").fg).toBeUndefined();
	});

	it("preserves whatever encoding the theme chose", () => {
		expect(resolveColorSpec(paletteTheme, "theme", "syntaxKeyword").fg).toBe("\x1b[38;5;183m");
		expect(resolveBackgroundSgr(paletteTheme, "theme", "syntaxKeyword")).toBe("\x1b[48;5;183m");
	});
});

describe("resolveBackgroundSgr", () => {
	it("promotes the foreground colour when no bg: is given", () => {
		expect(resolveBackgroundSgr(truecolorTheme, "theme", "bold purple")).toBe(
			"\x1b[48;2;203;166;247m",
		);
	});

	it("prefers an explicit bg:", () => {
		expect(resolveBackgroundSgr(truecolorTheme, "theme", "bg:#1e1e2e fg:#cdd6f4")).toBe(
			"\x1b[48;2;30;30;46m",
		);
	});

	it("is undefined for an empty spec, so callers can pick a neutral", () => {
		expect(resolveBackgroundSgr(truecolorTheme, "theme", "")).toBeUndefined();
		expect(resolveBackgroundSgr(truecolorTheme, "terminal", "")).toBeUndefined();
	});

	it("is undefined when only attributes are given on the terminal path", () => {
		expect(resolveBackgroundSgr(truecolorTheme, "terminal", "bold")).toBeUndefined();
	});

	// Mirrors renderThemeStyle: an attribute-only spec falls through
	// `mapThemeColor(...) ?? "text"`, so it renders in the theme's text colour.
	// The resolver reports that faithfully rather than inventing a neutral.
	it("promotes the theme text colour for an attribute-only spec on the theme path", () => {
		expect(resolveBackgroundSgr(truecolorTheme, "theme", "bold")).toBe("\x1b[48;2;205;214;244m");
	});
});

/**
 * The resolvers are additive — the text footer must keep rendering exactly as it
 * did before they existed. These lock the shapes the pill work must not disturb.
 */
describe("text-mode rendering is untouched", () => {
	it("keeps the theme path on chalk modifiers and the \\x1b[39m close", () => {
		expect(renderThemeStyle(truecolorTheme, "bold purple", "main")).toBe(
			"\x1b[38;2;203;166;247m\x1b[1mmain\x1b[22m\x1b[39m",
		);
	});

	it("keeps the terminal path on a single merged SGR closed with \\x1b[0m", () => {
		expect(renderStyle(truecolorTheme, "bold purple", "main")).toBe("\x1b[1;35mmain\x1b[0m");
	});

	it("keeps routing explicit terminal colours away from the theme", () => {
		expect(renderStyleForSource(truecolorTheme, "theme", "bold #cba6f7", "main")).toBe(
			"\x1b[1;38;2;203;166;247mmain\x1b[0m",
		);
	});

	it("keeps an empty spec as a passthrough", () => {
		expect(renderStyleForSource(truecolorTheme, "theme", "", "main")).toBe("main");
		expect(renderStyleForSource(truecolorTheme, "terminal", "", "main")).toBe("main");
	});
});
