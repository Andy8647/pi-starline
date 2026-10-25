/**
 * Builds `assets/cover.svg` (and, through `rsvg-convert`, `assets/cover.png`):
 * the README hero and the image `pi.image` shows in Pi's package list.
 *
 * The two things that carry the product are not drawn by hand. The pill bar and
 * the bubble above it are the real renderers' own ANSI — `renderPillBar` and
 * `renderPillBubble`, fed the same colour specs the config file uses — parsed
 * back into cells and drawn with the Catppuccin Mocha palette a terminal would
 * paint them with. So a change to a pill's colour, width or padding shows up in
 * the cover instead of drifting away from it.
 *
 * Reproduce:
 *   node tools/cover/generate.mjs
 *   rsvg-convert -z 2 assets/cover.svg -o assets/cover.png
 *
 * The script resolves the extension sources the way the bundler does (relative
 * imports without extensions), which is why it registers a resolver hook first.
 */

import { writeFileSync } from "node:fs";
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

const { renderPillBar } = await import("../../extensions/starline/pill.ts");
const { defaultConfig } = await import("../../extensions/starline/config.ts");
const { renderGitSegments } = await import("../../extensions/starline/git-segments.ts");
const { emptyGitStatus } = await import("../../extensions/starline/git.ts");
const { pillBubblePlacement, pillBubbleWidth, renderPillBubble } = await import(
	"../../extensions/starline/pill-bubble.ts"
);

// --------------------------------------------------------------------------
// Palette: Catppuccin Mocha, the theme the screenshots are taken in.
// --------------------------------------------------------------------------

const MOCHA = {
	base: "#11111b",
	mantle: "#181825",
	crust: "#0f0f16",
	surface0: "#313244",
	surface1: "#45475a",
	surface2: "#585b70",
	overlay0: "#6c7086",
	subtext0: "#a6adc8",
	subtext1: "#bac2de",
	text: "#cdd6f4",
	blue: "#89b4fa",
	lavender: "#b4befe",
	mauve: "#cba6f7",
	maroon: "#eba0ac",
	peach: "#fab387",
	green: "#a6e3a1",
	teal: "#94e2d5",
	yellow: "#f9e2af",
	red: "#f38ba8",
	pink: "#f5c2e7",
};

/** ANSI base colours, as this terminal theme paints them. */
const ANSI = [
	"#45475a",
	"#f38ba8",
	"#a6e3a1",
	"#f9e2af",
	"#89b4fa",
	"#f5c2e7",
	"#94e2d5",
	"#bac2de",
	"#585b70",
	"#f38ba8",
	"#a6e3a1",
	"#f9e2af",
	"#89b4fa",
	"#f5c2e7",
	"#94e2d5",
	"#a6adc8",
];

const DEFAULT_FG = MOCHA.text;

/** Identity renderer: the bar only asks its theme for text, never for colour. */
const THEME = {
	fg: (_color, text) => text,
	bold: (text) => text,
	italic: (text) => text,
	underline: (text) => text,
};

// --------------------------------------------------------------------------
// ANSI → cells
// --------------------------------------------------------------------------

const ANSI_RE = /\x1b\[([0-9;]*)m/g;

/** Parse one ANSI-coloured line into styled cells, one per screen column. */
function parseAnsiLine(line) {
	const cells = [];
	let fg;
	let bg;
	let bold = false;
	let lastIndex = 0;

	const push = (text) => {
		for (const ch of text) cells.push({ ch, fg, bg, bold });
	};

	for (let match = ANSI_RE.exec(line); match !== null; match = ANSI_RE.exec(line)) {
		push(line.slice(lastIndex, match.index));
		lastIndex = ANSI_RE.lastIndex;

		const codes = (match[1] ?? "").split(";").filter(Boolean).map(Number);
		for (let index = 0; index < codes.length; index += 1) {
			const code = codes[index];
			if (code === 0) {
				fg = undefined;
				bg = undefined;
				bold = false;
			} else if (code === 1) {
				bold = true;
			} else if (code === 22) {
				bold = false;
			} else if (code === 39) {
				fg = undefined;
			} else if (code === 49) {
				bg = undefined;
			} else if (code === 38 || code === 48) {
				const color =
					codes[index + 1] === 2
						? rgb(codes[index + 2], codes[index + 3], codes[index + 4])
						: (ANSI[codes[index + 2]] ?? MOCHA.text);
				index += codes[index + 1] === 2 ? 4 : 2;
				if (code === 38) fg = color;
				else bg = color;
			} else if (code >= 30 && code <= 37) {
				fg = ANSI[code - 30];
			} else if (code >= 90 && code <= 97) {
				fg = ANSI[code - 90 + 8];
			} else if (code >= 40 && code <= 47) {
				bg = ANSI[code - 40];
			} else if (code >= 100 && code <= 107) {
				bg = ANSI[code - 100 + 8];
			}
		}
	}
	push(line.slice(lastIndex));
	return cells;
}

function rgb(r, g, b) {
	return `#${[r, g, b].map((value) => (value ?? 0).toString(16).padStart(2, "0")).join("")}`;
}

/** A run of ANSI text as rows of cells. */
function parseAnsi(text) {
	return text.split("\n").map(parseAnsiLine);
}

// --------------------------------------------------------------------------
// The bar and the bubble, from the real renderers
// --------------------------------------------------------------------------

/** Colour specs, in the shape `starline.json` uses: the pill is a background. */
const SPECS = {
	model: "bg:#89b4fa",
	thinking: "bg:#b4befe",
	cwd: "bg:#cba6f7",
	runtime: "bg:#f5c2e7",
	git: "bg:#eba0ac",
	context: "bg:#585b70",
	cost: "bg:#a6e3a1",
};

const SEGMENTS = ["model", "thinking", "cwd", "runtime", "git", "context", "cost"];

/** The bar's text, built the way the footer builds it: an icon, then the value. */
function pillText(name) {
	const icon = defaultConfig.icons;
	switch (name) {
		case "model":
			return `${icon.model} k3-256k`;
		case "thinking":
			return `${icon.thinking} high`;
		case "cwd":
			return `${icon.cwd} pi-starline`;
		case "runtime":
			return "v26.4.0";
		case "git":
			return gitLabel();
		case "context":
			return `${icon.context} 24%`;
		case "cost":
			return `${icon.cost} $0.42`;
		default:
			return "";
	}
}

/** The git pill's own text, from the renderer, so the dirty markers are real. */
function gitLabel() {
	const status = {
		...emptyGitStatus(),
		branch: "main",
		dirty: true,
		ahead: 1,
		modified: 2,
		untracked: 1,
		staged: 1,
	};
	// The forge glyph in front of the branch is a Nerd Font icon; the cover draws
	// the pill text at half its terminal size, where it turns into a smudge.
	const label = renderGitSegments(status, defaultConfig, THEME, "terminal").label;
	return label.replace(defaultConfig.icons.git, "").trim();
}

function buildBar(width) {
	const spans = [];
	const inputs = SEGMENTS.map((name) => ({
		key: name,
		text: pillText(name),
		spec: SPECS[name],
	}));
	const ansi = renderPillBar(
		inputs,
		THEME,
		"terminal",
		{ ...defaultConfig.pill, separator: "powerline", caps: "round", bold: true },
		width,
		{ onSpan: (span) => spans.push(span) },
	);
	return { ansi, spans };
}

function buildBubble(anchor, terminalWidth) {
	const content = {
		title: "main · 3 changed",
		body: [
			"modified · src/footer.ts",
			"added · src/project-probe.ts",
			"untracked · docs/cover.md",
			"1 ahead · 1 staged",
		],
		hint: "read-only · esc to close",
	};
	const width = pillBubbleWidth(content, terminalWidth, anchor);
	const placement = pillBubblePlacement(anchor, width, terminalWidth);
	const lines = renderPillBubble({
		content,
		width,
		background: anchor.background,
		foreground: anchor.foreground,
		attached: true,
		tab: placement.tab,
	});
	return { lines, placement, width };
}

// --------------------------------------------------------------------------
// SVG
// --------------------------------------------------------------------------

const escapeXml = (text) =>
	text
		.replaceAll("&", "&amp;")
		.replaceAll("<", "&lt;")
		.replaceAll(">", "&gt;")
		.replaceAll('"', "&quot;");

const POWERLINE = {
	"\ue0b0": "right-arrow",
	"\ue0b4": "right-round",
	"\ue0b6": "left-round",
};

/**
 * Draw one block of cells: a rectangle per coloured cell, then the glyph.
 *
 * Glyphs are placed per cell rather than as one long string so the columns always
 * line up whatever the font's advance width does. The powerline arrows and caps
 * are vectors: they are solid shapes a terminal draws from a patched font, and
 * drawing them as text would put the cover at the mercy of the glyph.
 */
function drawCells(rows, options) {
	const { x, y, cell, rowHeight, fontSize, weight = 400 } = options;
	const out = [];
	rows.forEach((row, rowIndex) => {
		const top = y + rowIndex * rowHeight;
		const baseline = top + rowHeight / 2 + fontSize * 0.35;
		row.forEach((entry, column) => {
			const left = x + column * cell;
			if (entry.bg) {
				out.push(
					`<rect x="${left.toFixed(2)}" y="${top.toFixed(2)}" width="${cell.toFixed(2)}" height="${rowHeight.toFixed(2)}" fill="${entry.bg}"/>`,
				);
			}
			if (!entry.ch || entry.ch === " ") return;
			const fill = entry.fg ?? DEFAULT_FG;
			const shape = POWERLINE[entry.ch];
			if (shape) {
				out.push(powerlineShape(shape, left, top, cell, rowHeight, fill));
				return;
			}
			out.push(
				`<text x="${(left + cell / 2).toFixed(2)}" y="${baseline.toFixed(2)}" fill="${fill}" font-size="${fontSize}" font-weight="${entry.bold ? 700 : weight}" text-anchor="middle">${escapeXml(entry.ch)}</text>`,
			);
		});
	});
	return out.join("\n");
}

function powerlineShape(shape, left, top, cell, height, fill) {
	const right = left + cell;
	const bottom = top + height;
	if (shape === "right-arrow") {
		// The solid powerline arrow: full height at the left, a point at the right.
		return `<path d="M${left.toFixed(2)},${top.toFixed(2)} L${right.toFixed(2)},${(top + height / 2).toFixed(2)} L${left.toFixed(2)},${bottom.toFixed(2)} Z" fill="${fill}"/>`;
	}
	if (shape === "left-round") {
		// The rounded cap opening the bar: a half ellipse, flat side on the right.
		return `<path d="M${right.toFixed(2)},${top.toFixed(2)} A${cell.toFixed(2)},${(height / 2).toFixed(2)} 0 0 0 ${right.toFixed(2)},${bottom.toFixed(2)} Z" fill="${fill}"/>`;
	}
	return `<path d="M${left.toFixed(2)},${top.toFixed(2)} A${cell.toFixed(2)},${(height / 2).toFixed(2)} 0 0 1 ${left.toFixed(2)},${bottom.toFixed(2)} Z" fill="${fill}"/>`;
}

// --------------------------------------------------------------------------
// Layout
// --------------------------------------------------------------------------

const WIDTH = 1280;
const HEIGHT = 720;

const PANEL = { x: 468, y: 88, w: 744, h: 544, radius: 16, pad: 28 };

// Rendered wide enough to never truncate, then re-read at its own width: the
// bubble clamps itself against the same number of columns the bar occupies, so
// the two must agree or the bubble runs off the panel.
const { ansi: wideBarAnsi } = buildBar(200);
const TERMINAL_WIDTH = parseAnsi(wideBarAnsi)[0].length;
const { ansi: barAnsi, spans } = buildBar(TERMINAL_WIDTH);
const barRows = parseAnsi(barAnsi);
const barCells = TERMINAL_WIDTH;

// The cell size is whatever makes the bar fill the panel, within a readable range.
const CELL = Math.min(13, Math.max(8, (PANEL.w - PANEL.pad * 2) / Math.max(barCells, 46)));
const ROW_HEIGHT = CELL * 1.55;

const gitSpan = spans.find((span) => span.key === "git");
const anchor = {
	startColumn: gitSpan.bodyStartColumn,
	endColumn: gitSpan.bodyEndColumn,
	centerColumn: Math.floor((gitSpan.startColumn + gitSpan.endColumn - 1) / 2),
	terminalWidth: TERMINAL_WIDTH,
	background: gitSpan.bg,
	foreground: gitSpan.fg,
};
const bubble = buildBubble(anchor, TERMINAL_WIDTH);
const bubbleRows = parseAnsi(bubble.lines.join("\n"));

const BUBBLE_LEFT = PANEL.x + PANEL.pad + bubble.placement.leftColumn * CELL;
const barTop = PANEL.y + PANEL.h - PANEL.pad - ROW_HEIGHT;
// The bubble sits on the footer row: its bottom edge lands directly above the bar,
// the way the overlay's `offsetY: -1` puts it in the real thing.
const bubbleTop = barTop - bubbleRows.length * ROW_HEIGHT;

const terminalFont = `font-family="Maple Mono NF, Menlo, monospace"`;

/** The transcript inside the panel: [text, colour, weight]. */
const transcript = [
	["> fix the flaky git status test", MOCHA.text, 400],
	["", MOCHA.text, 400],
	["✓ bash · pnpm test", MOCHA.green, 400],
	["✓ edit · test/git.test.ts", MOCHA.blue, 400],
	["✓ bash · git status -s", MOCHA.green, 400],
	["Clicking the git pill lists what changed.", MOCHA.subtext0, 400],
];
const TRANSCRIPT_TOP = PANEL.y + 92;
const TRANSCRIPT_STEP = ROW_HEIGHT * 1.75;

function transcriptRows() {
	return transcript
		.map(([text, color, weight], index) => {
			if (!text) return "";
			const y = TRANSCRIPT_TOP + index * TRANSCRIPT_STEP;
			return `    <text x="${PANEL.x + PANEL.pad}" y="${y.toFixed(2)}" fill="${color}" font-size="${(CELL * 1.2).toFixed(2)}" font-weight="${weight}">${escapeXml(text)}</text>`;
		})
		.filter(Boolean)
		.join("\n");
}

const bullets = [
	["●", MOCHA.blue, "one bar: model, git, context, cost"],
	["●", MOCHA.mauve, "click a pill: numbers behind it"],
	["●", MOCHA.maroon, "one git pill: branch, dirty, files"],
	["●", MOCHA.green, "select, copy, caret and wheel"],
];

const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${WIDTH}" height="${HEIGHT}" viewBox="0 0 ${WIDTH} ${HEIGHT}" role="img">
  <title>pi-starline · a statusline you can click</title>
  <!-- pi-starline cover. Catppuccin Mocha, 16:9. The pill bar and the bubble are
       generated from the real renderers by tools/cover/generate.mjs, then pasted
       in; do not hand-edit their rows. -->
  <rect width="${WIDTH}" height="${HEIGHT}" fill="${MOCHA.base}"/>
  <rect x="0" y="0" width="${WIDTH}" height="${HEIGHT}" fill="url(#glow)"/>
  <defs>
    <radialGradient id="glow" cx="30%" cy="18%" r="72%">
      <stop offset="0%" stop-color="${MOCHA.blue}" stop-opacity="0.10"/>
      <stop offset="100%" stop-color="${MOCHA.base}" stop-opacity="0"/>
    </radialGradient>
    <clipPath id="panel">
      <rect x="${PANEL.x}" y="${PANEL.y}" width="${PANEL.w}" height="${PANEL.h}" rx="${PANEL.radius}"/>
    </clipPath>
  </defs>

  <!-- Left: name, pitch, install -->
  <g ${terminalFont}>
    <text x="72" y="196" font-size="48" font-weight="700" fill="${MOCHA.text}">pi-starline</text>
    <rect x="74" y="214" width="58" height="4" rx="2" fill="${MOCHA.blue}"/>

    <text x="72" y="268" font-size="19" fill="${MOCHA.text}">A statusline you can click.</text>
    <text x="72" y="308" font-size="15" fill="${MOCHA.subtext0}">Bars, bubbles and an editor frame</text>
    <text x="72" y="332" font-size="15" fill="${MOCHA.subtext0}">for the pi coding agent.</text>

${bullets
	.map(
		([glyph, color, text], index) =>
			`    <text x="74" y="${400 + index * 34}" font-size="14" fill="${color}">${glyph}</text>\n    <text x="96" y="${400 + index * 34}" font-size="14" fill="${MOCHA.subtext0}">${escapeXml(text)}</text>`,
	)
	.join("\n")}

    <rect x="72" y="556" width="352" height="42" rx="10" fill="${MOCHA.mantle}" stroke="${MOCHA.surface0}"/>
    <text x="92" y="583" font-size="15" fill="${MOCHA.overlay0}">$ <tspan fill="${MOCHA.text}">pi install npm:pi-starline</tspan></text>
  </g>

  <!-- Right: a session, with the git bubble open -->
  <g clip-path="url(#panel)">
    <rect x="${PANEL.x}" y="${PANEL.y}" width="${PANEL.w}" height="${PANEL.h}" fill="${MOCHA.mantle}"/>
  </g>
  <rect x="${PANEL.x}" y="${PANEL.y}" width="${PANEL.w}" height="${PANEL.h}" rx="${PANEL.radius}" fill="none" stroke="${MOCHA.surface0}" stroke-width="1.5"/>
  <line x1="${PANEL.x}" y1="${PANEL.y + 46}" x2="${PANEL.x + PANEL.w}" y2="${PANEL.y + 46}" stroke="${MOCHA.surface0}" stroke-width="1.5"/>
  <circle cx="${PANEL.x + 28}" cy="${PANEL.y + 23}" r="5.5" fill="${MOCHA.surface1}"/>
  <circle cx="${PANEL.x + 48}" cy="${PANEL.y + 23}" r="5.5" fill="${MOCHA.surface1}"/>
  <circle cx="${PANEL.x + 68}" cy="${PANEL.y + 23}" r="5.5" fill="${MOCHA.surface1}"/>
  <text x="${PANEL.x + PANEL.w / 2}" y="${PANEL.y + 28}" ${terminalFont} font-size="13" fill="${MOCHA.overlay0}" text-anchor="middle">~/Projects/fork/pi/pi-starline</text>

  <g ${terminalFont}>
${transcriptRows()}
  </g>

  <!-- The bubble: renderPillBubble's own rows -->
  <g ${terminalFont}>
${drawCells(bubbleRows, {
	x: BUBBLE_LEFT,
	y: bubbleTop,
	cell: CELL,
	rowHeight: ROW_HEIGHT,
	fontSize: CELL * 1.2,
})}
  </g>

  <!-- The bar: renderPillBar's own cells, powerline glyphs as vectors -->
  <g ${terminalFont}>
${drawCells(barRows, {
	x: PANEL.x + PANEL.pad,
	y: barTop,
	cell: CELL,
	rowHeight: ROW_HEIGHT,
	fontSize: CELL * 1.2,
})}
  </g>
</svg>
`;

writeFileSync(new URL("../../assets/cover.svg", import.meta.url), svg);
console.log(
	`wrote assets/cover.svg — bar ${barCells} cells, cell ${CELL.toFixed(2)}px, bubble ${bubble.width} cells x ${bubbleRows.length} rows`,
);
