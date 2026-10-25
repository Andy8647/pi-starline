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
 * The same action is reachable from the keyboard as `/starline <key>`.
 */

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { type PillAnchor, type PillBubbleContent, showPillBubble } from "./pill-bubble";

export const PILL_API_SYMBOL = Symbol.for("pi-starline.pill-api.v1");

export type PillApiContext = {
	ctx: ExtensionContext;
	/** Geometry and colours of the pill that was clicked, when there was one. */
	pill?: PillAnchor;
	/**
	 * "click" from the pill, "command" from `/starline <key>`. A bubble's targets
	 * need a pointer, so an action that offers choices can do something direct
	 * from the command instead. Optional: hosts before it was added do not send it.
	 */
	via?: "click" | "command";
};

export type PillApiAction = (context: PillApiContext) => void;

export type PillApi = {
	version: 1;
	/** Make the pill published under `key` clickable. Returns an unregister handle. */
	register(key: string, action: PillApiAction): () => void;
	/** Open the standard bubble, pointed at `pill` when one is known. */
	showBubble(ctx: ExtensionContext, content: PillBubbleContent, pill?: PillAnchor): void;
};

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
 * Publish the API on `globalThis`. Idempotent: a second Starline instance (or a
 * reload that keeps the global) adopts the first object, so every bridge holds
 * the same registry.
 */
export function publishPillApi(): void {
	const host = globalThis as Record<PropertyKey, unknown>;
	const existing = host[PILL_API_SYMBOL] as PillApi | undefined;
	if (existing?.version === 1) return;
	const api: PillApi = {
		version: 1,
		register: registerExternalPillAction,
		showBubble: (ctx, content, pill) => showPillBubble(ctx, content, pill),
	};
	host[PILL_API_SYMBOL] = api;
}
