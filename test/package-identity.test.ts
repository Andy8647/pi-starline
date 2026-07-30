import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const pkg = JSON.parse(readFileSync(join(process.cwd(), "package.json"), "utf8"));

describe("package identity", () => {
	it("publishes as pi-starline under a plain semver version", () => {
		expect(pkg.name).toBe("pi-starline");
		// The publish workflow checks the tag against this field, so pinning an
		// exact version here would only mean editing two places per release.
		expect(pkg.version).toMatch(/^\d+\.\d+\.\d+$/);
	});

	it("points every url at this fork's repository", () => {
		const urls = [pkg.repository.url, pkg.homepage, pkg.bugs.url, pkg.pi.image];
		for (const url of urls) {
			expect(url).toContain("Andy8647/pi-starline");
			expect(url).not.toContain("lmilojevicc");
		}
	});

	it("ships only the extension sources", () => {
		expect(pkg.files).toEqual(["extensions"]);
	});

	it("keeps both copyright lines in the licence", () => {
		const licence = readFileSync(join(process.cwd(), "LICENSE"), "utf8");

		expect(licence).toContain("Copyright (c) 2025-2026 Luka");
		expect(licence).toContain("Copyright (c) 2026 Andy");
	});
});
