import { afterEach, describe, expect, it, vi } from "vitest";
import {
	installPillBubbleDismiss,
	isOutsideBubble,
} from "../../extensions/starline/mouse/bubble-dismiss";
import { installPointerShape } from "../../extensions/starline/mouse/pointer-shape";
import {
	activePillBubbleGeometry,
	closePillBubble,
	isPillBubbleOpenFor,
	type PillAnchor,
	type PillBubbleGeometry,
	showPillBubble,
} from "../../extensions/starline/pill-bubble";

const ROWS = 24;
const WIDTH = 80;

const BACKGROUND = "\x1b[48;2;249;226;175m";

const content = { title: "Queue", body: ["· first", "· second"], hint: "esc to close" };

function anchor(overrides: Partial<PillAnchor> = {}): PillAnchor {
	return {
		key: "queue",
		startColumn: 10,
		endColumn: 18,
		centerColumn: 14,
		terminalWidth: WIDTH,
		background: BACKGROUND,
		foreground: "",
		...overrides,
	};
}

type BubbleComponent = { render(width: number): string[] };

/** An overlay-only Pi UI: `custom` records what the bubble asked to mount. */
function fakeContext() {
	const custom = vi.fn().mockResolvedValue(undefined);
	return { custom, ctx: { hasUI: true, ui: { custom } } as never };
}

/** Mount the overlay the bubble asked for, and render it once so it records its rectangle. */
function mountBubble(custom: ReturnType<typeof vi.fn>): { done: ReturnType<typeof vi.fn> } {
	const [factory, options] = custom.mock.calls.at(-1) ?? [];
	const done = vi.fn();
	const component = (factory as (...args: unknown[]) => BubbleComponent)(
		{ requestRender() {} },
		{},
		{},
		done,
	);
	const width = (options as { overlayOptions: { width: number } }).overlayOptions.width;
	component.render(width);
	return { done };
}

/** The renderer stand-in: `handleMouseEvent` runs whatever Pi would dispatch. */
class FakeRenderer {
	terminal = { write: vi.fn(), rows: ROWS };
	under: () => void = () => {};
	handleMouseEvent(_raw: { button: number; x: number; y: number; release?: boolean }): void {
		this.under();
	}
}

/**
 * `button` is the SGR code: 0 is a left press, 32 a motion with the left button
 * held, 64 a wheel notch, and `release` ends a gesture.
 */
const pressAt = (x: number, y: number) => ({ button: 0, x, y, release: false });
const moveAt = (x: number, y: number) => ({ button: 35, x, y, release: false });

let disposable: (() => void)[] = [];
afterEach(() => {
	for (const dispose of disposable.reverse()) dispose();
	disposable = [];
	closePillBubble();
});

function setup() {
	const { ctx, custom } = fakeContext();
	const handle = showPillBubble(ctx, content, anchor());
	const bubble = mountBubble(custom);
	disposable.push(() => handle.close());

	const disposeShape = installPointerShape(FakeRenderer.prototype);
	if (!disposeShape) throw new Error("the fake renderer should be patchable");
	disposable.push(disposeShape);
	disposable.push(installPillBubbleDismiss());

	const renderer = new FakeRenderer();
	return { renderer, bubble, ctx, custom };
}

/** The bubble's own rows, resolved the way a click resolves them. */
function rows(geometry: PillBubbleGeometry) {
	const bottom = ROWS - 1 - geometry.bottomOffset;
	return { top: bottom - geometry.height + 1, bottom, left: geometry.leftColumn };
}

describe("isOutsideBubble", () => {
	const geometry: PillBubbleGeometry = {
		leftColumn: 10,
		width: 30,
		height: 5,
		bottomOffset: 1,
	};

	it("is true for a press anywhere outside the rectangle", () => {
		// Rows 18..22 are the bubble (24 rows, one for the footer).
		expect(isOutsideBubble(pressAt(10, 5), geometry, ROWS)).toBe(true);
		expect(isOutsideBubble(pressAt(10, 17), geometry, ROWS)).toBe(true);
		expect(isOutsideBubble(pressAt(5, 20), geometry, ROWS)).toBe(true);
		expect(isOutsideBubble(pressAt(40, 20), geometry, ROWS)).toBe(true);
	});

	it("is false for a press anywhere inside it, edges included", () => {
		expect(isOutsideBubble(pressAt(10, 18), geometry, ROWS)).toBe(false);
		expect(isOutsideBubble(pressAt(39, 22), geometry, ROWS)).toBe(false);
		expect(isOutsideBubble(pressAt(20, 20), geometry, ROWS)).toBe(false);
	});

	it("never fires from the footer row, which belongs to the pills", () => {
		expect(isOutsideBubble(pressAt(0, ROWS - 1), geometry, ROWS)).toBe(false);
		expect(isOutsideBubble(pressAt(79, ROWS - 1), geometry, ROWS)).toBe(false);
	});

	it("ignores everything that is not a press", () => {
		expect(isOutsideBubble(moveAt(0, 5), geometry, ROWS)).toBe(false);
		expect(isOutsideBubble({ button: 64, x: 0, y: 5, release: false }, geometry, ROWS)).toBe(false);
		expect(isOutsideBubble({ button: 0, x: 0, y: 5, release: true }, geometry, ROWS)).toBe(false);
		expect(isOutsideBubble({ button: 32, x: 0, y: 5, release: false }, geometry, ROWS)).toBe(false);
	});

	it("does nothing without a bubble or without a row count", () => {
		expect(isOutsideBubble(pressAt(0, 5), undefined, ROWS)).toBe(false);
		expect(isOutsideBubble(pressAt(0, 5), geometry, undefined)).toBe(false);
	});
});

describe("a click outside the open bubble", () => {
	it("records the rectangle the bubble drew", () => {
		setup();
		const geometry = activePillBubbleGeometry();
		expect(geometry).not.toBeUndefined();
		const rect = rows(geometry as PillBubbleGeometry);
		// Three columns of edge left of the pill's own columns, as the tab draws it.
		expect(rect.left).toBe(10 - 3);
		expect(rect.bottom).toBe(ROWS - 2);
		expect(rect.top).toBe(rect.bottom - (geometry as PillBubbleGeometry).height + 1);
	});

	it("closes it, and still gives the press to Pi", () => {
		const { renderer, bubble } = setup();
		const under = vi.fn();
		renderer.under = under;
		const geometry = activePillBubbleGeometry() as PillBubbleGeometry;
		const rect = rows(geometry);

		renderer.handleMouseEvent(pressAt(rect.left + 1, rect.top - 2));

		expect(bubble.done).toHaveBeenCalledTimes(1);
		expect(isPillBubbleOpenFor("queue")).toBe(false);
		expect(activePillBubbleGeometry()).toBeUndefined();
		// Not consumed: the editor still gets the click that dismissed the bubble.
		expect(under).toHaveBeenCalledTimes(1);
	});

	it("leaves the bubble open for a press inside it", () => {
		const { renderer, bubble } = setup();
		const geometry = activePillBubbleGeometry() as PillBubbleGeometry;
		const rect = rows(geometry);

		renderer.handleMouseEvent(pressAt(rect.left + 2, rect.bottom));

		expect(bubble.done).not.toHaveBeenCalled();
		expect(isPillBubbleOpenFor("queue")).toBe(true);
	});

	it("leaves it open for a press on the footer row, where the pills decide", () => {
		const { renderer, bubble } = setup();

		renderer.handleMouseEvent(pressAt(0, ROWS - 1));

		expect(bubble.done).not.toHaveBeenCalled();
		expect(isPillBubbleOpenFor("queue")).toBe(true);
	});

	it("leaves it open while the pointer merely moves", () => {
		const { renderer, bubble } = setup();

		renderer.handleMouseEvent(moveAt(0, 3));

		expect(bubble.done).not.toHaveBeenCalled();
		expect(isPillBubbleOpenFor("queue")).toBe(true);
	});

	it("survives a Pi without component mouse events", () => {
		closePillBubble();
		const dispose = installPillBubbleDismiss();
		expect(() => dispose()).not.toThrow();
		expect(installPointerShape({})).toBeUndefined();
	});
});
