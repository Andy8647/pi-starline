import { describe, expect, it } from "vitest";
import { migrateFixedEditorKeys } from "../../extensions/starline/config";

describe("migrateFixedEditorKeys", () => {
	it("moves every old key to its new name, drops the old block, and ignores copyOnSelect", () => {
		// `copyOnSelect` was Starline's own select-without-copy toggle; Pi 0.84.4
		// owns that setting now (`fullscreenCopyOnSelect`), so the migration
		// deliberately drops it — migrating it to a config key that no longer
		// exists would silently re-enable auto-copy for users who turned it off.
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
			clickToExpandTools: false,
		});
	});

	it("does nothing when there is no old block", () => {
		const { config, migrated } = migrateFixedEditorKeys({ mouse: { enabled: false } });
		expect(migrated).toBe(false);
		expect(config.mouse).toEqual({ enabled: false });
	});

	it("lets an existing mouse key win over the old one it would migrate", () => {
		const { config } = migrateFixedEditorKeys({
			fixedEditor: { clickToExpandTools: false },
			mouse: { clickToExpandTools: true },
		});
		expect((config.mouse as Record<string, unknown>).clickToExpandTools).toBe(true);
	});

	it("ignores an unknown key inside the old block", () => {
		const { config } = migrateFixedEditorKeys({ fixedEditor: { somethingElse: 1 } });
		expect(config.mouse).toEqual({});
	});
});
