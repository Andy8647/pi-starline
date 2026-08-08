/**
 * Verifies Task 5's mouse patches against the REAL installed
 * `TuiAltScreen.prototype` — not a fake. `pi-tui-contract.test.ts` checks that
 * the methods Starline touches still exist with the right shape; this checks
 * that `installMouse`'s patches actually compose correctly with Pi's real
 * method bodies: the real `getSelectionColumns`/`copySelectionToClipboard`
 * column math, the real OSC 52 write, the real `handleViewportInput`
 * ctrl+c-falls-through behavior.
 *
 * Every test disposes its own install in an `afterEach` and asserts the
 * prototype is back to the exact function references it started with —
 * leaving a patched shared prototype behind would poison every test that
 * runs after this file.
 */
import { TuiAltScreen } from "@earendil-works/pi-tui";
import { afterEach, describe, expect, it } from "vitest";
import { activeSelectionHintText, installMouse } from "../../extensions/starline/mouse/index";

// `copySelectionToClipboard`/`handleViewportInput` are typed `private` in
// pi-tui's `.d.ts` even though they are plain functions on the prototype at
// runtime (TypeScript `private` is erased, not enforced) — the same fact
// `pi-tui-contract.test.ts` documents. This local view exposes them so the
// test can call and reassign them directly, the way Pi's own internals do.
type TuiAltScreenPrototype = {
	copySelectionToClipboard: () => void;
	handleViewportInput: (data: string) => { consume: boolean } | undefined;
	handleSelectionMouseEvent: (event: unknown) => void;
	getWordSelection: (point: unknown) => unknown;
};
const prototype = TuiAltScreen.prototype as unknown as TuiAltScreenPrototype;

const originalCopy = prototype.copySelectionToClipboard;
const originalViewportInput = prototype.handleViewportInput;
const originalMouseEvent = prototype.handleSelectionMouseEvent;
const originalWordSelection = prototype.getWordSelection;

type RealReceiver = {
	selectionAnchor: { row: number; col: number } | undefined;
	selectionFocus: { row: number; col: number } | undefined;
	previousScreen: string[];
	terminal: { write: (data: string) => void };
	flashes: { flash: (message: string) => void };
	copySelectionToClipboard: () => void;
	handleViewportInput: (data: string) => { consume: boolean } | undefined;
};

function makeReceiver(previousScreen: string[]): { instance: RealReceiver; written: string[] } {
	const written: string[] = [];
	const instance = Object.create(TuiAltScreen.prototype) as RealReceiver;
	instance.selectionAnchor = undefined;
	instance.selectionFocus = undefined;
	instance.previousScreen = previousScreen;
	instance.terminal = { write: (data: string) => written.push(data) };
	instance.flashes = { flash: () => {} };
	return { instance, written };
}

function decodeOsc52(data: string): string {
	const match = /\x1b\]52;c;([A-Za-z0-9+/=]*)\x07/.exec(data);
	return Buffer.from(match?.[1] ?? "", "base64").toString();
}

describe("mouse patches against the real TuiAltScreen.prototype", () => {
	let dispose: (() => void) | undefined;

	afterEach(() => {
		// try/finally so the restoration check still runs — and still reports
		// clearly — even if a test body throws before calling dispose, or if
		// dispose itself throws. A patch left on this shared prototype would
		// poison every test that runs after this file, invisibly, depending on
		// run order, so this assertion is not optional.
		try {
			dispose?.();
		} finally {
			dispose = undefined;
			expect(prototype.copySelectionToClipboard).toBe(originalCopy);
			expect(prototype.handleViewportInput).toBe(originalViewportInput);
			// Every method `installMouse` may touch, not only the two this file
			// exercises: the real prototype is shared with every other test file.
			expect(prototype.handleSelectionMouseEvent).toBe(originalMouseEvent);
			expect(prototype.getWordSelection).toBe(originalWordSelection);
		}
	});

	it("installs on the real prototype and restores it on dispose", () => {
		dispose = installMouse(prototype, {
			getConfig: () => ({ mouse: { copyOnSelect: false, copyNotice: true } }) as never,
			requestRender: () => {},
		});

		expect(prototype.copySelectionToClipboard).not.toBe(originalCopy);
		expect(prototype.handleViewportInput).not.toBe(originalViewportInput);
	});

	it("withholds the real copy on release, then performs it byte-exact on ctrl+c", () => {
		dispose = installMouse(prototype, {
			getConfig: () => ({ mouse: { copyOnSelect: false, copyNotice: true } }) as never,
			requestRender: () => {},
		});

		const { instance, written } = makeReceiver([
			"hello world   ", // trailing spaces must be trimmed, matching Pi's own .trimEnd()
			"second row here",
			"end",
		]);
		instance.selectionAnchor = { row: 0, col: 2 };
		instance.selectionFocus = { row: 2, col: 3 };

		instance.copySelectionToClipboard(); // release: armed, nothing written yet
		expect(written).toEqual([]);

		const expectedText = ["llo world", "second row here", "end"].join("\n");
		expect(activeSelectionHintText()).toBe(
			`${expectedText.length} characters selected, ctrl+c to copy`,
		);

		const result = instance.handleViewportInput("\x03");
		expect(result).toEqual({ consume: true });
		expect(written).toHaveLength(1);
		expect(decodeOsc52(written[0])).toBe(expectedText);
		expect(activeSelectionHintText()).toBeNull();
	});

	it("falls through to Pi's real ctrl+c handling when nothing is pending", () => {
		dispose = installMouse(prototype, {
			getConfig: () => ({ mouse: { copyOnSelect: false, copyNotice: true } }) as never,
			requestRender: () => {},
		});

		const { instance, written } = makeReceiver(["hello"]);
		// No selectionAnchor/selectionFocus set — getSelectionBounds() is undefined.

		const result = instance.handleViewportInput("\x03");

		// Pi's real handleViewportInput does not consume a bare ctrl+c — this is
		// what keeps interrupt working.
		expect(result).toBeUndefined();
		expect(written).toEqual([]);
	});
});
