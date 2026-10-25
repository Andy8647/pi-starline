import { afterEach, describe, expect, it, vi } from "vitest";
import {
	type ModelChoice,
	modelChoices,
	modelPickerContent,
	pillActionFor,
	runPillAction,
	setModelSwitcher,
} from "../extensions/starline/pill-actions";
import { closePillBubble } from "../extensions/starline/pill-bubble";

const flash = { provider: "deepseek", id: "deepseek-flash" };
const k3 = { provider: "kimi-coding", id: "k3" };
const k3Long = { provider: "kimi-coding", id: "k3-256k" };

function context(overrides: Record<string, unknown> = {}) {
	const custom = vi.fn().mockResolvedValue(undefined);
	const notify = vi.fn();
	const ctx = {
		hasUI: true,
		model: flash,
		scopedModels: [{ model: flash }, { model: k3, thinkingLevel: "high" }, { model: k3Long }],
		modelRegistry: { getAvailable: () => [] },
		ui: { custom, notify },
		...overrides,
	};
	return { ctx: ctx as never, custom, notify };
}

type Line = string | { text: string; onSelect: () => void };

afterEach(() => {
	setModelSwitcher(undefined);
	closePillBubble();
});

describe("model choices", () => {
	it("offers the scoped models, with the thinking level a scope pins", () => {
		const { ctx } = context();
		const { choices, more } = modelChoices(ctx);
		expect(choices.map((choice) => choice.model.id)).toEqual(["deepseek-flash", "k3", "k3-256k"]);
		expect(choices[1]?.thinkingLevel).toBe("high");
		expect(more).toBe(0);
	});

	it("falls back to the available models, capped, keeping the current one", () => {
		const available = Array.from({ length: 12 }, (_, index) => ({
			provider: "p",
			id: `m${index}`,
		}));
		const { ctx } = context({
			scopedModels: [],
			modelRegistry: { getAvailable: () => available },
		});
		const { choices, more } = modelChoices(ctx);
		expect(choices[0]?.model).toBe(flash);
		expect(choices).toHaveLength(9);
		expect(more).toBe(4);
	});
});

describe("model picker", () => {
	it("marks the current model and switches on a click", async () => {
		const switcher = vi.fn(async (_choice: ModelChoice) => true);
		setModelSwitcher(switcher);
		const { ctx } = context();
		const content = modelPickerContent(ctx);
		const body = content.body as Line[];

		// The current model is a target too, marked so the bubble opens on it.
		expect(body[0]).toMatchObject({ text: "● deepseek-flash · deepseek", current: true });
		const k3Line = body[1] as Exclude<Line, string>;
		expect(k3Line.text).toBe("○ k3 · kimi-coding");
		k3Line.onSelect();
		await vi.waitFor(() => expect(switcher).toHaveBeenCalledTimes(1));
		expect(switcher.mock.calls[0]?.[0]).toEqual({ model: k3, thinkingLevel: "high" });
	});

	it("says so when the switch is refused", async () => {
		setModelSwitcher(async () => false);
		const { ctx, notify } = context();
		const k3Line = (modelPickerContent(ctx).body as Line[])[1] as Exclude<Line, string>;
		k3Line.onSelect();
		await vi.waitFor(() =>
			expect(notify).toHaveBeenCalledWith("Could not switch to k3 · kimi-coding", "error"),
		);
	});

	it("points at /model when it cannot switch from here", () => {
		const { ctx } = context();
		expect(modelPickerContent(ctx).body).toEqual([
			"Current model: deepseek-flash · deepseek.",
			"Use /model to pick one.",
		]);
	});

	it("opens on a click without switching", () => {
		const switcher = vi.fn(async () => true);
		setModelSwitcher(switcher);
		const { ctx, custom } = context();
		runPillAction(pillActionFor("model") as never, ctx);
		expect(custom).toHaveBeenCalledTimes(1);
		expect(switcher).not.toHaveBeenCalled();
	});

	it("steps to the next scoped model from the command, like ctrl+p", async () => {
		const switcher = vi.fn(async (_choice: ModelChoice) => true);
		setModelSwitcher(switcher);
		const { ctx, custom } = context();
		runPillAction(pillActionFor("model") as never, ctx, undefined, "command");
		await vi.waitFor(() => expect(custom).toHaveBeenCalledTimes(1));
		expect(switcher.mock.calls[0]?.[0]?.model).toBe(k3);
	});
});
