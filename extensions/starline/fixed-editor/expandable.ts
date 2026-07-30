/**
 * Click-to-expand for a single tool box.
 *
 * Pi's expansion state is already per component: `ctrl+o` walks the chat
 * container and calls `setExpanded` on every child that has it. So expanding
 * one box on its own needs nothing more than the component it belongs to —
 * which is what the transcript index finds. This file holds the two pure
 * decisions around that: what counts as an expandable component, and which of
 * its rows are a click target.
 *
 * Only the chrome is a target: the frame's rules and verticals, and the
 * "… ctrl+o to expand" hint. Body text keeps double click for a word and triple
 * click for the line, which is worth more there than a toggle.
 *
 * @internal
 */

import { visibleWidth } from "@earendil-works/pi-tui";

import { stripAnsi } from "./selection";

export type ExpandableNode = {
	setExpanded: (expanded: boolean) => void;
	expanded?: unknown;
};

/**
 * Fallback record of what we last set, for components that keep their flag
 * somewhere we cannot read. Weak so a component dropped from the chat (a
 * compaction, a thinking-block toggle) is still collectable.
 */
const assumedState = new WeakMap<object, boolean>();

export function isExpandableNode(value: unknown): value is ExpandableNode {
	if (typeof value !== "object" || value === null) return false;
	return typeof (value as ExpandableNode).setExpanded === "function";
}

/** Whether this component currently shows its full output. */
export function isExpanded(node: ExpandableNode): boolean {
	if (typeof node.expanded === "boolean") return node.expanded;
	return assumedState.get(node as object) ?? false;
}

/**
 * Flip one component's expansion. Returns false when the component rejects the
 * call, in which case the click should go on to behave like a normal one.
 */
export function toggleExpanded(node: ExpandableNode): boolean {
	const next = !isExpanded(node);
	try {
		node.setExpanded(next);
	} catch {
		return false;
	}
	assumedState.set(node as object, next);
	return true;
}

/** Box-drawing glyphs a frame can be made of, corners included. */
const FRAME_GLYPHS = new Set(["╭", "╮", "╰", "╯", "┌", "┐", "└", "┘", "─", "━", "═", "│", "┃"]);

/**
 * A rule row of a box frame: nothing on it but frame glyphs.
 *
 * Body rows carry text between their two verticals, and a blank padding row
 * carries spaces, so neither is mistaken for the frame itself.
 */
export function isFrameRuleRow(line: string): boolean {
	const plain = stripAnsi(line).trim();
	if (plain.length < 4) return false;
	for (const char of plain) {
		if (!FRAME_GLYPHS.has(char)) return false;
	}
	return true;
}

/**
 * The row offering to expand or collapse. Pi writes the key hint as
 * `(… <key> to expand)` in several places — a truncated tool result, a read,
 * a bash box, a skill invocation — and the key itself is rebindable, so the
 * match is anchored on the words and the paren that closes them rather than on
 * `ctrl+o`.
 */
const HINT_RE = /to (?:expand|collapse)\)/;

export function isExpandHintRow(line: string): boolean {
	return HINT_RE.test(stripAnsi(line));
}

/** The verticals of a frame, which run down every row of a box. */
const VERTICAL_GLYPHS = new Set(["│", "┃", "┆", "┊"]);

const graphemeSegmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });

/** The grapheme sitting at a visible column, or "" past the end of the row. */
function cellAtColumn(plain: string, col: number): string {
	let at = 0;
	for (const { segment } of graphemeSegmenter.segment(plain)) {
		const width = Math.max(1, visibleWidth(segment));
		if (col < at + width) return segment;
		at += width;
	}
	return "";
}

/**
 * A click on one of the box's own verticals.
 *
 * An expanded box can easily be taller than the screen, which leaves its rules
 * scrolled out of reach — so the side of the frame is a target too, giving every
 * row of the box somewhere to click to shut it again.
 */
export function isFrameEdgeCell(line: string, col: number): boolean {
	if (col < 0) return false;
	return VERTICAL_GLYPHS.has(cellAtColumn(stripAnsi(line), col));
}

/** Whether a click on this row should toggle the box it belongs to. */
export function isToggleTargetRow(line: string): boolean {
	return isFrameRuleRow(line) || isExpandHintRow(line);
}

/** Whether a click at this cell should toggle the box it belongs to. */
export function isToggleTarget(line: string, col: number): boolean {
	return isToggleTargetRow(line) || isFrameEdgeCell(line, col);
}
