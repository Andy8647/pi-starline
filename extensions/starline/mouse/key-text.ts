/**
 * The keys spelled the way Pi's on-screen hints spell them.
 *
 * The primary source is `pi-coding-agent`'s own exported `keyText` — literally
 * the function `keyHint` calls to build the hint text the UI shows, so there
 * is no second formatting rule to drift (it is `keyText` that turns `alt`
 * into `option` on macOS and joins alternatives with "/"), and no second
 * keybinding registry to disagree.
 *
 * That last point is not theoretical. `getKeybindings()` is a *singleton* per
 * copy of pi-tui, and a copy is per `node_modules` tree: in this repo
 * `pi-coding-agent` nests its own pi-tui, so the registry Starline's direct
 * import reaches is not the registry the hints are rendered from. Production
 * resolves both to Pi's own copy, but reading the value through the same
 * package that renders it makes the question moot instead of assumed.
 *
 * pi-tui's registry is kept as a fallback for the case where `keyText` yields
 * nothing. Both routes return "" when the binding is unbound, and callers
 * read "" as "show no key" rather than as a wildcard.
 */

import { keyText } from "@earendil-works/pi-coding-agent";
import { getKeybindings } from "@earendil-works/pi-tui";

/**
 * `keyText(keybinding)` with the registry fallback, shared by every feature
 * that quotes a key on screen. See the module header for why the primary
 * route is pi-coding-agent's own function rather than this repo's registry.
 */
export function keyTextFor(keybinding: string): string {
	try {
		const rendered = keyText(keybinding as never);
		if (typeof rendered === "string" && rendered.length > 0) return rendered;
	} catch {
		// A Pi build that has moved this function is one where quoting the key
		// simply shows nothing; it is never a reason to break a mouse feature.
	}
	return fallbackKeyText(keybinding);
}

/**
 * `keyText` re-derived from pi-tui's registry: keys joined with "/", `alt`
 * shown as `option` on macOS, matching `formatKeyText` in
 * `keybinding-hints.js`.
 */
function fallbackKeyText(keybinding: string): string {
	try {
		const bound: unknown = getKeybindings().getKeys(keybinding as never);
		if (!Array.isArray(bound) || bound.length === 0) return "";
		const keys = bound.filter((key): key is string => typeof key === "string");
		return keys
			.map((key: string) =>
				key
					.split("+")
					.map((part) =>
						process.platform === "darwin" && part.toLowerCase() === "alt" ? "option" : part,
					)
					.join("+"),
			)
			.join("/");
	} catch {
		return "";
	}
}
