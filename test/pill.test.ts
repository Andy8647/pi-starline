import { stripVTControlCharacters } from "node:util";
import { describe, expect, it } from "vitest";
import type { ExtensionStatusSegment } from "../extensions/starline/extension-status";
import {
	backgroundSgrToRgb,
	collectPillInputs,
	contrastTextSgr,
	type PillInput,
	renderPillBar,
} from "../extensions/starline/pill";
import {
	DEFAULT_PILL_CONFIG,
	isKnownPillSegment,
	normalizePillConfig,
	type PillConfig,
	parseFooterStyle,
} from "../extensions/starline/pill-config";
import type { ThemeLike } from "../extensions/starline/style";

const MAUVE_FG = "\x1b[38;2;203;166;247m";
const MAUVE_BG = "\x1b[48;2;203;166;247m";
const GREEN_BG = "\x1b[48;2;166;227;161m";
const SURFACE1_BG = "\x1b[48;2;69;71;90m";

const SOLID_ARROW = "";
const THIN_ARROW = "";

const theme: ThemeLike = {
	fg(color: string, text: string): string {
		const colors: Record<string, string> = {
			syntaxKeyword: MAUVE_FG,
			success: "\x1b[38;2;166;227;161m",
			borderMuted: "\x1b[38;2;69;71;90m",
			text: "\x1b[38;2;205;214;244m",
		};
		const ansi = colors[color];
		if (!ansi) throw new Error(`Unknown theme color: ${color}`);
		return `${ansi}${text}\x1b[39m`;
	},
	bold: (text: string) => `\x1b[1m${text}\x1b[22m`,
};

const config: PillConfig = { ...DEFAULT_PILL_CONFIG };

function bar(inputs: PillInput[], overrides: Partial<PillConfig> = {}, ascii = false): string {
	return renderPillBar(inputs, theme, "theme", { ...config, ...overrides }, 200, { ascii });
}

describe("parseFooterStyle", () => {
	it("defaults to text so upstream behaviour is the default", () => {
		for (const value of [undefined, null, "", "pillar", 1]) {
			expect(parseFooterStyle(value)).toBe("text");
		}
	});

	it("accepts pill", () => {
		expect(parseFooterStyle("pill")).toBe("pill");
	});
});

describe("normalizePillConfig", () => {
	it("falls back to defaults for a non-record", () => {
		expect(normalizePillConfig(undefined)).toEqual(DEFAULT_PILL_CONFIG);
		expect(normalizePillConfig("pill")).toEqual(DEFAULT_PILL_CONFIG);
	});

	it("keeps the given segment order", () => {
		expect(normalizePillConfig({ segments: ["cost", "cwd", "model"] }).segments).toEqual([
			"cost",
			"cwd",
			"model",
		]);
	});

	it("drops unknown segment names instead of rendering empty pills", () => {
		expect(normalizePillConfig({ segments: ["cwd", "nonsense", "cost"] }).segments).toEqual([
			"cwd",
			"cost",
		]);
	});

	it("drops duplicates and non-strings", () => {
		expect(normalizePillConfig({ segments: ["cwd", "cwd", 5, "cost"] }).segments).toEqual([
			"cwd",
			"cost",
		]);
	});

	it("accepts an addressed extension status", () => {
		expect(normalizePillConfig({ segments: ["extensionStatus:balance"] }).segments).toEqual([
			"extensionStatus:balance",
		]);
	});

	it("rejects a bare extensionStatus: with no key", () => {
		expect(normalizePillConfig({ segments: ["extensionStatus:"] }).segments).toEqual([]);
	});

	it("validates separator, caps and bold", () => {
		expect(normalizePillConfig({ separator: "powerline-thin" }).separator).toBe("powerline-thin");
		expect(normalizePillConfig({ separator: "swirl" }).separator).toBe("powerline");
		expect(normalizePillConfig({ caps: "right" }).caps).toBe("right");
		expect(normalizePillConfig({ caps: "sharp" }).caps).toBe("round");
		expect(normalizePillConfig({ bold: false }).bold).toBe(false);
		expect(normalizePillConfig({ bold: "yes" }).bold).toBe(true);
	});
});

describe("isKnownPillSegment", () => {
	it("accepts footer segment names, the status group, and addressed statuses", () => {
		expect(isKnownPillSegment("gitBranch")).toBe(true);
		expect(isKnownPillSegment("extensionStatus")).toBe(true);
		expect(isKnownPillSegment("extensionStatus:balance")).toBe(true);
		expect(isKnownPillSegment("git_branch")).toBe(false);
		expect(isKnownPillSegment("nope")).toBe(false);
	});
});

describe("collectPillInputs", () => {
	const statuses: ExtensionStatusSegment[] = [
		{ key: "automode", text: "AM", placement: "right", colorMode: "themed" },
		{ key: "balance", text: "5h 15%", placement: "right", colorMode: "themed" },
		{ key: "mcp", text: "mcp 3", placement: "right", colorMode: "original" },
	];
	const renderVariable = (name: string) => `<${name}>`;
	const specFor = (segment: string) => `spec:${segment}`;

	// Text comes from the footer variable, but the colour is looked up by segment
	// name — that is the key footer.ts's pillSpecFor switch dispatches on.
	it("maps segment names onto footer variables and looks colours up by segment", () => {
		const inputs = collectPillInputs(["cwd", "gitBranch"], [], renderVariable, specFor, () => "st");
		expect(inputs).toEqual([
			{ key: "cwd", text: "<cwd>", spec: "spec:cwd" },
			{ key: "gitBranch", text: "<git_branch>", spec: "spec:gitBranch" },
		]);
	});

	it("expands extensionStatus into every registered status", () => {
		const inputs = collectPillInputs(
			["extensionStatus"],
			statuses,
			renderVariable,
			specFor,
			() => "st",
		);
		expect(inputs.map((input) => input.key)).toEqual(["automode", "balance", "mcp"]);
	});

	it("places an addressed status where it is listed", () => {
		const inputs = collectPillInputs(
			["extensionStatus:balance", "cwd"],
			statuses,
			renderVariable,
			specFor,
			() => "st",
		);
		expect(inputs.map((input) => input.key)).toEqual(["balance", "cwd"]);
	});

	it("does not repeat a status that was already placed explicitly", () => {
		const inputs = collectPillInputs(
			["extensionStatus:balance", "cwd", "extensionStatus"],
			statuses,
			renderVariable,
			specFor,
			() => "st",
		);
		expect(inputs.map((input) => input.key)).toEqual(["balance", "cwd", "automode", "mcp"]);
	});

	it("skips an addressed status that no extension registered", () => {
		const inputs = collectPillInputs(
			["extensionStatus:tavily"],
			statuses,
			renderVariable,
			specFor,
			() => "st",
		);
		expect(inputs).toEqual([]);
	});

	it("marks colorMode original statuses to keep their own styling", () => {
		const inputs = collectPillInputs(
			["extensionStatus"],
			statuses,
			renderVariable,
			specFor,
			() => "st",
		);
		const mcp = inputs.find((input) => input.key === "mcp");
		expect(mcp).toEqual({ key: "mcp", text: "mcp 3", spec: "", keepStyling: true });
		expect(inputs.find((input) => input.key === "balance")?.spec).toBe("st");
	});
});

describe("backgroundSgrToRgb", () => {
	it("reads truecolor backgrounds", () => {
		expect(backgroundSgrToRgb(MAUVE_BG)).toEqual([203, 166, 247]);
	});

	it("reads the 256 colour cube, greyscale ramp and base entries", () => {
		expect(backgroundSgrToRgb("\x1b[48;5;0m")).toEqual([0, 0, 0]);
		expect(backgroundSgrToRgb("\x1b[48;5;196m")).toEqual([255, 0, 0]);
		expect(backgroundSgrToRgb("\x1b[48;5;231m")).toEqual([255, 255, 255]);
		expect(backgroundSgrToRgb("\x1b[48;5;232m")).toEqual([8, 8, 8]);
		expect(backgroundSgrToRgb("\x1b[48;5;255m")).toEqual([238, 238, 238]);
	});

	it("reads the named background codes", () => {
		expect(backgroundSgrToRgb("\x1b[41m")).toEqual([128, 0, 0]);
		expect(backgroundSgrToRgb("\x1b[101m")).toEqual([255, 0, 0]);
	});

	it("gives up on the terminal default background", () => {
		expect(backgroundSgrToRgb("\x1b[49m")).toBeUndefined();
	});
});

describe("contrastTextSgr", () => {
	it("uses dark text on light backgrounds and light text on dark ones", () => {
		expect(contrastTextSgr(MAUVE_BG)).toBe("\x1b[30m");
		expect(contrastTextSgr(GREEN_BG)).toBe("\x1b[30m");
		expect(contrastTextSgr("\x1b[48;2;30;30;46m")).toBe("\x1b[97m");
	});

	it("emits basic colour codes, which every terminal renders", () => {
		expect(["\x1b[30m", "\x1b[97m"]).toContain(contrastTextSgr("\x1b[48;5;99m"));
	});
});

describe("renderPillBar", () => {
	const cwd: PillInput = { key: "cwd", text: "pi-starline", spec: "syntaxKeyword" };
	const cost: PillInput = { key: "cost", text: "$0.42", spec: "success" };

	it("returns empty when nothing has content", () => {
		expect(bar([])).toBe("");
		expect(bar([{ key: "cwd", text: "   ", spec: "syntaxKeyword" }])).toBe("");
	});

	it("renders the text with its resolved background", () => {
		const out = bar([cwd]);
		expect(out).toContain(MAUVE_BG);
		expect(stripVTControlCharacters(out)).toContain("pi-starline");
	});

	it("joins two pills with an arrow carrying both colours", () => {
		const out = bar([cwd, cost]);
		// Arrow foreground is the left pill's background, its background the right's.
		expect(out).toContain(`${GREEN_BG}${MAUVE_FG}`);
	});

	it("caps both ends by default", () => {
		const plain = stripVTControlCharacters(bar([cwd]));
		expect(plain.startsWith("")).toBe(true);
		expect(plain.endsWith("")).toBe(true);
	});

	it("caps only the right end when asked", () => {
		const plain = stripVTControlCharacters(bar([cwd], { caps: "right" }));
		expect(plain.startsWith("")).toBe(false);
		expect(plain.endsWith("")).toBe(true);
	});

	it("omits caps entirely when asked", () => {
		const plain = stripVTControlCharacters(bar([cwd], { caps: "none" }));
		expect(plain).toBe(" pi-starline ");
	});

	it("uses the thin separator when configured", () => {
		expect(stripVTControlCharacters(bar([cwd, cost], { separator: "powerline-thin" }))).toContain(
			"",
		);
	});

	it("lets backgrounds abut when the separator is off", () => {
		const plain = stripVTControlCharacters(bar([cwd, cost], { separator: "none" }));
		expect(plain).not.toContain("");
		expect(plain).toContain("pi-starline");
		expect(plain).toContain("$0.42");
	});

	it("drops every Nerd Font glyph in ascii mode", () => {
		const plain = stripVTControlCharacters(bar([cwd, cost], {}, true));
		for (const glyph of ["", "", "", ""]) {
			expect(plain).not.toContain(glyph);
		}
		expect(plain).toContain("pi-starline");
	});

	it("falls back to a neutral background when the spec names no colour", () => {
		expect(bar([{ key: "runtime", text: "node", spec: "" }])).toContain(SURFACE1_BG);
	});

	it("strips styling the segment text arrived with", () => {
		const out = bar([{ key: "cwd", text: `${MAUVE_FG}pi-starline\x1b[39m`, spec: "success" }]);
		expect(out).not.toContain(MAUVE_FG);
		expect(out).toContain(GREEN_BG);
	});

	it("keeps an extension's own colours on the neutral background", () => {
		const out = bar([
			{ key: "mcp", text: `${MAUVE_FG}mcp 3\x1b[39m`, spec: "", keepStyling: true },
		]);
		expect(out).toContain(MAUVE_FG);
		expect(out).toContain(SURFACE1_BG);
	});

	it("honours an explicit fg: alongside bg:", () => {
		const out = bar([{ key: "cwd", text: "x", spec: "bg:#cba6f7 fg:#1e1e2e" }]);
		expect(out).toContain("\x1b[48;2;203;166;247m");
		expect(out).toContain("\x1b[38;2;30;30;46m");
	});

	it("bolds by default and stops when told to", () => {
		expect(bar([cwd])).toContain("\x1b[1m");
		expect(bar([cwd], { bold: false })).not.toContain("\x1b[1m");
	});

	// Several segments default to the same theme colour (extensionStatus, tokens
	// and contextNormal are all "bright-black"). A solid arrow is the left colour
	// on the right colour, so it was invisible there and the pills merged.
	it("keeps a visible divider between pills that share a background", () => {
		const same: PillInput[] = [
			{ key: "a", text: "aaa", spec: "success" },
			{ key: "b", text: "bbb", spec: "success" },
		];
		const plain = stripVTControlCharacters(bar(same));
		expect(plain).toContain(THIN_ARROW);
		expect(plain).not.toContain(SOLID_ARROW);
	});

	it("still uses the solid arrow between different backgrounds", () => {
		const plain = stripVTControlCharacters(bar([cwd, cost]));
		expect(plain).toContain(SOLID_ARROW);
		expect(plain).not.toContain(THIN_ARROW);
	});

	it("draws that divider in the text colour so it stays legible", () => {
		const same: PillInput[] = [
			{ key: "a", text: "aaa", spec: "syntaxKeyword" },
			{ key: "b", text: "bbb", spec: "syntaxKeyword" },
		];
		expect(bar(same)).toContain(`${MAUVE_BG}\x1b[30m`);
	});

	it("truncates to the given width", () => {
		const out = renderPillBar([cwd, cost], theme, "theme", config, 8);
		expect(stripVTControlCharacters(out).length).toBeLessThanOrEqual(8);
	});

	// A cut mid-pill must not leave the background set, or it bleeds to the end
	// of the line. truncateToWidth closes the sequence for us; pin that.
	it("closes styling when the cut lands mid-pill", () => {
		const out = renderPillBar([cwd, cost], theme, "theme", config, 8);
		expect(out.endsWith("\x1b[0m")).toBe(true);
	});
});

describe("per-status icons in the bar", () => {
	const statuses: ExtensionStatusSegment[] = [
		{ key: "balance", text: "¥327", placement: "right", colorMode: "themed" },
		{ key: "mcp", text: "3", placement: "right", colorMode: "original" },
	];

	it("prefixes the status text", () => {
		const inputs = collectPillInputs(
			["extensionStatus"],
			statuses,
			() => "",
			() => "",
			() => "st",
			(key) => (key === "balance" ? "◈" : ""),
		);
		expect(inputs.find((input) => input.key === "balance")?.text).toBe("◈ ¥327");
	});

	// colorMode "original" text arrives pre-styled; splicing an icon into it would
	// land inside or outside its escapes unpredictably.
	it("leaves colorMode original text untouched", () => {
		const inputs = collectPillInputs(
			["extensionStatus"],
			statuses,
			() => "",
			() => "",
			() => "st",
			() => "◈",
		);
		expect(inputs.find((input) => input.key === "mcp")?.text).toBe("3");
	});

	it("adds nothing when no icon is configured", () => {
		const inputs = collectPillInputs(
			["extensionStatus"],
			statuses,
			() => "",
			() => "",
			() => "st",
		);
		expect(inputs.find((input) => input.key === "balance")?.text).toBe("¥327");
	});
});
