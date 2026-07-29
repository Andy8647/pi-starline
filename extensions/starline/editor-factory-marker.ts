/**
 * Marks the editor factory Starline installed, so a re-entrant install
 * recognises its own work instead of wrapping it a second time.
 *
 * Marks are written under BOTH `pi-starline.*` and the pre-rename
 * `pi-zentui.*` keys, and both are read back. Package load order is not
 * controlled by either side: pi-zentui loading first only needs the legacy
 * keys read, but pi-starline loading first (the alphabetically-first, and
 * therefore common, order) needs a pi-zentui reader loading second to still
 * find the mark under the legacy key it looks for. Writing only the new key
 * would leave that direction unprotected and a second, stacked editor
 * factory would get built.
 */

const EDITOR_FACTORY = Symbol.for("pi-starline.editor-factory");
const EDITOR_BASE_FACTORY = Symbol.for("pi-starline.editor-base-factory");
const LEGACY_EDITOR_FACTORY = Symbol.for("pi-zentui.editor-factory");
const LEGACY_EDITOR_BASE_FACTORY = Symbol.for("pi-zentui.editor-base-factory");

type Marked = Record<PropertyKey, unknown>;

function asMarked(factory: unknown): Marked | undefined {
	return typeof factory === "function" || (typeof factory === "object" && factory !== null)
		? (factory as Marked)
		: undefined;
}

export function markEditorFactory<T extends object>(factory: T, baseFactory?: object): T {
	const marked = factory as unknown as Marked;
	marked[EDITOR_FACTORY] = true;
	marked[LEGACY_EDITOR_FACTORY] = true;
	if (baseFactory) {
		marked[EDITOR_BASE_FACTORY] = baseFactory;
		marked[LEGACY_EDITOR_BASE_FACTORY] = baseFactory;
	}
	return factory;
}

export function isStarlineEditorFactory(factory: unknown): boolean {
	const marked = asMarked(factory);
	if (!marked) return false;
	return marked[EDITOR_FACTORY] === true || marked[LEGACY_EDITOR_FACTORY] === true;
}

export function getStarlineEditorBaseFactory<T>(factory: unknown): T | undefined {
	const marked = asMarked(factory);
	if (!marked) return undefined;
	return (marked[EDITOR_BASE_FACTORY] ?? marked[LEGACY_EDITOR_BASE_FACTORY]) as T | undefined;
}
