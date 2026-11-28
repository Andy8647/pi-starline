/**
 * The `tree` pill: what it says, what its bubble shows, and what a click does.
 *
 * The pill is the cheap half. Pi's footer renders on every message, so the graph
 * is memoised on the leaf id: an append moves the leaf, so one key covers every
 * change the tree can have (a new entry, a navigation, a label).
 *
 * The bubble draws the turns you wrote as a tree (`tree-view.ts`) and moves
 * nothing itself. A click on a turn opens Pi's own `/tree` with that turn already
 * selected, so the preview, the "summarize the branch you leave?" question and the
 * move itself are Pi's, exactly as if the turn had been picked there. Pi has no
 * extension API for that selector, so the interactive mode is captured from a
 * method Starline already wraps (see `installTreeSelectorHost`).
 *
 * The two actions that do act — clone, and going back to the session this one
 * was forked from — need the command context that `pi.registerCommand` handlers
 * receive, which a click does not have. They dispatch `/starline tree <verb>`
 * through `pi.sendUserMessage(..., { expandPromptTemplates: true })`, which Pi
 * resolves as a command before it reaches the model.
 */

import { readFileSync } from "node:fs";
import type { ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { InteractiveMode } from "@earendil-works/pi-coding-agent";
import { truncateToWidth } from "@earendil-works/pi-tui";
import type { PillAnchor, PillBubbleLine } from "../../types/pill-api";
import { showPillBubble } from "./pill-bubble";
import { installPrototypePatch } from "./prototype-patch-registry";
import {
	buildTurnGraph,
	entryText,
	renderTurnGraph,
	type TurnGraph,
	treePillText,
} from "./tree-view";

export type TreeVerb = "clone" | "parent";

type Host = {
	/** Send `/starline tree …` so the command context runs it. */
	sendCommand: (commandText: string) => void;
};

type TreeSelectorHost = { showTreeSelector: (initialSelectedId?: string) => void };

/** Widest the tree bubble gets: room for a sentence beside the branch rails. */
const BUBBLE_MAX_WIDTH = 100;

let host: Host | undefined;
let selectorHost: TreeSelectorHost | undefined;
let cachedLeafId: string | undefined;
let cachedGraph: TurnGraph | undefined;

/** How the bubble reaches a command context. Set once from `index.ts`. */
export function setTreeHost(next: Host | undefined): void {
	host = next;
	resetTreeCache();
}

/** Drop the memoised graph. Called on session start, shutdown, and clone. */
export function resetTreeCache(): void {
	cachedLeafId = undefined;
	cachedGraph = undefined;
}

/**
 * Remember the interactive mode, so a click can open Pi's own `/tree`.
 *
 * `renderWidgetContainer` runs whenever the widget slots are rebuilt, which
 * Starline does right after installing its patches, so the instance is known
 * before the footer can be clicked. Returns the uninstaller.
 */
export function installTreeSelectorHost(): () => void {
	try {
		const dispose = installPrototypePatch(
			InteractiveMode.prototype,
			"renderWidgetContainer",
			"tree-selector-host",
			({ predecessor, receiver, args }) => {
				const candidate = receiver as Partial<TreeSelectorHost>;
				if (typeof candidate.showTreeSelector === "function") {
					selectorHost = receiver as TreeSelectorHost;
				}
				return Reflect.apply(predecessor, receiver, args);
			},
		);
		return () => {
			dispose();
			selectorHost = undefined;
		};
	} catch {
		return () => {};
	}
}

/** The graph as of the current leaf. Cheap after the first call for a leaf. */
function currentGraph(ctx: ExtensionContext): TurnGraph | undefined {
	const leafId = ctx.sessionManager.getLeafId() ?? undefined;
	if (leafId === cachedLeafId) return cachedGraph;
	// Build first, cache after: a build that throws must not leave the previous
	// leaf's graph filed under this one.
	const graph = buildTurnGraph(ctx.sessionManager);
	cachedLeafId = leafId;
	cachedGraph = graph;
	return graph;
}

/** What the footer shows. Empty means "leave the pill out". */
export function treePillLabel(ctx: ExtensionContext, icon: string): string {
	try {
		return treePillText(currentGraph(ctx), icon);
	} catch {
		// A footer that throws takes the render loop with it; a missing segment is
		// the same as a session with nothing in it yet.
		return "";
	}
}

function dispatch(commandText: string, ctx: ExtensionContext): void {
	if (host) {
		host.sendCommand(commandText);
		return;
	}
	// Without a host (a test) the request still lands in the editor, one Enter
	// away, instead of doing nothing.
	ctx.ui.setEditorText(commandText);
}

/** Open Pi's `/tree` on `entryId`, or say how to get there when it cannot be reached. */
function openInTree(entryId: string, ctx: ExtensionContext): void {
	if (selectorHost) {
		selectorHost.showTreeSelector(entryId);
		return;
	}
	ctx.ui.setEditorText("/tree");
	ctx.ui.notify("Press Enter to open /tree", "info");
}

/**
 * The name the session this one was forked from goes by: its `/name`, else its
 * first message, the same two things `/resume` lists it by.
 */
function parentName(file: string): string | undefined {
	let text: string;
	try {
		text = readFileSync(file, "utf8");
	} catch {
		return undefined;
	}
	let name: string | undefined;
	let first: string | undefined;
	for (const line of text.split("\n")) {
		if (!line.includes('"session_info"') && (first || !line.includes('"user"'))) continue;
		try {
			const entry = JSON.parse(line);
			if (entry.type === "session_info" && typeof entry.name === "string") name = entry.name;
			else if (!first && entry.type === "message" && entry.message?.role === "user") {
				first = entryText(entry) || undefined;
			}
		} catch {
			// A line cut short by a write in progress names nothing.
		}
	}
	return name || first;
}

function lineageLine(ctx: ExtensionContext, width: number): PillBubbleLine | undefined {
	const parent = ctx.sessionManager.getHeader()?.parentSession;
	if (!parent) return undefined;
	const name = parentName(parent);
	const text = name ? `↱ forked from “${name}”` : "↱ forked from another session";
	return {
		text: truncateToWidth(text, width, "…"),
		onSelect: () => dispatch("/starline tree parent", ctx),
	};
}

/** Inner width the rows are laid out for. */
function rowBudget(): number {
	const columns = process.stdout.columns ?? 80;
	return Math.max(24, Math.min(BUBBLE_MAX_WIDTH - 4, columns - 8));
}

/** Open the bubble for the tree pill. */
export function showTreeBubble(ctx: ExtensionContext, pill?: PillAnchor): void {
	const graph = currentGraph(ctx);
	if (!graph) {
		ctx.ui.notify("No messages in this session yet", "info");
		return;
	}
	const width = rowBudget();
	const body: PillBubbleLine[] = [];
	const lineage = lineageLine(ctx, width);
	if (lineage) body.push(lineage, "");
	for (const row of renderTurnGraph(graph, width)) {
		const entryId = row.entryId;
		body.push(entryId ? { text: row.text, onSelect: () => openInTree(entryId, ctx) } : row.text);
	}
	body.push("", {
		text: "▸ Copy this branch into a new session",
		onSelect: () => dispatch("/starline tree clone", ctx),
	});
	const branches = graph.tips > 1 ? `Tree · ${graph.tips} branches` : "Tree";
	// Static content: the bubble is a menu, and a body that re-reads the tree while
	// it is open can change height under an overlay whose rows were already placed.
	showPillBubble(
		ctx,
		{
			title: branches,
			body,
			hint: "click a turn to open it in /tree",
			maxWidth: BUBBLE_MAX_WIDTH,
			underlineTargets: false,
		},
		pill,
	);
}

export function parseTreeCommand(args: string): { verb: TreeVerb } | undefined {
	const match = /^\s*tree\s+(\S+)\s*$/i.exec(args);
	const verb = match?.[1]?.toLowerCase();
	if (verb !== "clone" && verb !== "parent") return undefined;
	return { verb };
}

/**
 * Run a tree verb with the context that can replace the session. Called from the
 * `/starline tree …` command, whether the user typed it or a bubble row sent it.
 */
export async function runTreeCommand(ctx: ExtensionCommandContext, verb: TreeVerb): Promise<void> {
	try {
		if (verb === "clone") {
			const leafId = ctx.sessionManager.getLeafId();
			if (!leafId) {
				ctx.ui.notify("Nothing to copy yet", "info");
				return;
			}
			await ctx.fork(leafId, {
				position: "at",
				withSession: async (next) => {
					resetTreeCache();
					next.ui.notify("Copied this branch into a new session", "info");
				},
			});
			return;
		}

		const parent = ctx.sessionManager.getHeader()?.parentSession;
		if (!parent) {
			ctx.ui.notify("This session was not forked from another one", "info");
			return;
		}
		await ctx.switchSession(parent, {
			withSession: async () => {
				resetTreeCache();
			},
		});
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		try {
			ctx.ui.notify(`Tree: ${message}`, "error");
		} catch {
			// After a clone or a switch this context is stale and every call on it
			// throws; the replacement already happened, so there is nothing to report to.
		}
	}
}
