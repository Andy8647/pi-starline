import {
	chmodSync,
	existsSync,
	lstatSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	readlinkSync,
	rmSync,
	statSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { describe, expect, it } from "vitest";
import {
	configPath,
	DEFAULT_EDITOR_METADATA_FORMAT,
	defaultConfig,
	getExtensionStatusColorMode,
	isExtensionStatusColorMode,
	mergeConfig,
	saveColorSourcesPatch,
	saveContextStylePatch,
	saveContextThresholdsPatch,
	saveExtensionStatusColorMode,
	saveExtensionStatusPlacement,
	saveGitBranchPatch,
	saveMousePatch,
	savePathDisplayPatch,
	saveUiFeaturesPatch,
} from "../extensions/starline/config";
import {
	colorize,
	renderChromeBorder,
	renderStyle,
	renderStyleForSource,
	renderTerminalStyle,
} from "../extensions/starline/style";

function configTempFiles(dir: string, filename = "starline.json"): string[] {
	return readdirSync(dir).filter(
		(name) => name.startsWith(`.${filename}.`) && name.endsWith(".tmp"),
	);
}

describe("mergeConfig", () => {
	it("defaults project refresh polling to 30 seconds and Starship styles", () => {
		const config = mergeConfig({});
		expect(config.projectRefreshIntervalMs).toBe(30_000);
		expect(config.icons.cacheHit).toBe("󰆼");
		expect(config.icons.editorPrompt).toBe("");
		expect(config.colors.gitBranch).toBe("bold purple");
		expect(config.colors.packageVersion).toBe("208");
		expect(config.colors.gitCommit).toBe("bold green");
		expect(config.colors.gitMetricsAdded).toBe("bold green");
		expect(config.colors.gitMetricsDeleted).toBe("bold red");
		expect(config.colors.sessionName).toBe("bold green");
		expect(config.colors.contextNormal).toBe("bright-black");
		expect(config.colors.tokens).toBe("bright-black");
		expect(config.colors.extensionStatus).toBe("bright-black");
		expect(config.colors.editorAccent).toBeUndefined();
		expect(config.colors.editorPrompt).toBeUndefined();
		expect(config.colors.editorBorder).toBeUndefined();
		expect(config.colorSources).toEqual({
			starship: "theme",
			editor: "theme",
			userMessages: "theme",
		});
		expect(config.features).toEqual({
			editor: true,
			statusLine: true,
			copyFriendly: false,
		});
		expect(config.git).toEqual({
			counts: false,
			hostIcon: false,
			branch: { maxLength: "full" },
			commit: { hashLength: 7, onlyDetached: true, showTag: true },
			metrics: { onlyNonzero: true, ignoreSubmodules: false },
		});
		expect(config.extensionStatuses).toEqual({
			defaultPlacement: "right",
			placements: {},
			colorModes: {},
			colors: {},
			icons: {},
		});
	});

	it("defaults mouse features to enabled", () => {
		expect(mergeConfig({}).mouse).toEqual({
			enabled: true,
			wheelRouting: true,
			copyNotice: true,
			transcriptCleanCopy: true,
		});
		expect(defaultConfig.mouse).toEqual({
			enabled: true,
			wheelRouting: true,
			copyNotice: true,
			transcriptCleanCopy: true,
		});
	});

	it("accepts mouse config", () => {
		expect(mergeConfig({ mouse: { enabled: false, wheelRouting: false } }).mouse).toEqual({
			enabled: false,
			wheelRouting: false,
			copyNotice: true,
			transcriptCleanCopy: true,
		});
	});

	it("normalizes invalid mouse values", () => {
		expect(mergeConfig({ mouse: { enabled: "yes" } }).mouse).toEqual({
			enabled: true,
			wheelRouting: true,
			copyNotice: true,
			transcriptCleanCopy: true,
		});
	});

	it("defaults editorMetadataFormat and preserves non-empty strings", () => {
		expect(defaultConfig.editorMetadataFormat).toBe(DEFAULT_EDITOR_METADATA_FORMAT);
		for (const value of [undefined, null, 123, true]) {
			expect(mergeConfig({ editorMetadataFormat: value }).editorMetadataFormat).toBe(
				DEFAULT_EDITOR_METADATA_FORMAT,
			);
		}
		expect(mergeConfig({ editorMetadataFormat: "$model · $provider" }).editorMetadataFormat).toBe(
			"$model · $provider",
		);
		expect(mergeConfig({ editorMetadataFormat: "   " }).editorMetadataFormat).toBe("   ");
		// An explicit "" means "show nothing", so the model and thinking segments can
		// move to the footer without the editor still spelling them out.
		expect(mergeConfig({ editorMetadataFormat: "" }).editorMetadataFormat).toBe("");
	});

	it("accepts custom project refresh intervals and 0 to disable polling", () => {
		expect(mergeConfig({ projectRefreshIntervalMs: 60_000 }).projectRefreshIntervalMs).toBe(60_000);
		expect(mergeConfig({ projectRefreshIntervalMs: 0 }).projectRefreshIntervalMs).toBe(0);
	});

	it("clamps short project refresh intervals up to 5 seconds", () => {
		expect(mergeConfig({ projectRefreshIntervalMs: 100 }).projectRefreshIntervalMs).toBe(5_000);
		expect(mergeConfig({ projectRefreshIntervalMs: 4_999 }).projectRefreshIntervalMs).toBe(5_000);
		expect(mergeConfig({ projectRefreshIntervalMs: 5_000 }).projectRefreshIntervalMs).toBe(5_000);
	});

	it("ignores invalid project refresh intervals", () => {
		expect(mergeConfig({ projectRefreshIntervalMs: "30000" }).projectRefreshIntervalMs).toBe(
			30_000,
		);
		expect(
			mergeConfig({ projectRefreshIntervalMs: Number.POSITIVE_INFINITY }).projectRefreshIntervalMs,
		).toBe(30_000);
	});

	it("refuses corrupt config without changing its bytes", () => {
		const dir = mkdtempSync(join(tmpdir(), "starline-config-"));
		const path = join(dir, "starline.json");
		const original = "{ invalid json\n";
		try {
			writeFileSync(path, original);

			expect(() => saveContextStylePatch("gauge", path)).toThrow(
				/Refusing to save Starline config.*corrupt/,
			);
			expect(readFileSync(path, "utf8")).toBe(original);
			expect(configTempFiles(dir)).toEqual([]);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("creates missing config atomically and returns the config written to disk", () => {
		const dir = mkdtempSync(join(tmpdir(), "starline-config-"));
		const path = join(dir, "starline.json");
		try {
			expect(existsSync(path)).toBe(false);
			const config = saveContextStylePatch("gauge", path);
			const raw = JSON.parse(readFileSync(path, "utf8"));

			expect(raw).toEqual({ contextStyle: "gauge" });
			expect(config).toEqual(mergeConfig(raw));
			expect(configTempFiles(dir)).toEqual([]);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("preserves the existing destination mode during atomic replacement", () => {
		const dir = mkdtempSync(join(tmpdir(), "starline-config-"));
		const path = join(dir, "starline.json");
		try {
			writeFileSync(path, `${JSON.stringify({ contextStyle: "text" }, null, 2)}\n`);
			chmodSync(path, 0o600);

			saveContextStylePatch("gauge", path);

			expect(statSync(path).mode & 0o777).toBe(0o600);
			expect(JSON.parse(readFileSync(path, "utf8")).contextStyle).toBe("gauge");
			expect(configTempFiles(dir)).toEqual([]);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("updates a symlink target atomically without replacing the symlink", () => {
		const dir = mkdtempSync(join(tmpdir(), "starline-config-"));
		const targetDir = join(dir, "target");
		const targetPath = join(targetDir, "actual.json");
		const linkPath = join(dir, "starline.json");
		try {
			mkdirSync(targetDir);
			writeFileSync(targetPath, `${JSON.stringify({ unknown: true }, null, 2)}\n`);
			chmodSync(targetPath, 0o600);
			symlinkSync(targetPath, linkPath);
			const originalLink = readlinkSync(linkPath);

			const config = saveContextStylePatch("gauge", linkPath);
			const raw = JSON.parse(readFileSync(targetPath, "utf8"));

			expect(lstatSync(linkPath).isSymbolicLink()).toBe(true);
			expect(readlinkSync(linkPath)).toBe(originalLink);
			expect(raw).toEqual({ unknown: true, contextStyle: "gauge" });
			expect(config).toEqual(mergeConfig(raw));
			expect(statSync(targetPath).mode & 0o777).toBe(0o600);
			expect(configTempFiles(targetDir, "actual.json")).toEqual([]);
			expect(configTempFiles(dir)).toEqual([]);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("refuses a dangling symlink without changing it", () => {
		const dir = mkdtempSync(join(tmpdir(), "starline-config-"));
		const targetDir = join(dir, "target");
		const missingTarget = join(targetDir, "missing.json");
		const linkPath = join(dir, "starline.json");
		try {
			mkdirSync(targetDir);
			symlinkSync(missingTarget, linkPath);
			const originalLink = readlinkSync(linkPath);

			expect(() => saveContextStylePatch("gauge", linkPath)).toThrow(
				/Refusing to save Starline config/,
			);
			expect(lstatSync(linkPath).isSymbolicLink()).toBe(true);
			expect(readlinkSync(linkPath)).toBe(originalLink);
			expect(existsSync(missingTarget)).toBe(false);
			expect(configTempFiles(targetDir, "missing.json")).toEqual([]);
			expect(configTempFiles(dir)).toEqual([]);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("preserves scalar and nested unknown keys through the shared mutation path", () => {
		const dir = mkdtempSync(join(tmpdir(), "starline-config-"));
		const path = join(dir, "starline.json");
		try {
			writeFileSync(
				path,
				`${JSON.stringify(
					{
						futureScalar: "keep",
						pathDisplay: { mode: "basename", depth: 2, futureNested: { keep: true } },
					},
					null,
					2,
				)}\n`,
			);

			saveContextStylePatch("gauge", path);
			const config = savePathDisplayPatch({ mode: "full" }, path);
			const raw = JSON.parse(readFileSync(path, "utf8"));

			expect(raw.futureScalar).toBe("keep");
			expect(raw.contextStyle).toBe("gauge");
			expect(raw.pathDisplay).toEqual({
				mode: "full",
				depth: 2,
				futureNested: { keep: true },
			});
			expect(config).toEqual(mergeConfig(raw));
			expect(configTempFiles(dir)).toEqual([]);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("keeps the destination and removes the temp file when serialization fails", () => {
		const dir = mkdtempSync(join(tmpdir(), "starline-config-"));
		const path = join(dir, "starline.json");
		const original = `${JSON.stringify({ unknown: true }, null, 2)}\n`;
		try {
			writeFileSync(path, original);

			expect(() => saveContextThresholdsPatch({ warning: 1n as never }, path)).toThrow();
			expect(readFileSync(path, "utf8")).toBe(original);
			expect(configTempFiles(dir)).toEqual([]);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("defaults context style/thresholds and accepts valid overrides", () => {
		expect(mergeConfig({}).contextStyle).toBe("text");
		expect(mergeConfig({}).contextThresholds).toEqual({ warning: 70, error: 90 });
		expect(mergeConfig({ contextStyle: "gauge" }).contextStyle).toBe("gauge");
		expect(mergeConfig({ contextStyle: "text+gauge" }).contextStyle).toBe("text+gauge");
		expect(mergeConfig({ contextStyle: "bars" }).contextStyle).toBe("text");
		expect(
			mergeConfig({ contextThresholds: { warning: 50, error: 80 } }).contextThresholds,
		).toEqual({ warning: 50, error: 80 });
		expect(
			mergeConfig({ contextThresholds: { warning: 90, error: 70 } }).contextThresholds,
		).toEqual({ warning: 70, error: 90 });
	});

	it("defaults editorModelLabel to id and accepts valid overrides", () => {
		expect(mergeConfig({}).editorModelLabel).toBe("id");
		expect(mergeConfig({ editorModelLabel: "name" }).editorModelLabel).toBe("name");
		expect(mergeConfig({ editorModelLabel: "id" }).editorModelLabel).toBe("id");
		expect(mergeConfig({ editorModelLabel: "title" }).editorModelLabel).toBe("id");
	});

	it("defaults pathDisplay and accepts mode/depth overrides", () => {
		expect(mergeConfig({}).pathDisplay).toEqual({ mode: "basename", depth: 0 });
		expect(mergeConfig({ pathDisplay: { mode: "full" } }).pathDisplay).toEqual({
			mode: "full",
			depth: 0,
		});
		expect(mergeConfig({ pathDisplay: { mode: "full", depth: 3 } }).pathDisplay).toEqual({
			mode: "full",
			depth: 3,
		});
		expect(mergeConfig({ pathDisplay: { mode: "fish", depth: -3 } }).pathDisplay).toEqual({
			mode: "basename",
			depth: 0,
		});
		expect(mergeConfig({ pathDisplay: { depth: 12.8 } }).pathDisplay).toEqual({
			mode: "basename",
			depth: 5,
		});
		expect(mergeConfig({ pathDisplay: "full" }).pathDisplay).toEqual({
			mode: "basename",
			depth: 0,
		});
		expect(
			mergeConfig({ pathDisplay: { mode: "full", depth: Number.POSITIVE_INFINITY } }).pathDisplay,
		).toEqual({ mode: "full", depth: 0 });
	});

	it("saves pathDisplay patches and keeps unknown keys", () => {
		const dir = mkdtempSync(join(tmpdir(), "starline-config-"));
		const path = join(dir, "starline.json");
		try {
			writeFileSync(
				path,
				`${JSON.stringify(
					{
						unknown: true,
						pathDisplay: {
							mode: "basename",
							depth: 3,
							futureKey: "future",
						},
					},
					null,
					2,
				)}
`,
			);

			const config = savePathDisplayPatch({ mode: "full" }, path);
			const raw = JSON.parse(readFileSync(path, "utf8"));

			expect(config.pathDisplay).toEqual({ mode: "full", depth: 3 });
			expect(raw.unknown).toBe(true);
			expect(raw.pathDisplay).toEqual({
				mode: "full",
				depth: 3,
				futureKey: "future",
			});

			const depthConfig = savePathDisplayPatch({ depth: 1 }, path);
			expect(depthConfig.pathDisplay).toEqual({ mode: "full", depth: 1 });
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("defaults git branch length to full and accepts positive integer values", () => {
		expect(mergeConfig({}).git.branch).toEqual({ maxLength: "full" });
		expect(defaultConfig.git.branch).toEqual({ maxLength: "full" });
		for (const maxLength of [1, 10, 17, 20, 30, 40, 50, 10_000]) {
			expect(mergeConfig({ git: { branch: { maxLength } } }).git.branch).toEqual({ maxLength });
		}
		expect(mergeConfig({ git: { branch: { maxLength: "full" } } }).git.branch).toEqual({
			maxLength: "full",
		});
	});

	it("falls back to full for invalid git branch lengths", () => {
		for (const maxLength of [0, -1, 1.5, "10", "short", null, true]) {
			expect(mergeConfig({ git: { branch: { maxLength } } }).git.branch).toEqual({
				maxLength: "full",
			});
		}
		expect(mergeConfig({ git: { branch: 20 } }).git.branch).toEqual({ maxLength: "full" });
	});

	it("saves git branch length without erasing unknown config", () => {
		const dir = mkdtempSync(join(tmpdir(), "starline-config-"));
		const path = join(dir, "starline.json");
		try {
			writeFileSync(
				path,
				`${JSON.stringify({ unknown: true, git: { branch: { maxLength: 17, future: true } } }, null, 2)}\n`,
			);

			const config = saveGitBranchPatch({ maxLength: 30 }, path);
			const raw = JSON.parse(readFileSync(path, "utf8"));
			expect(config.git.branch).toEqual({ maxLength: 30 });
			expect(raw).toEqual({
				unknown: true,
				git: { branch: { maxLength: 30, future: true } },
			});
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("defaults icon mode to auto and accepts nerd/ascii", () => {
		expect(mergeConfig({}).icons.mode).toBe("auto");
		expect(mergeConfig({ icons: { mode: "ascii" } }).icons.mode).toBe("ascii");
		expect(mergeConfig({ icons: { mode: "nerd" } }).icons.mode).toBe("nerd");
		expect(mergeConfig({ icons: { mode: "emoji" } }).icons.mode).toBe("auto");
		expect(mergeConfig({ icons: { mode: "ascii" } }).icons.cwd).toBe("");
		expect(mergeConfig({ icons: { mode: "ascii", cwd: "DIR" } }).icons.cwd).toBe("DIR");
	});

	it("accepts Starship colors and old color key aliases", () => {
		expect(mergeConfig({ colors: { gitBranch: "bold purple" } }).colors.gitBranch).toBe(
			"bold purple",
		);
		expect(mergeConfig({ colors: { packageVersion: "bold green" } }).colors.packageVersion).toBe(
			"bold green",
		);
		expect(mergeConfig({ colors: { gitCommit: "bold yellow" } }).colors.gitCommit).toBe(
			"bold yellow",
		);
		expect(mergeConfig({ colors: { gitMetricsAdded: "green" } }).colors.gitMetricsAdded).toBe(
			"green",
		);
		expect(mergeConfig({ colors: { gitMetricsDeleted: "red" } }).colors.gitMetricsDeleted).toBe(
			"red",
		);
		expect(mergeConfig({ colors: { queue: "bold purple" } }).colors.queue).toBe("bold purple");
		expect(mergeConfig({ colors: { git: "syntaxKeyword" } }).colors.gitBranch).toBe(
			"syntaxKeyword",
		);
		expect(mergeConfig({ colors: { extensionStatus: "warning" } }).colors.extensionStatus).toBe(
			"warning",
		);
		expect(mergeConfig({ colors: { extensionStatus: "neon" } }).colors.extensionStatus).toBe(
			defaultConfig.colors.extensionStatus,
		);
	});

	it("accepts extension status placement and color mode config", () => {
		const config = mergeConfig({
			extensionStatuses: {
				defaultPlacement: "middle",
				placements: {
					alpha: "left",
					beta: "off",
					gamma: "right",
					delta: "editor",
				},
				colorModes: {
					alpha: "original",
					beta: "themed",
				},
				colors: {},
				icons: {},
			},
		});

		expect(config.extensionStatuses).toEqual({
			defaultPlacement: "middle",
			placements: {
				alpha: "left",
				beta: "off",
				gamma: "right",
				delta: "editor",
			},
			colorModes: {
				alpha: "original",
				beta: "themed",
			},
			colors: {},
			icons: {},
		});
	});

	it("normalizes invalid extension status placement config", () => {
		expect(
			mergeConfig({
				extensionStatuses: {
					defaultPlacement: "center",
					placements: {
						alpha: "left",
						beta: "center",
						gamma: 1,
					},
					colorModes: {
						alpha: "original",
						beta: "muted",
						gamma: 1,
					},
					colors: {},
					icons: {},
				},
			}).extensionStatuses,
		).toEqual({
			defaultPlacement: "right",
			placements: { alpha: "left" },
			colorModes: { alpha: "original" },
			colors: {},
			icons: {},
		});
		expect(mergeConfig({ extensionStatuses: { placements: "none" } }).extensionStatuses).toEqual({
			defaultPlacement: "right",
			placements: {},
			colorModes: {},
			colors: {},
			icons: {},
		});
	});

	it("accepts optional editor and user-message chrome color overrides", () => {
		const config = mergeConfig({
			colors: {
				editorAccent: "bold purple",
				editorBorder: "#89b4fa",
				editorModel: "accent",
				editorProvider: "text",
				editorThinking: "muted",
				editorThinkingMinimal: "thinkingMinimal",
				editorThinkingLow: "thinkingLow",
				editorThinkingMedium: "thinkingMedium",
				editorThinkingHigh: "thinkingHigh",
				editorThinkingXhigh: "thinkingXhigh",
			},
		});

		expect(config.colors.editorAccent).toBe("bold purple");
		expect(config.colors.editorBorder).toBe("#89b4fa");
		expect(config.colors.editorModel).toBe("accent");
		expect(config.colors.editorProvider).toBe("text");
		expect(config.colors.editorThinking).toBe("muted");
		expect(config.colors.editorThinkingMinimal).toBe("thinkingMinimal");
		expect(config.colors.editorThinkingLow).toBe("thinkingLow");
		expect(config.colors.editorThinkingMedium).toBe("thinkingMedium");
		expect(config.colors.editorThinkingHigh).toBe("thinkingHigh");
		expect(config.colors.editorThinkingXhigh).toBe("thinkingXhigh");
	});

	it("ignores invalid known values at runtime instead of trusting starline.json", () => {
		const config = mergeConfig({
			projectRefreshIntervalMs: "fast",
			icons: {
				cwd: 42,
				git: "git",
				cacheHit: "CH",
				editorPrompt: ">",
			},
			colors: {
				cwd: 123,
				gitStatus: "not-a-color",
				separator: "dimmed",
				editorAccent: "neon",
				editorPrompt: "accent",
				editorBorder: "also-neon",
				editorThinkingHigh: "thinkingHigh",
			},
			colorSources: {
				starship: "neon",
				editor: "terminal",
			},
		});

		expect(config.projectRefreshIntervalMs).toBe(defaultConfig.projectRefreshIntervalMs);
		expect(config.icons.cwd).toBe(defaultConfig.icons.cwd);
		expect(config.icons.git).toBe("git");
		expect(config.icons.cacheHit).toBe("CH");
		expect(config.icons.editorPrompt).toBe(">");
		expect(config.colors.cwd).toBe(defaultConfig.colors.cwd);
		expect(config.colors.gitStatus).toBe(defaultConfig.colors.gitStatus);
		expect(config.colors.editorAccent).toBeUndefined();
		expect(config.colors.editorPrompt).toBe("accent");
		expect(config.colors.editorBorder).toBeUndefined();
		expect(config.colors.editorThinkingHigh).toBe("thinkingHigh");
		expect(config.colorSources).toEqual({
			starship: "theme",
			editor: "terminal",
			userMessages: "theme",
		});
	});

	it("accepts valid color source preferences and ignores invalid values", () => {
		expect(
			mergeConfig({ colorSources: { starship: "terminal", editor: "theme" } }).colorSources,
		).toEqual({ starship: "terminal", editor: "theme", userMessages: "theme" });
		expect(
			mergeConfig({ colorSources: { starship: "neon", userMessages: "terminal" } }).colorSources,
		).toEqual({ starship: "theme", editor: "theme", userMessages: "terminal" });
	});

	it("accepts valid UI feature preferences and ignores invalid values", () => {
		expect(mergeConfig({ features: { editor: false } }).features).toEqual({
			editor: false,
			statusLine: true,
			copyFriendly: false,
		});
		expect(
			mergeConfig({ features: { editor: "off", statusLine: false, copyFriendly: true } }).features,
		).toEqual({
			editor: true,
			statusLine: false,
			copyFriendly: true,
		});
		expect(mergeConfig({ features: { copyFriendly: "on" } }).features.copyFriendly).toBe(false);
	});

	it("normalizes the session-name colour", () => {
		expect(mergeConfig({ colors: { sessionName: "success" } }).colors.sessionName).toBe("success");
		expect(mergeConfig({ colors: { sessionName: "not-a-color" } }).colors.sessionName).toBe(
			"bold green",
		);
	});

	it("saves color source patches without erasing unknown user config", () => {
		const dir = mkdtempSync(join(tmpdir(), "starline-config-"));
		const path = join(dir, "starline.json");
		try {
			writeFileSync(
				path,
				`${JSON.stringify(
					{
						unknown: true,
						icons: { git: "git" },
						colors: {
							futureKey: "future",
							cwd: "bold cyan",
							gitBranch: "syntaxKeyword",
							cost: "success",
						},
						colorSources: { editor: "terminal" },
					},
					null,
					2,
				)}\n`,
			);

			const config = saveColorSourcesPatch({ starship: "terminal" }, path);
			const raw = JSON.parse(readFileSync(path, "utf8"));

			expect(config.colorSources).toEqual({
				starship: "terminal",
				editor: "terminal",
				userMessages: "theme",
			});
			expect(raw.unknown).toBe(true);
			expect(raw.icons.git).toBe("git");
			expect(raw.colors.cwd).toBe("bold cyan");
			expect(raw.colors.futureKey).toBe("future");
			expect(raw.colors.gitBranch).toBe("syntaxKeyword");
			expect(raw.colors.cost).toBe("success");
			expect(raw.colorSources).toEqual({
				starship: "terminal",
				editor: "terminal",
			});
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("preserves invalid and unknown color source data on disk while normalizing runtime", () => {
		const dir = mkdtempSync(join(tmpdir(), "starline-config-"));
		const path = join(dir, "starline.json");
		try {
			writeFileSync(
				path,
				`${JSON.stringify(
					{
						colorSources: {
							starship: "neon",
							editor: "terminal",
							userMessages: "invalid",
							extra: "terminal",
						},
					},
					null,
					2,
				)}\n`,
			);

			const config = saveColorSourcesPatch({ userMessages: "terminal" }, path);
			const raw = JSON.parse(readFileSync(path, "utf8"));

			expect(config.colorSources).toEqual({
				starship: "theme",
				editor: "terminal",
				userMessages: "terminal",
			});
			expect(raw.colorSources).toEqual({
				starship: "neon",
				editor: "terminal",
				userMessages: "terminal",
				extra: "terminal",
			});
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("writes only the requested settings when creating starline.json", () => {
		const dir = mkdtempSync(join(tmpdir(), "starline-config-"));
		const path = join(dir, "starline.json");
		try {
			const config = saveColorSourcesPatch({ starship: "terminal" }, path);
			const raw = JSON.parse(readFileSync(path, "utf8"));

			expect(config.colorSources).toEqual({
				starship: "terminal",
				editor: "theme",
				userMessages: "theme",
			});
			expect(raw).toEqual({ colorSources: { starship: "terminal" } });
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("saves UI feature patches without erasing unknown user config", () => {
		const dir = mkdtempSync(join(tmpdir(), "starline-config-"));
		const path = join(dir, "starline.json");
		try {
			writeFileSync(
				path,
				`${JSON.stringify(
					{
						unknown: true,
						features: {
							editor: true,
							futureKey: "future",
						},
					},
					null,
					2,
				)}\n`,
			);

			const config = saveUiFeaturesPatch({ statusLine: false }, path);
			const raw = JSON.parse(readFileSync(path, "utf8"));

			expect(config.features).toEqual({
				editor: true,
				statusLine: false,
				copyFriendly: false,
			});
			expect(raw.unknown).toBe(true);
			expect(raw.features).toEqual({
				editor: true,
				futureKey: "future",
				statusLine: false,
			});
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("writes only the requested UI feature setting when creating starline.json", () => {
		const dir = mkdtempSync(join(tmpdir(), "starline-config-"));
		const path = join(dir, "starline.json");
		try {
			const config = saveUiFeaturesPatch({ editor: false }, path);
			const raw = JSON.parse(readFileSync(path, "utf8"));

			expect(config.features).toEqual({
				editor: false,
				statusLine: true,
				copyFriendly: false,
			});
			expect(raw).toEqual({ features: { editor: false } });
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("gitCommit config defaults and normalizes hashLength", () => {
		expect(defaultConfig.git.commit).toEqual({ hashLength: 7, onlyDetached: true, showTag: true });
		expect(mergeConfig({ git: { commit: { hashLength: 3 } } }).git.commit.hashLength).toBe(4);
		expect(mergeConfig({ git: { commit: { hashLength: 100 } } }).git.commit.hashLength).toBe(40);
		expect(mergeConfig({ git: { commit: { hashLength: 10 } } }).git.commit.hashLength).toBe(10);
		expect(mergeConfig({ git: { commit: { onlyDetached: false } } }).git.commit.onlyDetached).toBe(
			false,
		);
		expect(mergeConfig({ git: { commit: { showTag: false } } }).git.commit.showTag).toBe(false);
		// Missing fields fall back to defaults.
		expect(mergeConfig({ git: { commit: {} } }).git.commit).toEqual({
			hashLength: 7,
			onlyDetached: true,
			showTag: true,
		});
	});

	it("gitMetrics config defaults", () => {
		expect(defaultConfig.git.metrics).toEqual({ onlyNonzero: true, ignoreSubmodules: false });
		expect(mergeConfig({ git: { metrics: { onlyNonzero: false } } }).git.metrics.onlyNonzero).toBe(
			false,
		);
		expect(
			mergeConfig({ git: { metrics: { ignoreSubmodules: true } } }).git.metrics.ignoreSubmodules,
		).toBe(true);
	});

	it("saves extension status placement when creating starline.json", () => {
		const dir = mkdtempSync(join(tmpdir(), "starline-config-"));
		const path = join(dir, "starline.json");
		try {
			const config = saveExtensionStatusPlacement("plugin.key", "middle", path);
			const raw = JSON.parse(readFileSync(path, "utf8"));

			expect(config.extensionStatuses.placements).toEqual({ "plugin.key": "middle" });
			expect(raw).toEqual({
				extensionStatuses: {
					placements: {
						"plugin.key": "middle",
					},
				},
			});
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("saves extension status color mode when creating starline.json", () => {
		const dir = mkdtempSync(join(tmpdir(), "starline-config-"));
		const path = join(dir, "starline.json");
		try {
			const config = saveExtensionStatusColorMode("plugin.key", "original", path);
			const raw = JSON.parse(readFileSync(path, "utf8"));

			expect(config.extensionStatuses.colorModes).toEqual({ "plugin.key": "original" });
			expect(raw).toEqual({
				extensionStatuses: {
					colorModes: {
						"plugin.key": "original",
					},
				},
			});
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("saves extension status color mode without erasing placement config", () => {
		const dir = mkdtempSync(join(tmpdir(), "starline-config-"));
		const path = join(dir, "starline.json");
		try {
			writeFileSync(
				path,
				`${JSON.stringify(
					{
						unknown: true,
						colors: { futureKey: "future" },
						extensionStatuses: {
							defaultPlacement: "left",
							futureKey: "future",
							placements: {
								alpha: "right",
								invalid: "center",
							},
							colorModes: {
								alpha: "themed",
								invalid: "muted",
							},
						},
					},
					null,
					2,
				)}\n`,
			);

			const config = saveExtensionStatusColorMode("beta", "original", path);
			const raw = JSON.parse(readFileSync(path, "utf8"));

			expect(config.extensionStatuses).toEqual({
				defaultPlacement: "left",
				placements: { alpha: "right" },
				colorModes: { alpha: "themed", beta: "original" },
				colors: {},
				icons: {},
			});
			expect(raw.unknown).toBe(true);
			expect(raw.colors.futureKey).toBe("future");
			expect(raw.extensionStatuses.futureKey).toBe("future");
			expect(raw.extensionStatuses.placements).toEqual({
				alpha: "right",
				invalid: "center",
			});
			expect(raw.extensionStatuses.colorModes).toEqual({
				alpha: "themed",
				invalid: "muted",
				beta: "original",
			});
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("saves extension status placement without erasing unknown user config", () => {
		const dir = mkdtempSync(join(tmpdir(), "starline-config-"));
		const path = join(dir, "starline.json");
		try {
			writeFileSync(
				path,
				`${JSON.stringify(
					{
						unknown: true,
						colors: { futureKey: "future" },
						extensionStatuses: {
							defaultPlacement: "left",
							futureKey: "future",
							placements: {
								alpha: "right",
								invalid: "center",
							},
						},
					},
					null,
					2,
				)}\n`,
			);

			const config = saveExtensionStatusPlacement("beta", "off", path);
			const raw = JSON.parse(readFileSync(path, "utf8"));

			expect(config.extensionStatuses).toEqual({
				defaultPlacement: "left",
				placements: { alpha: "right", beta: "off" },
				colorModes: {},
				colors: {},
				icons: {},
			});
			expect(raw.unknown).toBe(true);
			expect(raw.colors.futureKey).toBe("future");
			expect(raw.extensionStatuses.futureKey).toBe("future");
			expect(raw.extensionStatuses.placements).toEqual({
				alpha: "right",
				invalid: "center",
				beta: "off",
			});
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

describe("renderTerminalStyle", () => {
	it("renders Starship bold green with terminal palette ANSI codes", () => {
		expect(renderTerminalStyle("bold green", " v22.0.0")).toBe("\u001b[1;32m v22.0.0\u001b[0m");
	});

	it("supports 256-color, fg/bg aliases, dimmed, and Starship hex styles", () => {
		expect(renderTerminalStyle("bold 149", "C")).toBe("\u001b[1;38;5;149mC\u001b[0m");
		expect(renderTerminalStyle("bold fg:202", "Haxe")).toBe("\u001b[1;38;5;202mHaxe\u001b[0m");
		expect(renderTerminalStyle("red dimmed", "Java")).toBe("\u001b[31;2mJava\u001b[0m");
		expect(renderTerminalStyle("bg:blue fg:bright-green", "ok")).toBe("\u001b[44;92mok\u001b[0m");
		expect(renderTerminalStyle("bold #FFAFF3", "Gleam")).toBe(
			"\u001b[1;38;2;255;175;243mGleam\u001b[0m",
		);
	});
});

describe("style rendering", () => {
	const theme = {
		fg(token: string, text: string) {
			return `<${token}>${text}</${token}>`;
		},
	};

	it("uses theme tokens when provided to colorize", () => {
		expect(colorize(theme, "accent", "hello")).toBe("<accent>hello</accent>");
	});

	it("falls back to plain text for invalid theme tokens", () => {
		const throwingTheme = {
			fg(token: string, text: string) {
				if (token === "text") return `<text>${text}</text>`;
				throw new Error(`Unknown color: ${token}`);
			},
		};

		expect(colorize(throwingTheme, "doesNotExist", "hello")).toBe("hello");
		expect(renderStyle(throwingTheme, "doesNotExist", "hello")).toBe("hello");
		expect(renderStyleForSource(throwingTheme, "theme", "doesNotExist", "hello")).toBe("hello");
	});

	it("maps Starship modifiers to safe theme colors when the theme rejects unknown tokens", () => {
		const strictTheme = {
			fg(token: string, text: string) {
				if (!["muted", "syntaxKeyword", "text"].includes(token)) {
					throw new Error(`Unknown theme color: ${token}`);
				}
				return `<${token}>${text}</${token}>`;
			},
			bold(text: string) {
				return `<bold>${text}</bold>`;
			},
		};

		expect(renderStyleForSource(strictTheme, "theme", "dimmed", "tokens")).toBe(
			"<muted>tokens</muted>",
		);
		expect(renderStyleForSource(strictTheme, "theme", "bold purple", "git")).toBe(
			"<syntaxKeyword><bold>git</bold></syntaxKeyword>",
		);
		expect(renderStyleForSource(strictTheme, "theme", "unknownColor", "text")).toBe("text");
	});

	it("supports hex colors", () => {
		expect(colorize(theme, "#89b4fa", "hello")).toBe("\u001b[38;2;137;180;250mhello\u001b[39m");
	});

	it("supports short #rgb hex colors by expanding to rrggbb", () => {
		expect(colorize(theme, "#89b", "hello")).toBe("\u001b[38;2;136;153;187mhello\u001b[39m");
		expect(renderTerminalStyle("bold #89b", "x")).toBe("\u001b[1;38;2;136;153;187mx\u001b[0m");
	});

	it("renders Starship styles before falling back to theme tokens", () => {
		expect(renderStyle(theme, "bold purple", "git")).toBe("\u001b[1;35mgit\u001b[0m");
		expect(renderStyle(theme, "syntaxKeyword", "git")).toBe("<syntaxKeyword>git</syntaxKeyword>");
	});

	it("renders theme-source Starship colors through Pi theme tokens", () => {
		expect(renderStyleForSource(theme, "theme", "bold cyan", "cwd")).toBe(
			"<syntaxFunction>cwd</syntaxFunction>",
		);
		expect(renderStyleForSource(theme, "theme", "bold purple", "git")).toBe(
			"<syntaxKeyword>git</syntaxKeyword>",
		);
		expect(renderStyleForSource(theme, "theme", "bold red", "!")).toBe("<error>!</error>");
		expect(renderStyleForSource(theme, "theme", "dimmed", "tokens")).toBe("<muted>tokens</muted>");
		expect(renderStyleForSource(theme, "theme", "bold green", "cost")).toBe(
			"<success>cost</success>",
		);
		expect(renderStyleForSource(theme, "theme", "syntaxKeyword", "git")).toBe(
			"<syntaxKeyword>git</syntaxKeyword>",
		);
	});

	it("keeps explicit terminal styles available for terminal source", () => {
		expect(renderStyleForSource(theme, "terminal", "bold purple", "git")).toBe(
			"\u001b[1;35mgit\u001b[0m",
		);
		expect(renderStyleForSource(theme, "theme", "fg:202", "git")).toBe(
			"\u001b[38;5;202mgit\u001b[0m",
		);
	});

	it("renders theme borders with borderMuted and terminal borders with bright black", () => {
		const thinkingTheme = {
			fg(token: string, text: string) {
				return `<${token}>${text}</${token}>`;
			},
		};

		expect(renderChromeBorder(thinkingTheme, "theme", "bright-black", "────")).toBe(
			"<borderMuted>────</borderMuted>",
		);
		expect(renderChromeBorder(thinkingTheme, "terminal", "bright-black", "────")).toBe(
			"\u001b[90m────\u001b[0m",
		);
	});
});

describe("saveMousePatch", () => {
	it("saves enabled flag and round-trips", () => {
		const dir = mkdtempSync(join(tmpdir(), "starline-cfg-"));
		const path = join(dir, "starline.json");
		try {
			const config = saveMousePatch({ enabled: false }, path);
			expect(config.mouse.enabled).toBe(false);

			const raw = JSON.parse(readFileSync(path, "utf8"));
			expect(raw.mouse.enabled).toBe(false);
		} finally {
			rmSync(dir, { recursive: true });
		}
	});

	it("saves wheelRouting flag alongside existing enabled, without dropping it", () => {
		const dir = mkdtempSync(join(tmpdir(), "starline-cfg-"));
		const path = join(dir, "starline.json");
		try {
			saveMousePatch({ enabled: false }, path);
			const config = saveMousePatch({ wheelRouting: false }, path);
			expect(config.mouse).toEqual({
				enabled: false,
				wheelRouting: false,
				copyNotice: true,
				transcriptCleanCopy: true,
			});
		} finally {
			rmSync(dir, { recursive: true });
		}
	});
});

describe("config identity after the starline rename", () => {
	it("reads its config from starline.json", () => {
		expect(basename(configPath)).toBe("starline.json");
	});

	it("defaults a third-party status to the themed colour mode", () => {
		expect(getExtensionStatusColorMode(mergeConfig({}), "some.plugin")).toBe("themed");
	});

	it("accepts themed and original, and rejects the old brand name", () => {
		expect(isExtensionStatusColorMode("themed")).toBe(true);
		expect(isExtensionStatusColorMode("original")).toBe(true);
		expect(isExtensionStatusColorMode("zentui")).toBe(false);
	});
});
