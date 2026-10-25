/**
 * Changes the mouse pointer while it is over something clickable.
 *
 * The terminal draws the pointer, and OSC 22 (`ESC ] 22 ; <shape> ST`, shape names
 * from CSS `cursor`) asks it for a different one; Ghostty and kitty support it, and
 * other terminals ignore it. Pi already forwards every pointer movement to the
 * component under it as a `move` event (any-motion tracking, off under tmux and
 * friends), so the footer knows when the pointer is on a pill.
 *
 * What it cannot know is when the pointer *leaves*: the next `move` goes to
 * whatever is under it now, and Pi has no leave event. So the shape is owned here,
 * around the renderer's own dispatch, not by any component. During each `move` a
 * component may call `requestPointerShape`; after the dispatch, a move that nobody
 * claimed puts the pointer back to `default`. Only a change is written, so moving
 * across a pill costs one escape sequence, not one per cell.
 *
 * This is a stand-in for an upstream API: a `pointer` field on the result a
 * component's `handleMouse` returns, with the renderer writing OSC 22 itself.
 * When Pi ships that, the callers return `{ pointer: "pointer" }` instead and this
 * file goes away.
 */

import { installPrototypePatch } from "../prototype-patch-registry";

/** CSS cursor names; `default` is the terminal's own arrow. */
export type PointerShape = "default" | "pointer" | "text";

type MouseEventRaw = { button?: unknown; release?: unknown };
type TerminalHost = { terminal?: { write?: (data: string) => void } };

/** SGR bit for "this report is motion", and the button code for "no button held". */
const MOTION_BIT = 32;
const NO_BUTTON = 3;

let dispatching = false;
let requested: PointerShape | undefined;
let current: PointerShape = "default";
let lastHost: TerminalHost | undefined;

/**
 * Ask for `shape` while the pointer stays where it is. Only meaningful while a
 * `move` is being dispatched; outside one it is ignored, so a click handler that
 * calls it by accident cannot leave the pointer stuck.
 */
export function requestPointerShape(shape: PointerShape): void {
	if (dispatching) requested = shape;
}

/** A pointer movement with no button held: what Pi turns into a `move` event. */
function isHover(raw: MouseEventRaw | undefined): boolean {
	if (!raw || raw.release === true || typeof raw.button !== "number") return false;
	return (raw.button & MOTION_BIT) !== 0 && (raw.button & 0b11) === NO_BUTTON;
}

function writeShape(host: TerminalHost | undefined, shape: PointerShape): void {
	try {
		host?.terminal?.write?.(`\x1b]22;${shape}\x1b\\`);
	} catch {
		// A terminal that cannot be written to keeps its pointer; nothing to undo.
	}
}

/** Put the pointer back if this module changed it. */
function resetPointer(): void {
	if (current !== "default") writeShape(lastHost, "default");
	current = "default";
	requested = undefined;
	lastHost = undefined;
}

/**
 * Wrap `TuiAltScreen.handleMouseEvent`, the one method every pointer report passes
 * through before Pi dispatches it. Returns undefined on a build without it — that
 * is a Pi without component mouse events, so there is nothing clickable to point
 * at either.
 */
export function installPointerShape(prototype: object): (() => void) | undefined {
	const target = prototype as Record<string, unknown>;
	if (typeof target.handleMouseEvent !== "function") return undefined;

	const onExit = () => resetPointer();
	let uninstall: () => void;
	try {
		uninstall = installPrototypePatch(
			prototype,
			"handleMouseEvent",
			"mouse-pointer-shape",
			({ predecessor, receiver, args }) => {
				if (!isHover(args[0] as MouseEventRaw | undefined)) {
					return Reflect.apply(predecessor, receiver, args);
				}
				dispatching = true;
				requested = undefined;
				try {
					return Reflect.apply(predecessor, receiver, args);
				} finally {
					dispatching = false;
					const next = requested ?? "default";
					requested = undefined;
					lastHost = receiver as TerminalHost;
					if (next !== current) {
						current = next;
						writeShape(lastHost, next);
					}
				}
			},
		);
	} catch {
		return undefined;
	}

	// Pi restores the terminal on exit but has never heard of this shape; without
	// the reset a hand left over a pill outlives the process.
	process.once("exit", onExit);
	return () => {
		process.removeListener("exit", onExit);
		resetPointer();
		uninstall();
	};
}
