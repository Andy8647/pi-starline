/**
 * Types for Starline's pill API: make your extension's footer pill clickable and
 * open Starline's popover with your own content.
 *
 * The API is found on `globalThis`, not imported, so an extension can use it
 * without depending on Starline at runtime. Only these types are imported:
 *
 *     import type { PillApi } from "pi-starline/types/pill-api";
 *     const api = (globalThis as Record<symbol, unknown>)[
 *       Symbol.for("pi-starline.pill-api.v1")
 *     ] as PillApi | undefined;
 *
 * Guide and templates: docs/pill-api.md in the pi-starline repository.
 */

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

/**
 * Where a pill sits and how it is painted, as the footer last drew it. Pass it
 * through to `showBubble` untouched; its fields are Starline's to interpret.
 */
export type PillAnchor = {
	/** The pill's segment key; a click on the pill whose bubble is open closes it. */
	key?: string;
	/** First column painted in the pill's colour. */
	startColumn?: number;
	/** First column after the pill's colour, where its arrow or cap begins. */
	endColumn?: number;
	/** Column of the pill's centre on the footer line. */
	centerColumn: number;
	/** Width the footer was rendered at, which is the terminal width. */
	terminalWidth: number;
	/** Background SGR the pill was painted with. */
	background: string;
	/** Foreground SGR of the pill; "" derives a legible one from the background. */
	foreground: string;
};

/**
 * A body line. A plain string is information; an object with `onSelect` is a
 * target: it renders underlined, the pointer turns into a hand over it, and a
 * click closes the bubble and then runs the callback.
 */
export type PillBubbleLine = string | { text: string; onSelect: () => void };

export type PillBubbleContent = {
	/** Bold first line, optional. */
	title?: string;
	/** Body lines, wrapped to the bubble. */
	body: PillBubbleLine[];
	/** Muted last line, e.g. the key that dismisses it. */
	hint?: string;
};

/**
 * Content, or a function that returns it. A function is called again on every
 * `refresh()`, which is how a bubble shows numbers that change while it is open.
 */
export type PillBubbleSource = PillBubbleContent | (() => PillBubbleContent);

/** The open bubble. Returned by `showBubble` from Starline 0.4; older versions return nothing. */
export type PillBubbleHandle = {
	/**
	 * Read the content again (when it was given as a function) and redraw. The
	 * bubble widens if a line outgrew it; it never narrows while open. A no-op once
	 * the bubble is closed, so a timer that fires late is harmless.
	 */
	refresh(): void;
	/** Close the bubble. Safe to call more than once. */
	close(): void;
	/** Whether the bubble is still on screen. */
	isOpen(): boolean;
	/**
	 * Run `callback` once the bubble closes, however that happens: Escape, a
	 * second click on its pill, another bubble replacing it, or `close()`. Stop
	 * timers here. Runs at once if the bubble is already closed.
	 */
	onClose(callback: () => void): void;
};

export type PillApiContext = {
	ctx: ExtensionContext;
	/** The pill that was clicked, or the one the footer last drew for this key. */
	pill?: PillAnchor;
	/**
	 * "click" from the pill, "command" from `/starline <key>`. A bubble's targets
	 * need a pointer, so an action that offers choices can act directly from the
	 * command instead. Absent on Starline versions before it was added.
	 */
	via?: "click" | "command";
};

export type PillApiAction = (context: PillApiContext) => void | Promise<void>;

export type PillApi = {
	version: 1;
	/**
	 * Make the pill published under `key` (your `ctx.ui.setStatus` key) clickable.
	 * Register from `session_start`; a second registration for the same key
	 * replaces the first. Returns an unregister handle that only removes its own
	 * registration.
	 */
	register(key: string, action: PillApiAction): () => void;
	/** Open the standard bubble, attached to `pill` when one is known. */
	showBubble(
		ctx: ExtensionContext,
		content: PillBubbleSource,
		pill?: PillAnchor,
	): PillBubbleHandle | undefined;
};
