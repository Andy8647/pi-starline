import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { getSettingsListTheme } from "@earendil-works/pi-coding-agent";
import {
	type AutocompleteItem,
	Key,
	matchesKey,
	type SettingItem,
	SettingsList,
	type SettingsListTheme,
	truncateToWidth,
} from "@earendil-works/pi-tui";
import {
	type ColorSource,
	type ColorSourcesConfig,
	type ContextStyle,
	type ExtensionStatusColorMode,
	type ExtensionStatusPlacement,
	type GitBranchConfig,
	type GitBranchMaxLength,
	getExtensionStatusColorMode,
	getExtensionStatusPlacement,
	type IconMode,
	isExtensionStatusColorMode,
	isExtensionStatusPlacement,
	type MouseConfig,
	type PathDisplayConfig,
	type PathDisplayMode,
	type PolishedTuiConfig,
	type UiFeaturesConfig,
} from "./config";
import { sanitizeExtensionStatusText } from "./extension-status";
import { isIconMode } from "./icons";
import { pillActionFor, runPillAction } from "./pill-actions";
import { getPillAnchor } from "./pill-anchors";
import {
	EXTENSION_STATUS_PREFIX,
	isKnownPillSegment,
	movePillSegment,
	PILL_SEGMENT_NAMES,
	pillSegmentPosition,
} from "./pill-config";
import type { SessionLifecycle } from "./session-lifecycle";
import { EDITOR_BORDER_STYLE, renderChromeBorder, safeThemeFg } from "./style";

const colorSourceValues: ColorSource[] = ["theme", "terminal"];
const extensionStatusPlacementValues: ExtensionStatusPlacement[] = [
	"off",
	"left",
	"middle",
	"right",
];
const extensionStatusColorModeValues: ExtensionStatusColorMode[] = ["themed", "original"];
const contextStyleValues: ContextStyle[] = ["text", "gauge", "text+gauge"];
const pathDisplayModeValues: PathDisplayMode[] = ["basename", "full"];
const pathDepthValues = ["0", "1", "2", "3", "4", "5"] as const;
const branchLengthPresetValues = ["full", "10", "20", "30", "40", "50"] as const;
const iconModeValues: IconMode[] = ["auto", "nerd", "ascii"];
type FeatureState = "enabled" | "disabled";

const featureStateValues: FeatureState[] = ["enabled", "disabled"];
const settingsSections = ["coloring", "features", "layout", "pills", "extensionSegments"] as const;

type ColorSettingId = "starship" | "editorChrome";
type FeatureSettingId = keyof UiFeaturesConfig;
type SettingsSection = (typeof settingsSections)[number];
type LayoutSettingId = "contextStyle" | "pathDisplay" | "pathDepth" | "branchLength" | "iconMode";

type SettingsCommandDeps = {
	sessionLifecycle: SessionLifecycle;
	getConfig: () => PolishedTuiConfig;
	setColorSources: (patch: Partial<ColorSourcesConfig>) => void;
	setUiFeatures: (
		patch: Partial<UiFeaturesConfig>,
		ctx: ExtensionContext,
	) => { applied: boolean; reason?: string };
	setIconMode: (mode: IconMode) => void;
	setContextStyle: (style: ContextStyle) => void;
	setPathDisplay: (patch: Partial<PathDisplayConfig>) => void;
	setGitBranch: (patch: Partial<GitBranchConfig>) => void;
	setPillSegments: (segments: readonly string[]) => void;
	getActiveExtensionStatuses: () => ReadonlyMap<string, string>;
	setExtensionStatusPlacement: (key: string, placement: ExtensionStatusPlacement) => void;
	setExtensionStatusColorMode: (key: string, colorMode: ExtensionStatusColorMode) => void;
	setMouseConfig: (patch: Partial<MouseConfig>, ctx: ExtensionContext) => void;
	requestRender: () => void;
	settingsListTheme?: SettingsListTheme;
};

const colorSettingLabels: Record<ColorSettingId, string> = {
	starship: "Starship/footer colors",
	editorChrome: "Editor and selectors",
};

const colorSettingDescriptions: Record<ColorSettingId, string> = {
	starship:
		"Choose whether footer runtime/git/context colors use Pi theme tokens or terminal palette styles.",
	editorChrome:
		"Choose whether the editor's and selectors' borders and rail use Pi theme colors or terminal palette styles. User messages are styled by pi-tidy.",
};

const featureSettingLabels: Record<FeatureSettingId, string> = {
	editor: "Editor",
	statusLine: "Status line",
	copyFriendly: "Copy-friendly mode",
};

const featureSettingDescriptions: Record<FeatureSettingId, string> = {
	editor: "Enable or disable Starline's custom editor and selector borders.",
	statusLine: "Enable or disable Starline's custom footer/status line.",
	copyFriendly:
		"Hide editor and previous-message rail glyphs for cleaner native terminal selection.",
};

/** Row label per bar segment. The order rows are listed in is fixed. */
const pillSegmentLabels: Record<string, string> = {
	model: "Model",
	thinking: "Thinking",
	queue: "Queue",
	subagents: "Subagents",
	cwd: "Directory",
	sessionName: "Session name",
	git: "Git",
	gitCommit: "Git commit",
	gitTag: "Git tag",
	gitMetrics: "Git line metrics",
	runtime: "Runtime",
	context: "Context",
	cost: "Cost",
	sessionDuration: "Session duration",
	username: "user@host",
	time: "Time",
	os: "OS",
	packageVersion: "Package version",
	extensionStatus: "Other extensions",
};

const pillSegmentSettingPrefix = "pillSegment:";

function pillSegmentSettingId(name: string): string {
	return `${pillSegmentSettingPrefix}${name}`;
}

function pillSegmentFromId(id: string): string | undefined {
	if (!id.startsWith(pillSegmentSettingPrefix)) return undefined;
	const name = id.slice(pillSegmentSettingPrefix.length);
	// Per-status segments (`extensionStatus:<key>`) are rows too; the key is read
	// from whatever the extension published this session, so any key is valid.
	return isKnownPillSegment(name) ? name : undefined;
}

/** Row label for a segment, including the single-status rows. */
function pillSegmentLabel(name: string): string {
	const builtin = pillSegmentLabels[name];
	if (builtin) return builtin;
	return name.startsWith(EXTENSION_STATUS_PREFIX)
		? name.slice(EXTENSION_STATUS_PREFIX.length)
		: name;
}

/**
 * Values a row cycles through: `off`, then every position the bar can hold.
 *
 * A segment that is not on the bar gets one extra value so it can be appended to
 * the end. A segment that is already on the bar must not get it: appending it
 * would put it back where it already is, so the cycle would bounce between the
 * last position and a number that renders as that same position, and `off` would
 * become unreachable — which is exactly how a segment at the end of the bar got
 * stuck.
 */
function pillSegmentValues(shown: number, onBar: boolean): string[] {
	const positions = Array.from({ length: onBar ? shown : shown + 1 }, (_, index) =>
		String(index + 1),
	);
	return ["off", ...positions];
}

const directCommandSuggestions = [
	"editor enable",
	"editor disable",
	"editor toggle",
	"statusline enable",
	"statusline disable",
	"statusline toggle",
	"copy-friendly enable",
	"copy-friendly disable",
	"copy-friendly toggle",
	"mouse enable",
	"mouse disable",
	"mouse toggle",
	"queue",
	"subagents",
	"thinking",
];

const sectionLabels: Record<SettingsSection, string> = {
	coloring: "Coloring",
	features: "Features",
	layout: "Layout",
	pills: "Pills",
	extensionSegments: "Extension segments",
};

const thirdPartyStatusSettingPrefix = "thirdPartyStatus:";
type ThirdPartyStatusSettingKind = "placement" | "colorMode";

function isColorSource(value: string): value is ColorSource {
	return value === "theme" || value === "terminal";
}

function isColorSettingId(value: string): value is ColorSettingId {
	return value === "starship" || value === "editorChrome";
}

function isFeatureSettingId(value: string): value is FeatureSettingId {
	return value === "editor" || value === "statusLine" || value === "copyFriendly";
}

function isFeatureState(value: string): value is FeatureState {
	return value === "enabled" || value === "disabled";
}

function isContextStyle(value: string): value is ContextStyle {
	return value === "text" || value === "gauge" || value === "text+gauge";
}

function isPathDisplayMode(value: string): value is PathDisplayMode {
	return value === "basename" || value === "full";
}

function isPathDepthValue(value: string): boolean {
	return (pathDepthValues as readonly string[]).includes(value);
}

function parseGitBranchLengthValue(value: string): GitBranchMaxLength | undefined {
	if (value === "full") return value;
	const parsed = Number(value);
	return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined;
}

function branchLengthValues(maxLength: GitBranchMaxLength): string[] {
	const current = String(maxLength);
	return (branchLengthPresetValues as readonly string[]).includes(current)
		? [...branchLengthPresetValues]
		: [current, ...branchLengthPresetValues];
}

function isLayoutSettingId(value: string): value is LayoutSettingId {
	return (
		value === "contextStyle" ||
		value === "pathDisplay" ||
		value === "pathDepth" ||
		value === "branchLength" ||
		value === "iconMode"
	);
}

function patchForSetting(id: ColorSettingId, value: ColorSource): Partial<ColorSourcesConfig> {
	return id === "starship" ? { starship: value } : { editor: value };
}

function featureValue(enabled: boolean): FeatureState {
	return enabled ? "enabled" : "disabled";
}

function featurePatch(id: FeatureSettingId, value: FeatureState): Partial<UiFeaturesConfig> {
	return { [id]: value === "enabled" } as Partial<UiFeaturesConfig>;
}

function usageText(): string {
	return "Usage: /starline [editor|statusline|copy-friendly] [enable|disable|toggle], or /starline queue";
}

function featureNotification(
	feature: FeatureSettingId,
	value: FeatureState,
	result: { applied: boolean; reason?: string },
): string {
	const base = `${featureSettingLabels[feature]}: ${value}`;
	return result.applied ? base : `${base} (${result.reason ?? "reload Pi to apply this change"})`;
}

function parseDirectFeatureCommand(
	args: string,
	config: PolishedTuiConfig,
): { feature: FeatureSettingId; enabled: boolean } | undefined {
	const normalized = args.trim().toLowerCase().replaceAll(/[_-]+/g, " ");
	if (!normalized) return undefined;

	const words = normalized.split(/\s+/g).filter(Boolean);
	const hasWord = (value: string) => words.includes(value);
	const feature = hasWord("editor")
		? "editor"
		: hasWord("footer") || hasWord("statusline") || hasWord("status")
			? "statusLine"
			: hasWord("copyfriendly") || hasWord("copy")
				? "copyFriendly"
				: undefined;
	const action = hasWord("toggle")
		? "toggle"
		: hasWord("enable") || hasWord("enabled") || hasWord("on")
			? "enable"
			: hasWord("disable") || hasWord("disabled") || hasWord("off")
				? "disable"
				: undefined;

	if (!feature || !action) return undefined;

	return {
		feature,
		enabled: action === "toggle" ? !config.features[feature] : action === "enable",
	};
}

function parseMouseCommand(
	args: string,
	config: PolishedTuiConfig,
): { enabled: boolean } | undefined {
	const normalized = args.trim().toLowerCase().replaceAll(/[_-]+/g, " ");
	if (!normalized) return undefined;

	const words = normalized.split(/\s+/g).filter(Boolean);
	const hasWord = (value: string) => words.includes(value);
	if (!hasWord("mouse")) return undefined;

	const action = hasWord("toggle")
		? "toggle"
		: hasWord("enable") || hasWord("enabled") || hasWord("on")
			? "enable"
			: hasWord("disable") || hasWord("disabled") || hasWord("off")
				? "disable"
				: undefined;
	if (!action) return undefined;

	return {
		enabled: action === "toggle" ? !config.mouse.enabled : action === "enable",
	};
}

function argumentCompletions(prefix: string): AutocompleteItem[] | null {
	const trimmedPrefix = prefix.trimStart().toLowerCase();
	const items = directCommandSuggestions.map((value) => ({ value, label: value }));
	const matches = items.filter((item) => item.value.startsWith(trimmedPrefix));
	return matches.length > 0 ? matches : null;
}

function thirdPartyStatusSettingId(key: string, kind: ThirdPartyStatusSettingKind): string {
	return `${thirdPartyStatusSettingPrefix}${kind}:${key}`;
}

function thirdPartyStatusSettingFromId(
	id: string,
): { kind: ThirdPartyStatusSettingKind; key: string } | undefined {
	if (!id.startsWith(thirdPartyStatusSettingPrefix)) return undefined;
	const rest = id.slice(thirdPartyStatusSettingPrefix.length);
	const separatorIndex = rest.indexOf(":");
	if (separatorIndex < 0) return undefined;

	const kind = rest.slice(0, separatorIndex);
	if (kind !== "placement" && kind !== "colorMode") return undefined;

	return { kind, key: rest.slice(separatorIndex + 1) };
}

function buildItems(
	section: SettingsSection,
	config: PolishedTuiConfig,
	activeStatuses: ReadonlyMap<string, string>,
): SettingItem[] {
	if (section === "coloring") {
		return (Object.keys(colorSettingLabels) as ColorSettingId[]).map((key) => ({
			id: key,
			label: colorSettingLabels[key],
			description: colorSettingDescriptions[key],
			currentValue: key === "starship" ? config.colorSources.starship : config.colorSources.editor,
			values: colorSourceValues,
		}));
	}

	if (section === "features") {
		const items: SettingItem[] = (Object.keys(featureSettingLabels) as FeatureSettingId[]).map(
			(key) => ({
				id: key,
				label: featureSettingLabels[key],
				description: featureSettingDescriptions[key],
				currentValue: featureValue(config.features[key]),
				values: featureStateValues,
			}),
		);
		items.push({
			id: "mouse",
			label: "Mouse features",
			description:
				"Wheel routing, click-to-expand tool boxes, path-aware word selection, and Starline's own copy behaviour.",
			currentValue: featureValue(config.mouse.enabled),
			values: featureStateValues,
		});
		if (config.mouse.enabled) {
			items.push({
				id: "mouseWheelRouting",
				label: "Wheel routing",
				description:
					"Scroll transcript with mouse wheel. Breaks native terminal selection and tmux scrollback.",
				currentValue: featureValue(config.mouse.wheelRouting),
				values: featureStateValues,
			});
			items.push({
				id: "mouseCopyNotice",
				label: "Copy notice",
				description: "Show a 'Copied to clipboard' message for a copy Starline performs.",
				currentValue: featureValue(config.mouse.copyNotice),
				values: featureStateValues,
			});
		}
		return items;
	}

	if (section === "layout") {
		return [
			{
				id: "contextStyle",
				label: "Context style",
				description: "Render context as text, a gauge bar, or both.",
				currentValue: config.contextStyle,
				values: contextStyleValues,
			},
			{
				id: "pathDisplay",
				label: "Path display",
				description: "Show cwd as basename or full path (home contracted to ~).",
				currentValue: config.pathDisplay.mode,
				values: pathDisplayModeValues,
			},
			{
				id: "pathDepth",
				label: "Path depth",
				description:
					"In full mode, trailing directories to show (0 = all, max 5). Ignored for basename.",
				currentValue: String(config.pathDisplay.depth),
				values: [...pathDepthValues],
			},
			{
				id: "branchLength",
				label: "Branch length",
				description: "Show the full branch name or truncate it to a preset visible width.",
				currentValue: String(config.git.branch.maxLength),
				values: branchLengthValues(config.git.branch.maxLength),
			},
			{
				id: "iconMode",
				label: "Icon mode",
				description: "auto/nerd use Nerd Font glyphs; ascii uses plain fallbacks.",
				currentValue: config.icons.mode,
				values: iconModeValues,
			},
		];
	}

	if (section === "pills") {
		const segments = config.pill.segments;
		const row = (name: string, label: string): SettingItem => {
			const position = pillSegmentPosition(segments, name);
			const onBar = position > 0;
			const values = pillSegmentValues(segments.length, onBar);
			return {
				id: pillSegmentSettingId(name),
				label,
				description: `Position in the bar (1 is leftmost). Space cycles off → 1…${values.length - 1}.`,
				currentValue: onBar ? String(position) : "off",
				values,
			};
		};
		const items = PILL_SEGMENT_NAMES.map((name) => row(name, pillSegmentLabel(name)));
		// One row per status an extension published this session, so a single
		// status can be placed on the bar without editing starline.json. Sorted,
		// so the rows do not move under the cursor between changes.
		const statusKeys = [...activeStatuses.keys()].sort();
		for (const key of statusKeys) {
			items.push(row(`${EXTENSION_STATUS_PREFIX}${key}`, key));
		}
		return items;
	}

	const statuses = Array.from(activeStatuses.entries()).sort(([a], [b]) =>
		a < b ? -1 : a > b ? 1 : 0,
	);
	if (statuses.length === 0) {
		return [
			{
				id: "noThirdPartyStatuses",
				label: "No active statuses",
				description: "This tab only lists statuses currently published through ctx.ui.setStatus().",
				currentValue: "—",
			},
		];
	}

	return statuses.flatMap(([key, value]) => {
		const sanitizedText = sanitizeExtensionStatusText(value);
		const description = sanitizedText ? `Current status: ${sanitizedText}` : undefined;
		return [
			{
				id: thirdPartyStatusSettingId(key, "placement"),
				label: `${key} placement`,
				description,
				currentValue: getExtensionStatusPlacement(config, key),
				values: extensionStatusPlacementValues,
			},
			{
				id: thirdPartyStatusSettingId(key, "colorMode"),
				label: `${key} color`,
				description,
				currentValue: getExtensionStatusColorMode(config, key),
				values: extensionStatusColorModeValues,
			},
		];
	});
}

function nextSection(section: SettingsSection): SettingsSection {
	const currentIndex = settingsSections.indexOf(section);
	return settingsSections[(currentIndex + 1) % settingsSections.length] ?? "coloring";
}

function previousSection(section: SettingsSection): SettingsSection {
	const currentIndex = settingsSections.indexOf(section);
	return (
		settingsSections[(currentIndex - 1 + settingsSections.length) % settingsSections.length] ??
		"coloring"
	);
}

function formatSectionTabs(
	activeSection: SettingsSection,
	theme: ExtensionContext["ui"]["theme"],
): string {
	const rendered = settingsSections.map((section) => {
		const label = sectionLabels[section];
		return section === activeSection ? theme.bold(label) : safeThemeFg(theme, "muted", label);
	});
	return `  ${rendered.join(safeThemeFg(theme, "muted", " / "))}`;
}

function withSectionFooter(lines: string[], theme: ExtensionContext["ui"]["theme"]): string[] {
	const next = [...lines];
	for (let index = next.length - 1; index >= 0; index -= 1) {
		if (next[index]?.includes("Enter/Space")) {
			next[index] = safeThemeFg(
				theme,
				"muted",
				"  Enter/Space to change · Tab/Shift+Tab to switch sections · Esc to close",
			);
			break;
		}
	}
	return next;
}

export function registerStarlineSettingsCommand(pi: ExtensionAPI, deps: SettingsCommandDeps): void {
	pi.registerCommand("starline", {
		description: "Configure Starline",
		getArgumentCompletions: argumentCompletions,
		handler: async (_args, ctx) => {
			const args = typeof _args === "string" ? _args : "";

			const directCommand = parseDirectFeatureCommand(args, deps.getConfig());
			if (directCommand) {
				try {
					const result = deps.setUiFeatures(
						{ [directCommand.feature]: directCommand.enabled },
						ctx,
					);
					deps.requestRender();
					if (ctx.hasUI) {
						ctx.ui.notify(
							featureNotification(
								directCommand.feature,
								featureValue(directCommand.enabled),
								result,
							),
							"info",
						);
					}
				} catch (error) {
					const message = error instanceof Error ? error.message : String(error);
					if (ctx.hasUI) ctx.ui.notify(`Could not update Starline settings: ${message}`, "error");
				}
				return;
			}

			const mouseCommand = parseMouseCommand(args, deps.getConfig());
			if (mouseCommand) {
				try {
					deps.setMouseConfig({ enabled: mouseCommand.enabled }, ctx);
					deps.requestRender();
					if (ctx.hasUI) {
						ctx.ui.notify(`Mouse: ${featureValue(mouseCommand.enabled)}`, "info");
					}
				} catch (error) {
					const message = error instanceof Error ? error.message : String(error);
					if (ctx.hasUI) ctx.ui.notify(`Could not update mouse settings: ${message}`, "error");
				}
				return;
			}

			// The keyboard half of a clickable pill: same action, same bubble, pointed at
			// the pill the footer last drew. Only segments with an action resolve, so an
			// unknown word still falls through to the usage warning below.
			const actionKey = args.trim().toLowerCase();
			const action = pillActionFor(actionKey);
			if (action) {
				runPillAction(action, ctx, getPillAnchor(actionKey), "command");
				return;
			}

			if (args.trim()) {
				if (ctx.hasUI) ctx.ui.notify(usageText(), "warning");
				return;
			}

			const mode = (ctx as typeof ctx & { mode?: string }).mode;
			if (!ctx.hasUI || (mode !== undefined && mode !== "tui")) return;

			await ctx.ui.custom<void>((tui, theme, _keybindings, done) => {
				const settingsListTheme = deps.settingsListTheme ?? getSettingsListTheme();
				let activeSection: SettingsSection = "coloring";
				const applyFeatureChange = (id: FeatureSettingId, newValue: FeatureState) => {
					const result = deps.setUiFeatures(featurePatch(id, newValue), ctx);
					deps.requestRender();
					ctx.ui.notify(featureNotification(id, newValue, result), "info");
					tui.requestRender();
				};
				let settingsList: SettingsList;
				const makeSettingsList = () =>
					new SettingsList(
						buildItems(activeSection, deps.getConfig(), deps.getActiveExtensionStatuses()),
						8,
						settingsListTheme,
						(id, newValue) => {
							try {
								if (isColorSettingId(id) && isColorSource(newValue)) {
									deps.setColorSources(patchForSetting(id, newValue));
									settingsList.updateValue(id, newValue);
									deps.requestRender();
									ctx.ui.notify(`${colorSettingLabels[id]}: ${newValue}`, "info");
									tui.requestRender();
									return;
								}

								if (isFeatureSettingId(id) && isFeatureState(newValue)) {
									if (id === "editor") {
										done(undefined);
										// Changing the editor component while ctx.ui.custom() is active clears the
										// custom component without resolving it, leaving Pi's input loop stuck.
										// Close the settings UI first, then apply the editor swap on the next tick.
										const applyEditorChange = () => {
											try {
												applyFeatureChange(id, newValue);
											} catch (error) {
												const message = error instanceof Error ? error.message : String(error);
												ctx.ui.notify(`Could not update Starline settings: ${message}`, "error");
											}
										};
										deps.sessionLifecycle.defer(applyEditorChange);
										return;
									}

									applyFeatureChange(id, newValue);
									settingsList.updateValue(id, newValue);
									return;
								}

								if (isLayoutSettingId(id)) {
									if (id === "contextStyle" && isContextStyle(newValue)) {
										deps.setContextStyle(newValue);
										settingsList.updateValue(id, newValue);
										deps.requestRender();
										ctx.ui.notify(`Context style: ${newValue}`, "info");
										tui.requestRender();
										return;
									}

									if (id === "pathDisplay" && isPathDisplayMode(newValue)) {
										deps.setPathDisplay({ mode: newValue });
										settingsList.updateValue(id, newValue);
										deps.requestRender();
										ctx.ui.notify(`Path display: ${newValue}`, "info");
										tui.requestRender();
										return;
									}

									if (id === "pathDepth" && isPathDepthValue(newValue)) {
										deps.setPathDisplay({ depth: Number(newValue) });
										settingsList.updateValue(id, newValue);
										deps.requestRender();
										ctx.ui.notify(`Path depth: ${newValue}`, "info");
										tui.requestRender();
										return;
									}

									if (id === "branchLength") {
										const maxLength = parseGitBranchLengthValue(newValue);
										if (maxLength === undefined) return;
										deps.setGitBranch({ maxLength });
										settingsList.updateValue(id, newValue);
										deps.requestRender();
										ctx.ui.notify(`Branch length: ${newValue}`, "info");
										tui.requestRender();
										return;
									}

									if (id === "iconMode" && isIconMode(newValue)) {
										deps.setIconMode(newValue);
										settingsList.updateValue(id, newValue);
										deps.requestRender();
										ctx.ui.notify(`Icon mode: ${newValue}`, "info");
										tui.requestRender();
									}
									return;
								}

								const pillSegment = pillSegmentFromId(id);
								if (pillSegment) {
									const segments = movePillSegment(
										deps.getConfig().pill.segments,
										pillSegment,
										newValue,
									);
									deps.setPillSegments(segments);
									// Every row's position can change, so the list is rebuilt
									// rather than patched — then the cursor is put back.
									settingsList = makeSettingsList();
									settingsList.selectItem(id);
									deps.requestRender();
									const label = pillSegmentLabel(pillSegment);
									ctx.ui.notify(
										newValue === "off" ? `${label}: off` : `${label}: position ${newValue}`,
										"info",
									);
									tui.requestRender();
									return;
								}

								if (id === "mouse" && isFeatureState(newValue)) {
									deps.setMouseConfig({ enabled: newValue === "enabled" }, ctx);
									settingsList = makeSettingsList();
									deps.requestRender();
									ctx.ui.notify(`Mouse: ${newValue}`, "info");
									tui.requestRender();
									return;
								}
								if (id === "mouseWheelRouting" && isFeatureState(newValue)) {
									deps.setMouseConfig({ wheelRouting: newValue === "enabled" }, ctx);
									settingsList.updateValue(id, newValue);
									deps.requestRender();
									ctx.ui.notify(`Wheel routing: ${newValue}`, "info");
									tui.requestRender();
									return;
								}
								if (id === "mouseCopyNotice" && isFeatureState(newValue)) {
									deps.setMouseConfig({ copyNotice: newValue === "enabled" }, ctx);
									settingsList.updateValue(id, newValue);
									deps.requestRender();
									ctx.ui.notify(`Copy notice: ${newValue}`, "info");
									tui.requestRender();
									return;
								}

								const thirdPartyStatusSetting = thirdPartyStatusSettingFromId(id);
								if (
									thirdPartyStatusSetting?.kind === "placement" &&
									isExtensionStatusPlacement(newValue)
								) {
									deps.setExtensionStatusPlacement(thirdPartyStatusSetting.key, newValue);
									settingsList.updateValue(id, newValue);
									deps.requestRender();
									ctx.ui.notify(
										`Third-party status ${thirdPartyStatusSetting.key} placement: ${newValue}`,
										"info",
									);
									tui.requestRender();
									return;
								}

								if (
									thirdPartyStatusSetting?.kind === "colorMode" &&
									isExtensionStatusColorMode(newValue)
								) {
									deps.setExtensionStatusColorMode(thirdPartyStatusSetting.key, newValue);
									settingsList.updateValue(id, newValue);
									deps.requestRender();
									ctx.ui.notify(
										`Third-party status ${thirdPartyStatusSetting.key} color: ${newValue}`,
										"info",
									);
									tui.requestRender();
								}
							} catch (error) {
								settingsList = makeSettingsList();
								tui.requestRender();
								const message = error instanceof Error ? error.message : String(error);
								ctx.ui.notify(`Could not update Starline settings: ${message}`, "error");
							}
						},
						() => done(undefined),
					);
				settingsList = makeSettingsList();
				const switchSection = (direction: "forward" | "backward") => {
					activeSection =
						direction === "forward" ? nextSection(activeSection) : previousSection(activeSection);
					settingsList = makeSettingsList();
					tui.requestRender();
				};

				return {
					render(width: number) {
						const colorSource = deps.getConfig().colorSources.editor;
						const border = renderChromeBorder(
							theme,
							colorSource,
							EDITOR_BORDER_STYLE,
							"─".repeat(Math.max(0, width)),
						);
						return [
							truncateToWidth(border, width, ""),
							truncateToWidth(formatSectionTabs(activeSection, theme), width, ""),
							truncateToWidth(border, width, ""),
							...withSectionFooter(settingsList.render(width), theme).map((line) =>
								truncateToWidth(line, width, ""),
							),
							truncateToWidth(border, width, ""),
						];
					},
					invalidate() {
						settingsList.invalidate();
					},
					handleInput(data: string) {
						if (matchesKey(data, Key.tab)) {
							switchSection("forward");
							return;
						}
						if (matchesKey(data, Key.shift("tab"))) {
							switchSection("backward");
							return;
						}
						settingsList.handleInput(data);
					},
				};
			});
		},
	});
}
