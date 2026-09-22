import { describe, expect, it } from "vitest";
import { migrateFixedEditorKeys } from "../../extensions/starline/config";

describe("migrateFixedEditorKeys", () => {
	it("moves every old key to its new name, and drops the old block and the keys Pi now owns", () => {
		// `copyOnSelect` was Starline's own select-without-copy toggle; Pi 0.84.4
		// owns that setting now (`fullscreenCopyOnSelect`), so the migration
		// deliberately drops it — migrating it to a config key that no longer
		// exists would silently re-enable auto-copy for users who turned it off.
		// `clickToExpandTools` is dropped the same way: Pi 0.86.0 toggles a tool
		// box on click natively, so the key no longer exists to migrate to.
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
		});
	});

	it("does nothing when there is no old block", () => {
		const { config, migrated } = migrateFixedEditorKeys({ mouse: { enabled: false } });
		expect(migrated).toBe(false);
		expect(config.mouse).toEqual({ enabled: false });
	});

	it("lets an existing mouse key win over the old one it would migrate", () => {
		const { config } = migrateFixedEditorKeys({
			fixedEditor: { copyNotice: false },
			mouse: { copyNotice: true },
		});
		expect((config.mouse as Record<string, unknown>).copyNotice).toBe(true);
	});

	it("ignores an unknown key inside the old block", () => {
		const { config } = migrateFixedEditorKeys({ fixedEditor: { somethingElse: 1 } });
		expect(config.mouse).toEqual({});
	});
});
