/**
 * Asserts the shape of Pi that Starline patches, against the real installed
 * package rather than a fake. When Pi renames or freezes one of these, CI goes
 * red here — loudly, at build time — instead of a feature silently vanishing at
 * runtime on a user's machine.
 */
import { AgentSession, InteractiveMode } from "@earendil-works/pi-coding-agent";
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
	"copyActiveSelectionToClipboard",
	// The hover pointer watches where each move lands (mouse/pointer-shape.ts).
	"handleMouseEvent",
	// Cursor-marker dedupe during selection (mouse/cursor-marker.ts).
	"applySelection",
];

// Read, not patched — the selection itself stays Pi's, and `hasOverlay` is
// asked the same question Pi's own press path asks before it resolves a scroll
// view, so click-to-expand does not reach through a dialog. `getCopyOnSelect`
// and `hasActiveSelection` are read the same way: the hint is derived from
// them, never patched.
const READ_METHODS = [
	"getSelectionBounds",
	"getSelectionColumns",
	"getCopyOnSelect",
	"hasActiveSelection",
	"flash",
	"hasOverlay",
];

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

function expectReplaceable(target: object, owner: string, name: string): void {
	const descriptor = descriptorInChain(target, name);
	expect(descriptor, `${owner}.prototype.${name} is gone`).toBeDefined();
	expect(typeof descriptor?.value).toBe("function");
	expect(descriptor?.writable).toBe(true);
	expect(descriptor?.configurable).toBe(true);
}

/**
 * The coding-agent side the pills reach into. Wrapped: `prompt` and
 * `getContextUsage` record the live session (live-session.ts), and
 * `updatePendingMessagesDisplay` is what hides Pi's queue rows (queue-rows.ts).
 * Read: what the queue and thinking pills call on that session.
 */
describe("coding-agent contract", () => {
	it.each(["prompt", "getContextUsage"])(
		"AgentSession exposes %s as a replaceable method",
		(name) => {
			expectReplaceable(AgentSession.prototype, "AgentSession", name);
		},
	);

	it.each([
		"getSteeringMessages",
		"getFollowUpMessages",
		"getAvailableThinkingLevels",
		"setThinkingLevel",
	])("AgentSession exposes %s for the pills", (name) => {
		expect(typeof descriptorInChain(AgentSession.prototype, name)?.value).toBe("function");
	});

	it("InteractiveMode exposes updatePendingMessagesDisplay as a replaceable method", () => {
		expectReplaceable(InteractiveMode.prototype, "InteractiveMode", "updatePendingMessagesDisplay");
	});
});
