/**
 * The frame `pi-toolbox` actually draws, as a fixture.
 *
 * Not a stand-in shape: this is `drawFrame` from `pi-toolbox/frame.ts`,
 * transcribed —
 *
 * ```ts
 * const out: string[] = [bc(`╭${"─".repeat(inner)}╮`)];
 * out.push(`${bc("│")}${padToWidth(stripBackgroundFills(line), inner)}${bc("│")}`);
 * out.push(bc(`╰${"─".repeat(inner)}╯`));
 * ```
 *
 * — with the theme colouring dropped. It lives in its own module because three
 * test files need it and every one of them used square corners instead, which
 * is exactly how a rule-row glyph set with no `╭ ╮ ╰ ╯` in it survived three
 * review rounds while matching none of the frames that ship.
 */
export function toolboxFrame(body: string, inner = 8): string[] {
	return [`╭${"─".repeat(inner)}╮`, `│${` ${body}`.padEnd(inner)}│`, `╰${"─".repeat(inner)}╯`];
}
