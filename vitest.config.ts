import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defineConfig } from "vitest/config";

/**
 * Point Pi's agent directory at a throwaway path for the whole run.
 *
 * `loadConfig()` reads `<agentDir>/starline.json`, and several tests go through it,
 * so without this the suite reads the developer's own config and its result
 * depends on how they happen to have Starline set up. Pi resolves the directory
 * from PI_CODING_AGENT_DIR before falling back to ~/.pi/agent.
 */
process.env.PI_CODING_AGENT_DIR ??= mkdtempSync(join(tmpdir(), "starline-test-agent-"));

export default defineConfig({
	test: {
		env: { PI_CODING_AGENT_DIR: process.env.PI_CODING_AGENT_DIR },
	},
});
