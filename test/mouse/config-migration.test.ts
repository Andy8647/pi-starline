import { describe, expect, it } from "vitest";
import { migrateFixedEditorKeys } from "../../extensions/starline/config";

describe("migrateFixedEditorKeys", () => {
	it("moves every old key to its new name and drops the old block", () => {
		const { config, migrated } = migrateFixedEditorKeys({
			fixedEditor: {
				enabled: true,
				mouseScroll: true,
				copyNotice: false,
				copyOnSelect: false,
				clickToExpandTools: false,
			},
		});
		expect(migrated).toBe(true);
		expect(config.fixedEditor).toBeUndefined();
		expect(config.mouse).toEqual({
			enabled: true,
			wheelRouting: true,
			copyNotice: false,
			copyOnSelect: false,
			clickToExpandTools: false,
		});
	});

	it("does nothing when there is no old block", () => {
		const { config, migrated } = migrateFixedEditorKeys({ mouse: { copyOnSelect: false } });
		expect(migrated).toBe(false);
		expect(config.mouse).toEqual({ copyOnSelect: false });
	});

	it("lets an existing mouse key win over the old one it would migrate", () => {
		const { config } = migrateFixedEditorKeys({
			fixedEditor: { copyOnSelect: false },
			mouse: { copyOnSelect: true },
		});
		expect((config.mouse as Record<string, unknown>).copyOnSelect).toBe(true);
	});

	it("ignores an unknown key inside the old block", () => {
		const { config } = migrateFixedEditorKeys({ fixedEditor: { somethingElse: 1 } });
		expect(config.mouse).toEqual({});
	});
});
