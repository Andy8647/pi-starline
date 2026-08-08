/**
 * Asserts the shape of Pi that Starline patches, against the real installed
 * package rather than a fake. When Pi renames or freezes one of these, CI goes
 * red here — loudly, at build time — instead of a feature silently vanishing at
 * runtime on a user's machine.
 */
import { Editor, TuiAltScreen } from "@earendil-works/pi-tui";
import { describe, expect, it } from "vitest";

function descriptorInChain(target: object, name: string): PropertyDescriptor | undefined {
	let current: object | null = target;
	while (current) {
		const descriptor = Object.getOwnPropertyDescriptor(current, name);
		if (descriptor) return descriptor;
		current = Object.getPrototypeOf(current);
	}
	return undefined;
}

const PATCHED_METHODS = [
	"handleViewportInput",
	"routeWheel",
	"handleSelectionMouseEvent",
	"copySelectionToClipboard",
	"getWordSelection",
];

// Read, not patched — the selection itself stays Pi's, and `hasOverlay` is
// asked the same question Pi's own press path asks before it resolves a scroll
// view, so click-to-expand does not reach through a dialog.
const READ_METHODS = ["getSelectionBounds", "getSelectionColumns", "flash", "hasOverlay"];

const EDITOR_METHODS = [
	"getCursor",
	"moveCursor",
	"setCursorCol",
	"buildVisualLineMap",
	"findVisualLineAt",
	"moveToVisualLine",
	"getLines",
	"getText",
	"handleBackspace",
	"handleForwardDelete",
];

describe("TuiAltScreen contract", () => {
	it.each(PATCHED_METHODS)("exposes %s as a replaceable method", (name) => {
		const descriptor = descriptorInChain(TuiAltScreen.prototype, name);
		expect(descriptor, `TuiAltScreen.prototype.${name} is gone`).toBeDefined();
		expect(typeof descriptor?.value).toBe("function");
		expect(descriptor?.writable).toBe(true);
		expect(descriptor?.configurable).toBe(true);
	});

	it.each(READ_METHODS)("exposes %s for reading", (name) => {
		expect(typeof descriptorInChain(TuiAltScreen.prototype, name)?.value).toBe("function");
	});

	it("declares no #private fields, which reflection cannot reach", () => {
		expect(TuiAltScreen.toString()).not.toMatch(/this\.#/);
	});
});

describe("Editor contract", () => {
	it.each(EDITOR_METHODS)("exposes %s", (name) => {
		expect(typeof descriptorInChain(Editor.prototype, name)?.value).toBe("function");
	});

	it("declares no #private fields", () => {
		expect(Editor.toString()).not.toMatch(/this\.#/);
	});
});
