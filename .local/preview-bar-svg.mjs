/**
 * Draw the pill bar as an SVG/PNG so a colour change can be judged before it
 * lands in the terminal.
 *
 *   node .local/preview-bar-svg.mjs [configPath] [out.svg]
 *   rsvg-convert -z 2 out.svg -o out.png
 *
 * Geometry mirrors the renderer: capsule caps at both ends, one arrow cell
 * between pills, all background colours taken from the same specs the footer
 * passes in. Glyph shapes are approximate (Nerd Font icons are drawn as simple
 * vector stand-ins) — this is a colour check, not a cover.
 */

import { registerHooks } from "node:module";
import { writeFileSync } from "node:fs";

registerHooks({
	resolve(specifier, context, next) {
		try {
			return next(specifier, context);
		} catch (error) {
			if (specifier.startsWith(".")) return next(`${specifier}.ts`, context);
			throw error;
		}
	},
});

const { renderPillBar, backgroundSgrToRgb } = await import("../extensions/starline/pill.ts");
const { loadConfig } = await import("../extensions/starline/config.ts");

const configPath = process.argv[2] ?? `${process.env.HOME}/.pi/agent/starline.json`;
const outPath = process.argv[3] ?? "/tmp/pill-preview.svg";
const config = loadConfig(configPath);
const theme = { fg: (_c, t) => t, bold: (t) => t, italic: (t) => t, underline: (t) => t };

const TEXTS = {
	model: "k3-256k",
	thinking: "high",
	queue: "1 queued",
	subagents: "2",
	cwd: "pi-starline",
	runtime: "v26.4.0",
	git: "main [!?]",
	context: "24%",
	cost: "$0.42",
};
const STATUS_TEXTS = {
	"provider-balance": "41.1%",
	"mcp-status": "3",
	"tavily-usage": "41.1%",
	procs: "2 running",
	"pi-ide": "\uf121",
};

const ICONS = {
	model: "\uf2db",
	thinking: "\U000f09d1",
	cwd: "\uf07b",
	context: "\U000f01bc",
	cost: "\uf155",
};

const specFor = (segment) => {
	if (segment.startsWith("extensionStatus:")) {
		const key = segment.slice("extensionStatus:".length);
		return config.extensionStatuses.colors[key] ?? config.colors.extensionStatus;
	}
	if (segment === "context") return config.colors.contextNormal;
	if (segment === "git") return config.colors.gitBranch;
	if (segment === "runtime") return config.colors.runtimePrefix;
	return config.colors[segment] ?? config.colors.extensionStatus;
};

const textFor = (segment) => {
	if (segment.startsWith("extensionStatus:")) {
		const key = segment.slice("extensionStatus:".length);
		return STATUS_TEXTS[key] ?? ` ${key}`;
	}
	const base = TEXTS[segment] ?? segment;
	const icon = ICONS[segment];
	return icon ? `${icon} ${base}` : base;
};

const inputs = config.pill.segments.map((segment) => ({
	key: segment,
	text: textFor(segment),
	spec: specFor(segment),
}));

const spans = [];
// Width 0 = no truncation; spans come back in draw order.
const raw = renderPillBar(inputs, theme, "theme", config.pill, 0, { onSpan: (s) => spans.push(s) });
if (!spans.length) throw new Error(`no pills: ${JSON.stringify(raw)}`);

const CELL = 10;
const PAD = 12;
const HEIGHT = 34;
const hexOf = (sgr) => {
	const rgb = backgroundSgrToRgb(sgr);
	if (!rgb) return "#45475a";
	return `#${rgb.map((v) => v.toString(16).padStart(2, "0")).join("")}`;
};
const luminance = (sgr) => {
	const rgb = backgroundSgrToRgb(sgr) ?? [69, 71, 90];
	return 0.299 * rgb[0] + 0.587 * rgb[1] + 0.114 * rgb[2];
};

const totalCells = spans[spans.length - 1].endColumn;
const WIDTH = totalCells * CELL;
const parts = [
	`<svg xmlns="http://www.w3.org/2000/svg" width="${WIDTH}" height="${HEIGHT}" viewBox="0 0 ${WIDTH} ${HEIGHT}">`,
	`<rect width="${WIDTH}" height="${HEIGHT}" fill="#1e1e2e"/>`,
];

for (const span of spans) {
	const x0 = span.bodyStartColumn * CELL;
	const x1 = span.bodyEndColumn * CELL;
	const bg = hexOf(span.bg);
	const fg = luminance(span.bg) >= 128 ? "#11111b" : "#f5f5f5";
	const text = textFor(span.key).trim();
	parts.push(`<rect x="${x0}" y="0" width="${Math.max(1, x1 - x0)}" height="${HEIGHT}" fill="${bg}"/>`);
	parts.push(
		`<text x="${(x0 + x1) / 2}" y="${HEIGHT / 2 + 5}" text-anchor="middle" font-family="Maple Mono NF" font-size="14" font-weight="600" fill="${fg}">${text.replace(/&/g, "&amp;").replace(/</g, "&lt;")}</text>`,
	);
}
parts.push("</svg>");
writeFileSync(outPath, parts.join("\n"));
console.log(`${outPath}  cells=${totalCells}  pills=${spans.length}`);
