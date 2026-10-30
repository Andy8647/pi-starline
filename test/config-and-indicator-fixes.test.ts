import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { defaultConfig, loadConfig } from "../extensions/starline/config";
import { readWorkingFrame, setWorkingIndicator } from "../extensions/starline/working-indicator";

/**
 * Fixes for a batch of small, user-visible gaps: segments that could be set in
 * JSON but not from `/starline`, a config file that failed silently, and the pill
 * spinner ignoring `icons.mode: "ascii"`.
 */

function tempConfig(contents?: string): string {
	const dir = mkdtempSync(join(tmpdir(), "starline-config-"));
	const path = join(dir, "starline.json");
	if (contents !== undefined) writeFileSync(path, contents);
	return path;
}

describe("a broken config file says so", () => {
	it("warns with the path and still returns defaults", () => {
		const path = tempConfig("{ not json");
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		const config = loadConfig(path);
		const messages = warn.mock.calls.map((call) => String(call[0])).join("\n");
		warn.mockRestore();

		expect(config.pill.segments).toEqual(defaultConfig.pill.segments);
		expect(messages).toContain(path);
		expect(messages).toContain("using defaults");
	});
});

describe("user message settings that moved to pi-tidy", () => {
	it("are named in one warning per process, and the config still loads", () => {
		const path = tempConfig(
			JSON.stringify({
				userMessagePaddingY: 0,
				colors: { userMessageBorder: "accent", cwd: "bold red" },
				colorSources: { userMessages: "terminal" },
			}),
		);
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		const config = loadConfig(path);
		loadConfig(path);
		const calls = warn.mock.calls.map((call) => String(call[0]));
		warn.mockRestore();

		expect(config.colors.cwd).toBe("bold red");
		expect(calls).toHaveLength(1);
		expect(calls[0]).toContain("pi-tidy");
		expect(calls[0]).toContain(
			"userMessagePaddingY, colors.userMessageBorder, colorSources.userMessages",
		);
	});

	it("say nothing when none are set", () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		loadConfig(tempConfig(JSON.stringify({ editorPaddingY: 0 })));
		const count = warn.mock.calls.length;
		warn.mockRestore();
		expect(count).toBe(0);
	});
});

describe("the pill spinner follows icons.mode", () => {
	const frame = (ascii: boolean) => {
		setWorkingIndicator({
			kind: "working",
			renderSpinnerInBorder: () => "⠋",
		});
		return readWorkingFrame(ascii);
	};

	it("uses braille frames by default", () => {
		expect(frame(false)).toBe("⣾");
	});

	it("falls back to plain strokes in ascii mode", () => {
		const ascii = frame(true);
		expect(ascii).toBeDefined();
		expect([...(ascii ?? "")].every((char) => char.charCodeAt(0) < 128)).toBe(true);
	});

	it("still leaves customized frames alone", () => {
		setWorkingIndicator({ kind: "working", renderSpinnerInBorder: () => "◐" });
		expect(readWorkingFrame(true)).toBe("◐");
	});
});
