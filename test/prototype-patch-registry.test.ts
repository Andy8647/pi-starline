import { describe, expect, it } from "vitest";
import { installPrototypePatch } from "../extensions/starline/prototype-patch-registry";

describe("patching an arbitrary method name", () => {
	it("wraps a method that is neither render nor invalidate", () => {
		const calls: string[] = [];
		const target = {
			handleViewportInput(data: string) {
				calls.push(`original:${data}`);
				return { consume: false };
			},
		};
		const original = target.handleViewportInput;

		const dispose = installPrototypePatch(
			target,
			"handleViewportInput",
			"mouse-viewport-input",
			({ predecessor, receiver, args }) => {
				calls.push(`patched:${args[0]}`);
				return Reflect.apply(predecessor, receiver, args);
			},
		);

		expect(target.handleViewportInput("\x03")).toEqual({ consume: false });
		expect(calls).toEqual(["patched:\x03", "original:\x03"]);

		dispose();
		expect(target.handleViewportInput).toBe(original);
	});

	it("restores the original when two mouse adapters are disposed out of order", () => {
		const target = {
			routeWheel() {
				return "wheel";
			},
			handleSelectionMouseEvent() {
				return "select";
			},
		};
		const originalWheel = target.routeWheel;
		const originalSelect = target.handleSelectionMouseEvent;

		const disposeWheel = installPrototypePatch(
			target,
			"routeWheel",
			"mouse-wheel",
			({ predecessor, receiver, args }) => Reflect.apply(predecessor, receiver, args),
		);
		const disposeSelect = installPrototypePatch(
			target,
			"handleSelectionMouseEvent",
			"mouse-selection-event",
			({ predecessor, receiver, args }) => Reflect.apply(predecessor, receiver, args),
		);

		disposeSelect();
		expect(target.handleSelectionMouseEvent).toBe(originalSelect);
		expect(target.routeWheel).not.toBe(originalWheel);

		disposeWheel();
		expect(target.routeWheel).toBe(originalWheel);
	});
});
