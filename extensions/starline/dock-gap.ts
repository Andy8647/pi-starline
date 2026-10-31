/**
 * Removes the blank row Pi keeps above the editor box.
 *
 * `InteractiveMode.renderWidgets` fills two widget slots through
 * `renderWidgetContainer`, and the above-editor one is called with
 * `spacerWhenEmpty`: when no extension put a widget there, the slot still gets a
 * `Spacer(1)`. That is Pi's own separator between the transcript and the input.
 * Starline draws the box itself, so the row is a gap between the box and
 * whatever is above it. There is no switch for it, so the method is wrapped: the
 * empty above-editor case clears the container and stops, while a slot that
 * really holds a widget (pi-subagents' fleet status, pi-processes' dock) and the
 * below-editor slot are left to Pi.
 *
 * The container is only rebuilt when a widget changes, and Pi fills it once at
 * startup, so installing has to ask for one rebuild — `setWidget(key, undefined)`
 * is the public way to trigger it. The way out does the same, which puts the row
 * back without a restart.
 */

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { InteractiveMode } from "@earendil-works/pi-coding-agent";
import { installPrototypePatch } from "./prototype-patch-registry";

type WidgetSlot = { clear?: () => void };

/** A key nothing else uses; only the removal, which rebuilds the slots, matters. */
const REBUILD_KEY = "starline-widget-slot-rebuild";

/**
 * Wrap the slot builder. `isEnabled` is read on every rebuild, so turning
 * `features.editor` off in `/starline` brings Pi's row back on the next widget
 * change.
 */
export function installAboveEditorGapHiding(isEnabled: () => boolean): () => void {
	try {
		return installPrototypePatch(
			InteractiveMode.prototype,
			"renderWidgetContainer",
			"above-editor-gap-hide",
			({ predecessor, receiver, args }) => {
				const [container, widgets, spacerWhenEmpty] = args as [
					WidgetSlot | undefined,
					Map<string, unknown> | undefined,
					boolean | undefined,
				];
				const aboveEditorIsEmpty =
					isEnabled() &&
					spacerWhenEmpty === true &&
					(widgets?.size ?? 0) === 0 &&
					typeof container?.clear === "function";
				if (!aboveEditorIsEmpty) return Reflect.apply(predecessor, receiver, args);
				container.clear?.();
				return undefined;
			},
		);
	} catch {
		return () => {};
	}
}

/** Rebuild the widget slots so a patch installed or removed just now takes effect. */
export function rebuildWidgetSlots(ctx: Pick<ExtensionContext, "ui">): void {
	try {
		ctx.ui.setWidget(REBUILD_KEY, undefined);
	} catch {
		// The slots keep what they had; the next widget change rebuilds them.
	}
}
