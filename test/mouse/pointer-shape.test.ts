import { afterEach, describe, expect, it, vi } from "vitest";
import {
	installPointerShape,
	type PointerShape,
	requestPointerShape,
} from "../../extensions/starline/mouse/pointer-shape";

/**
 * The renderer stand-in: `handleMouseEvent` runs whatever the test says sits under
 * the pointer, the way Pi dispatches a `move` to the component at that cell.
 */
class FakeRenderer {
	terminal = { write: vi.fn() };
	under: () => void = () => {};
	handleMouseEvent(_raw: { button: number; x: number; y: number; release: boolean }): void {
		this.under();
	}
}

/** SGR codes: 35 is motion with no button, 32 motion with the left button, 0 a press. */
const hover = { button: 35, x: 1, y: 1, release: false };
const drag = { button: 32, x: 1, y: 1, release: false };
const press = { button: 0, x: 1, y: 1, release: false };

const osc = (shape: PointerShape) => `\x1b]22;${shape}\x1b\\`;

let dispose: (() => void) | undefined;
afterEach(() => {
	dispose?.();
	dispose = undefined;
});

function setup() {
	const prototype = FakeRenderer.prototype;
	dispose = installPointerShape(prototype);
	const renderer = new FakeRenderer();
	return { renderer, writes: () => renderer.terminal.write.mock.calls.map(([data]) => data) };
}

describe("pointer shape", () => {
	it("turns the pointer into a hand over a target, once, and back off it", () => {
		const { renderer, writes } = setup();
		renderer.under = () => requestPointerShape("pointer");
		renderer.handleMouseEvent(hover);
		renderer.handleMouseEvent(hover);
		expect(writes()).toEqual([osc("pointer")]);

		// Pi has no leave event: the next move simply lands somewhere that does not ask.
		renderer.under = () => {};
		renderer.handleMouseEvent(hover);
		renderer.handleMouseEvent(hover);
		expect(writes()).toEqual([osc("pointer"), osc("default")]);
	});

	it("writes nothing while the pointer moves over things that do not ask", () => {
		const { renderer, writes } = setup();
		renderer.handleMouseEvent(hover);
		expect(writes()).toEqual([]);
	});

	it("leaves the shape alone on presses and drags", () => {
		const { renderer, writes } = setup();
		renderer.under = () => requestPointerShape("pointer");
		renderer.handleMouseEvent(hover);
		renderer.under = () => {};
		renderer.handleMouseEvent(press);
		renderer.handleMouseEvent(drag);
		expect(writes()).toEqual([osc("pointer")]);
	});

	it("ignores a request made outside a move", () => {
		const { renderer, writes } = setup();
		requestPointerShape("pointer");
		renderer.handleMouseEvent(hover);
		expect(writes()).toEqual([]);
	});

	it("puts the pointer back and the method back when uninstalled", () => {
		const original = FakeRenderer.prototype.handleMouseEvent;
		const { renderer, writes } = setup();
		renderer.under = () => requestPointerShape("pointer");
		renderer.handleMouseEvent(hover);

		dispose?.();
		dispose = undefined;
		expect(writes()).toEqual([osc("pointer"), osc("default")]);
		expect(FakeRenderer.prototype.handleMouseEvent).toBe(original);
	});

	it("installs nothing on a renderer without component mouse events", () => {
		expect(installPointerShape({})).toBeUndefined();
	});

	it("survives a terminal that throws on write", () => {
		const { renderer } = setup();
		renderer.terminal.write.mockImplementation(() => {
			throw new Error("closed");
		});
		renderer.under = () => requestPointerShape("pointer");
		expect(() => renderer.handleMouseEvent(hover)).not.toThrow();
	});
});
