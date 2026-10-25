/**
 * A second reader for pointer events, so more than one part of Starline can see
 * where a click landed without taking a second patch on the same method.
 *
 * The renderer's `handleMouseEvent` is the one method every pointer report goes
 * through before Pi dispatches it to a component or an overlay, and the patch
 * registry holds exactly one behaviour per adapter key (`mouse-pointer-shape`,
 * installed by `pointer-shape.ts`). Rather than register a second adapter on the
 * same method — which would silently replace the first — the patch publishes
 * every event here and whoever needs one subscribes.
 *
 * Observers run before the event is dispatched, so one can close a popover
 * before the click it belongs to reaches the thing underneath, and they never
 * consume anything: whatever the renderer does with the event afterwards is
 * unchanged.
 */

export type PointerEventRaw = {
	/** SGR button code: `button & 3` is the button, bit 32 motion, bit 64 wheel. */
	button: number;
	/** Column, 0-based, in screen cells. */
	x: number;
	/** Row, 0-based, from the top of the viewport. */
	y: number;
	/** The `m`/`M` terminator: true ends a gesture. */
	release?: boolean;
};

/** The renderer instance the event is being dispatched on. */
export type PointerReceiver = {
	terminal?: { rows?: number };
};

export type PointerObserver = (
	event: PointerEventRaw,
	receiver: PointerReceiver | undefined,
) => void;

const observers = new Set<PointerObserver>();

/** Watch every pointer report. Returns the disposer. */
export function observePointerEvents(observer: PointerObserver): () => void {
	observers.add(observer);
	return () => {
		observers.delete(observer);
	};
}

/**
 * Publish one event to the observers. Called by the `handleMouseEvent` patch
 * before it dispatches; one observer throwing must not swallow the event for
 * the others or for Pi.
 */
export function publishPointerEvent(
	event: PointerEventRaw,
	receiver: PointerReceiver | undefined,
): void {
	for (const observer of [...observers]) {
		try {
			observer(event, receiver);
		} catch {
			// Observers only observe; a broken one is not the event's problem.
		}
	}
}

/** True for a left-or-any-button press: not a release, not a drag, not a notch. */
export function isPointerPress(event: PointerEventRaw): boolean {
	if (event.release === true) return false;
	if (!Number.isFinite(event.button)) return false;
	// Bit 32 is motion (a drag when a button is held), bit 64 a wheel notch.
	return (event.button & 32) === 0 && (event.button & 64) === 0;
}
