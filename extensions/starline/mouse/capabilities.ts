/**
 * What of Pi's renderer this build can actually reach.
 *
 * Pi's TUI internals carry no stability contract, so every method Starline
 * patches is probed before it is trusted. The probe is deliberately structural —
 * the method exists, is a function, and can be replaced and put back. Signature
 * drift is caught by `test/contract/pi-tui-contract.test.ts` in CI rather than
 * guessed at here: default parameters make `fn.length` a liar.
 */

export type MouseCapability =
	| "handleViewportInput"
	| "routeWheel"
	| "handleSelectionMouseEvent"
	| "copySelectionToClipboard"
	| "getWordSelection"
	| "getSelectionBounds"
	| "getSelectionColumns"
	| "flash";

export type MouseFeature =
	| "selectionPendingMode"
	| "pathAwareWords"
	| "clickToExpandTools"
	| "editorWheelScroll"
	| "editorClickToCaret"
	| "editorBufferCopy";

const CAPABILITIES: readonly MouseCapability[] = [
	"handleViewportInput",
	"routeWheel",
	"handleSelectionMouseEvent",
	"copySelectionToClipboard",
	"getWordSelection",
	"getSelectionBounds",
	"getSelectionColumns",
	"flash",
];

/**
 * Every capability a feature needs before it may install.
 *
 * There is no `frameFreeSelection` entry, deliberately: the feature is cut
 * (see `installMouse` in `index.ts`). A feature listed here is one
 * `installMouse` installs, and a table that claims a feature nothing installs
 * is worse than no table.
 */
const REQUIREMENTS: Record<MouseFeature, readonly MouseCapability[]> = {
	// Without ctrl+c interception the pending mode strands a highlight the user
	// cannot copy, which is worse than copy-on-release. It also reads the
	// selection directly (`getSelectionBounds`, `getSelectionColumns`) to build
	// an exact character count, and raises its own notice (`flash`), so all
	// three must be reachable too.
	selectionPendingMode: [
		"copySelectionToClipboard",
		"handleViewportInput",
		"getSelectionBounds",
		"getSelectionColumns",
		"flash",
	],
	pathAwareWords: ["getWordSelection"],
	clickToExpandTools: ["handleSelectionMouseEvent"],
	editorWheelScroll: ["routeWheel"],
	editorClickToCaret: ["handleSelectionMouseEvent"],
	editorBufferCopy: ["copySelectionToClipboard"],
};

function isPatchable(prototype: object, name: string): boolean {
	try {
		let current: object | null = prototype;
		while (current) {
			const descriptor = Object.getOwnPropertyDescriptor(current, name);
			if (descriptor) {
				if (typeof descriptor.value !== "function") return false;
				return descriptor.writable === true && descriptor.configurable === true;
			}
			current = Object.getPrototypeOf(current);
		}
		return false;
	} catch {
		// A prototype that throws on inspection is one we do not touch.
		return false;
	}
}

export function probeCapabilities(prototype: object): ReadonlySet<MouseCapability> {
	const found = new Set<MouseCapability>();
	for (const capability of CAPABILITIES) {
		if (isPatchable(prototype, capability)) found.add(capability);
	}
	return found;
}

export function enabledFeatures(
	available: ReadonlySet<MouseCapability>,
): ReadonlySet<MouseFeature> {
	const enabled = new Set<MouseFeature>();
	for (const [feature, needed] of Object.entries(REQUIREMENTS) as [
		MouseFeature,
		readonly MouseCapability[],
	][]) {
		if (needed.every((capability) => available.has(capability))) enabled.add(feature);
	}
	return enabled;
}

/**
 * One line naming everything that will not run, or null when all is well. Pi
 * prints this once per process — a line per feature would be noise on a build
 * where Pi has moved on.
 */
export function disabledFeatureWarning(enabled: ReadonlySet<MouseFeature>): string | null {
	const disabled = (Object.keys(REQUIREMENTS) as MouseFeature[]).filter(
		(feature) => !enabled.has(feature),
	);
	if (disabled.length === 0) return null;
	return `[starline] This Pi build does not expose what these mouse features need, so they are off: ${disabled.join(", ")}. Everything else still works.`;
}
