/**
 * The bridge other extensions use to make their pill clickable and to open the
 * same speech bubble Starline uses.
 *
 * Starline renders other extensions' pills from `ctx.ui.setStatus()`; this is the
 * other half: the owning extension says what a click means. A `pi-balance` pill
 * can open a bubble with its 5h/7d numbers, a `pi-subagents` pill can list its
 * runs, and neither has to render or position anything.
 *
 * The handshake is a global symbol rather than an import, for the same reason
 * `@xzzpig/pi-mouse-events` publishes one: an extension cannot depend on a
 * package Starline may be loaded twice from, and load order is not guaranteed.
 * Register from a `session_start` handler, which runs after every extension in the
 * process has been loaded; `/reload` re-runs it, so re-registering there is also
 * what keeps the bridge alive across a reload.
 *
 *     const api = globalThis[Symbol.for("pi-starline.pill-api.v1")];
 *     api?.register("pi-balance", ({ ctx, pill }) => {
 *       api.showBubble(ctx, { title: "Balance", body: ["5h: 42%", "7d: 12%"] }, pill);
 *     });
 *
 * The same action is reachable from the keyboard as `/starline <key>`. Types for
 * other extensions are in `types/pill-api.d.ts`; the guide is `docs/pill-api.md`.
 */

import type { PillApi, PillApiAction } from "../../types/pill-api";
import { showPillBubble } from "./pill-bubble";

export const PILL_API_SYMBOL = Symbol.for("pi-starline.pill-api.v1");

// The published shapes: `types/pill-api.d.ts` is what other extensions compile
// against, so it is also what this file implements.
export type {
	PillAnchor,
	PillApi,
	PillApiAction,
	PillApiContext,
	PillBubbleContent,
	PillBubbleHandle,
	PillBubbleLine,
	PillBubbleSource,
} from "../../types/pill-api";

/**
 * One action per key: a second registration replaces the first, which is what a
 * `/reload` of the owning extension does. The disposer only removes its own
 * action, so a stale handle cannot take a newer bridge down with it.
 */
const externalActions = new Map<string, PillApiAction>();

export function registerExternalPillAction(key: string, action: PillApiAction): () => void {
	const name = key.trim();
	if (!name) return () => {};
	externalActions.set(name, action);
	return () => {
		if (externalActions.get(name) === action) externalActions.delete(name);
	};
}

export function externalPillAction(key: string): PillApiAction | undefined {
	return externalActions.get(key);
}

/**
 * Publish the API on `globalThis`, replacing any earlier object.
 *
 * The newest Starline wins. This runs when the extension loads, which is before
 * any `session_start`, so bridges always register on the object published by the
 * Starline that is actually running. Keeping an older object instead would, after
 * a `/reload` that re-imports this module, leave bridges registering into the
 * previous module's registry while the new footer reads its own.
 */
export function publishPillApi(): void {
	const api: PillApi = {
		version: 1,
		register: registerExternalPillAction,
		showBubble: (ctx, content, pill) => showPillBubble(ctx, content, pill),
	};
	(globalThis as Record<PropertyKey, unknown>)[PILL_API_SYMBOL] = api;
}
