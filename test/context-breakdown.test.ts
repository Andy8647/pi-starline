import { visibleWidth } from "@earendil-works/pi-tui";
import { describe, expect, it } from "vitest";
import {
	type ContextProbe,
	collectContextBreakdown,
	contextBreakdownBody,
	contextBreakdownNote,
	probeFor,
} from "../extensions/starline/context-breakdown";

/** A probe with nothing to report; each test replaces the reads it cares about. */
function probe(overrides: Partial<ContextProbe> = {}): ContextProbe {
	return {
		systemPrompt: () => "",
		allTools: () => [],
		activeTools: () => [],
		usage: () => undefined,
		modelContextWindow: () => undefined,
		reserveTokens: () => undefined,
		...overrides,
	};
}

/** A rendered prompt shaped the way pi 1.4 builds it. */
function prompt(preamble: string, sections: Record<string, string>): string {
	const body = Object.entries(sections)
		.map(([name, text]) => `<${name}>\n${text}\n</${name}>`)
		.join("\n\n");
	return body ? `${preamble}\n\n${body}` : preamble;
}

function tokens(breakdown: ReturnType<typeof collectContextBreakdown>, id: string): number {
	return breakdown.parts.find((part) => part.id === id)?.tokens ?? 0;
}

describe("context breakdown", () => {
	it("attributes pi's named sections instead of guessing from the text", () => {
		const breakdown = collectContextBreakdown(
			probe({
				systemPrompt: () =>
					prompt("You are an expert.", {
						tools: "- read: reads files",
						project_context: "the project rules",
						skills: "the skill list",
					}),
			}),
		);
		// project_context is memory, skills is skills, and the rest stays system prompt.
		expect(tokens(breakdown, "memory")).toBeGreaterThan(0);
		expect(tokens(breakdown, "skills")).toBeGreaterThan(0);
		expect(tokens(breakdown, "system")).toBeGreaterThan(tokens(breakdown, "skills"));
	});

	it("counts memory from the section names the extensions use", () => {
		for (const name of ["memory", "pi_memory", "memory-context", "local_memory"]) {
			const breakdown = collectContextBreakdown(
				probe({
					systemPrompt: () => prompt("You are an expert.", { [name]: "a remembered fact" }),
				}),
			);
			expect(tokens(breakdown, "memory"), name).toBeGreaterThan(0);
		}
	});

	it("counts a memory block that was appended instead of declared", () => {
		const body = Array(40).fill("remembered").join(" ");
		const breakdown = collectContextBreakdown(
			probe({
				systemPrompt: () =>
					`You are an expert.\n\n<local_memory path="~/.pi/memory">\n${body}\n</local_memory>`,
			}),
		);
		expect(tokens(breakdown, "memory")).toBeGreaterThan(0);
	});

	it("leaves an unknown section in the system prompt", () => {
		const breakdown = collectContextBreakdown(
			probe({ systemPrompt: () => prompt("You are an expert.", { something_else: "not memory" }) }),
		);
		expect(tokens(breakdown, "memory")).toBe(0);
		expect(tokens(breakdown, "system")).toBeGreaterThan(0);
	});

	it("counts the tool schemas the model receives, and MCP apart", () => {
		const tools = [
			{ name: "read", description: "Read a file", parameters: { type: "object" } },
			{
				name: "mcp__docs__search",
				description: "Search the docs",
				parameters: { type: "object" },
				namespace: { name: "mcp__docs" },
			},
		];
		const breakdown = collectContextBreakdown(
			probe({ allTools: () => tools, activeTools: () => tools.map((tool) => tool.name) }),
		);
		expect(tokens(breakdown, "tools")).toBeGreaterThan(0);
		expect(tokens(breakdown, "mcp")).toBeGreaterThan(0);
	});

	it("leaves inactive and hidden tools out of the schemas", () => {
		const tools = [
			{ name: "read", description: "Read a file" },
			{ name: "bash", description: "Run a command" },
			{ name: "hidden", description: "Never sent", exposure: "hidden" },
		];
		const breakdown = collectContextBreakdown(
			probe({ allTools: () => tools, activeTools: () => ["read"] }),
		);
		const all = collectContextBreakdown(
			probe({ allTools: () => tools, activeTools: () => tools.map((tool) => tool.name) }),
		);
		expect(tokens(breakdown, "tools")).toBeGreaterThan(0);
		expect(tokens(breakdown, "tools")).toBeLessThan(tokens(all, "tools"));
	});

	it("counts codemode tools as free, because the model never receives them", () => {
		const tools = [
			{ name: "read", description: "Read a file", exposure: "direct" },
			{ name: "bash", description: "Run a command", exposure: "codemode" },
		];
		const breakdown = collectContextBreakdown(
			probe({ allTools: () => tools, activeTools: () => tools.map((tool) => tool.name) }),
		);
		const onlyRead = collectContextBreakdown(
			probe({ allTools: () => tools.slice(0, 1), activeTools: () => ["read"] }),
		);
		expect(tokens(breakdown, "tools")).toBe(tokens(onlyRead, "tools"));
	});

	it("gives the conversation whatever the measured total does not explain", () => {
		const breakdown = collectContextBreakdown(
			probe({
				systemPrompt: () => "You are an expert.",
				usage: () => ({ tokens: 50_000, contextWindow: 200_000 }),
			}),
		);
		expect(breakdown.measured).toBe(50_000);
		expect(breakdown.total).toBe(50_000);
		const parts = breakdown.parts.reduce((sum, part) => sum + part.tokens, 0);
		expect(parts).toBe(50_000);
	});

	it("estimates before the first turn instead of reporting zero", () => {
		const breakdown = collectContextBreakdown(
			probe({
				systemPrompt: () =>
					prompt("You are an expert.", { skills: "a skill list long enough to count" }),
				usage: () => ({ tokens: null, contextWindow: 200_000 }),
			}),
		);
		expect(breakdown.measured).toBeUndefined();
		expect(breakdown.total).toBeGreaterThan(0);
		expect(contextBreakdownNote(breakdown)).toContain("estimated");
	});

	it("reserves the autocompact buffer out of the free space", () => {
		const breakdown = collectContextBreakdown(
			probe({
				usage: () => ({ tokens: 100_000, contextWindow: 200_000 }),
				reserveTokens: () => 16_384,
			}),
		);
		const buffer = breakdown.spaces.find((space) => space.id === "buffer");
		const free = breakdown.spaces.find((space) => space.id === "free");
		expect(buffer?.tokens).toBe(16_384);
		expect(free?.tokens).toBe(200_000 - 100_000 - 16_384);
	});

	it("draws the grid at eight rows of ten two-column cells", () => {
		const breakdown = collectContextBreakdown(
			probe({
				systemPrompt: () => "You are an expert.",
				usage: () => ({ tokens: 40_000, contextWindow: 200_000 }),
			}),
		);
		const body = contextBreakdownBody(breakdown, { fg: (_color, text) => text });
		expect(body).toHaveLength(8);
		// Every row starts with the same ten two-column cells, whether or not it also
		// carries a legend entry.
		for (const line of body) expect(visibleWidth(line)).toBeGreaterThanOrEqual(20);
	});

	it("lists every category it drew, and nothing it did not", () => {
		const breakdown = collectContextBreakdown(
			probe({
				usage: () => ({ tokens: 100_000, contextWindow: 200_000 }),
			}),
		);
		const body = contextBreakdownBody(breakdown, { fg: (_color, text) => text }).join("\n");
		expect(body).toContain("messages");
		expect(body).toContain("free space");
		expect(body).not.toContain("autocompact buffer");
	});

	it("survives a Pi build without the reads", () => {
		const breakdown = collectContextBreakdown(probeFor({}));
		expect(breakdown.total).toBe(0);
		expect(breakdown.parts.every((part) => part.tokens === 0)).toBe(true);
	});
});
