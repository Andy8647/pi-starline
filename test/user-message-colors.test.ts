import { describe, expect, it } from "vitest";
import { defaultConfig, mergeConfig } from "../extensions/starline/config";

describe("user message colours", () => {
	it("are unset by default, preserving upstream rendering", () => {
		expect(defaultConfig.colors.userMessageBorder).toBeUndefined();
		expect(defaultConfig.colors.userMessageText).toBeUndefined();
	});

	it("accept explicit values", () => {
		const config = mergeConfig({
			colors: { userMessageBorder: "#585b70", userMessageText: "#cdd6f4" },
		});
		expect(config.colors.userMessageBorder).toBe("#585b70");
		expect(config.colors.userMessageText).toBe("#cdd6f4");
	});

	it("accept theme keys, not just literals", () => {
		expect(
			mergeConfig({ colors: { userMessageBorder: "borderMuted" } }).colors.userMessageBorder,
		).toBe("borderMuted");
	});

	it("reject an unsupported spec", () => {
		expect(
			mergeConfig({ colors: { userMessageBorder: "chartreuse" } }).colors.userMessageBorder,
		).toBeUndefined();
	});

	it("resolve palette references", () => {
		const config = mergeConfig({
			palette: { surface: "#585b70" },
			colors: { userMessageBorder: "$surface" },
		});
		expect(config.colors.userMessageBorder).toBe("#585b70");
	});

	// The user message box borrowed the editor's border colour upstream. Setting
	// only editorBorder must keep doing that, so existing configs are unaffected.
	it("leave editorBorder as the fallback when only it is set", () => {
		const config = mergeConfig({ colors: { editorBorder: "#111111" } });
		expect(config.colors.editorBorder).toBe("#111111");
		expect(config.colors.userMessageBorder).toBeUndefined();
	});

	it("are independent of the editor colours once set", () => {
		const config = mergeConfig({
			colors: { editorBorder: "#111111", userMessageBorder: "#222222" },
		});
		expect(config.colors.editorBorder).toBe("#111111");
		expect(config.colors.userMessageBorder).toBe("#222222");
	});
});
