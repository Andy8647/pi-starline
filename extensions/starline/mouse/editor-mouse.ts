/**
 * Where the input box is on screen, and which live editor is in it.
 *
 * A wheel notch has to be routed before it can be acted on, and routing it
 * needs two facts Pi does not hand out: which component the draft belongs to,
 * and which rows on screen that component drew.
 *
 * ## Finding the editor's rectangle
 *
 * The plan for this feature assumed the editor is a direct child of a stack and
 * therefore carries its own `LayoutBox` — the one place in Pi's layout tree
 * where `boxFor` would finally have a production caller. It is not, and
 * `test/mouse/editor-wheel.test.ts` pins that against the real engine.
 * `interactive-mode.js` mounts the editor in a `Container` (`tui.js:39`) and
 * puts *the container* in the dock's `VStack`. `Container` carries no
 * `LAYOUT_NODE`, so `layoutComponent` folds it and everything inside it into a
 * single leaf box with `children: []` — exactly the finding
 * `test/contract/transcript-layout.test.ts` recorded for the transcript.
 * `boxFor(root, editor)` is therefore always `undefined`.
 *
 * What does work is the box one level up: the container's. Its rect is the
 * editor's rows, because the container renders nothing but its children and
 * holds exactly one. So the lookup here is still by identity — the identity of
 * the live editor instance inside `Container.children` — rather than by
 * position in the dock or by the shape of the rendered border. That
 * distinction matters: the container also holds Pi's extension selector, input
 * and alternate editor at various times (`interactive-mode.js:1918-2011`), and
 * while one of those is up the draft is not on screen at all. Asking whether
 * *this* editor is in there answers that for free.
 *
 * ## Finding the editor itself
 *
 * Nothing on Pi's renderer points at the editor: `TuiAltScreen` has no
 * reference to one, and the extension API exposes the *factory*
 * (`getEditorComponent`) rather than the instance it built. But Starline builds
 * the instance itself, in `index.ts`'s editor factory, so the extension is the
 * one thing in the process that already has it. It registers it here on the way
 * out of the factory.
 *
 * Two references are registered, not one, because the mounted component and the
 * scrollable editor are not always the same object. In the standalone path they
 * are (`PolishedEditor` extends Pi's `Editor`); in the wrapped path Starline
 * mounts a `WrappedPolishedEditor` that delegates by composition and exposes
 * none of `state`, `buildVisualLineMap` or `scrollOffset`. Hit-testing needs
 * the mounted one; scrolling needs the inner one.
 */

import { type BoxLike, boxesAt, boxMatching } from "./hit-test";

export type WheelTarget = "editor" | "transcript";

export type MountedEditor = {
	/** The component in the layout — what a screen rectangle belongs to. */
	component: unknown;
	/**
	 * The component that owns the draft's visual lines — what `editor-scroll.ts`
	 * reads. In the wrapped path this is somebody else's editor, which may not
	 * expose that surface at all; `scrollEditorBy` says so by returning false
	 * and the notch falls through to the transcript.
	 */
	scrollable: unknown;
};

/**
 * The editor Starline's factory built most recently, or undefined before the
 * first one is built and after the extension is torn down.
 *
 * A module-level register rather than an `installMouse` dependency: the mouse
 * patches live on Pi's *prototype* and outlive any one editor instance, while
 * the editor is rebuilt whenever `setCustomEditorComponent` runs. Threading it
 * through `installMouse` would mean re-installing every patch on every editor
 * rebuild. This mirrors `activeSelectionHintText`'s register in `index.ts`.
 */
let active: MountedEditor | undefined;

export function setActiveEditor(editor: MountedEditor | undefined): void {
	active = editor;
}

export function activeEditor(): MountedEditor | undefined {
	return active;
}

/** Whether `component` is a container the editor is currently mounted in. */
function hosts(component: unknown, editor: unknown): boolean {
	if (typeof component !== "object" || component === null) return false;
	const children = (component as { children?: unknown }).children;
	return Array.isArray(children) && children.includes(editor);
}

/**
 * The box covering the editor's rows: its own if Pi ever gives it one, else
 * the box of the container it is mounted in.
 *
 * The direct lookup is tried first and is not dead code waiting on a
 * hypothetical: a Pi build that gave the editor a `LAYOUT_NODE`, or an
 * embedding that put it straight into the dock stack, would produce exactly
 * that box, and it is the more specific of the two answers.
 */
export function editorBoxFor(root: BoxLike | undefined, editor: unknown): BoxLike | undefined {
	if (!root || editor === undefined || editor === null) return undefined;
	return (
		boxMatching(root, (component) => component === editor) ??
		boxMatching(root, (component) => hosts(component, editor))
	);
}

/**
 * Whether the input box is what is painted at `(x, y)`.
 *
 * The box has to be under the pointer *and* actually painted there, which is
 * why this asks `boxesAt` rather than testing the rectangle directly:
 * `boxesAt` walks down from the root honouring each box's `clip`, so a dock
 * squeezed out of the viewport cannot claim rows it is not drawing.
 *
 * Two features ask it — the wheel, for which notch belongs to the draft, and
 * click-to-caret, for which press does.
 */
export function pointerOverEditor(
	root: BoxLike | undefined,
	editor: unknown,
	x: number,
	y: number,
): boolean {
	if (!root) return false;
	const box = editorBoxFor(root, editor);
	if (!box) return false;
	return boxesAt(root, x, y).includes(box);
}

/**
 * Whether a wheel notch at `(x, y)` belongs to the input box or to the
 * transcript behind it.
 */
export function wheelTarget(
	root: BoxLike | undefined,
	editor: unknown,
	x: number,
	y: number,
): WheelTarget {
	return pointerOverEditor(root, editor, x, y) ? "editor" : "transcript";
}
