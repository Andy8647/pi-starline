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
 * — with the theme colouring dropped, so `FramedToolComponent` in
 * `component-graph.ts` renders the shape that really ships rather than a
 * hand-typed approximation of it.
 */

import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

/** `padToWidth` from `pi-toolbox/frame.ts`. */
function padToWidth(line: string, width: number): string {
	const w = visibleWidth(line);
	if (w === width) return line;
	if (w < width) return line + " ".repeat(width - w);
	return truncateToWidth(line, width);
}

/** `drawFrame`: a rounded frame `width` cells wide around `lines`. */ export function drawToolboxFrame(
	lines: readonly string[],
	width: number,
): string[] {
	const inner = Math.max(2, width - 2);
	const out = [`╭${"─".repeat(inner)}╮`];
	for (const line of lines) out.push(`│${padToWidth(line, inner)}│`);
	out.push(`╰${"─".repeat(inner)}╯`);
	return out;
}
