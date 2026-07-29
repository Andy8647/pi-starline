import { describe, expect, it } from "vitest";
import {
	displayColumnToStringIndex,
	editorTextColumn,
	findEditorBox,
	hitTestEditorBox,
	isEditorRule,
} from "../extensions/starline/fixed-editor/editor-hit-test";
import {
	positionEditorTextCursor,
	resolveEditorInternals,
	supportsEditorTextCursor,
} from "../extensions/starline/fixed-editor/editor-text-cursor";

const RULE = "─".repeat(40);
const RAIL = "│ ";

/** What renderPolishedFrame lays down, plus a footer line under it. */
function cluster(textRows: string[], paddingY: number): string[] {
	const pad = paddingY > 0 ? [`${RAIL}`] : [];
	return [
		"status line",
		RULE,
		...pad,
		...textRows.map((row) => `${RAIL}${row}`),
		...pad,
		`${RAIL}the metadata`,
		RULE,
		"footer text",
	];
}

describe("isEditorRule", () => {
	it("recognises a run of box rule", () => {
		expect(isEditorRule(RULE)).toBe(true);
		expect(isEditorRule(`\x1b[38;2;1;2;3m${RULE}\x1b[0m`)).toBe(true);
	});

	it("rejects content, including a content row that starts with the rail", () => {
		expect(isEditorRule(`${RAIL}────────`)).toBe(false);
		expect(isEditorRule("footer text")).toBe(false);
		expect(isEditorRule("───")).toBe(false);
		expect(isEditorRule("")).toBe(false);
	});
});

describe("findEditorBox", () => {
	it("locates the text rows at padding 1", () => {
		const box = findEditorBox(cluster(["one", "two"], 1), 1, 2);
		expect(box).toEqual({ firstTextRow: 3, lastTextRow: 4, textColumn: 2 });
	});

	it("locates the text rows at padding 0", () => {
		const box = findEditorBox(cluster(["one", "two"], 0), 0, 2);
		expect(box).toEqual({ firstTextRow: 2, lastTextRow: 3, textColumn: 2 });
	});

	it("handles a single text row", () => {
		const box = findEditorBox(cluster(["only"], 1), 1, 2);
		expect(box).toEqual({ firstTextRow: 3, lastTextRow: 3, textColumn: 2 });
	});

	it("is null without two rules", () => {
		expect(findEditorBox(["status", RULE, "footer"], 1, 2)).toBeNull();
		expect(findEditorBox(["status", "footer"], 1, 2)).toBeNull();
		expect(findEditorBox([], 1, 2)).toBeNull();
	});

	// Reading the padding wrong would put the text rows somewhere they are not.
	it("is null when the geometry leaves no room for text", () => {
		expect(findEditorBox([RULE, `${RAIL}meta`, RULE], 1, 2)).toBeNull();
	});
});

describe("hitTestEditorBox", () => {
	const box = { firstTextRow: 3, lastTextRow: 5, textColumn: 2 };

	it("maps rows relative to the first text row", () => {
		expect(hitTestEditorBox(box, 3, 2)).toEqual({ visualRow: 0, visualCol: 0 });
		expect(hitTestEditorBox(box, 5, 2)).toEqual({ visualRow: 2, visualCol: 0 });
	});

	it("subtracts the chrome from the column", () => {
		expect(hitTestEditorBox(box, 3, 9)).toEqual({ visualRow: 0, visualCol: 7 });
	});

	it("is null outside the text rows", () => {
		expect(hitTestEditorBox(box, 2, 5)).toBeNull();
		expect(hitTestEditorBox(box, 6, 5)).toBeNull();
	});

	it("is null on the chrome itself", () => {
		expect(hitTestEditorBox(box, 3, 0)).toBeNull();
		expect(hitTestEditorBox(box, 3, 1)).toBeNull();
	});
});

describe("editorTextColumn", () => {
	it("counts the rail plus its trailing space", () => {
		expect(editorTextColumn({ copyFriendly: false, railIcon: "│", promptIcon: "" })).toBe(2);
	});

	// The rail's trailing space is drawn even when the glyph is blank.
	it("still counts the space when the rail glyph is empty", () => {
		expect(editorTextColumn({ copyFriendly: false, railIcon: "", promptIcon: "" })).toBe(1);
	});

	it("uses the prompt in copy-friendly mode, and nothing without one", () => {
		expect(editorTextColumn({ copyFriendly: true, railIcon: "│", promptIcon: "❯" })).toBe(2);
		expect(editorTextColumn({ copyFriendly: true, railIcon: "│", promptIcon: "" })).toBe(0);
	});
});

describe("displayColumnToStringIndex", () => {
	it("counts plain characters one to one", () => {
		expect(displayColumnToStringIndex("hello world", 0, 6)).toBe(6);
	});

	it("starts from the given index", () => {
		expect(displayColumnToStringIndex("hello world", 6, 3)).toBe(9);
	});

	it("stops at the end of the line", () => {
		expect(displayColumnToStringIndex("hi", 0, 99)).toBe(2);
	});

	// A wide glyph covers two columns but one or two code units.
	it("charges wide characters their real width", () => {
		expect(displayColumnToStringIndex("你好ab", 0, 2)).toBe(1);
		expect(displayColumnToStringIndex("你好ab", 0, 4)).toBe(2);
		expect(displayColumnToStringIndex("你好ab", 0, 5)).toBe(3);
	});

	it("does not split an astral character", () => {
		expect(displayColumnToStringIndex("🎉x", 0, 2)).toBe(2);
	});
});

describe("positionEditorTextCursor", () => {
	function makeEditor(lines: string[], visualLines: { l: number; s: number; n: number }[]) {
		return {
			state: { lines, cursorLine: 0, cursorCol: 0 },
			scrollOffset: 0,
			lastWidth: 40,
			preferredVisualCol: 7,
			snappedFromCursorCol: 3,
			buildVisualLineMap: () =>
				visualLines.map((v) => ({ logicalLine: v.l, startCol: v.s, length: v.n })),
		};
	}

	it("moves the cursor to the clicked point", () => {
		const editor = makeEditor(["hello world"], [{ l: 0, s: 0, n: 11 }]);
		expect(positionEditorTextCursor(editor, 0, 6)).toBe(true);
		expect(editor.state.cursorLine).toBe(0);
		expect(editor.state.cursorCol).toBe(6);
	});

	// Otherwise the next up/down press jumps back to where the cursor used to be.
	it("clears the sticky column", () => {
		const editor = makeEditor(["hello"], [{ l: 0, s: 0, n: 5 }]);
		positionEditorTextCursor(editor, 0, 2);
		expect(editor.preferredVisualCol).toBeNull();
		expect(editor.snappedFromCursorCol).toBeNull();
	});

	it("clamps past the end of a wrapped segment", () => {
		const editor = makeEditor(
			["abcdefghij"],
			[
				{ l: 0, s: 0, n: 5 },
				{ l: 0, s: 5, n: 5 },
			],
		);
		expect(positionEditorTextCursor(editor, 0, 99)).toBe(true);
		expect(editor.state.cursorCol).toBe(5);
	});

	it("resolves the second visual row of a wrapped line", () => {
		const editor = makeEditor(
			["abcdefghij"],
			[
				{ l: 0, s: 0, n: 5 },
				{ l: 0, s: 5, n: 5 },
			],
		);
		expect(positionEditorTextCursor(editor, 1, 2)).toBe(true);
		expect(editor.state.cursorCol).toBe(7);
	});

	it("accounts for the editor's own scroll offset", () => {
		const editor = makeEditor(
			["one", "two"],
			[
				{ l: 0, s: 0, n: 3 },
				{ l: 1, s: 0, n: 3 },
			],
		);
		editor.scrollOffset = 1;
		expect(positionEditorTextCursor(editor, 0, 1)).toBe(true);
		expect(editor.state.cursorLine).toBe(1);
	});

	it("is false for a row that does not exist", () => {
		const editor = makeEditor(["one"], [{ l: 0, s: 0, n: 3 }]);
		expect(positionEditorTextCursor(editor, 5, 0)).toBe(false);
	});

	/**
	 * This reaches into internals Pi never promised. Every shape it does not
	 * recognise has to degrade to "click did nothing", never to a crash.
	 */
	it("degrades instead of throwing on anything unexpected", () => {
		for (const value of [undefined, null, {}, { state: {} }, { buildVisualLineMap: 1 }]) {
			expect(supportsEditorTextCursor(value)).toBe(false);
			expect(positionEditorTextCursor(value, 0, 0)).toBe(false);
		}
	});

	it("degrades when the map itself throws", () => {
		const editor = {
			state: { lines: ["x"], cursorLine: 0, cursorCol: 0 },
			buildVisualLineMap: () => {
				throw new Error("internals moved");
			},
		};
		expect(positionEditorTextCursor(editor, 0, 0)).toBe(false);
	});

	it("degrades when the map is not an array", () => {
		const editor = {
			state: { lines: ["x"], cursorLine: 0, cursorCol: 0 },
			buildVisualLineMap: () => undefined as never,
		};
		expect(positionEditorTextCursor(editor, 0, 0)).toBe(false);
	});
});

/**
 * The compositor tracks the container Pi puts the editor in, not the editor,
 * and Zentui wraps the editor again in the wrapped-editor path. Resolving the
 * wrong object is a silent failure: clicks simply stop doing anything.
 */
describe("resolveEditorInternals", () => {
	const editor = {
		state: { lines: ["hi"], cursorLine: 0, cursorCol: 0 },
		buildVisualLineMap: () => [{ logicalLine: 0, startCol: 0, length: 2 }],
	};

	it("returns the editor when handed it directly", () => {
		expect(resolveEditorInternals(editor)).toBe(editor);
	});

	it("finds it inside a container's children", () => {
		expect(resolveEditorInternals({ children: [{}, editor] })).toBe(editor);
	});

	it("descends through a wrapper's base", () => {
		expect(resolveEditorInternals({ children: [{ base: editor }] })).toBe(editor);
	});

	it("is undefined when nothing in the tree qualifies", () => {
		expect(resolveEditorInternals({ children: [{}, { base: {} }] })).toBeUndefined();
		expect(resolveEditorInternals(undefined)).toBeUndefined();
	});

	it("terminates on a cyclic component graph", () => {
		const a: Record<string, unknown> = {};
		const b: Record<string, unknown> = { children: [a] };
		a.children = [b];
		expect(resolveEditorInternals(a)).toBeUndefined();
	});
});
