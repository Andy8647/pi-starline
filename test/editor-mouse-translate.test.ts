import type { TuiMouseEvent } from "@earendil-works/pi-tui";
import { describe, expect, it } from "vitest";
import { translateEditorMouse } from "../extensions/starline/ui";

/**
 * Pi 1.4 positions the caret on click itself, counting rows from its own frame:
 * `y = 1` is the first text row and `x = 0` the box's left edge. Starline's frame
 * adds a rail column, optionally a padding row, and `editorMinRows` filler after a
 * short draft, so a raw press lands a row or a column off. These pin the
 * arithmetic that puts it back.
 */

const click = (x: number, y: number, width = 40): TuiMouseEvent => ({
	type: "click",
	button: "left",
	x,
	y,
	screenX: x,
	screenY: y,
	width,
	height: 12,
	shift: false,
	alt: false,
	ctrl: false,
});

const geometry = { railWidth: 2, padTop: 0, editorLineCount: 3 };

describe("translateEditorMouse", () => {
	it("drops the rail from the column and leaves the first text row at 1", () => {
		const translated = translateEditorMouse(click(6, 1), geometry);
		expect(translated).toMatchObject({ x: 4, y: 1, width: 38 });
	});

	it("subtracts the padding row the frame draws above the text", () => {
		const translated = translateEditorMouse(click(6, 2), { ...geometry, padTop: 1 });
		expect(translated).toMatchObject({ x: 4, y: 1 });
	});

	it("refuses the top rule, the row under the text and everything below it", () => {
		for (const y of [0, 4, 5, 9]) {
			expect(translateEditorMouse(click(6, y), geometry)).toBeUndefined();
		}
	});

	it("sends a click on a filler row to the end of the last text row", () => {
		const filled = { ...geometry, fillerRows: 2 };
		for (const y of [4, 5]) {
			expect(translateEditorMouse(click(6, y), filled)).toMatchObject({ x: 37, y: 3, width: 38 });
		}
		expect(translateEditorMouse(click(6, 6), filled)).toBeUndefined();
		expect(translateEditorMouse(click(6, 2), filled)).toMatchObject({ x: 4, y: 2 });
	});

	it("refuses the padding row itself", () => {
		expect(translateEditorMouse(click(6, 1), { ...geometry, padTop: 1 })).toBeUndefined();
	});

	it("refuses everything when the frame has not rendered yet", () => {
		expect(translateEditorMouse(click(6, 1), { ...geometry, editorLineCount: 0 })).toBeUndefined();
	});

	it("clamps the width so Pi never divides by a rail-only box", () => {
		expect(translateEditorMouse(click(0, 1, 1), geometry)?.width).toBe(1);
	});

	it("keeps the fields it does not own", () => {
		const translated = translateEditorMouse(
			{ ...click(6, 1), clickCount: 2, screenX: 6, screenY: 1 },
			geometry,
		);
		expect(translated).toMatchObject({ type: "click", button: "left", clickCount: 2, screenY: 1 });
	});
});
