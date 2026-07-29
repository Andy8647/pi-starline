import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { defaultConfig } from "../extensions/starline/config";

const readme = readFileSync(join(process.cwd(), "README.md"), "utf8");
// The config reference lives in its own document; the README links to it and
// keeps only a short taste of the format.
const configDoc = readFileSync(join(process.cwd(), "docs/configuration.md"), "utf8");

const TABLE_HEADER = "| Key | Type | Default | What it does |";
const TABLE_END_MARKER = "User config lives at";

const tableStart = configDoc.indexOf(TABLE_HEADER);
const tableEnd = configDoc.indexOf(TABLE_END_MARKER, tableStart);
if (tableStart === -1 || tableEnd === -1) {
	throw new Error("Could not locate the config table in docs/configuration.md");
}
// Scoped to just the top-level config table, not the many other `| \`key\` |`
// tables further down (pill footer sub-keys, extension-status JSON, etc).
const configTable = configDoc.slice(tableStart, tableEnd);

const ROW_PATTERN = /^\|\s*`([^`]+)`\s*\|\s*([^|]+?)\s*\|\s*([^|]+?)\s*\|/;

const rows = new Map<string, { type: string; def: string }>();
for (const line of configTable.split("\n")) {
	const match = line.match(ROW_PATTERN);
	if (match) rows.set(match[1], { type: match[2], def: match[3] });
}

// Object-valued keys are documented in prose/JSON-block form rather than as a
// literal Default cell (e.g. `see [Pill footer](#pill-footer)`), so they are
// exempt from the value check below. This is the ONLY exemption; any key not
// in this set must have its literal default value verified.
const OBJECT_VALUED_KEYS = new Set(
	Object.entries(defaultConfig)
		.filter(([, value]) => typeof value === "object" && value !== null)
		.map(([key]) => key),
);

function formatExpectedDefaultCell(value: string | number | boolean): string {
	const inner = typeof value === "string" ? JSON.stringify(value) : String(value);
	return `\`${inner}\``;
}

describe("config reference", () => {
	it("is linked from the README, so splitting it out does not hide it", () => {
		expect(readme).toContain("docs/configuration.md");
	});

	it("has a row for every top-level config key", () => {
		const missing = Object.keys(defaultConfig).filter((key) => !rows.has(key));

		expect(missing).toEqual([]);
	});

	it("has no rows for keys that are not in defaultConfig", () => {
		const extra = [...rows.keys()].filter((key) => !(key in defaultConfig));

		expect(extra).toEqual([]);
	});

	it("scalar defaults in the table match defaultConfig", () => {
		const mismatches: string[] = [];

		for (const [key, value] of Object.entries(defaultConfig)) {
			if (OBJECT_VALUED_KEYS.has(key)) continue;
			const row = rows.get(key);
			if (!row) continue; // covered by the "has a row" test above

			const expected = formatExpectedDefaultCell(value as string | number | boolean);
			if (row.def !== expected) {
				mismatches.push(`${key}: table says ${row.def}, defaultConfig has ${expected}`);
			}
		}

		expect(mismatches).toEqual([]);
	});

	it("still credits the upstream project", () => {
		expect(readme).toContain("https://github.com/lmilojevicc/pi-zentui");
		expect(readme).toContain("Luka");
	});
});
