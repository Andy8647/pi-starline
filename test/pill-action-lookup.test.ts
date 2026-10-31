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
});
