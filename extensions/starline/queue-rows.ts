/**
 * Hides Pi's own queued-message rows above the editor while the queue pill is
 * showing the same thing.
 *
 * Pi draws `Steering: …` / `Follow-up: …` plus a dequeue hint in
 * `pendingMessagesContainer`, rebuilt by `InteractiveMode.updatePendingMessagesDisplay`.
 * There is no switch for it, so the method is wrapped: when the queue pill is on,
 * the container is cleared instead of refilled, which leaves the layout row empty
 * rather than collapsing the layout from outside.
 *
 * Deliberately tied to the pill rather than a config key: the rows only disappear
 * when something else is already carrying that information. Remove `queue` from
 * `pill.segments` (or turn the status line off) and the rows come back on the next
 * queue update, with no restart.
 */

import { InteractiveMode } from "@earendil-works/pi-coding-agent";
import { installPrototypePatch } from "./prototype-patch-registry";

type PendingMessagesHost = {
	pendingMessagesContainer?: { clear?: () => void };
};

/**
 * Wrap the rebuild so it can be skipped. `isEnabled` is read on every queue
 * update, so a `/starline` change applies immediately.
 */
export function installNativeQueueRowHiding(isEnabled: () => boolean): () => void {
	try {
		return installPrototypePatch(
			InteractiveMode.prototype,
			"updatePendingMessagesDisplay",
			"pending-messages-hide",
			({ predecessor, receiver, args }) => {
				if (!isEnabled()) return Reflect.apply(predecessor, receiver, args);
				(receiver as PendingMessagesHost).pendingMessagesContainer?.clear?.();
				return undefined;
			},
		);
	} catch {
		return () => {};
	}
}
