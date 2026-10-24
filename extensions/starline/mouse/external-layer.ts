/**
 * Detection for an extension that already owns Pi's mouse layer.
 *
 * `@xzzpig/pi-mouse-events` patches the same `TuiAltScreen` methods Starline does
 * (wheel, press, copy) from one place and publishes an API object under a
 * process-global symbol so consumers do not have to import it — the way Pi loads
 * extensions makes a static import of a package that may not be installed a
 * problem, and `Symbol.for` is process-global by spec.
 *
 * Two layers patching the same prototype would both answer every notch, click and
 * copy: the wheel would move twice, the caret would move twice, the clipboard
 * would be written twice. Neither is wrong on its own, so the only safe answer is
 * for the later layer to stand down and say so.
 */

/** The key `@xzzpig/pi-mouse-events` publishes its API under, version-pinned. */
const MOUSE_EVENTS_API_KEY = Symbol.for("pi-mouse-events.api.v2");
const MOUSE_EVENTS_API_VERSION = 2;

export type ExternalMouseLayer = { name: string; version: number };

/**
 * The extension that owns the mouse layer in this process, if any.
 *
 * Read from the global the way that package's own consumers do, and checked for
 * the contract version: the symbol key pins the name, not the shape, so an object
 * from a different contract major is not something to hand events to.
 */
export function externalMouseLayer(
	scope: Record<PropertyKey, unknown> = globalThis,
): ExternalMouseLayer | undefined {
	try {
		const candidate = scope[MOUSE_EVENTS_API_KEY];
		if (typeof candidate !== "object" || candidate === null) return undefined;
		const version = (candidate as { version?: unknown }).version;
		return version === MOUSE_EVENTS_API_VERSION
			? { name: "@xzzpig/pi-mouse-events", version: MOUSE_EVENTS_API_VERSION }
			: undefined;
	} catch {
		return undefined;
	}
}
