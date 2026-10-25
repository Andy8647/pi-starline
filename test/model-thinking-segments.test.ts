import { describe, expect, it } from "vitest";
import { defaultConfig, mergeConfig } from "../extensions/starline/config";
import { thinkingThemeKey } from "../extensions/starline/footer";

describe("thinkingThemeKey", () => {
	it("maps each level to its theme colour key", () => {
		expect(thinkingThemeKey("minimal")).toBe("thinkingMinimal");
		expect(thinkingThemeKey("low")).toBe("thinkingLow");
		expect(thinkingThemeKey("medium")).toBe("thinkingMedium");
		expect(thinkingThemeKey("high")).toBe("thinkingHigh");
		expect(thinkingThemeKey("xhigh")).toBe("thinkingXhigh");
	});

	it("is case-insensitive", () => {
		expect(thinkingThemeKey("HIGH")).toBe("thinkingHigh");
		expect(thinkingThemeKey("XHigh")).toBe("thinkingXhigh");
	});

	it("falls back to thinkingOff for off and for anything unrecognised", () => {
		expect(thinkingThemeKey("off")).toBe("thinkingOff");
		expect(thinkingThemeKey("")).toBe("thinkingOff");
		expect(thinkingThemeKey("turbo")).toBe("thinkingOff");
	});

	it("only names keys the style layer accepts as theme colours", () => {
		const keys = ["off", "minimal", "low", "medium", "high", "xhigh"].map(thinkingThemeKey);
		// Mirrors themeColorTokens in style.ts — a typo here would silently render
		// unstyled text instead of the level colour.
		expect(new Set(keys)).toEqual(
			new Set([
				"thinkingOff",
				"thinkingMinimal",
				"thinkingLow",
				"thinkingMedium",
				"thinkingHigh",
				"thinkingXhigh",
			]),
		);
	});
});

describe("model and thinking colours", () => {
	it("give the model segment a concrete default", () => {
		expect(defaultConfig.colors.model).toBe("bold blue");
	});

	it("leave the thinking colour unset so it derives from the level", () => {
		expect(defaultConfig.colors.thinking).toBeUndefined();
	});

	it("accept an explicit override", () => {
		const config = mergeConfig({ colors: { model: "#cba6f7", thinking: "bold syntaxKeyword" } });
		expect(config.colors.model).toBe("#cba6f7");
		expect(config.colors.thinking).toBe("bold syntaxKeyword");
	});

	it("reject an unsupported spec and keep the default", () => {
		expect(mergeConfig({ colors: { model: "chartreuse" } }).colors.model).toBe("bold blue");
		expect(mergeConfig({ colors: { thinking: "chartreuse" } }).colors.thinking).toBeUndefined();
	});

	it("resolve palette references like every other colour", () => {
		const config = mergeConfig({
			palette: { mauve: "#cba6f7" },
			colors: { model: "bold bg:$mauve" },
		});
		expect(config.colors.model).toBe("bold bg:#cba6f7");
	});
});
