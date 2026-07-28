import { beforeEach, describe, expect, it, vi } from "vitest";

const copyToClipboard = vi.fn(async (_text: string) => {});
vi.mock("@earendil-works/pi-coding-agent", () => ({ copyToClipboard }));

const { SelectionState } = await import("../extensions/zentui/fixed-editor/selection");
const { overlayHintOnBorder, SelectionController } = await import(
	"../extensions/zentui/fixed-editor/selection-controller"
);

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
		selection.extend(0, 1);
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
