/**
 * The frame `pi-toolbox` actually draws, as a fixture.
 *
 * Not a stand-in shape: this is `drawFrame` from `pi-toolbox/frame.ts`,
 * transcribed —
 *
 * ```ts
 * function drawFrame(lines: string[], width: number, theme, color): string[] {
 * 	const inner = Math.max(2, width - 2);
 * 	const out: string[] = [bc(`╭${"─".repeat(inner)}╮`)];
 * 	for (const line of lines) {
 * 		out.push(`${bc("│")}${padToWidth(stripBackgroundFills(line), inner)}${bc("│")}`);
 * 	}
 * 	out.push(bc(`╰${"─".repeat(inner)}╯`));
 * 	return out;
 * }
 * ```
 *
 * — with the theme colouring dropped. It lives in its own module because
 * several test files need it and every one of them used square corners
 * instead, which is exactly how a rule-row glyph set with no `╭ ╮ ╰ ╯` in it
 * survived three review rounds while matching none of the frames that ship.
 */

/** `padToWidth` from `pi-toolbox/frame.ts`, for plain (unstyled) text. */
function padToWidth(line: string, width: number): string {
	return line.length < width ? line + " ".repeat(width - line.length) : line.slice(0, width);
}

/** `drawFrame`: a rounded frame `width` cells wide around `lines`. */
export function drawToolboxFrame(lines: readonly string[], width: number): string[] {
	const inner = Math.max(2, width - 2);
	const out = [`╭${"─".repeat(inner)}╮`];
	for (const line of lines) out.push(`│${padToWidth(line, inner)}│`);
	out.push(`╰${"─".repeat(inner)}╯`);
	return out;
}

/**
 * One framed body line, `inner + 2` cells wide. The extra leading space is
 * Pi's own shell padding, which lives inside the frame rather than being
 * drawn by it.
 */
export function toolboxFrame(body: string, inner = 8): string[] {
	return drawToolboxFrame([` ${body}`], inner + 2);
}
