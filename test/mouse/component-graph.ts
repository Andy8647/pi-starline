/**
 * A framed tool box built out of Pi's own components, for the clean-copy
 * tests that need the row ranges to be real.
 *
 * The early layout fixtures this suite was built on described a shape
 * production never produces: a `LayoutBox` per message component, nested
 * under the transcript's box. There is no such box — pi-tui only builds one
 * for a component carrying `LAYOUT_NODE`, and no message component has one —
 * which is why three rounds of green fixtures sat on top of behaviour that
 * did nothing. Hand-written rects cannot drift back into agreement with
 * reality; a real graph can only be wrong in ways the real thing is also
 * wrong in.
 *
 * `FramedToolComponent` is the one thing that has to be a stand-in, because
 * `pi-coding-agent` is not a dependency of this package. It is
 * `pi-toolbox`'s patched `ToolExecutionComponent.render` transcribed: a
 * `Container` subclass whose render opens with a blank spacer row and then
 * wraps its children's lines in `drawFrame`. That leading `""` is not
 * decoration — it is `const out: string[] = [""]` in `pi-toolbox/frame.ts`,
 * and it is why a frame's first *rendered* row is never the top rule.
 */

import { Container } from "@earendil-works/pi-tui";
import { drawToolboxFrame } from "./toolbox-frame";

/**
 * `pi-toolbox`'s framed tool box: a `Container` subclass rendering a blank
 * row and then its children inside a rounded frame. The children are rendered
 * two cells narrower, leaving room for the verticals, exactly as `frame.ts`
 * does (`source.render(w - 2)`).
 */
export class FramedToolComponent extends Container {
	override render(width: number): string[] {
		const content = super.render(width - 2);
		if (content.length === 0) return [];
		return ["", ...drawToolboxFrame(content, width)];
	}
}
