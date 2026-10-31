import { describe, expect, it } from "vitest";
import { parseGitRemote } from "../extensions/starline/git";

/**
 * The remote split every forge read starts from: owner (or GitLab's nested
 * namespace) and repository, with the `.git` suffix and any transport noise gone.
 */
describe("parseGitRemote", () => {
	it("splits the scp-style form git writes for ssh clones", () => {
		expect(parseGitRemote("git@github.com:Andy8647/pi-starline.git")).toEqual({
			host: "github",
			namespace: "Andy8647",
			name: "pi-starline",
		});
	});

	it("splits https and ssh URL forms", () => {
		expect(parseGitRemote("https://github.com/owner/repo.git")).toEqual({
			host: "github",
			namespace: "owner",
			name: "repo",
		});
		expect(parseGitRemote("ssh://git@github.com/owner/repo.git")).toEqual({
			host: "github",
			namespace: "owner",
			name: "repo",
		});
	});

	it("keeps a GitLab subgroup as the namespace", () => {
		expect(parseGitRemote("git@gitlab.com:group/sub/repo.git")).toEqual({
			host: "gitlab",
			namespace: "group/sub",
			name: "repo",
		});
	});

	it("tolerates a trailing slash, a port and a self-hosted host", () => {
		expect(parseGitRemote("https://gitlab.acme.com:8443/team/repo/")).toEqual({
			host: "gitlab",
			namespace: "team",
			name: "repo",
		});
	});

	it("has no repository to name from a bare host or a local path", () => {
		expect(parseGitRemote("")).toBeUndefined();
		expect(parseGitRemote("   ")).toBeUndefined();
		expect(parseGitRemote("/local/path/repo.git")).toBeUndefined();
		expect(parseGitRemote("https://github.com/onlyowner")).toBeUndefined();
	});
});
