import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { defaultConfig } from "../extensions/starline/config";

const readme = readFileSync(join(process.cwd(), "README.md"), "utf8");

describe("README config reference", () => {
	it("has a row for every top-level config key", () => {
		const missing = Object.keys(defaultConfig).filter((key) => !readme.includes(`| \`${key}\` |`));

		expect(missing).toEqual([]);
	});

	it("still credits the upstream project", () => {
		expect(readme).toContain("https://github.com/lmilojevicc/pi-zentui");
		expect(readme).toContain("Luka");
	});
});
