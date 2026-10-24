import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { defaultConfig, loadConfig, saveFooterSegmentsPatch } from "../extensions/starline/config";
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

describe("footer segments are patchable for every key", () => {
	// The hand-written whitelists had drifted: these three were dropped from
	// config patching *and* missing from the menu, so `/starline` rows for them
	// did nothing at all.
	it("round-trips the three that the old whitelist lost", () => {
		for (const key of ["model", "thinking", "cacheHit"] as const) {
			const path = tempConfig("{}");
			saveFooterSegmentsPatch({ [key]: true }, path);
			const saved = JSON.parse(readFileSync(path, "utf8"));
			expect(saved.footerSegments).toEqual({ [key]: true });
		}
	});

	it("accepts every key in the defaults, so a new segment cannot be forgotten", () => {
		const path = tempConfig("{}");
		saveFooterSegmentsPatch(
			Object.fromEntries(Object.keys(defaultConfig.footerSegments).map((key) => [key, true])),
			path,
		);
		const saved = JSON.parse(readFileSync(path, "utf8"));
		expect(Object.keys(saved.footerSegments).sort()).toEqual(
			Object.keys(defaultConfig.footerSegments).sort(),
		);
	});
});

describe("a broken config file says so", () => {
	it("warns with the path and still returns defaults", () => {
		const path = tempConfig("{ not json");
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		const config = loadConfig(path);
		const messages = warn.mock.calls.map((call) => String(call[0])).join("\n");
		warn.mockRestore();

		expect(config.footerStyle).toBe(defaultConfig.footerStyle);
		expect(messages).toContain(path);
		expect(messages).toContain("using defaults");
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
