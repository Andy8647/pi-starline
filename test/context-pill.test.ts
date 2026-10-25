import { afterEach, describe, expect, it } from "vitest";
import { setActiveContextSnapshot } from "../extensions/starline/context-live";
import { contextBubbleContent, pillActionFor } from "../extensions/starline/pill-actions";

afterEach(() => setActiveContextSnapshot(undefined));

describe("context pill", () => {
	it("has an action, so the details are a click away", () => {
		expect(pillActionFor("context")).toBeTypeOf("function");
	});

	it("says nothing has been sent when there is no usage yet", () => {
		const content = contextBubbleContent();
		expect(content.title).toBe("Context");
		expect(content.body).toEqual(["Nothing has been sent yet."]);
	});

	it("spells out the window, the tokens used and the session totals", () => {
		setActiveContextSnapshot({
			percent: 41.4,
			contextWindow: 200_000,
			tokens: 82_800,
			tokenLabel: "↑250k ↓193k",
			cacheLabel: "󰆼 99.9%",
		});
		const content = contextBubbleContent();
		expect(content.title).toBe("41% context");
		expect(content.body).toEqual([
			"41% of 200k · 83k used",
			"session ↑250k ↓193k",
			"cache 󰆼 99.9%",
		]);
	});

	it("leaves out the cache line when nobody has read the prompt from cache", () => {
		setActiveContextSnapshot({
			percent: 4,
			contextWindow: 10_000,
			tokens: 400,
			tokenLabel: "↑4 ↓2",
			cacheLabel: "",
		});
		expect(contextBubbleContent().body).toEqual(["4% of 10k · 400 used", "session ↑4 ↓2"]);
	});

	it("falls back to the window size when the percentage is unknown", () => {
		setActiveContextSnapshot({ contextWindow: 200_000, tokenLabel: "" });
		const content = contextBubbleContent();
		expect(content.title).toBe("Context");
		expect(content.body).toEqual(["window 200k"]);
	});
});
