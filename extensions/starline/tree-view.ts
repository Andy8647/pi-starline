/**
 * The session tree, reduced to the turns you wrote and the places they part.
 *
 * Pi stores a session as an append-only tree: every entry has an `id` and a
 * `parentId`, and one leaf pointer says where the conversation is. Replies, tool
 * calls, labels and extension state hang off that tree too, but none of them is
 * where a branch starts: a branch is a second message sent from the same point.
 * So this keeps only user messages, each under the nearest user message above it,
 * and the shape left over is the shape of the alternatives.
 *
 * - `buildTurnGraph` reads it through the read-only session manager and returns
 *   plain data, so it can be tested against fixtures without a terminal.
 * - `renderTurnGraph` indents it the way `/tree` does: straight runs in one
 *   column, branches under `├─` / `└─`, long runs folded. Rows carry the entry a click
 *   should open, not a callback, so the caller owns what a click does.
 */

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { stripTerminalSequences, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

type SessionManager = ExtensionContext["sessionManager"];
type SessionNode = ReturnType<SessionManager["getTree"]>[number];
type SessionEntry = SessionNode["entry"];

/** A straight run longer than this folds its middle into one `⋮` row. */
const FOLD_ABOVE = 5;
/** Turns kept at the end of a folded run, so the latest ones stay readable. */
const FOLD_KEEP_TAIL = 2;

const ON_PATH = "●";
const OFF_PATH = "○";
const FOLD = "⋮";
const HERE = "← here";
const ROOT = "◇";
const BRANCH = "├─ ";
const LAST = "└─ ";
const CONTINUE = "│  ";
const INDENT = "   ";
const ELLIPSIS = "…";
const DIM = "\x1b[2m";
const UNDIM = "\x1b[22m";

export type TurnTip = {
	/** The entry this branch ends on: what `/tree` should open to continue it. */
	leafId: string;
	/** User messages from the start of the session to here. */
	turns: number;
	/** ISO time the branch was last written to, when the entry has one. */
	timestamp?: string;
};

export type TurnNode = {
	/** The user message. */
	entryId: string;
	text: string;
	/** A label on the message or on any reply to it. */
	label?: string;
	/** On the path from the root to where the session is now. */
	onPath: boolean;
	/** The last message on that path: where the session is. */
	here: boolean;
	children: TurnNode[];
	/** Set when nothing was sent after this message: the end of a branch. */
	tip?: TurnTip;
};

export type TurnGraph = {
	roots: TurnNode[];
	/** Every branch end, the current one included. */
	tips: number;
	/** The nearest label on the current path, which is how a branch gets a name. */
	label?: string;
};

export type GraphRow = {
	text: string;
	/** The entry a click opens in `/tree`. Absent for rows that go nowhere. */
	entryId?: string;
};

/** A message's visible text, with images and tool blocks dropped. */
export function entryText(entry: SessionEntry): string {
	if (entry.type !== "message") return "";
	const message = (entry as { message?: { content?: unknown } }).message;
	const content = message?.content;
	if (typeof content === "string") return collapse(content);
	if (!Array.isArray(content)) return "";
	const parts: string[] = [];
	for (const part of content) {
		if (!part || typeof part !== "object") continue;
		const block = part as { type?: string; text?: unknown };
		if (block.type === "text" && typeof block.text === "string") parts.push(block.text);
	}
	return collapse(parts.join(" "));
}

function collapse(text: string): string {
	return stripTerminalSequences(text)
		.replace(/\s+/g, " ")
		.replace(/^[-*+]\s+/, "")
		.trim();
}

function isUserMessage(entry: SessionEntry): boolean {
	return (
		entry.type === "message" && (entry as { message?: { role?: string } }).message?.role === "user"
	);
}

function timeOf(entry: SessionEntry): number {
	const time = Date.parse((entry as { timestamp?: string }).timestamp ?? "");
	return Number.isNaN(time) ? 0 : time;
}

/**
 * Read the session as a turn graph, or `undefined` when nothing has been said yet.
 */
export function buildTurnGraph(manager: SessionManager): TurnGraph | undefined {
	const leafId = manager.getLeafId();
	if (!leafId) return undefined;
	const onPath = new Set(manager.getBranch(leafId).map((entry) => entry.id));

	const roots: TurnNode[] = [];
	/** Leaves under each turn that has no turn below it, by entry. */
	const leavesOf = new Map<TurnNode, SessionEntry[]>();
	const depthOf = new Map<TurnNode, number>();
	/** The deepest turn on the current path: where the session is. */
	const here: { turn?: TurnNode; depth: number } = { depth: -1 };

	const walk = (node: SessionNode, owner: TurnNode | undefined, depth: number): void => {
		const { entry } = node;
		let next = owner;
		let nextDepth = depth;
		const text = isUserMessage(entry) ? entryText(entry) : "";
		if (text) {
			const turn: TurnNode = {
				entryId: entry.id,
				text,
				onPath: onPath.has(entry.id),
				here: false,
				children: [],
			};
			(owner ? owner.children : roots).push(turn);
			next = turn;
			nextDepth = depth + 1;
			depthOf.set(turn, nextDepth);
			if (turn.onPath && nextDepth > here.depth) {
				here.turn = turn;
				here.depth = nextDepth;
			}
		}
		// Labels are on the message or on a reply to it; either names the turn.
		if (node.label && next) next.label = node.label;
		if (node.children.length === 0 && next) {
			const leaves = leavesOf.get(next) ?? [];
			leaves.push(entry);
			leavesOf.set(next, leaves);
		}
		for (const child of node.children) walk(child, next, nextDepth);
	};
	for (const root of manager.getTree()) walk(root, undefined, 0);
	if (roots.length === 0) return undefined;
	if (here.turn) here.turn.here = true;

	let tips = 0;
	const finish = (turn: TurnNode): void => {
		turn.children.sort((left, right) => {
			const a = manager.getEntry(left.entryId);
			const b = manager.getEntry(right.entryId);
			return (a ? timeOf(a) : 0) - (b ? timeOf(b) : 0);
		});
		for (const child of turn.children) finish(child);
		if (turn.children.length > 0) return;
		// Pi appends labels and extension state at the leaf, so one branch can end in
		// several leaves that are the same conversation. The one the session is on
		// wins; otherwise the one written last is where the branch got to.
		const leaves = leavesOf.get(turn) ?? [];
		const end =
			leaves.find((leaf) => leaf.id === leafId) ??
			leaves.reduce<SessionEntry | undefined>(
				(latest, leaf) => (!latest || timeOf(leaf) >= timeOf(latest) ? leaf : latest),
				undefined,
			);
		tips += 1;
		turn.tip = {
			leafId: end?.id ?? turn.entryId,
			turns: depthOf.get(turn) ?? 1,
			timestamp: (end as { timestamp?: string } | undefined)?.timestamp,
		};
	};
	for (const root of roots) finish(root);

	let label: string | undefined;
	const nearest = (turns: TurnNode[]): void => {
		for (const turn of turns) {
			if (!turn.onPath) continue;
			if (turn.label) label = turn.label;
			nearest(turn.children);
		}
	};
	nearest(roots);

	return { roots, tips, label };
}

/** `⑂ name +2`: the current branch's label, and how many others there are. */
export function treePillText(graph: TurnGraph | undefined, icon: string): string {
	if (!graph) return "";
	const parts: string[] = [];
	if (graph.label) parts.push(truncateToWidth(graph.label, 14, ELLIPSIS));
	if (graph.tips > 1) parts.push(`+${graph.tips - 1}`);
	if (icon && parts.length > 0) return `${icon} ${parts.join(" ")}`;
	return parts.length > 0 ? parts.join(" ") : icon;
}

export function relativeTime(iso: string | undefined, now: number): string | undefined {
	const time = Date.parse(iso ?? "");
	if (Number.isNaN(time)) return undefined;
	const minutes = Math.max(0, Math.round((now - time) / 60_000));
	if (minutes < 1) return "just now";
	if (minutes < 60) return `${minutes}m ago`;
	const hours = Math.round(minutes / 60);
	if (hours < 48) return `${hours}h ago`;
	return `${Math.round(hours / 24)}d ago`;
}

/** The turns of one straight run: from `start` down while there is one way on. */
function runFrom(start: TurnNode): TurnNode[] {
	const run = [start];
	let node = start;
	while (node.children.length === 1) {
		node = node.children[0] as TurnNode;
		run.push(node);
	}
	return run;
}

/**
 * Which turns of a run to draw. The first and the last few always; a turn with a
 * label or the one the session is on too, since those are what a reader looks for.
 */
function visibleTurns(run: readonly TurnNode[]): Array<TurnNode | number> {
	if (run.length <= FOLD_ABOVE) return [...run];
	const keep = run.map(
		(turn, index) =>
			index === 0 || index >= run.length - FOLD_KEEP_TAIL || turn.here || !!turn.label,
	);
	const out: Array<TurnNode | number> = [];
	let hidden = 0;
	run.forEach((turn, index) => {
		if (keep[index]) {
			// One hidden turn costs the same row as the fold that would replace it.
			if (hidden === 1) out.push(run[index - 1] as TurnNode);
			else if (hidden > 1) out.push(hidden);
			hidden = 0;
			out.push(turn);
		} else {
			hidden += 1;
		}
	});
	return out;
}

function tipMeta(turn: TurnNode, now: number): string {
	if (turn.here) return HERE;
	if (!turn.tip) return "";
	const turns = turn.tip.turns === 1 ? "1 turn" : `${turn.tip.turns} turns`;
	const age = relativeTime(turn.tip.timestamp, now);
	return age ? `${turns} · ${age}` : turns;
}

/**
 * Lay a row out to exactly `width` columns: the text clipped to what the right
 * side leaves, the right side flush right.
 */
function layoutRow(left: string, right: string, width: number, dim: boolean): string {
	const gap = right ? 2 : 0;
	const room = Math.max(1, width - visibleWidth(right) - gap);
	const shown = truncateToWidth(left, room, ELLIPSIS);
	const pad = " ".repeat(Math.max(0, width - visibleWidth(shown) - visibleWidth(right)));
	const body = `${shown}${pad}${right}`;
	return dim ? `${DIM}${body}${UNDIM}` : body;
}

/**
 * The graph as rows of exactly `width` columns:
 *
 * - a straight run stays in one column, however long it is;
 * - where the conversation forks, each branch hangs off `├─` / `└─`, oldest first,
 *   and the rest of that branch carries on in the column of its first turn.
 *
 * `/tree` steps the rest of a branch in once more than this, to group the replies
 * and tool calls under it. Here there are only your messages, so the turns after
 * the first are the same kind of thing as the first and line up with it.
 *
 * Long straight runs fold to `⋮ N turns`. Turns on the current path are `●`, the
 * rest `○` and dimmed. When the session has more than one first message, they
 * hang off a `◇ session start` row.
 */
export function renderTurnGraph(graph: TurnGraph, width: number, now = Date.now()): GraphRow[] {
	const rows: GraphRow[] = [];
	const inner = Math.max(20, width);

	/** Draw a run, its first turn after `connector`, then whatever forks off its end. */
	const drawRun = (start: TurnNode, prefix: string, connector: string): void => {
		const run = runFrom(start);
		const items = visibleTurns(run);
		// The column of the first turn, behind a rail while a sibling branch follows.
		// The rest of the run, and whatever forks off it, carry on from there.
		const rail = prefix + (connector === BRANCH ? CONTINUE : connector === LAST ? INDENT : "");
		items.forEach((item, index) => {
			const lead = index === 0 ? prefix + connector : rail;
			if (typeof item === "number") {
				rows.push({ text: layoutRow(`${lead}${FOLD} ${item} turns`, "", inner, true) });
				return;
			}
			const marker = item.onPath ? ON_PATH : OFF_PATH;
			const name = item.label ? ` [${item.label}]` : "";
			const right = item.children.length === 0 || item.here ? tipMeta(item, now) : "";
			rows.push({
				text: layoutRow(`${lead}${marker} ${item.text}${name}`, right, inner, !item.onPath),
				// The end of another branch opens on its last entry, so Enter in /tree
				// carries on from there. Any other turn opens on the message itself,
				// which /tree puts back in the editor to send again. The turn the
				// session is on goes nowhere: it is already there.
				entryId: item.here ? undefined : item.tip ? item.tip.leafId : item.entryId,
			});
		});
		const end = run.at(-1) as TurnNode;
		// Branches hang under the marker of the turn they fork from.
		drawBranches(end.children, rail);
	};

	const drawBranches = (children: readonly TurnNode[], prefix: string): void => {
		children.forEach((child, index) => {
			drawRun(child, prefix, index === children.length - 1 ? LAST : BRANCH);
		});
	};

	if (graph.roots.length === 1) {
		drawRun(graph.roots[0] as TurnNode, "", "");
	} else {
		rows.push({ text: layoutRow(`${ROOT} session start`, "", inner, false) });
		drawBranches(graph.roots, "");
	}
	return rows;
}
