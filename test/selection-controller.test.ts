import { beforeEach, describe, expect, it, vi } from "vitest";

const copyToClipboard = vi.fn(async (_text: string) => {});
vi.mock("@earendil-works/pi-coding-agent", () => ({ copyToClipboard }));

const { SelectionState } = await import("../extensions/starline/fixed-editor/selection");
const { overlayHintOnBorder, SelectionController } = await import(
	"../extensions/starline/fixed-editor/selection-controller"
);
const { installPasteCollapse } = await import("../extensions/starline/fixed-editor/paste-collapse");

type Config = { copyOnSelect: boolean; copyNotice: boolean; editorClickCursor?: boolean };

const TRANSCRIPT = ["first line here", "second line here", "third line here"];

function makeHarness(config: Config, lines: string[] = TRANSCRIPT) {
	const selection = new SelectionState();
	const calls = { render: 0, pauseMouse: 0, notice: 0 };
	const controller = new SelectionController({
		selection,
		getRootLines: () => lines,
		getVisibleRootStart: () => 0,
		getVisibleScrollableRows: () => lines.length,
		getConfig: () => ({ editorClickCursor: true, ...config }),
		getClusterLines: () => [],
		getEditorPaddingY: () => 1,
		getEditorTextColumn: () => 2,
		getEditorComponent: () => undefined,
		requestRender: () => {
			calls.render++;
		},
		pauseMouseReporting: () => {
			calls.pauseMouse++;
		},
		showCopyNotice: () => {
			calls.notice++;
		},
	});
	return { controller, selection, calls };
}

/** Press at (row,col), move to (row2,col2), release. Rows and cols are 1-based. */
function drag(
	controller: InstanceType<typeof SelectionController>,
	from: [number, number],
	to: [number, number],
) {
	controller.handleMouse({ button: "left", action: "press", row: from[0], col: from[1] });
	controller.handleMouse({ button: "left", action: "drag", row: to[0], col: to[1] });
	controller.handleMouse({ button: "left", action: "release", row: to[0], col: to[1] });
}

beforeEach(() => {
	copyToClipboard.mockClear();
});

describe("copyOnSelect: true (the default)", () => {
	it("copies on release and drops the highlight", () => {
		const { controller, selection } = makeHarness({ copyOnSelect: true, copyNotice: true });
		drag(controller, [1, 1], [1, 6]);
		expect(copyToClipboard).toHaveBeenCalledTimes(1);
		expect(copyToClipboard.mock.calls[0]?.[0]).toBe("first");
		expect(selection.active).toBe(false);
	});

	it("shows the copied notice, since nothing else signals the copy", () => {
		const { controller, calls } = makeHarness({ copyOnSelect: true, copyNotice: true });
		drag(controller, [1, 1], [1, 6]);
		expect(calls.notice).toBe(1);
	});

	it("respects copyNotice: false", () => {
		const { controller, calls } = makeHarness({ copyOnSelect: true, copyNotice: false });
		drag(controller, [1, 1], [1, 6]);
		expect(copyToClipboard).toHaveBeenCalledTimes(1);
		expect(calls.notice).toBe(0);
	});

	it("offers no hint, because the copy already happened", () => {
		const { controller } = makeHarness({ copyOnSelect: true, copyNotice: true });
		drag(controller, [1, 1], [1, 6]);
		expect(controller.hintText()).toBe("");
	});
});

describe("copyOnSelect: false", () => {
	it("keeps the highlight and writes nothing to the clipboard", () => {
		const { controller, selection } = makeHarness({ copyOnSelect: false, copyNotice: true });
		drag(controller, [1, 1], [1, 6]);
		expect(copyToClipboard).not.toHaveBeenCalled();
		expect(selection.active).toBe(true);
	});

	it("prompts for ctrl+c with the character count", () => {
		const { controller } = makeHarness({ copyOnSelect: false, copyNotice: true });
		drag(controller, [1, 1], [1, 6]);
		expect(controller.hintText()).toBe("5 characters selected, ctrl+c to copy");
	});

	it("says character, singular, for one", () => {
		const { controller, selection } = makeHarness({ copyOnSelect: false, copyNotice: true });
		selection.start(0, 0);
		selection.extend(0, 0);
		selection.setDragging(false);
		expect(controller.hintText()).toBe("1 character selected, ctrl+c to copy");
	});

	it("stays quiet mid-drag, when the count is still moving", () => {
		const { controller } = makeHarness({ copyOnSelect: false, copyNotice: true });
		controller.handleMouse({ button: "left", action: "press", row: 1, col: 1 });
		controller.handleMouse({ button: "left", action: "drag", row: 1, col: 6 });
		expect(controller.hintText()).toBe("");
	});

	it("stays quiet with no selection", () => {
		const { controller } = makeHarness({ copyOnSelect: false, copyNotice: true });
		expect(controller.hintText()).toBe("");
	});

	// Dragging backwards used to drop a character at each end: the cell the drag
	// started on and the cell it ended on both fell outside the range.
	it("selects the same text dragged backwards as forwards", () => {
		const forwards = makeHarness({ copyOnSelect: false, copyNotice: true });
		drag(forwards.controller, [1, 7], [1, 11]);
		const forwardsHint = forwards.controller.hintText();

		const backwards = makeHarness({ copyOnSelect: false, copyNotice: true });
		drag(backwards.controller, [1, 11], [1, 7]);

		expect(forwardsHint).toBe("4 characters selected, ctrl+c to copy"); // "line"
		expect(backwards.controller.hintText()).toBe(forwardsHint);
	});
});

describe("double and triple click", () => {
	/** Press and release on one cell, `times` in a row. Rows and cols are 1-based. */
	function click(
		controller: InstanceType<typeof SelectionController>,
		at: [number, number],
		times: number,
	) {
		for (let i = 0; i < times; i++) {
			controller.handleMouse({ button: "left", action: "press", row: at[0], col: at[1] });
			controller.handleMouse({ button: "left", action: "release", row: at[0], col: at[1] });
		}
	}

	it("selects the word under a double click", () => {
		const { controller } = makeHarness({ copyOnSelect: false, copyNotice: true });
		// "first line here", double click inside "line".
		click(controller, [1, 8], 2);
		expect(controller.hintText()).toBe("4 characters selected, ctrl+c to copy");
	});

	it("selects the whole line on a third click", () => {
		const { controller } = makeHarness({ copyOnSelect: false, copyNotice: true });
		click(controller, [1, 8], 3);
		expect(controller.hintText()).toBe("15 characters selected, ctrl+c to copy");
	});

	it("starts counting again on a fourth click", () => {
		const { controller } = makeHarness({ copyOnSelect: false, copyNotice: true });
		click(controller, [1, 8], 4);
		// Back to a plain click, which selects nothing.
		expect(controller.hintText()).toBe("");
	});

	it("does not count clicks on different cells as a double click", () => {
		const { controller } = makeHarness({ copyOnSelect: false, copyNotice: true });
		click(controller, [1, 8], 1);
		click(controller, [1, 12], 1);
		expect(controller.hintText()).toBe("");
	});

	it("copies straight away with copyOnSelect on", () => {
		const { controller } = makeHarness({ copyOnSelect: true, copyNotice: true });
		click(controller, [1, 8], 2);
		expect(copyToClipboard).toHaveBeenCalledWith("line");
		expect(controller.hintText()).toBe("");
	});

	it("selects nothing when the double click lands past the text", () => {
		const { controller } = makeHarness({ copyOnSelect: false, copyNotice: true });
		click(controller, [1, 60], 2);
		expect(controller.hintText()).toBe("");
	});
});

describe("deleting an editor selection", () => {
	const RULE = "─".repeat(40);
	const CLUSTER = [RULE, "│ ", "│ hello world", "│ second line", "│ ", "│ meta", RULE, "footer"];
	const SCROLLABLE = 5;
	const screenRow = (clusterRow: number) => SCROLLABLE + clusterRow + 1;

	function makeHarnessWithEditor(config: Config) {
		const editor = {
			state: { lines: ["hello world", "second line"], cursorLine: 0, cursorCol: 0 },
			lastWidth: 40,
			scrollOffset: 0,
			preferredVisualCol: null as number | null,
			snappedFromCursorCol: null as number | null,
			pushUndoSnapshot: vi.fn(),
			setCursorCol: (col: number) => {
				editor.state.cursorCol = col;
			},
			buildVisualLineMap: () =>
				editor.state.lines.map((line, logicalLine) => ({
					logicalLine,
					startCol: 0,
					length: line.length,
				})),
		};
		const controller = new SelectionController({
			selection: new SelectionState(),
			getRootLines: () => TRANSCRIPT,
			getVisibleRootStart: () => 0,
			getVisibleScrollableRows: () => SCROLLABLE,
			getConfig: () => ({ editorClickCursor: true, ...config }),
			getClusterLines: () => CLUSTER,
			getEditorPaddingY: () => 1,
			getEditorTextColumn: () => 2,
			getEditorComponent: () => editor,
			requestRender: () => {},
			pauseMouseReporting: () => {},
			showCopyNotice: () => {},
		});
		return { controller, editor, text: () => editor.state.lines.join("\n") };
	}

	function dragInEditor(
		controller: InstanceType<typeof SelectionController>,
		from: [number, number],
		to: [number, number],
	) {
		controller.handleMouse({
			button: "left",
			action: "press",
			row: screenRow(from[0]),
			col: from[1],
		});
		controller.handleMouse({ button: "left", action: "drag", row: screenRow(to[0]), col: to[1] });
		controller.handleMouse({
			button: "left",
			action: "release",
			row: screenRow(to[0]),
			col: to[1],
		});
	}

	it("backspace deletes the selected text and consumes the key", () => {
		const { controller, text } = makeHarnessWithEditor({ copyOnSelect: false, copyNotice: true });
		dragInEditor(controller, [2, 3], [2, 7]); // "hello"
		expect(controller.handleKey("\x7f")).toBe(true);
		expect(text()).toBe(" world\nsecond line");
		expect(controller.hintText()).toBe("");
	});

	it("the delete key does the same", () => {
		const { controller, text } = makeHarnessWithEditor({ copyOnSelect: false, copyNotice: true });
		dragInEditor(controller, [2, 3], [2, 7]);
		expect(controller.handleKey("\x1b[3~")).toBe(true);
		expect(text()).toBe(" world\nsecond line");
	});

	it("deletes across lines, joining what is left", () => {
		const { controller, text } = makeHarnessWithEditor({ copyOnSelect: false, copyNotice: true });
		dragInEditor(controller, [2, 8], [3, 8]); // " world" + newline + "second"
		expect(controller.handleKey("\x7f")).toBe(true);
		expect(text()).toBe("hello line");
	});

	it("leaves the key to Pi when nothing is selected", () => {
		const { controller, text } = makeHarnessWithEditor({ copyOnSelect: false, copyNotice: true });
		expect(controller.handleKey("\x7f")).toBe(false);
		expect(text()).toBe("hello world\nsecond line");
	});

	// The transcript is not editable, so a delete there is just a dismissal.
	it("leaves the key to Pi for a transcript selection", () => {
		const { controller, text } = makeHarnessWithEditor({ copyOnSelect: false, copyNotice: true });
		controller.handleMouse({ button: "left", action: "press", row: 1, col: 1 });
		controller.handleMouse({ button: "left", action: "drag", row: 1, col: 6 });
		controller.handleMouse({ button: "left", action: "release", row: 1, col: 6 });
		expect(controller.handleKey("\x7f")).toBe(false);
		expect(text()).toBe("hello world\nsecond line");
	});

	it("typing replaces the selection, leaving the key to Pi to insert", () => {
		const { controller, editor, text } = makeHarnessWithEditor({
			copyOnSelect: false,
			copyNotice: true,
		});
		dragInEditor(controller, [2, 3], [2, 7]); // "hello"
		// Not consumed: Pi still gets the key and inserts it at the caret, which
		// the deletion left where the selection started.
		expect(controller.handleKey("x")).toBe(false);
		expect(text()).toBe(" world\nsecond line");
		expect(editor.state.cursorLine).toBe(0);
		expect(editor.state.cursorCol).toBe(0);
		expect(controller.hintText()).toBe("");
	});

	it("does not treat a control key or an escape sequence as typing", () => {
		const { controller, text } = makeHarnessWithEditor({ copyOnSelect: false, copyNotice: true });
		dragInEditor(controller, [2, 3], [2, 7]);
		controller.handleKey("\x1b[A"); // arrow up
		expect(text()).toBe("hello world\nsecond line");

		dragInEditor(controller, [2, 3], [2, 7]);
		controller.handleKey("\r"); // submit
		expect(text()).toBe("hello world\nsecond line");
	});

	// A paste is Pi's own path, complete with the collapse threshold; replacing
	// the selection here would insert the text twice over.
	it("does not treat a bracketed paste as typing", () => {
		const { controller, text } = makeHarnessWithEditor({ copyOnSelect: false, copyNotice: true });
		dragInEditor(controller, [2, 3], [2, 7]);
		controller.handleKey("\x1b[200~pasted\x1b[201~");
		expect(text()).toBe("hello world\nsecond line");
	});

	it("leaves typing alone when the selection is in the transcript", () => {
		const { controller, text } = makeHarnessWithEditor({ copyOnSelect: false, copyNotice: true });
		controller.handleMouse({ button: "left", action: "press", row: 1, col: 1 });
		controller.handleMouse({ button: "left", action: "drag", row: 1, col: 6 });
		controller.handleMouse({ button: "left", action: "release", row: 1, col: 6 });
		expect(controller.handleKey("x")).toBe(false);
		expect(text()).toBe("hello world\nsecond line");
	});

	it("pushes one undo snapshot for the whole deletion", () => {
		const { controller, editor } = makeHarnessWithEditor({ copyOnSelect: false, copyNotice: true });
		dragInEditor(controller, [2, 3], [2, 7]);
		controller.handleKey("\x7f");
		expect(editor.pushUndoSnapshot).toHaveBeenCalledTimes(1);
	});
});

describe("the border hint is shared", () => {
	/** Arms a collapsed paste the way a real editor would, and returns a disposer. */
	function armPaste() {
		const editor = {
			pastes: new Map<number, string>(),
			pasteCounter: 0,
			state: { lines: [""], cursorLine: 0, cursorCol: 0 },
			handlePaste: (_text: string) => {},
			normalizeText: (text: string) => text,
			insertTextAtCursorInternal: (text: string) => {
				editor.state.lines = [text];
			},
		};
		const dispose = installPasteCollapse(editor, () => 3);
		editor.handlePaste("a\nb\nc\nd");
		return dispose;
	}

	it("shows the paste hint on its own", () => {
		const dispose = armPaste();
		try {
			const { controller } = makeHarness({ copyOnSelect: false, copyNotice: true });
			expect(controller.hintText()).toBe("paste again to expand");
		} finally {
			dispose?.();
		}
	});

	it("joins the paste hint and the selection hint with a middot", () => {
		const dispose = armPaste();
		try {
			const { controller } = makeHarness({ copyOnSelect: false, copyNotice: true });
			drag(controller, [1, 1], [1, 6]);
			expect(controller.hintText()).toBe(
				"paste again to expand ⋅ 5 characters selected, ctrl+c to copy",
			);
		} finally {
			dispose?.();
		}
	});

	it("still shows the paste hint with copyOnSelect on", () => {
		const dispose = armPaste();
		try {
			const { controller } = makeHarness({ copyOnSelect: true, copyNotice: true });
			drag(controller, [1, 1], [1, 6]);
			expect(controller.hintText()).toBe("paste again to expand");
		} finally {
			dispose?.();
		}
	});
});

describe("ctrl+c", () => {
	it("copies the pending selection and consumes the key", () => {
		const { controller, selection } = makeHarness({ copyOnSelect: false, copyNotice: true });
		drag(controller, [1, 1], [1, 6]);
		expect(controller.handleKey("\x03")).toBe(true);
		expect(copyToClipboard).toHaveBeenCalledWith("first");
		expect(selection.active).toBe(false);
	});

	it("shows no notice, because the hint disappearing is the feedback", () => {
		const { controller, calls } = makeHarness({ copyOnSelect: false, copyNotice: true });
		drag(controller, [1, 1], [1, 6]);
		controller.handleKey("\x03");
		expect(calls.notice).toBe(0);
	});

	// Otherwise ctrl+c would stop interrupting Pi.
	it("falls through when there is nothing selected", () => {
		const { controller } = makeHarness({ copyOnSelect: false, copyNotice: true });
		expect(controller.handleKey("\x03")).toBe(false);
		expect(copyToClipboard).not.toHaveBeenCalled();
	});

	it("works under copyOnSelect: true as well, for a fresh selection", () => {
		const { controller, selection } = makeHarness({ copyOnSelect: true, copyNotice: true });
		selection.start(0, 0);
		selection.extend(0, 5);
		selection.setDragging(false);
		expect(controller.handleKey("\x03")).toBe(true);
		expect(copyToClipboard).toHaveBeenCalledWith("first");
	});
});

describe("other keys", () => {
	it("dismiss a highlight that would otherwise linger", () => {
		const { controller, selection } = makeHarness({ copyOnSelect: false, copyNotice: true });
		drag(controller, [1, 1], [1, 6]);
		expect(selection.active).toBe(true);
		expect(controller.handleKey("a")).toBe(false);
		expect(selection.active).toBe(false);
	});

	it("are never consumed, so the editor still receives them", () => {
		const { controller } = makeHarness({ copyOnSelect: false, copyNotice: true });
		drag(controller, [1, 1], [1, 6]);
		expect(controller.handleKey("a")).toBe(false);
		expect(controller.handleKey("a")).toBe(false);
	});
});

describe("right click", () => {
	it("copies outright when it lands inside the selection", () => {
		const { controller, calls } = makeHarness({ copyOnSelect: false, copyNotice: true });
		drag(controller, [1, 1], [1, 6]);
		controller.handleMouse({ button: "right", action: "press", row: 1, col: 3 });
		expect(copyToClipboard).toHaveBeenCalledWith("first");
		expect(calls.pauseMouse).toBe(0);
		expect(calls.notice).toBe(0);
	});

	it("falls through to the native context menu outside the selection", () => {
		const { controller, calls } = makeHarness({ copyOnSelect: false, copyNotice: true });
		drag(controller, [1, 1], [1, 6]);
		controller.handleMouse({ button: "right", action: "press", row: 3, col: 3 });
		expect(copyToClipboard).not.toHaveBeenCalled();
		expect(calls.pauseMouse).toBe(1);
	});

	it("falls through when there is no selection at all", () => {
		const { controller, calls } = makeHarness({ copyOnSelect: true, copyNotice: true });
		controller.handleMouse({ button: "right", action: "press", row: 1, col: 3 });
		expect(calls.pauseMouse).toBe(1);
	});
});

describe("click versus drag", () => {
	it("treats a press and release at one point as a click, not a selection", () => {
		const { controller, selection } = makeHarness({ copyOnSelect: true, copyNotice: true });
		controller.handleMouse({ button: "left", action: "press", row: 1, col: 3 });
		controller.handleMouse({ button: "left", action: "release", row: 1, col: 3 });
		expect(selection.active).toBe(false);
		expect(copyToClipboard).not.toHaveBeenCalled();
	});

	it("ignores clicks below the scrollable region", () => {
		const { controller, selection } = makeHarness({ copyOnSelect: true, copyNotice: true });
		controller.handleMouse({ button: "left", action: "press", row: 99, col: 1 });
		expect(selection.active).toBe(false);
	});
});

describe("clearSelection", () => {
	it("reports whether there was anything to clear", () => {
		const { controller } = makeHarness({ copyOnSelect: false, copyNotice: true });
		expect(controller.clearSelection()).toBe(false);
		drag(controller, [1, 1], [1, 6]);
		expect(controller.clearSelection()).toBe(true);
		expect(controller.clearSelection()).toBe(false);
	});
});

/**
 * Zentui extracts OSC 8 hyperlink targets alongside the visible text, which the
 * powerline fork never did. Selection goes through SelectionState precisely so
 * this cannot be lost.
 */
describe("OSC 8 hyperlinks", () => {
	it("carries the URL into the copied text", () => {
		const link = "\x1b]8;;https://example.com\x07example\x1b]8;;\x07";
		const { controller } = makeHarness({ copyOnSelect: true, copyNotice: true }, [link]);
		controller.handleMouse({ button: "left", action: "press", row: 1, col: 1 });
		controller.handleMouse({ button: "left", action: "drag", row: 1, col: 40 });
		controller.handleMouse({ button: "left", action: "release", row: 1, col: 40 });
		expect(copyToClipboard).toHaveBeenCalledTimes(1);
		expect(String(copyToClipboard.mock.calls[0]?.[0])).toContain("https://example.com");
	});
});

describe("overlayHintOnBorder", () => {
	const rule = "─".repeat(40);

	it("returns the lines untouched with no hint", () => {
		const lines = [rule, "footer"];
		expect(overlayHintOnBorder(lines, "", 40)).toBe(lines);
	});

	it("writes the hint onto the lowest horizontal rule", () => {
		const out = overlayHintOnBorder([rule, "footer text"], "12 selected", 40);
		expect(out[0]).toContain("12 selected");
		expect(out[1]).toBe("footer text");
	});

	it("keeps the line the same visible width", () => {
		const out = overlayHintOnBorder([rule], "12 selected", 40);
		expect((out[0] ?? "").length).toBe(40);
	});

	it("leaves the frame alone when there is no rule to write on", () => {
		const lines = ["just text", "more text"];
		expect(overlayHintOnBorder(lines, "12 selected", 40)).toBe(lines);
	});

	it("skips the overlay rather than overflow a narrow terminal", () => {
		const lines = ["─".repeat(10)];
		expect(overlayHintOnBorder(lines, "a very long hint indeed", 10)).toBe(lines);
	});

	it("preserves the border's styling prefix", () => {
		const styled = `\x1b[38;2;69;71;90m${rule}`;
		const out = overlayHintOnBorder([styled], "12 selected", 40);
		expect(out[0]?.startsWith("\x1b[38;2;69;71;90m")).toBe(true);
	});
});

/**
 * Selecting inside the editor box works over the rendered cluster lines, not
 * the transcript, so it needs its own state and its own bounds. The chrome —
 * the rail on the left, the borders and the metadata row — must stay out of
 * whatever gets copied.
 */
describe("selecting inside the editor box", () => {
	const RULE = "─".repeat(40);
	const CLUSTER = [
		RULE, // 0  top border
		"│ ", // 1  padding
		"│ hello world", // 2  text
		"│ second line", // 3  text
		"│ ", // 4  padding
		"│ meta", // 5  metadata
		RULE, // 6  bottom border
		"footer", // 7
	];
	const SCROLLABLE = 5;

	function makeEditorHarness(config: Config) {
		const selection = new SelectionState();
		const calls = { render: 0, pauseMouse: 0, notice: 0 };
		const controller = new SelectionController({
			selection,
			getRootLines: () => TRANSCRIPT,
			getVisibleRootStart: () => 0,
			getVisibleScrollableRows: () => SCROLLABLE,
			getConfig: () => ({ editorClickCursor: true, ...config }),
			getClusterLines: () => CLUSTER,
			getEditorPaddingY: () => 1,
			getEditorTextColumn: () => 2,
			getEditorComponent: () => undefined,
			requestRender: () => {
				calls.render++;
			},
			pauseMouseReporting: () => {
				calls.pauseMouse++;
			},
			showCopyNotice: () => {
				calls.notice++;
			},
		});
		return { controller, calls };
	}

	/** Cluster row `r` (0-based) is screen row SCROLLABLE + r + 1. */
	const screenRow = (clusterRow: number) => SCROLLABLE + clusterRow + 1;

	function dragInEditor(
		controller: InstanceType<typeof SelectionController>,
		from: [number, number],
		to: [number, number],
	) {
		controller.handleMouse({
			button: "left",
			action: "press",
			row: screenRow(from[0]),
			col: from[1],
		});
		controller.handleMouse({ button: "left", action: "drag", row: screenRow(to[0]), col: to[1] });
		controller.handleMouse({
			button: "left",
			action: "release",
			row: screenRow(to[0]),
			col: to[1],
		});
	}

	it("copies the dragged text", () => {
		const { controller } = makeEditorHarness({ copyOnSelect: true, copyNotice: true });
		// Text starts at column 2, so screen column 3 is the first character.
		dragInEditor(controller, [2, 3], [2, 8]);
		expect(copyToClipboard).toHaveBeenCalledTimes(1);
		expect(copyToClipboard.mock.calls[0]?.[0]).toBe("hello");
	});

	it("never includes the rail, even when the drag starts on it", () => {
		const { controller } = makeEditorHarness({ copyOnSelect: true, copyNotice: true });
		dragInEditor(controller, [2, 1], [2, 8]);
		expect(String(copyToClipboard.mock.calls[0]?.[0])).not.toContain("│");
	});

	it("clamps a drag that runs off the bottom onto the last text row", () => {
		const { controller } = makeEditorHarness({ copyOnSelect: true, copyNotice: true });
		dragInEditor(controller, [2, 3], [7, 20]);
		const copied = String(copyToClipboard.mock.calls[0]?.[0]);
		expect(copied).toContain("hello world");
		expect(copied).toContain("second line");
		expect(copied).not.toContain("meta");
		expect(copied).not.toContain("─");
	});

	it("holds the highlight for ctrl+c when copyOnSelect is off", () => {
		const { controller } = makeEditorHarness({ copyOnSelect: false, copyNotice: true });
		dragInEditor(controller, [2, 3], [2, 8]);
		expect(copyToClipboard).not.toHaveBeenCalled();
		expect(controller.hintText()).toBe("5 characters selected, ctrl+c to copy");
		expect(controller.handleKey("\x03")).toBe(true);
		expect(copyToClipboard).toHaveBeenCalledWith("hello");
	});

	it("highlights only inside the box", () => {
		const { controller } = makeEditorHarness({ copyOnSelect: false, copyNotice: true });
		dragInEditor(controller, [2, 3], [2, 8]);
		const painted = controller.highlightCluster(CLUSTER);
		expect(painted[2]).not.toBe(CLUSTER[2]);
		expect(painted[0]).toBe(CLUSTER[0]);
		expect(painted[5]).toBe(CLUSTER[5]);
		expect(painted[7]).toBe(CLUSTER[7]);
	});

	it("leaves the lines untouched with no selection", () => {
		const { controller } = makeEditorHarness({ copyOnSelect: false, copyNotice: true });
		expect(controller.highlightCluster(CLUSTER)).toBe(CLUSTER);
	});

	it("starts nothing when the press lands on the chrome", () => {
		const { controller } = makeEditorHarness({ copyOnSelect: true, copyNotice: true });
		dragInEditor(controller, [0, 5], [2, 8]);
		expect(copyToClipboard).not.toHaveBeenCalled();
	});

	it("starts nothing when the press lands on the footer", () => {
		const { controller } = makeEditorHarness({ copyOnSelect: true, copyNotice: true });
		dragInEditor(controller, [7, 3], [7, 5]);
		expect(copyToClipboard).not.toHaveBeenCalled();
	});

	// The two areas share the hint and the ctrl+c path, so one must replace the
	// other rather than both being live at once.
	it("drops a transcript selection when a drag starts in the editor", () => {
		const { controller } = makeEditorHarness({ copyOnSelect: false, copyNotice: true });
		controller.handleMouse({ button: "left", action: "press", row: 1, col: 1 });
		controller.handleMouse({ button: "left", action: "drag", row: 1, col: 6 });
		controller.handleMouse({ button: "left", action: "release", row: 1, col: 6 });
		expect(controller.hintText()).toBe("5 characters selected, ctrl+c to copy");

		dragInEditor(controller, [3, 3], [3, 9]);
		expect(controller.hintText()).toBe("6 characters selected, ctrl+c to copy");
		controller.handleKey("\x03");
		expect(copyToClipboard).toHaveBeenCalledWith("second");
	});

	it("dismisses an editor highlight on the next keystroke", () => {
		const { controller } = makeEditorHarness({ copyOnSelect: false, copyNotice: true });
		dragInEditor(controller, [2, 3], [2, 8]);
		expect(controller.handleKey("a")).toBe(false);
		expect(controller.hintText()).toBe("");
	});
});
