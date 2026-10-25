/**
 * The live `AgentSession`, for the one thing the extension context does not
 * expose: the queued messages themselves.
 *
 * `ctx.hasPendingMessages()` is a boolean, but the data behind it is public on
 * `AgentSession` (`pendingMessageCount`, `getSteeringMessages()`,
 * `getFollowUpMessages()`). What is missing is a reference to the instance — the
 * extension context carries the session manager, not the session.
 *
 * So this captures the instance at the one moment it is guaranteed to be in hand:
 * the user's own `prompt()` call. One wrapper, registered through the same
 * prototype-patch registry the mouse layer uses, gone the moment the session ends.
 * The upstream fix is a `pendingMessages` field on the extension context, at
 * which point this file can be deleted.
 */

import { AgentSession } from "@earendil-works/pi-coding-agent";
import { installPrototypePatch } from "./prototype-patch-registry";

export type PendingMessages = {
	steering: readonly string[];
	followUp: readonly string[];
};

type QueuedMessageSource = {
	getSteeringMessages?: () => unknown;
	getFollowUpMessages?: () => unknown;
};

let liveSession: QueuedMessageSource | undefined;

/**
 * Wrap `AgentSession.prompt` so the first prompt of a session records its
 * receiver. Returns a disposer; a Pi build without that method simply captures
 * nothing, and `readPendingMessages()` stays undefined.
 */
export function installLiveSessionCapture(): () => void {
	try {
		return installPrototypePatch(
			AgentSession.prototype,
			"prompt",
			"agent-session-capture",
			({ predecessor, receiver, args }) => {
				liveSession = receiver as QueuedMessageSource;
				return Reflect.apply(predecessor, receiver, args);
			},
		);
	} catch {
		return () => {};
	}
}

export function forgetLiveSession(): void {
	liveSession = undefined;
}

/**
 * What is queued right now: steering messages first, then follow-ups, the same
 * order Pi hands them to the agent. Undefined when the session was never seen or
 * this build does not expose the getters.
 */
export function readPendingMessages(): PendingMessages | undefined {
	const session = liveSession;
	if (!session) return undefined;
	try {
		const steering = session.getSteeringMessages?.();
		const followUp = session.getFollowUpMessages?.();
		if (!Array.isArray(steering) || !Array.isArray(followUp)) return undefined;
		return {
			steering: steering.filter((message): message is string => typeof message === "string"),
			followUp: followUp.filter((message): message is string => typeof message === "string"),
		};
	} catch {
		return undefined;
	}
}
