/**
 * What fills the context window, split by where the tokens came from.
 *
 * Pi reports one number: the context tokens the provider last measured. That
 * number leaves out the two things that are already paid for before the first
 * turn — the system prompt and the tool schemas — and before any turn has
 * reported usage it does not exist at all, which is why the pill used to read 0
 * while tens of thousands of tokens were already committed.
 *
 * The parts can be recovered instead of guessed. Pi 1.4 renders the system
 * prompt as named sections (`<project_context>`, `<skills>`, …) and leaves the
 * preamble unwrapped, so each one can be attributed by its tag; the tool
 * schemas the model receives are available with their parameters; and whatever
 * the measured total does not explain is the conversation.
 *
 * Nothing here reads the transcript. A bubble may open between turns, and the
 * breakdown has to describe the context as it stands, not as the last turn left
 * it.
 */

import { visibleWidth } from "@earendil-works/pi-tui";
import { formatCount } from "./format";
import type { ThemeLike } from "./style";

/** A tool as the model receives it: the schema is what costs the tokens. */
export type ContextTool = {
	name: string;
	description?: string;
	parameters?: unknown;
	exposure?: string;
	namespace?: { name?: string };
};

/**
 * The reads this module needs, injected rather than imported.
 *
 * The pill action gets an `ExtensionContext`, and two of the reads live on the
 * extension API instead (`pi.getAllTools()`); passing them in keeps this file
 * about arithmetic and keeps the session plumbing in `index.ts`.
 */
export type ContextProbe = {
	systemPrompt(): string | undefined;
	allTools(): readonly ContextTool[];
	activeTools(): readonly string[];
	usage(): { tokens?: number | null; contextWindow?: number } | undefined;
	modelContextWindow(): number | undefined;
	reserveTokens(): number | undefined;
};

export type ContextPartId = "system" | "tools" | "mcp" | "memory" | "skills" | "messages";
export type ContextSpaceId = "free" | "buffer";

export type ContextPart = {
	id: ContextPartId;
	label: string;
	tokens: number;
	/** A pi theme colour token, so the split follows the theme. */
	color: string;
};

export type ContextSpace = {
	id: ContextSpaceId;
	label: string;
	tokens: number;
	color: string;
};

export type ContextBreakdown = {
	parts: ContextPart[];
	spaces: ContextSpace[];
	/** Tokens attributed. Pi's measured count when there is one, else the sum. */
	total: number;
	/** Pi's measured count; undefined until a turn has reported usage. */
	measured?: number;
	contextWindow?: number;
};

const PART_LABELS: Record<ContextPartId, string> = {
	system: "system prompt",
	tools: "tools",
	mcp: "mcp tools",
	memory: "memory",
	skills: "skills",
	messages: "messages",
};

const PART_COLORS: Record<ContextPartId, string> = {
	system: "dim",
	tools: "muted",
	mcp: "mdLink",
	memory: "error",
	skills: "warning",
	messages: "accent",
};

const FREE_COLOR = "borderMuted";
const BUFFER_COLOR = "dim";
/** MCP servers namespace their tools as `mcp__<server>` in pi. */
const MCP_NAMESPACE = "mcp__";

/** Pi's own estimate for plain text: one token per 3.5 characters. */
function estimateText(text: string): number {
	return Math.ceil(text.length / 3.5);
}

function safe<T>(read: () => T): T | undefined {
	try {
		return read();
	} catch {
		// A read that throws (an older Pi without the method, a stale context) must
		// leave the bubble short of a category, not take it down.
		return undefined;
	}
}

/**
 * Every section pi wraps is `<name>` + newline + body + newline + `</name>`; the
 * preamble is what goes in front of the first one, unwrapped. Matching the tags
 * means the section list never has to be kept in sync with pi.
 */
const SECTION_PATTERN = /<([a-z][a-z0-9_]*)>\n([\s\S]*?)\n<\/\1>/g;

/**
 * Section names that hold memory, whoever declared them.
 *
 * Pi's own context files are `project_context` (`AGENTS.md`, `CLAUDE.md`). The
 * memory extensions each use their own name — `memory`, `pi_memory`,
 * `memory-context`, `local_memory` — and the rendered prompt is the only place
 * those names survive, so the list is a set of names rather than a guess about
 * content.
 */
const MEMORY_SECTIONS = new Set([
	"project_context",
	"memory",
	"memories",
	"pi_memory",
	"memory-context",
	"local_memory",
	"claude_memory",
]);

/**
 * Some memory extensions append their block to the prompt text instead of
 * declaring a section (`<local_memory path="…">`, `<memory>`). Those land in the
 * preamble and would otherwise be counted as system prompt.
 */
const MEMORY_BLOCK =
	/<(memory|local_memory|memory-context|pi_memory|claude_memory)(?:\s[^>]*)?>[\s\S]*?<\/\1>/g;

/** Which category a prompt section belongs to. */
function partForSection(name: string): "system" | "memory" | "skills" {
	if (name === "skills") return "skills";
	return MEMORY_SECTIONS.has(name) ? "memory" : "system";
}

/**
 * Attribute the rendered prompt. The tags count as well as their bodies: they
 * are characters the model reads, and leaving them out makes the parts sum short
 * of the prompt.
 */
function splitPrompt(prompt: string): Record<"system" | "memory" | "skills", number> {
	const totals = { system: 0, memory: 0, skills: 0 };
	const preamble = prompt.replace(SECTION_PATTERN, (full: string, name: string) => {
		totals[partForSection(name)] += estimateText(full);
		return "";
	});
	// Blocks that never became a section: an extension that appends instead of
	// declaring still puts memory in the prompt, and it is still memory.
	const leftover = preamble.replace(MEMORY_BLOCK, (full: string) => {
		totals.memory += estimateText(full);
		return "";
	});
	totals.system += estimateText(leftover);
	return totals;
}

/**
 * Whether a tool belongs to an MCP server. Pi namespaces them as `mcp__<server>`
 * both in the tool's name and in its namespace, and a build may fill in only one
 * of the two, so either is enough.
 */
function isMcpTool(tool: ContextTool): boolean {
	return (
		tool.namespace?.name?.startsWith(MCP_NAMESPACE) === true || tool.name.startsWith(MCP_NAMESPACE)
	);
}

/**
 * Whether the tool's schema is in the request at all. Pi declares `direct` and
 * `model-only` tools; `codemode`, `deferred` and `hidden` ones are reachable but
 * never sent up front, so they cost nothing until the model loads them.
 */
function declaredToModel(tool: ContextTool): boolean {
	return (
		tool.exposure === undefined || tool.exposure === "direct" || tool.exposure === "model-only"
	);
}

/**
 * What pi sends for a tool, stringified the way pi's own estimator does it. The
 * surrounding `ToolInfo` carries fields the model never sees (`sourceInfo`,
 * `promptGuidelines`); counting them would inflate the category.
 */
function schemaTokens(tools: readonly ContextTool[]): number {
	if (tools.length === 0) return 0;
	const payload = tools.map((tool) => ({
		name: tool.name,
		description: tool.description,
		parameters: tool.parameters,
	}));
	try {
		return estimateText(JSON.stringify(payload));
	} catch {
		// A schema with a cycle (an extension building one at runtime) still costs
		// something; fall back to the descriptions rather than dropping the group.
		return estimateText(tools.map((tool) => `${tool.name} ${tool.description ?? ""}`).join("\n"));
	}
}

function part(id: ContextPartId, tokens: number): ContextPart {
	return {
		id,
		label: PART_LABELS[id],
		tokens: Math.max(0, Math.round(tokens)),
		color: PART_COLORS[id],
	};
}

/**
 * The reads that live on the extension API rather than the context: the tool
 * schemas and the compaction reserve. A pill action only gets a context, so
 * these are registered once from `index.ts`.
 */
export type ContextApi = {
	allTools(): readonly ContextTool[];
	activeTools(): readonly string[];
	reserveTokens(): number | undefined;
};

let api: ContextApi | undefined;

/** Point the breakdown at the extension API, or at nothing when the session ends. */
export function setContextApi(next: ContextApi | undefined): void {
	api = next;
}

/**
 * The context reads as a probe. Everything is optional and guarded, so a Pi
 * build without one of the methods loses that category instead of the bubble.
 */
export function probeFor(ctx: {
	getSystemPrompt?(): string;
	getContextUsage?(): { tokens?: number | null; contextWindow?: number } | undefined;
	model?: { contextWindow?: number };
}): ContextProbe {
	return {
		systemPrompt: () => ctx.getSystemPrompt?.(),
		allTools: () => api?.allTools() ?? [],
		activeTools: () => api?.activeTools() ?? [],
		usage: () => ctx.getContextUsage?.(),
		modelContextWindow: () => ctx.model?.contextWindow,
		reserveTokens: () => api?.reserveTokens(),
	};
}

/**
 * The breakdown for the session the probe reads.
 *
 * The conversation is the remainder: pi's total minus everything that is not
 * the conversation. That is the only way the parts add up to the number the pill
 * shows, and it is why an estimate that runs long never shows as an extra
 * category — it corrects the conversation, which is the one bucket that is
 * already an estimate in pi.
 */
export function collectContextBreakdown(probe: ContextProbe): ContextBreakdown {
	const prompt = safe(probe.systemPrompt) ?? "";
	const promptTokens = splitPrompt(prompt);

	const usage = safe(probe.usage);
	const measuredRaw = usage?.tokens;
	const measured =
		typeof measuredRaw === "number" && Number.isFinite(measuredRaw) && measuredRaw > 0
			? measuredRaw
			: undefined;
	const contextWindow = usage?.contextWindow ?? safe(probe.modelContextWindow);

	const active = new Set(safe(probe.activeTools) ?? []);
	const tools = (safe(probe.allTools) ?? []).filter(
		(tool) => active.has(tool.name) && declaredToModel(tool),
	);
	const mcpTools = tools.filter(isMcpTool);
	const plainTools = tools.filter((tool) => !isMcpTool(tool));

	const system = promptTokens.system;
	const toolTokens = schemaTokens(plainTools);
	const mcp = schemaTokens(mcpTools);
	const memory = promptTokens.memory;
	const skills = promptTokens.skills;
	const staticTokens = system + toolTokens + mcp + memory + skills;

	const total = measured ?? staticTokens;
	const messages = Math.max(0, total - staticTokens);

	const parts = [
		part("system", system),
		part("tools", toolTokens),
		part("mcp", mcp),
		part("memory", memory),
		part("skills", skills),
		part("messages", messages),
	];

	const spaces: ContextSpace[] = [];
	if (contextWindow && contextWindow > 0) {
		const reserve = Math.max(0, safe(probe.reserveTokens) ?? 0);
		const buffer = Math.min(reserve, Math.max(0, contextWindow - total));
		spaces.push({ id: "buffer", label: "autocompact buffer", tokens: buffer, color: BUFFER_COLOR });
		spaces.push({
			id: "free",
			label: "free space",
			tokens: Math.max(0, contextWindow - total - buffer),
			color: FREE_COLOR,
		});
	}

	return { parts, spaces, total, measured, contextWindow };
}

/** The grid Claude Code uses: ten cells a row, eight rows, each cell ~1.25%. */
const GRID_COLUMNS = 10;
const GRID_ROWS = 8;
/** A glyph and the gap after it, so neighbouring cells of one category stay countable. */
const CELL_WIDTH = 2;

type Cell = { id: string; glyph: string; color: string };

/**
 * The glyph a cell is drawn with: the category's own icon, so the grid and the
 * legend name the same thing.
 */
function glyphFor(id: string): string {
	return iconFor(id);
}

/**
 * One Nerd Font glyph a category, used by the grid and the legend alike.
 *
 * A cell is identity plus size: the icon says what it is, the number of cells
 * says how much. The alternatives — a block pair, or one neutral glyph for every
 * category — lose the first half of that, and a row of identical blocks melts
 * into a stripe as soon as two cells touch.
 */
const PART_ICONS: Record<ContextPartId, string> = {
	system: "󰒓", // md-cog
	tools: "󰖷", // md-wrench
	mcp: "󰒋", // md-server
	memory: "󰍛", // md-memory
	skills: "󰐱", // md-puzzle
	messages: "󰭹", // md-chat
};
/** md-circle_outline: room that is still there. */
const FREE_ICON = "󰝦";
/** md-archive: the headroom compaction keeps in reserve. */
const BUFFER_ICON = "󰀼";

function iconFor(id: string): string {
	if (id === "free") return FREE_ICON;
	if (id === "buffer") return BUFFER_ICON;
	return PART_ICONS[id as ContextPartId] ?? FREE_ICON;
}

/**
 * One cell per `window / 80` tokens: categories in order, then the buffer and
 * whatever is free. Anything with tokens gets at least one cell — a category
 * small enough to round to zero would otherwise vanish from the grid while
 * still appearing in the legend.
 */
function buildGrid(breakdown: ContextBreakdown): Cell[] {
	const total = GRID_COLUMNS * GRID_ROWS;
	const window = breakdown.contextWindow ?? 0;
	if (window <= 0) {
		return Array.from({ length: total }, () => ({
			id: "free",
			glyph: FREE_ICON,
			color: FREE_COLOR,
		}));
	}

	const cellSize = window / total;
	const entries = [...breakdown.parts, ...breakdown.spaces]
		.filter((entry) => entry.tokens > 0)
		.map((entry) => ({ ...entry, count: Math.max(1, Math.round(entry.tokens / cellSize)) }));

	// Rounding each entry up can overshoot the grid. Shrink the biggest one until
	// it fits, so the layout stays proportional instead of dropping the tail.
	let overflow = entries.reduce((sum, entry) => sum + entry.count, 0) - total;
	while (overflow > 0) {
		const largest = entries.reduce((a, b) => (b.count > a.count ? b : a));
		if (largest.count <= 1) break;
		largest.count -= 1;
		overflow -= 1;
	}

	const cells: Cell[] = [];
	for (const entry of entries) {
		const glyph = glyphFor(entry.id);
		for (let index = 0; index < entry.count; index += 1) {
			cells.push({ id: entry.id, glyph, color: entry.color });
		}
	}
	while (cells.length < total) cells.push({ id: "free", glyph: FREE_ICON, color: FREE_COLOR });
	return cells.slice(0, total);
}

function paint(theme: ThemeLike, color: string, text: string): string {
	try {
		return theme.fg(color, text);
	} catch {
		// An unknown token throws in pi's theme; drop the colour, keep the glyphs.
		return text;
	}
}

function padRight(text: string, width: number): string {
	// Wrapping and padding count cells, not bytes: the glyphs here are wide and the
	// colours add invisible bytes.
	const visible = visibleWidth(text);
	return visible >= width ? text : `${text}${" ".repeat(width - visible)}`;
}

function percentOf(tokens: number, whole: number | undefined): string {
	if (!whole || whole <= 0) return "";
	const percent = (tokens / whole) * 100;
	// A category that is real but tiny still gets a row; `0.0%` next to it would
	// read as a bug rather than as "smaller than a tenth".
	if (percent > 0 && percent < 0.05) return "<0.1%";
	return `${percent.toFixed(1)}%`;
}

/**
 * The bubble's body: a grid on the left, one legend row per category on the
 * right, and the numbers the grid cannot show underneath.
 *
 * The grid is the shape of the window; the legend is what the colours mean. Both
 * are needed — a stacked bar alone cannot say which blue is skills, and the
 * legend alone cannot show that the conversation barely reaches the edge.
 */
export function contextBreakdownBody(
	breakdown: ContextBreakdown,
	theme: ThemeLike,
	notes: readonly string[] = [],
): string[] {
	const cells = buildGrid(breakdown);
	const gridRows: Cell[][] = [];
	for (let row = 0; row < GRID_ROWS; row += 1) {
		gridRows.push(cells.slice(row * GRID_COLUMNS, (row + 1) * GRID_COLUMNS));
	}

	const entries = [...breakdown.parts, ...breakdown.spaces].filter((entry) => entry.tokens > 0);
	const labelWidth = Math.max(...entries.map((entry) => entry.label.length), 8);
	const legend = entries.map((entry) => {
		const percent = percentOf(entry.tokens, breakdown.contextWindow);
		const tokens = formatCount(entry.tokens).padStart(6);
		return `${paint(theme, entry.color, iconFor(entry.id))} ${padRight(entry.label, labelWidth)} ${tokens}${
			percent ? ` ${percent.padStart(5)}` : ""
		}`;
	});

	const body: string[] = [];
	const rows = Math.max(gridRows.length, legend.length);
	for (let row = 0; row < rows; row += 1) {
		const grid = (gridRows[row] ?? [])
			.map((cell) => `${paint(theme, cell.color, cell.glyph)} `)
			.join("");
		const label = legend[row] ?? "";
		body.push(`${padRight(grid, GRID_COLUMNS * CELL_WIDTH)}   ${label}`);
	}

	if (notes.length > 0) {
		body.push(" ");
		body.push(...notes);
	}
	return body;
}

/**
 * The one line the grid cannot say: how much of the window is used, and whether
 * the number is measured or only estimated.
 */
export function contextBreakdownNote(breakdown: ContextBreakdown): string {
	const window = breakdown.contextWindow;
	const used = formatCount(breakdown.total);
	const percent = percentOf(breakdown.total, window);
	if (breakdown.measured === undefined) {
		return window
			? `${used} estimated, no turn yet · ${percent} of ${formatCount(window)}`
			: `${used} estimated, no turn yet`;
	}
	return window
		? `${used} of ${formatCount(window)}${percent ? ` · ${percent}` : ""}`
		: `${used} used`;
}
