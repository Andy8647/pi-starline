import { describe, expect, it } from "vitest";
import { pillActionFor } from "../extensions/starline/pill-actions";

/**
 * `/starline <name>` lowercases its argument, so a camelCase segment key has to
 * answer to its lowercased spelling too — otherwise the keyboard half of a
 * clickable pill only works for names that happen to be one word.
 */
describe("pillActionFor", () => {
	it("finds a camelCase segment from the lowercased command argument", () => {
		expect(pillActionFor("gitPr")).toBeTypeOf("function");
		expect(pillActionFor("gitpr")).toBe(pillActionFor("gitPr"));
	});

	it("still leaves a label without an action alone", () => {
		expect(pillActionFor("gitcommit")).toBeUndefined();
		expect(pillActionFor("nonsense")).toBeUndefined();
	});

	it("answers for the counter that stands in for pills that did not fit", () => {
		// `overflow` is not a segment and never appears in `pill.segments`, so it has
		// to be answered before the segment lookup rather than through it.
		expect(pillActionFor("overflow")).toBeTypeOf("function");
	});
});
