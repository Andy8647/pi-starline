import { AgentSession } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	forgetLiveSession,
	installLiveSessionCapture,
	readPendingMessages,
} from "../extensions/starline/live-session";

/**
 * The capture wraps `AgentSession.prompt`, so the tests install it over a stub:
 * calling the wrapper then captures a fake session instead of running Pi's real
 * prompt. The original method is restored by `afterEach`.
 */
const prototype = AgentSession.prototype as unknown as { prompt: unknown };
const originalPrompt = prototype.prompt;

function stubPrompt() {
	prototype.prompt = vi.fn(async () => {});
}

afterEach(() => {
	prototype.prompt = originalPrompt;
	forgetLiveSession();
});

type PromptCall = (this: unknown, text: string) => Promise<void>;

describe("live session capture", () => {
	it("records the session that receives the prompt, then reads its queues", async () => {
		stubPrompt();
		const dispose = installLiveSessionCapture();
		try {
			const session = {
				getSteeringMessages: () => ["first", "second"],
				getFollowUpMessages: () => ["later"],
			};
			await (prototype.prompt as PromptCall).call(session, "hi");

			expect(readPendingMessages()).toEqual({
				steering: ["first", "second"],
				followUp: ["later"],
			});
		} finally {
			dispose();
		}
	});

	it("still forwards to the original prompt", async () => {
		const stub = vi.fn(async () => {});
		prototype.prompt = stub;
		const dispose = installLiveSessionCapture();
		try {
			await (prototype.prompt as PromptCall).call({}, "hi");
			expect(stub).toHaveBeenCalledTimes(1);
		} finally {
			dispose();
		}
	});

	it("ignores non-string entries and sessions without the getters", async () => {
		stubPrompt();
		const dispose = installLiveSessionCapture();
		try {
			await (prototype.prompt as PromptCall).call(
				{ getSteeringMessages: () => ["ok", 42], getFollowUpMessages: () => [] },
				"hi",
			);
			expect(readPendingMessages()).toEqual({ steering: ["ok"], followUp: [] });

			await (prototype.prompt as PromptCall).call({}, "hi");
			expect(readPendingMessages()).toBeUndefined();
		} finally {
			dispose();
		}
	});

	it("degrades when the getters throw", async () => {
		stubPrompt();
		const dispose = installLiveSessionCapture();
		try {
			await (prototype.prompt as PromptCall).call(
				{
					getSteeringMessages: () => {
						throw new Error("stale");
					},
					getFollowUpMessages: () => [],
				},
				"hi",
			);
			expect(readPendingMessages()).toBeUndefined();
		} finally {
			dispose();
		}
	});

	it("restores the prototype on dispose", () => {
		stubPrompt();
		const stubbed = prototype.prompt;
		const dispose = installLiveSessionCapture();
		expect(prototype.prompt).not.toBe(stubbed);
		dispose();
		expect(prototype.prompt).toBe(stubbed);
	});

	it("does nothing when the build has no prompt to wrap", () => {
		prototype.prompt = undefined;
		expect(() => installLiveSessionCapture()).not.toThrow();
		expect(readPendingMessages()).toBeUndefined();
	});
});
