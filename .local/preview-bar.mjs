/**
 * Offline preview of the real pill bar for a given starline.json.
 *
 *   node .local/preview-bar.mjs [configPath]
 *
 * Feeds the same colour specs the footer would build, renders with
 * `renderPillBar`, then prints one line per pill with the background hex the
 * terminal would paint — the fastest way to see whether a segment fell back to
 * the neutral grey.
 */

import { registerHooks } from "node:module";

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
const { resolveColorSpec, resolveBackgroundSgr } = await import("../extensions/starline/style.ts");

const configPath = process.argv[2] ?? `${process.env.HOME}/.pi/agent/starline.json`;
const config = loadConfig(configPath);

// Identity theme: specs here are all explicit `bg:#rrggbb` after palette expansion.
const theme = { fg: (_c, t) => t, bold: (t) => t, italic: (t) => t, underline: (t) => t };

const TEXTS = {
	model: " k3-256k ",
	thinking: " high ",
	queue: " 1 queued ",
	subagents: " 2 ",
	cwd: " pi-starline ",
	runtime: " v26.4.0 ",
	git: " main [!?] ",
	context: " 24% ",
	cost: " $0.42 ",
};
const STATUS_TEXTS = {
	"provider-balance": " 41.1% ",
	"mcp-status": " 3 ",
	"tavily-usage": " 41.1% ",
	procs: " 2 running ",
	"pi-ide": "\uf121",
};

const specFor = (segment) => {
	if (segment.startsWith("extensionStatus:")) {
		const key = segment.slice("extensionStatus:".length);
		return config.extensionStatuses.colors[key] ?? config.colors.extensionStatus;
	}
	if (segment === "context") return config.colors.contextNormal;
	return config.colors[segment] ?? config.colors.extensionStatus;
};

const textFor = (segment) => {
	if (segment.startsWith("extensionStatus:")) {
		const key = segment.slice("extensionStatus:".length);
		return STATUS_TEXTS[key] ?? ` ${key} `;
	}
	return TEXTS[segment] ?? ` ${segment} `;
};

const hex = (sgr) => {
	const rgb = backgroundSgrToRgb(sgr);
	if (!rgb) return sgr.replace(/\x1b/g, "^");
	return `#${rgb.map((v) => v.toString(16).padStart(2, "0")).join("")}`;
};

const inputs = config.pill.segments.map((segment) => ({
	key: segment,
	text: textFor(segment),
	spec: specFor(segment),
}));

const spans = [];
renderPillBar(inputs, theme, "theme", config.pill, 0, { onSpan: (span) => spans.push(span) });
console.log(`segments: ${config.pill.segments.join(" -> ")}\n`);
for (const [index, span] of spans.entries()) {
	console.log(`${String(index + 1).padStart(2)}  ${hex(span.bg).padEnd(9)}  ${span.key}`);
}

console.log("\nneutral fallback (colors.extensionStatus):", config.colors.extensionStatus);
console.log("editor status colour source resolves to:", resolveColorSpec(theme, "theme", config.colors.extensionStatus));
