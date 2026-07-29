import { describe, expect, it, vi } from "vitest";
import { registerStarlineSettingsCommand } from "../extensions/starline/settings-command";

describe("settings command identity", () => {
	it("registers itself as /starline", () => {
		const registerCommand = vi.fn();

		registerStarlineSettingsCommand(
			{ registerCommand } as unknown as Parameters<typeof registerStarlineSettingsCommand>[0],
			{} as unknown as Parameters<typeof registerStarlineSettingsCommand>[1],
		);

		expect(registerCommand).toHaveBeenCalledTimes(1);
		const [name, options] = registerCommand.mock.calls[0];
		expect(name).toBe("starline");
		expect(options.description).toBe("Configure Starline");
	});
});
