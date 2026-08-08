import { describe, expect, it } from "vitest";
import { composeHints } from "../../extensions/starline/mouse/hint";

describe("composeHints", () => {
	it("returns null when neither hint is up", () => {
		expect(composeHints(null, null)).toBeNull();
	});

	it("returns the paste hint alone", () => {
		expect(composeHints("paste again to expand", null)).toBe("paste again to expand");
	});

	it("returns the selection hint alone", () => {
		expect(composeHints(null, "5 characters selected, ctrl+c to copy")).toBe(
			"5 characters selected, ctrl+c to copy",
		);
	});

	it("puts the paste hint first, separated by a dot", () => {
		// The order and separator 0.2.0's controller used, and its tests asserted.
		expect(composeHints("paste again to expand", "5 characters selected, ctrl+c to copy")).toBe(
			"paste again to expand ⋅ 5 characters selected, ctrl+c to copy",
		);
	});
});
