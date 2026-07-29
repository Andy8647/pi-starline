import { describe, expect, it } from "vitest";
import { defaultConfig, getExtensionStatusIcon, mergeConfig } from "../extensions/starline/config";
import { gitHostIconGlyph } from "../extensions/starline/footer";
import { emptyGitStatus, parseGitRemoteHost } from "../extensions/starline/git";
import {
	ASCII_DEFAULT_ICONS,
	ICON_GLYPH_KEYS,
	NERD_DEFAULT_ICONS,
} from "../extensions/starline/icons";
import { applyProjectRefreshToState } from "../extensions/starline/project-state";
import { createInitialState } from "../extensions/starline/state";

describe("parseGitRemoteHost", () => {
	it("reads scp-style SSH remotes", () => {
		expect(parseGitRemoteHost("git@github.com:Andy8647/pi-starline.git")).toBe("github");
		expect(parseGitRemoteHost("git@gitlab.com:group/repo.git")).toBe("gitlab");
		expect(parseGitRemoteHost("git@bitbucket.org:team/repo.git")).toBe("bitbucket");
	});

	it("reads HTTPS remotes", () => {
		expect(parseGitRemoteHost("https://github.com/Andy8647/pi-starline.git")).toBe("github");
		expect(parseGitRemoteHost("https://gitlab.com/group/repo")).toBe("gitlab");
	});

	it("reads ssh:// and git:// URLs", () => {
		expect(parseGitRemoteHost("ssh://git@github.com/user/repo.git")).toBe("github");
		expect(parseGitRemoteHost("git://github.com/user/repo.git")).toBe("github");
	});

	it("recognises self-hosted forges by subdomain", () => {
		expect(parseGitRemoteHost("git@gitlab.acme.com:group/repo.git")).toBe("gitlab");
		expect(parseGitRemoteHost("https://github.enterprise.io/team/repo")).toBe("github");
	});

	it("calls anything else generic", () => {
		expect(parseGitRemoteHost("git@git.sr.ht:~user/repo")).toBe("generic");
		expect(parseGitRemoteHost("https://codeberg.org/user/repo.git")).toBe("generic");
	});

	it("is undefined for input that names no host", () => {
		expect(parseGitRemoteHost("")).toBeUndefined();
		expect(parseGitRemoteHost("   ")).toBeUndefined();
		expect(parseGitRemoteHost("/local/path/repo.git")).toBeUndefined();
	});

	it("tolerates the trailing newline git prints", () => {
		expect(parseGitRemoteHost("git@github.com:user/repo.git\n")).toBe("github");
	});
});

describe("gitHostIconGlyph", () => {
	it("gives each forge its own glyph in nerd mode", () => {
		const icons = { ...NERD_DEFAULT_ICONS, mode: "nerd" as const };
		const glyphs = (["github", "gitlab", "bitbucket", "generic"] as const).map((host) =>
			gitHostIconGlyph(icons, host),
		);
		expect(glyphs.every(Boolean)).toBe(true);
		expect(new Set(glyphs).size).toBe(4);
	});

	it("returns nothing in ascii mode, disabling the feature", () => {
		const icons = { ...ASCII_DEFAULT_ICONS, mode: "ascii" as const };
		for (const host of ["github", "gitlab", "bitbucket", "generic"] as const) {
			expect(gitHostIconGlyph(icons, host)).toBe("");
		}
	});
});

describe("gitHostIcon config", () => {
	it("is off by default", () => {
		expect(defaultConfig.gitHostIcon).toBe(false);
	});

	it("only accepts a real boolean true", () => {
		expect(mergeConfig({ gitHostIcon: true }).gitHostIcon).toBe(true);
		expect(mergeConfig({ gitHostIcon: "yes" }).gitHostIcon).toBe(false);
		expect(mergeConfig({}).gitHostIcon).toBe(false);
	});
});

describe("gitHost in project state", () => {
	const ok = { kind: "ok" as const, status: emptyGitStatus() };
	const runtime = { kind: "ok" as const, runtime: undefined };

	it("stores a detected host", () => {
		const state = createInitialState(emptyGitStatus());
		applyProjectRefreshToState(state, {
			cwd: "/repo",
			previousCwd: "/repo",
			git: ok,
			gitHost: "github",
			runtime,
		});
		expect(state.gitHost).toBe("github");
	});

	// gitHost is undefined whenever the feature is off, and that must not wipe a
	// previously detected host — only leaving the repo should.
	it("keeps the last value when the refresh did not look", () => {
		const state = createInitialState(emptyGitStatus());
		state.gitHost = "gitlab";
		applyProjectRefreshToState(state, {
			cwd: "/repo",
			previousCwd: "/repo",
			git: ok,
			runtime,
		});
		expect(state.gitHost).toBe("gitlab");
	});

	it("clears the host when the directory is not a repo", () => {
		const state = createInitialState(emptyGitStatus());
		state.gitHost = "github";
		applyProjectRefreshToState(state, {
			cwd: "/tmp",
			previousCwd: "/tmp",
			git: { kind: "not_a_repo" },
			runtime,
		});
		expect(state.gitHost).toBeUndefined();
	});

	it("clears the host on a directory change", () => {
		const state = createInitialState(emptyGitStatus());
		state.gitHost = "github";
		applyProjectRefreshToState(state, {
			cwd: "/other",
			previousCwd: "/repo",
			git: { kind: "error" },
			runtime,
		});
		expect(state.gitHost).toBeUndefined();
	});
});

describe("per-segment icons", () => {
	const added = ["model", "thinking", "context", "cost", "tokens"] as const;

	it("registers the new glyph keys as overridable", () => {
		for (const key of added) {
			expect(ICON_GLYPH_KEYS).toContain(key);
		}
	});

	// Giving these defaults would change the text footer, which must stay
	// byte-identical to upstream. They are opt-in.
	it("defaults them to empty in every mode", () => {
		for (const key of added) {
			expect(NERD_DEFAULT_ICONS[key]).toBe("");
			expect(ASCII_DEFAULT_ICONS[key]).toBe("");
		}
	});

	it("accepts an override", () => {
		expect(mergeConfig({ icons: { model: "◈" } }).icons.model).toBe("◈");
	});

	// Upstream's documented rule is that an explicit override wins over the mode
	// default, ascii included. The new keys follow it rather than carving out an
	// exception. gitHostIcon still disables itself in ascii because its glyphs
	// are defaults, not overrides.
	it("keeps an explicit override in ascii mode, as upstream does", () => {
		expect(mergeConfig({ icons: { mode: "ascii", model: "◈" } }).icons.model).toBe("◈");
		expect(mergeConfig({ icons: { mode: "ascii" } }).icons.gitHostGithub).toBe("");
	});
});

describe("per-status icons", () => {
	it("are unset by default", () => {
		expect(defaultConfig.extensionStatuses.icons).toEqual({});
	});

	it("are read per status key", () => {
		const config = mergeConfig({
			extensionStatuses: { icons: { "provider-balance": "◈", "mcp-status": "◆" } },
		});
		expect(getExtensionStatusIcon(config, "provider-balance")).toBe("◈");
		expect(getExtensionStatusIcon(config, "mcp-status")).toBe("◆");
		expect(getExtensionStatusIcon(config, "unlisted")).toBe("");
	});

	it("drop out in ascii mode, like every other Nerd Font affordance", () => {
		const config = mergeConfig({
			icons: { mode: "ascii" },
			extensionStatuses: { icons: { balance: "◈" } },
		});
		expect(getExtensionStatusIcon(config, "balance")).toBe("");
	});

	it("ignore non-string values", () => {
		const config = mergeConfig({ extensionStatuses: { icons: { balance: 5 } } });
		expect(getExtensionStatusIcon(config, "balance")).toBe("");
	});
});
