import { describe, expect, it } from "vitest";
import { parseGitRemote } from "../extensions/starline/git";

/**
 * The remote split every forge read starts from: owner (or GitLab's nested
 * namespace) and repository, with the `.git` suffix, any transport noise and a
 * browser URL that keeps the host the remote actually lives on.
 */
describe("parseGitRemote", () => {
	it("splits the scp-style form git writes for ssh clones", () => {
		expect(parseGitRemote("git@github.com:Andy8647/pi-starline.git")).toEqual({
			host: "github",
			namespace: "Andy8647",
			name: "pi-starline",
			webUrl: "https://github.com/Andy8647/pi-starline",
		});
	});

	it("splits https and ssh URL forms", () => {
		expect(parseGitRemote("https://github.com/owner/repo.git")).toEqual({
			host: "github",
			namespace: "owner",
			name: "repo",
			webUrl: "https://github.com/owner/repo",
		});
		expect(parseGitRemote("ssh://git@github.com/owner/repo.git")).toEqual({
			host: "github",
			namespace: "owner",
			name: "repo",
			webUrl: "https://github.com/owner/repo",
		});
	});

	it("keeps a GitLab subgroup as the namespace", () => {
		expect(parseGitRemote("git@gitlab.com:group/sub/repo.git")).toEqual({
			host: "gitlab",
			namespace: "group/sub",
			name: "repo",
			webUrl: "https://gitlab.com/group/sub/repo",
		});
	});

	it("tolerates a trailing slash and keeps a self-hosted host's port", () => {
		expect(parseGitRemote("https://gitlab.acme.com:8443/team/repo/")).toEqual({
			host: "gitlab",
			namespace: "team",
			name: "repo",
			webUrl: "https://gitlab.acme.com:8443/team/repo",
		});
	});

	it("has no repository to name from a bare host or a local path", () => {
		expect(parseGitRemote("")).toBeUndefined();
		expect(parseGitRemote("   ")).toBeUndefined();
		expect(parseGitRemote("/local/path/repo.git")).toBeUndefined();
		expect(parseGitRemote("https://github.com/onlyowner")).toBeUndefined();
	});
});
