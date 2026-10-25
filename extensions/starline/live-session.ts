/**
 * The live `AgentSession`, for the two things the extension context does not
 * expose: the queued messages themselves, and the thinking-level switch.
 *
 * `ctx.hasPendingMessages()` is a boolean, but the data behind it is public on
 * `AgentSession` (`pendingMessageCount`, `getSteeringMessages()`,
 * `getFollowUpMessages()`), and so are the thinking-level getters and setters.
 * What is missing is a reference to the instance — the extension context carries
 * the session manager, not the session.
 *
 * So this captures the instance from any method the footer already reaches:
 * `getContextUsage()` runs on every render, and `prompt()` covers a queue that
 * existed before Starline loaded. Two wrappers, registered through the same
 * prototype-patch registry the mouse layer uses, gone the moment the session
 * ends. The upstream fix is a `pendingMessages` field on the extension context,
 * at which point this file can be deleted.
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
	getAvailableThinkingLevels?: () => unknown;
	setThinkingLevel?: (level: string) => unknown;
	readonly thinkingLevel?: string;
};

let liveSession: QueuedMessageSource | undefined;

/**
 * Record the receiver of a patched method. Two methods are wrapped because the
 * queue needs the session before the first prompt too, and the footer asks for
 * context usage on every render.
 */
function captureVia(
	method: "prompt" | "getContextUsage",
	adapter: "agent-session-capture-prompt" | "agent-session-capture-usage",
): () => void {
	try {
		return installPrototypePatch(
			AgentSession.prototype,
			method,
			adapter,
			({ predecessor, receiver, args }) => {
				liveSession = receiver as QueuedMessageSource;
				return Reflect.apply(predecessor, receiver, args);
			},
		);
	} catch {
		return () => {};
	}
}

/**
 * Wrap the two `AgentSession` methods that put the instance in hand. Returns a
 * disposer; a Pi build without them simply captures nothing and
 * `readPendingMessages()` stays undefined.
 */
export function installLiveSessionCapture(): () => void {
	const disposers = [
		captureVia("prompt", "agent-session-capture-prompt"),
		captureVia("getContextUsage", "agent-session-capture-usage"),
	];
	return () => {
		for (const dispose of disposers) dispose();
		forgetLiveSession();
	};
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

export type ThinkingCycle = { from: string; to: string };

export type ThinkingLevels = {
	/** Levels the model supports, in Pi's order, without "off". */
	levels: string[];
	/** The session's level now; "" when it does not say. */
	current: string;
};

/**
 * The levels the thinking pill can switch between.
 *
 * "off" is filtered out on purpose: the thinking pill only exists while thinking
 * is on, so a choice that removes its own pill would be a surprise and leave no
 * way back from the same place. Returns undefined when the session was never
 * seen, cannot set the level, or the model has nothing to choose from.
 */
export function readThinkingLevels(): ThinkingLevels | undefined {
	const session = liveSession;
	if (!session) return undefined;
	try {
		const readLevels = session.getAvailableThinkingLevels;
		if (typeof readLevels !== "function" || typeof session.setThinkingLevel !== "function") {
			return undefined;
		}
		const levels = readLevels.call(session);
		if (!Array.isArray(levels)) return undefined;
		const usable = levels.filter(
			(level): level is string => typeof level === "string" && level !== "off",
		);
		if (usable.length === 0) return undefined;
		const current = typeof session.thinkingLevel === "string" ? session.thinkingLevel : "";
		return { levels: usable, current };
	} catch {
		return undefined;
	}
}

/** Switch the live session to `level`. False when it could not be done. */
export function setThinkingLevel(level: string): boolean {
	const session = liveSession;
	const setLevel = session?.setThinkingLevel;
	if (!session || typeof setLevel !== "function") return false;
	try {
		setLevel.call(session, level);
		return true;
	} catch {
		return false;
	}
}

/**
 * Step to the next level `readThinkingLevels` offers, wrapping around. This is
 * the keyboard path; a click opens the list instead.
 */
export function cycleThinkingLevel(): ThinkingCycle | undefined {
	const read = readThinkingLevels();
	if (!read) return undefined;
	const index = read.levels.indexOf(read.current);
	const to = read.levels[(index + 1) % read.levels.length];
	if (!to || !setThinkingLevel(to)) return undefined;
	return { from: read.current || to, to };
}
