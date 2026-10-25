/**
 * Marks the editor factory Starline installed, so a re-entrant install
 * recognises its own work instead of wrapping it a second time.
 */

const EDITOR_FACTORY = Symbol.for("pi-starline.editor-factory");
const EDITOR_BASE_FACTORY = Symbol.for("pi-starline.editor-base-factory");

type Marked = Record<PropertyKey, unknown>;

function asMarked(factory: unknown): Marked | undefined {
	return typeof factory === "function" || (typeof factory === "object" && factory !== null)
		? (factory as Marked)
		: undefined;
}

export function markEditorFactory<T extends object>(factory: T, baseFactory?: object): T {
	const marked = factory as unknown as Marked;
	marked[EDITOR_FACTORY] = true;
	if (baseFactory) marked[EDITOR_BASE_FACTORY] = baseFactory;
	return factory;
}

export function isStarlineEditorFactory(factory: unknown): boolean {
	const marked = asMarked(factory);
	if (!marked) return false;
	return marked[EDITOR_FACTORY] === true;
}

export function getStarlineEditorBaseFactory<T>(factory: unknown): T | undefined {
	const marked = asMarked(factory);
	if (!marked) return undefined;
	return marked[EDITOR_BASE_FACTORY] as T | undefined;
}
