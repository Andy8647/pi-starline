import { AgentSession } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	cycleThinkingLevel,
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

	it("does nothing when a method it wraps is missing", () => {
		prototype.prompt = undefined;
		expect(() => installLiveSessionCapture()).not.toThrow();
		expect(readPendingMessages()).toBeUndefined();
		expect(cycleThinkingLevel()).toBeUndefined();
	});
});

describe("thinking cycle", () => {
	type ThinkingSession = {
		thinkingLevel: string;
		getAvailableThinkingLevels: () => string[];
		setThinkingLevel: ReturnType<typeof vi.fn>;
	};

	async function capture(session: ThinkingSession): Promise<() => void> {
		stubPrompt();
		const dispose = installLiveSessionCapture();
		await (prototype.prompt as PromptCall).call(session, "hi");
		return dispose;
	}

	it("steps forward and reports both ends", async () => {
		const session: ThinkingSession = {
			thinkingLevel: "high",
			getAvailableThinkingLevels: () => ["off", "minimal", "low", "medium", "high", "xhigh"],
			setThinkingLevel: vi.fn(),
		};
		const dispose = await capture(session);
		try {
			expect(cycleThinkingLevel()).toEqual({ from: "high", to: "xhigh" });
			expect(session.setThinkingLevel).toHaveBeenCalledWith("xhigh");
		} finally {
			dispose();
		}
	});

	it("wraps around without ever landing on off", async () => {
		const session: ThinkingSession = {
			thinkingLevel: "xhigh",
			getAvailableThinkingLevels: () => ["off", "minimal", "low", "medium", "high", "xhigh"],
			setThinkingLevel: vi.fn(),
		};
		const dispose = await capture(session);
		try {
			expect(cycleThinkingLevel()).toEqual({ from: "xhigh", to: "minimal" });
		} finally {
			dispose();
		}
	});

	it("starts at the first level when the current one is not listed", async () => {
		const session: ThinkingSession = {
			thinkingLevel: "odd",
			getAvailableThinkingLevels: () => ["off", "low", "high"],
			setThinkingLevel: vi.fn(),
		};
		const dispose = await capture(session);
		try {
			expect(cycleThinkingLevel()).toEqual({ from: "odd", to: "low" });
		} finally {
			dispose();
		}
	});

	it("stays inert without a session or without the setters", async () => {
		expect(cycleThinkingLevel()).toBeUndefined();

		const session = {
			thinkingLevel: "low",
			getAvailableThinkingLevels: () => ["low"],
		};
		const dispose = await capture(session as unknown as ThinkingSession);
		try {
			expect(cycleThinkingLevel()).toBeUndefined();
		} finally {
			dispose();
		}
	});

	it("returns undefined when the only available level is off", async () => {
		const session: ThinkingSession = {
			thinkingLevel: "off",
			getAvailableThinkingLevels: () => ["off"],
			setThinkingLevel: vi.fn(),
		};
		const dispose = await capture(session);
		try {
			expect(cycleThinkingLevel()).toBeUndefined();
		} finally {
			dispose();
		}
	});
});
