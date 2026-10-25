import { afterEach, describe, expect, it, vi } from "vitest";
import { defaultConfig } from "../extensions/starline/config";
import { pillActionFor, runPillAction } from "../extensions/starline/pill-actions";
import {
	PILL_API_SYMBOL,
	type PillApi,
	publishPillApi,
	registerExternalPillAction,
} from "../extensions/starline/pill-api";
import { registerStarlineSettingsCommand } from "../extensions/starline/settings-command";

const cleanups: Array<() => void> = [];

afterEach(() => {
	for (const cleanup of cleanups.splice(0)) cleanup();
	delete (globalThis as Record<PropertyKey, unknown>)[PILL_API_SYMBOL];
});

const anchor = {
	centerColumn: 20,
	terminalWidth: 80,
	background: "\x1b[48;5;3m",
	foreground: "",
};

describe("the published pill API", () => {
	it("is published once, under a versioned symbol", () => {
		publishPillApi();
		const api = (globalThis as Record<PropertyKey, unknown>)[PILL_API_SYMBOL] as PillApi;
		expect(api.version).toBe(1);
		expect(api.register).toBeTypeOf("function");
		expect(api.showBubble).toBeTypeOf("function");
	});

	it("keeps one registry per process", () => {
		publishPillApi();
		const first = (globalThis as Record<PropertyKey, unknown>)[PILL_API_SYMBOL];
		publishPillApi();
		expect((globalThis as Record<PropertyKey, unknown>)[PILL_API_SYMBOL]).toBe(first);
	});

	it("makes a status key clickable and hands over the pill", () => {
		const action = vi.fn();
		cleanups.push(registerExternalPillAction("pi-balance", action));

		const resolved = pillActionFor("pi-balance");
		expect(resolved).toBeTypeOf("function");
		runPillAction(resolved as never, { hasUI: false } as never, anchor);

		expect(action).toHaveBeenCalledWith({ ctx: { hasUI: false }, pill: anchor, via: "click" });
	});

	it("forgets an action when the bridge unregisters", () => {
		const unregister = registerExternalPillAction("pi-balance", vi.fn());
		expect(pillActionFor("pi-balance")).toBeTypeOf("function");
		unregister();
		expect(pillActionFor("pi-balance")).toBeUndefined();
	});

	it("does not let a stale handle remove a newer registration", () => {
		const first = vi.fn();
		const second = vi.fn();
		const unregisterFirst = registerExternalPillAction("pi-balance", first);
		cleanups.push(registerExternalPillAction("pi-balance", second));

		unregisterFirst();
		runPillAction(pillActionFor("pi-balance") as never, { hasUI: false } as never);

		expect(first).not.toHaveBeenCalled();
		expect(second).toHaveBeenCalledTimes(1);
	});

	it("lets Starline's own segments win over a bridge", () => {
		const bridged = vi.fn();
		cleanups.push(registerExternalPillAction("queue", bridged));
		const custom = vi.fn().mockResolvedValue(undefined);

		runPillAction(
			pillActionFor("queue") as never,
			{
				hasUI: true,
				hasPendingMessages: () => true,
				ui: { custom },
			} as never,
		);

		expect(bridged).not.toHaveBeenCalled();
		expect(custom).toHaveBeenCalledTimes(1);
	});

	it("ignores an empty key", () => {
		cleanups.push(registerExternalPillAction("   ", vi.fn()));
		expect(pillActionFor("")).toBeUndefined();
	});
});

describe("a bridged action from the keyboard", () => {
	it("is reachable as /starline <key>", async () => {
		const action = vi.fn();
		cleanups.push(registerExternalPillAction("pi-balance", action));

		let handler: ((args: string, ctx: unknown) => Promise<void>) | undefined;
		registerStarlineSettingsCommand(
			{
				registerCommand(_name: string, options: { handler: typeof handler }) {
					handler = options.handler;
				},
			} as never,
			{ getConfig: () => defaultConfig, requestRender() {} } as never,
		);

		const ctx = { hasUI: true, mode: "tui", ui: { custom: vi.fn() } };
		await handler?.("pi-balance", ctx);

		expect(action).toHaveBeenCalledTimes(1);
		expect(action.mock.calls[0]?.[0]).toMatchObject({ ctx });
	});
});
