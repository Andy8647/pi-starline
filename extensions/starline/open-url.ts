import { execFile } from "node:child_process";

/**
 * Open a URL in the user's browser.
 *
 * Pi has an opener of its own and does not export it, so this is the short
 * version: `open` on macOS, `xdg-open` on Linux, `cmd /c start` on Windows. Fire
 * and forget — a headless or remote session may have no browser at all, and a
 * click that cannot open one must not throw into the render loop.
 *
 * `execFile` rather than a shell: the URL comes from a forge, and it is passed as
 * one argument rather than pasted into a command line.
 */
export function openExternalUrl(url: string): void {
	if (!url) return;
	const [command, args] =
		process.platform === "darwin"
			? ["open", [url]]
			: process.platform === "win32"
				? ["cmd", ["/c", "start", "", url]]
				: ["xdg-open", [url]];
	try {
		const child = execFile(command, args, () => {
			// A failed open is not worth a message: the user sees that nothing happened.
		});
		child.on("error", () => {});
		child.unref();
	} catch {
		// No opener on this machine.
	}
}
