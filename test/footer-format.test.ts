import { describe, expect, it } from "vitest";
import { parseFooterFormat } from "../extensions/starline/footer-format";

describe("parseFooterFormat", () => {
	it("returns empty array for empty string", () => {
		expect(parseFooterFormat("")).toEqual([]);
	});

	it("parses a single variable", () => {
		expect(parseFooterFormat("$cwd")).toEqual([{ kind: "var", name: "cwd" }]);
	});

	it("parses $package and $package_version as package-version vars", () => {
		expect(parseFooterFormat("$package")).toEqual([{ kind: "var", name: "package" }]);
		expect(parseFooterFormat("$package_version")).toEqual([
			{ kind: "var", name: "package_version" },
		]);
	});

	it("parses $git_commit, $commit, $git_tag, and $tag as git-commit vars", () => {
		expect(parseFooterFormat("$git_commit")).toEqual([{ kind: "var", name: "git_commit" }]);
		expect(parseFooterFormat("$commit")).toEqual([{ kind: "var", name: "commit" }]);
		expect(parseFooterFormat("$git_tag")).toEqual([{ kind: "var", name: "git_tag" }]);
		expect(parseFooterFormat("$tag")).toEqual([{ kind: "var", name: "tag" }]);
	});

	it("parses git-metrics vars", () => {
		expect(parseFooterFormat("$git_metrics")).toEqual([{ kind: "var", name: "git_metrics" }]);
		expect(parseFooterFormat("$git_added")).toEqual([{ kind: "var", name: "git_added" }]);
		expect(parseFooterFormat("$git_deleted")).toEqual([{ kind: "var", name: "git_deleted" }]);
	});

	it("parses braced variables", () => {
		const braced = "${" + "git_branch}";
		expect(parseFooterFormat(braced)).toEqual([{ kind: "var", name: "git_branch" }]);
	});

	it("parses text and variables mixed", () => {
		expect(parseFooterFormat("$cwd on $git_branch")).toEqual([
			{ kind: "var", name: "cwd" },
			{ kind: "text", value: " on " },
			{ kind: "var", name: "git_branch" },
		]);
	});

	it("parses the fill token", () => {
		expect(parseFooterFormat("$fill")).toEqual([{ kind: "fill" }]);
	});

	it("preserves literal text exactly including multiple spaces", () => {
		const tokens = parseFooterFormat("$cwd   on   $git_branch");
		expect(tokens).toEqual([
			{ kind: "var", name: "cwd" },
			{ kind: "text", value: "   on   " },
			{ kind: "var", name: "git_branch" },
		]);
	});

	it("preserves leading and trailing text", () => {
		const tokens = parseFooterFormat("prefix $cwd suffix");
		expect(tokens).toEqual([
			{ kind: "text", value: "prefix " },
			{ kind: "var", name: "cwd" },
			{ kind: "text", value: " suffix" },
		]);
	});

	it("treats unknown variable names as var tokens", () => {
		expect(parseFooterFormat("$nope")).toEqual([{ kind: "var", name: "nope" }]);
	});

	it("handles mixed fill, vars, and text", () => {
		expect(parseFooterFormat("$cwd on $git_branch $fill $cost $time")).toEqual([
			{ kind: "var", name: "cwd" },
			{ kind: "text", value: " on " },
			{ kind: "var", name: "git_branch" },
			{ kind: "text", value: " " },
			{ kind: "fill" },
			{ kind: "text", value: " " },
			{ kind: "var", name: "cost" },
			{ kind: "text", value: " " },
			{ kind: "var", name: "time" },
		]);
	});
});
