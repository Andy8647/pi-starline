import { describe, expect, it, vi } from "vitest";
import { defaultConfig, mergeConfig } from "../extensions/starline/config";
import {
	installPasteCollapse,
	pasteExpandHintText,
	shouldCollapse,
	supportsPasteCollapse,
} from "../extensions/starline/paste-collapse";

const lines = (count: number) => Array.from({ length: count }, (_, i) => `line ${i}`).join("\n");

/** Stands in for Pi's editor: the members the shadow reaches for, and no more. */
function makeEditor() {
	const inserted: string[] = [];
	const editor = {
		pastes: new Map<number, string>(),
		pasteCounter: 0,
		lastAction: "type-word" as unknown,
		state: { lines: [""], cursorLine: 0, cursorCol: 0 },
		isInPaste: false,
		handlePaste: vi.fn(function (this: unknown, _text: string) {}),
		handleInput: vi.fn(function (this: unknown, _data: string) {}),
		normalizeText: (text: string) => text.replace(/\r\n?/g, "\n").replace(/\t/g, "  "),
		insertTextAtCursorInternal: (text: string) => {
			inserted.push(text);
			// Enough of Pi's insert to keep the editor text in sync: markers have to
			// be findable in state.lines for expansion to work at all.
			const state = editor.state;
			const line = state.lines[state.cursorLine] ?? "";
			const merged = line.slice(0, state.cursorCol) + text + line.slice(state.cursorCol);
			const split = merged.split("\n");
			state.lines.splice(state.cursorLine, 1, ...split);
			state.cursorLine += split.length - 1;
			state.cursorCol = (split.at(-1) ?? "").length - (line.length - state.cursorCol);
		},
		setCursorCol: (col: number) => {
			editor.state.cursorCol = col;
		},
		cancelAutocomplete: vi.fn(),
		exitHistoryBrowsing: vi.fn(),
		pushUndoSnapshot: vi.fn(),
	};
	return { editor, inserted, text: () => editor.state.lines.join("\n") };
}

/** Stands in for Pi's own collapse of a paste above its hardcoded threshold. */
function collapseLikePi(editor: ReturnType<typeof makeEditor>["editor"]) {
	return (text: string) => {
		const lineCount = text.split("\n").length;
		if (lineCount <= 10 && text.length <= 1000) {
			editor.insertTextAtCursorInternal(text);
			return;
		}
		editor.pasteCounter += 1;
		const id = editor.pasteCounter;
		editor.pastes.set(id, text);
		editor.insertTextAtCursorInternal(`[paste #${id} +${lineCount} lines]`);
	};
}

describe("pasteCollapseLines config", () => {
	it("defaults to 11, which is Pi's own behaviour", () => {
		expect(defaultConfig.pasteCollapseLines).toBe(11);
		expect(mergeConfig({}).pasteCollapseLines).toBe(11);
	});

	it("accepts 2 through 10", () => {
		for (const value of [2, 3, 5, 10]) {
			expect(mergeConfig({ pasteCollapseLines: value }).pasteCollapseLines).toBe(value);
		}
	});

	// Anything outside the range means "leave Pi alone" rather than clamping into
	// a threshold the user did not ask for.
	it("normalises anything else back to 11", () => {
		for (const value of [0, 1, 11, 50, -3, 2.5, "3", null, true]) {
			expect(mergeConfig({ pasteCollapseLines: value }).pasteCollapseLines).toBe(11);
		}
	});
});

describe("shouldCollapse", () => {
	it("collapses at or above the configured line count", () => {
		expect(shouldCollapse(lines(3), 3)).toBe(true);
		expect(shouldCollapse(lines(5), 3)).toBe(true);
	});

	it("leaves shorter pastes inline", () => {
		expect(shouldCollapse(lines(2), 3)).toBe(false);
		expect(shouldCollapse("one line", 3)).toBe(false);
	});

	// Above Pi's own threshold Pi collapses it itself; taking over would double up.
	it("defers to Pi above its own thresholds", () => {
		expect(shouldCollapse(lines(11), 3)).toBe(false);
		expect(shouldCollapse(`${"x".repeat(1001)}\n\n`, 3)).toBe(false);
	});

	it("does nothing outside the 2..10 range", () => {
		expect(shouldCollapse(lines(5), 11)).toBe(false);
		expect(shouldCollapse(lines(5), 1)).toBe(false);
	});

	// Pi reformats pasted paths; leave those entirely to it.
	it("leaves pasted paths alone", () => {
		for (const prefix of ["/", "~", "."]) {
			expect(shouldCollapse(`${prefix}some/path\nsecond\nthird`, 3)).toBe(false);
		}
	});
});

describe("supportsPasteCollapse", () => {
	it("accepts an editor with everything it needs", () => {
		expect(supportsPasteCollapse(makeEditor().editor)).toBe(true);
	});

	it("rejects anything missing a piece", () => {
		const { editor } = makeEditor();
		expect(supportsPasteCollapse(undefined)).toBe(false);
		expect(supportsPasteCollapse({})).toBe(false);
		expect(supportsPasteCollapse({ ...editor, pastes: {} })).toBe(false);
		expect(supportsPasteCollapse({ ...editor, normalizeText: undefined })).toBe(false);
		expect(supportsPasteCollapse({ ...editor, insertTextAtCursorInternal: undefined })).toBe(false);
	});
});

describe("installPasteCollapse", () => {
	it("does not patch an editor it cannot drive", () => {
		expect(installPasteCollapse({}, () => 3)).toBeUndefined();
	});

	it("collapses a paste Pi would have left inline", () => {
		const { editor, inserted } = makeEditor();
		installPasteCollapse(editor, () => 3);
		editor.handlePaste(lines(4));

		expect(inserted).toEqual(["[paste #1 +4 lines]"]);
		expect(editor.pastes.get(1)).toBe(lines(4));
		expect(editor.pasteCounter).toBe(1);
	});

	it("keeps ids climbing across pastes", () => {
		const { editor, inserted } = makeEditor();
		installPasteCollapse(editor, () => 3);
		editor.handlePaste(lines(4));
		editor.handlePaste(lines(5));

		expect(inserted).toEqual(["[paste #1 +4 lines]", "[paste #2 +5 lines]"]);
		expect(editor.pastes.get(2)).toBe(lines(5));
	});

	it("mirrors the bookkeeping Pi does around its own collapse", () => {
		const { editor } = makeEditor();
		installPasteCollapse(editor, () => 3);
		editor.handlePaste(lines(4));

		expect(editor.cancelAutocomplete).toHaveBeenCalled();
		expect(editor.exitHistoryBrowsing).toHaveBeenCalled();
		expect(editor.pushUndoSnapshot).toHaveBeenCalled();
		expect(editor.lastAction).toBeNull();
	});

	// What is stored has to be what Pi would have stored, or the marker expands
	// to the wrong text on submit.
	it("stores text cleaned the way Pi cleans it", () => {
		const { editor } = makeEditor();
		installPasteCollapse(editor, () => 3);
		editor.handlePaste("a\r\nb\tc\r\nde\n");

		expect(editor.pastes.get(1)).toBe("a\nb  c\nde\n");
	});

	it("decodes the CSI-u control re-encoding some terminals apply", () => {
		const { editor } = makeEditor();
		installPasteCollapse(editor, () => 2);
		// ESC [ 106 ; 5 u is Ctrl+J, a newline.
		editor.handlePaste("a\x1b[106;5ub\x1b[106;5uc");

		expect(editor.pastes.get(1)).toBe("a\nb\nc");
	});

	it("hands back to Pi when it would not collapse", () => {
		const base = makeEditor();
		const original = base.editor.handlePaste;
		installPasteCollapse(base.editor, () => 3);
		base.editor.handlePaste("one line");

		expect(original).toHaveBeenCalledWith("one line");
		expect(base.inserted).toEqual([]);
	});

	it("hands back to Pi above Pi's own threshold", () => {
		const base = makeEditor();
		const original = base.editor.handlePaste;
		installPasteCollapse(base.editor, () => 3);
		base.editor.handlePaste(lines(20));

		expect(original).toHaveBeenCalled();
		expect(base.inserted).toEqual([]);
	});

	it("hands back to Pi at the default threshold", () => {
		const base = makeEditor();
		const original = base.editor.handlePaste;
		installPasteCollapse(base.editor, () => 11);
		base.editor.handlePaste(lines(4));

		expect(original).toHaveBeenCalled();
		expect(base.inserted).toEqual([]);
	});

	// A thrown paste is a lost paste, which is the one outcome worth guarding.
	it("falls back to Pi rather than swallowing a paste that throws", () => {
		const base = makeEditor();
		const original = base.editor.handlePaste;
		installPasteCollapse(base.editor, () => {
			throw new Error("config blew up");
		});
		expect(() => base.editor.handlePaste(lines(4))).not.toThrow();
		expect(original).toHaveBeenCalledWith(lines(4));
	});

	it("restores Pi's handler when disposed", () => {
		const { editor, inserted } = makeEditor();
		const original = editor.handlePaste;
		const dispose = installPasteCollapse(editor, () => 3);
		dispose?.();

		editor.handlePaste(lines(4));
		expect(original).toHaveBeenCalled();
		expect(inserted).toEqual([]);
	});

	it("reads the threshold at paste time, not install time", () => {
		const { editor, inserted } = makeEditor();
		let minLines = 11;
		installPasteCollapse(editor, () => minLines);

		editor.handlePaste(lines(4));
		expect(inserted).toEqual([]);

		minLines = 3;
		editor.handlePaste(lines(4));
		expect(inserted).toEqual(["[paste #1 +4 lines]"]);
	});
});

describe("paste again to expand", () => {
	const HINT = "paste again to expand";

	it("arms the hint after a collapse and clears it after expanding", () => {
		const { editor, text } = makeEditor();
		installPasteCollapse(editor, () => 3);

		editor.handlePaste(lines(4));
		expect(pasteExpandHintText()).toBe(HINT);

		editor.handlePaste(lines(4));
		expect(pasteExpandHintText()).toBeNull();
		expect(text()).toBe(lines(4));
		expect(text()).not.toContain("[paste #");
	});

	it("leaves the cursor at the end of the expanded text", () => {
		const { editor } = makeEditor();
		installPasteCollapse(editor, () => 3);

		editor.handlePaste(lines(4));
		editor.handlePaste(lines(4));

		expect(editor.state.cursorLine).toBe(3);
		expect(editor.state.cursorCol).toBe("line 3".length);
	});

	it("stacks a second marker when different text is pasted, and re-arms for it", () => {
		const { editor, inserted, text } = makeEditor();
		installPasteCollapse(editor, () => 3);

		editor.handlePaste(lines(4));
		editor.handlePaste(lines(5));

		expect(inserted).toEqual(["[paste #1 +4 lines]", "[paste #2 +5 lines]"]);
		expect(pasteExpandHintText()).toBe(HINT);

		// The hint now belongs to #2: re-pasting that text expands it, not #1.
		editor.handlePaste(lines(5));
		expect(text()).toContain("[paste #1 +4 lines]");
		expect(text()).toContain(lines(5));
	});

	// Above Pi's own threshold the paste is Pi's to collapse; the affordance still
	// has to work, since that is where big pastes actually land.
	it("arms and expands a paste Pi collapsed itself", () => {
		const { editor, text } = makeEditor();
		editor.handlePaste.mockImplementation(collapseLikePi(editor));
		installPasteCollapse(editor, () => 11);

		editor.handlePaste(lines(20));
		expect(text()).toBe("[paste #1 +20 lines]");
		expect(pasteExpandHintText()).toBe(HINT);

		editor.handlePaste(lines(20));
		expect(text()).toBe(lines(20));
		expect(pasteExpandHintText()).toBeNull();
	});

	it("does not arm for a paste that stayed inline", () => {
		const { editor } = makeEditor();
		editor.handlePaste.mockImplementation(collapseLikePi(editor));
		installPasteCollapse(editor, () => 3);

		editor.handlePaste("one line");
		expect(pasteExpandHintText()).toBeNull();
	});

	// Pi renumbers paste ids when a marker is deleted, so the armed id can end up
	// pointing at somebody else's text. Expanding then would paste the wrong
	// content silently — the one outcome worth refusing.
	it("refuses to expand when the stored text no longer matches", () => {
		const { editor, inserted } = makeEditor();
		installPasteCollapse(editor, () => 3);

		editor.handlePaste(lines(4));
		editor.pastes.set(1, "something else entirely");

		editor.handlePaste(lines(4));
		expect(inserted).toEqual(["[paste #1 +4 lines]", "[paste #2 +4 lines]"]);
	});

	it("clears the hint when the marker is deleted from the editor", () => {
		const { editor } = makeEditor();
		installPasteCollapse(editor, () => 3);

		editor.handlePaste(lines(4));
		editor.state.lines = [""];
		expect(pasteExpandHintText()).toBeNull();
	});

	it("disarms on any non-paste input", () => {
		const { editor } = makeEditor();
		installPasteCollapse(editor, () => 3);

		editor.handlePaste(lines(4));
		editor.handleInput("x");
		expect(pasteExpandHintText()).toBeNull();
	});

	it("keeps the hint armed across the chunks of a bracketed paste", () => {
		const { editor } = makeEditor();
		installPasteCollapse(editor, () => 3);

		editor.handlePaste(lines(4));
		editor.isInPaste = true;
		editor.handleInput("chunk");
		expect(pasteExpandHintText()).toBe(HINT);
	});

	it("reports no hint once disposed", () => {
		const { editor } = makeEditor();
		const dispose = installPasteCollapse(editor, () => 3);

		editor.handlePaste(lines(4));
		dispose?.();
		expect(pasteExpandHintText()).toBeNull();
	});
});

// Another extension may hand us its own Proxy over the editor rather than the
// editor. `pi-better-background-tasks` does: its get trap answers `handleInput`
// with a wrapper built on the spot, and writes land on the editor behind. If we
// capture that wrapper and then shadow the property it dispatches through, the
// two call each other with nothing underneath and the first keystroke overflows
// the stack. These cover the capture going to the real handler either way.
describe("editor wrapped by another extension's Proxy", () => {
	type Proxied = ReturnType<typeof makeEditor>["editor"];

	/** The shape `pi-better-background-tasks` installs: get trap synthesises
	 *  `handleInput`, and everything else — writes included — goes to the target. */
	function proxyLikeNavigator(editor: Proxied, seen: string[]) {
		return new Proxy(editor, {
			get(target, prop, receiver) {
				if (prop === "handleInput") {
					return (data: string) => {
						seen.push(data);
						return target.handleInput?.call(target, data);
					};
				}
				const value = Reflect.get(target, prop, receiver);
				return typeof value === "function" ? value.bind(target) : value;
			},
		});
	}

	it("does not recurse when the handler is an instance property", () => {
		const { editor } = makeEditor();
		const original = editor.handleInput;
		const seen: string[] = [];
		const proxy = proxyLikeNavigator(editor, seen);

		const dispose = installPasteCollapse(proxy, () => 3);
		expect(dispose).toBeTypeOf("function");
		expect(() => proxy.handleInput?.("x")).not.toThrow();

		// One pass through each layer: the wrapper first, then the real handler.
		expect(seen).toEqual(["x"]);
		expect(original).toHaveBeenCalledTimes(1);
		dispose?.();
	});

	/** Pi's real layout: the handlers live on the prototype, so there is nothing
	 *  own for a shadow to find. */
	function makeProtoEditor() {
		const inputs: string[] = [];
		const pastes = new Map<number, string>();
		class ProtoEditor {
			pastes = pastes;
			pasteCounter = 0;
			isInPaste = false;
			state = { lines: [""], cursorLine: 0, cursorCol: 0 };
			handlePaste(text: string) {
				this.state.lines = [text];
			}
			handleInput(data: string) {
				inputs.push(data);
			}
			normalizeText(text: string) {
				return text;
			}
			insertTextAtCursorInternal(text: string) {
				this.state.lines = [text];
			}
		}
		return { editor: new ProtoEditor(), inputs };
	}

	// Pi keeps its handlers on the prototype, so this is the real layout: nothing
	// own to find, and the wrapper still gets its look at the keystroke.
	it("reaches a prototype handler underneath the Proxy", () => {
		const { editor, inputs } = makeProtoEditor();
		const seen: string[] = [];
		const proxy = proxyLikeNavigator(editor as unknown as Proxied, seen);

		const dispose = installPasteCollapse(proxy, () => 3);
		expect(dispose).toBeTypeOf("function");
		expect(() => proxy.handleInput?.("x")).not.toThrow();
		expect(() => proxy.handleInput?.("y")).not.toThrow();

		expect(inputs).toEqual(["x", "y"]);
		expect(seen).toEqual(["x", "y"]);
		dispose?.();
	});

	// Reading the shadow back through [[Get]] gets the navigation wrapper, so the
	// disposer used to decide its shadow was gone and leave it in place — one more
	// layer per /reload, each holding the editor it was written for.
	it("puts an instance handleInput back the way it found it", () => {
		const { editor } = makeEditor();
		const original = Object.getOwnPropertyDescriptor(editor, "handleInput");
		const proxy = proxyLikeNavigator(editor, []);

		const dispose = installPasteCollapse(proxy, () => 3);
		expect(Object.getOwnPropertyDescriptor(editor, "handleInput")?.value).not.toBe(original?.value);

		dispose?.();
		expect(Object.getOwnPropertyDescriptor(editor, "handleInput")).toEqual(original);
	});

	it("leaves no handleInput on the instance when the handler is a prototype one", () => {
		const { editor, inputs } = makeProtoEditor();
		const proxy = proxyLikeNavigator(editor as unknown as Proxied, []);

		const dispose = installPasteCollapse(proxy, () => 3);
		expect(Object.getOwnPropertyDescriptor(editor, "handleInput")).toBeDefined();

		dispose?.();
		expect(Object.getOwnPropertyDescriptor(editor, "handleInput")).toBeUndefined();

		// Nothing left underneath, so the next install covers the real handler and
		// not the previous shadow.
		const again = installPasteCollapse(proxy, () => 3);
		proxy.handleInput?.("x");
		expect(inputs).toEqual(["x"]);
		again?.();
		expect(Object.getOwnPropertyDescriptor(editor, "handleInput")).toBeUndefined();
	});

	// The paste path is patched the same way, so it has to survive the Proxy too.
	it("still collapses a paste arriving through the Proxy", () => {
		const { editor, inserted } = makeEditor();
		const proxy = proxyLikeNavigator(editor, []);

		installPasteCollapse(proxy, () => 3);
		proxy.handlePaste?.(lines(4));

		expect(inserted).toEqual(["[paste #1 +4 lines]"]);
		expect(editor.pastes.get(1)).toBe(lines(4));
	});
});
