/**
 * The status indicator Pi hands to the mounted editor.
 *
 * Pi draws a working / retry / compaction status in its own row above the editor
 * unless the editor opts in with `embedWorkingStatus`; opting in makes the
 * placement the editor's problem. Starline takes that deal so the plain
 * `working` spinner can ride in the model pill: same glyph slot, same display
 * width, no extra row and no pill bar reflow. The plain spinner also carries the
 * run's elapsed time in the pill, which is the one thing the spinner alone does
 * not say — and keeps the total there once the run is over.
 *
 * Everything that is not a plain spinner (retry, compaction, branch summary)
 * spells a sentence and carries an interrupt hint, which a pill cannot hold, so
 * those stay on the editor's top border in Pi's own layout.
 *
 * The reference is published by the editor and read by the footer, so it lives
 * here rather than in either of them.
 */

import { stripVTControlCharacters } from "node:util";
import { visibleWidth } from "@earendil-works/pi-tui";
import type { PolishedTuiConfig } from "./config";
import { buildElapsedLabel } from "./format";
import type { TurnTiming } from "./turn-clock";

/**
 * Structural twin of Pi's `StatusIndicator`, which the package does not export.
 *
 * Both render helpers are optional because they only exist on the Pi versions
 * that also support embedding. Without them the indicator renders nowhere and
 * Pi's own row stays the only one, which is the pre-embedding behaviour.
 */
export type WorkingIndicator = {
	/** "working" | "retry" | "compaction" | "branchSummary". */
	readonly kind?: string;
	renderInBorder?: (width: number) => string;
	renderSpinnerInBorder?: (width: number) => string;
};

let currentIndicator: WorkingIndicator | undefined;

export function setWorkingIndicator(indicator: WorkingIndicator | undefined): void {
	currentIndicator = indicator;
}

/**
 * The model pill exists when the status line is on and `pill.segments` asks for
 * it. When it does not, the spinner belongs on the editor's top border instead of
 * vanishing, so the editor asks exactly the question the footer answers.
 */
export function footerRendersModel(config: PolishedTuiConfig): boolean {
	return config.features.statusLine && config.pill.segments.includes("model");
}

/** A plain spinner, as opposed to a status that has to spell something out. */
function isSpinnerOnly(indicator: WorkingIndicator): boolean {
	return indicator.kind === undefined || indicator.kind === "working";
}

/**
 * Whether the pill should read as working, which is a wider question than
 * whether it has a frame: `setWorkingIndicator({ frames: [] })` keeps the run
 * going with the animation hidden, and the elapsed time is still true then.
 */
function isPlainSpinnerWorking(): boolean {
	const indicator = currentIndicator;
	return indicator !== undefined && isSpinnerOnly(indicator);
}

/**
 * Pi's default frames. Sparse on purpose: each frame inks a few dots, so the
 * spinner reads as a moving speck.
 */
const PI_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

/**
 * The pill's own frames: the same braille grid, but filled, so the ink covers the
 * whole cell instead of hugging one corner.
 *
 * Pi's sparse set is what makes the spinner look like it sits high above the
 * model name — the top-left dot lands near the pill's top edge while the pill's
 * text is optically centred. A filled frame has no such corner bias.
 */
const PILL_FRAMES = ["⣾", "⣽", "⣻", "⢿", "⡿", "⣟", "⣯", "⣷"];

/** `icons.mode: "ascii"` exists for terminals without a Nerd Font; braille is no safer. */
const ASCII_PILL_FRAMES = ["|", "/", "-", "\\"];

/**
 * Swap Pi's frame for the pill's, keeping Pi's cadence: the frame arrives from the
 * loader's own tick, so its index in Pi's set is the phase to reuse. Anything the
 * session customized is passed through untouched.
 */
function pillFrame(frame: string, frames: string[]): string {
	const index = PI_FRAMES.indexOf(frame);
	if (index < 0) return frame;
	const scaled = Math.floor((index * frames.length) / PI_FRAMES.length) % frames.length;
	return frames[scaled] ?? frame;
}

/** Long statuses still clip, but to what the border can hold rather than to nothing. */
function borderStatus(indicator: WorkingIndicator, width: number): string | undefined {
	try {
		const status = stripVTControlCharacters(
			indicator.renderInBorder?.(Math.max(1, width)) ?? "",
		).trim();
		return visibleWidth(status) > 0 ? status : undefined;
	} catch {
		return undefined;
	}
}

/**
 * The current spinner frame for the footer, or undefined when the pill should
 * keep its own icon: no indicator, not a plain spinner, a Pi build without the
 * render helper, or `setWorkingIndicator({ frames: [] })` hiding the animation.
 *
 * The frame arrives already coloured (Pi paints it with the editor's border
 * colour), so the colour is stripped here and the footer paints it like any
 * other segment text.
 */
export function readWorkingFrame(ascii = false): string | undefined {
	const indicator = currentIndicator;
	if (!indicator || !isSpinnerOnly(indicator)) return undefined;
	try {
		const frame = stripVTControlCharacters(indicator.renderSpinnerInBorder?.(1) ?? "");
		if (visibleWidth(frame) === 0) return undefined;
		return pillFrame(frame, ascii ? ASCII_PILL_FRAMES : PILL_FRAMES);
	} catch {
		return undefined;
	}
}

/**
 * What the editor's top border has to show, if anything: every status that is
 * not the pill's spinner, plus the spinner itself when there is no model pill to
 * put it in.
 */
export function workingStatusForBorder(
	config: PolishedTuiConfig,
	width: number,
): string | undefined {
	const indicator = currentIndicator;
	if (!indicator) return undefined;
	if (isSpinnerOnly(indicator) && footerRendersModel(config)) return undefined;
	return borderStatus(indicator, width);
}

/**
 * The model pill's icon slot while the agent works. The spinner takes the icon's
 * place at the icon's own display width, so the pill never resizes and the pill
 * bar never reflows. An icon-less pill gains the two cells the spinner needs; a
 * one-cell icon is swapped in place.
 */
export function modelPillIcon(icon: string, frame: string | undefined): string {
	if (!frame) return icon;
	const frameWidth = visibleWidth(frame);
	if (frameWidth === 0) return icon;
	return `${frame}${" ".repeat(Math.max(0, visibleWidth(icon) - frameWidth))}`;
}

/**
 * The model pill's whole label: icon slot, model name, and the run's elapsed
 * time — ticking while the agent works, frozen at the total once the run ends.
 *
 * The time sits after the name rather than before it because the spinner has
 * already taken the icon's slot: `⣾ claude 12s` reads as one sentence, while a
 * number between the spinner and the name reads as a second icon.
 *
 * Two reasons to keep it in the one pill rather than a segment of its own: a
 * segment that appears and disappears would slide the rest of the bar sideways
 * at the start and end of every turn, and "working" and "for how long" are the
 * same question. Whether the number is still counting is what the icon slot
 * says — a spinner there means live, the model's own icon means this is the last
 * run's total.
 */
export function modelPillLabel(
	icon: string,
	label: string,
	options: { ascii?: boolean; timing?: TurnTiming } = {},
): string {
	if (!label) return "";
	const iconSlot = modelPillIcon(icon, readWorkingFrame(options.ascii === true));
	const working = isPlainSpinnerWorking();
	const timing = options.timing ?? {};
	const elapsedMs = working ? timing.running : timing.last;
	const text = elapsedMs === undefined ? label : `${label} ${buildElapsedLabel(elapsedMs)}`;
	return iconSlot ? `${iconSlot} ${text}` : text;
}
