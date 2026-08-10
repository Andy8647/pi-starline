import type {
	ExtensionAPI,
	ExtensionContext,
	KeybindingsManager,
	Theme,
} from "@earendil-works/pi-coding-agent";
import { type EditorTheme, type TUI, TuiAltScreen } from "@earendil-works/pi-tui";
import {
	type ColorSourcesConfig,
	type ContextStyle,
	type ExtensionStatusColorMode,
	type ExtensionStatusPlacement,
	ensureConfigExists,
	type FooterSegmentsConfig,
	type GitBranchConfig,
	type IconMode,
	loadConfig,
	type MouseConfig,
	type PathDisplayConfig,
	type PolishedTuiConfig,
	type SeparatorStyle,
	saveColorSourcesPatch,
	saveContextStylePatch,
	saveExtensionStatusColorMode,
	saveExtensionStatusPlacement,
	saveFooterFormatPatch,
	saveFooterSegmentsPatch,
	saveGitBranchPatch,
	saveIconsModePatch,
	saveMousePatch,
	savePathDisplayPatch,
	saveSeparatorPatch,
	saveUiFeaturesPatch,
	type UiFeaturesConfig,
} from "./config";
import {
	getStarlineEditorBaseFactory,
	isStarlineEditorFactory,
	markEditorFactory,
} from "./editor-factory-marker";
import { installFooter } from "./footer";
import { buildSessionDurationLabel, invalidateUsageTotalsCache } from "./format";
import { emptyGitStatus, readGitHost, readGitStatus } from "./git";
import { LiveContextController } from "./live-context";
import { installMouse } from "./mouse";
import { setActiveEditor } from "./mouse/editor-mouse";
import { readPackageVersionResult } from "./package-version";
import { installPasteCollapse } from "./paste-collapse";
import {
	createProjectRefreshScheduler,
	type ScheduleProjectRefreshOptions,
	type StopProjectRefreshInterval,
	startProjectRefreshInterval,
} from "./project-refresh";
import { applyProjectRefreshToState } from "./project-state";
import { readRuntimeInfo } from "./runtime";
import { installSelectorBorderStyle } from "./selector-border";
import { SessionLifecycle } from "./session-lifecycle";
import { registerStarlineSettingsCommand } from "./settings-command";
import { createInitialState, type FooterState, syncState } from "./state";
import { PolishedEditor, WrappedPolishedEditor } from "./ui";
import { installUserMessageStyle } from "./user-message";

type EditorFactory = NonNullable<Parameters<ExtensionContext["ui"]["setEditorComponent"]>[0]>;

type ApplyUiResult = {
	editorBlocked: boolean;
};

type EditorInstallMode = "none" | "standalone" | "wrapper";

function isTuiContext(ctx: ExtensionContext): boolean {
	try {
		const mode = (ctx as ExtensionContext & { mode?: string }).mode;
		return ctx.hasUI && (mode === undefined || mode === "tui");
	} catch {
		return false;
	}
}

export default function (pi: ExtensionAPI) {
	const state: FooterState = createInitialState(emptyGitStatus());
	const sessionLifecycle = new SessionLifecycle();

	let currentConfig: PolishedTuiConfig = loadConfig();
	let activeTheme: Theme | undefined;
	let requestFooterRender: (() => void) | undefined;
	let getActiveExtensionStatuses: () => ReadonlyMap<string, string> = () => new Map();
	let stopRefreshInterval: StopProjectRefreshInterval = () => {};
	let cleanupPrototypePatches: () => void = () => {};
	let footerInstalled = false;
	let editorInstalled = false;
	let editorInstallMode: EditorInstallMode = "none";
	let installedEditorFactory: EditorFactory | undefined;
	let wrappedEditorFactory: EditorFactory | undefined;
	let prototypePatchesInstalled = false;
	let stopSessionTimer: () => void = () => {};
	let lastDurationLabel = "";
	let lastProjectCwd: string | undefined;
	let disposePasteCollapse: (() => void) | undefined;
	let disposeMouse: (() => void) | undefined;

	const refresh = () => {
		if (sessionLifecycle.isCurrent()) requestFooterRender?.();
	};
	const liveContext = new LiveContextController(sessionLifecycle, refresh);
	const getActiveTheme = () => activeTheme;
	const getCurrentConfig = () => currentConfig;
	const getThinkingLevel = () =>
		sessionLifecycle.isCurrent() ? pi.getThinkingLevel() : ("off" as const);
	const syncFooterState = (ctx: ExtensionContext) =>
		syncState(
			state,
			ctx,
			currentConfig.icons.cacheHit,
			currentConfig.editorModelLabel,
			currentConfig.segmentOptions.tokens.cache,
		);

	type ProjectRefreshTarget = { cwd: string; generation: number };
	const refreshProjectState = async ({ cwd, generation }: ProjectRefreshTarget) => {
		if (!sessionLifecycle.isCurrent(generation)) return;
		const gitCommitConfig = currentConfig.gitCommit;
		const gitMetricsConfig = currentConfig.gitMetrics;
		const segments = currentConfig.footerSegments;
		const fmt = currentConfig.footerFormat;
		// Enable optional probes when the segment is on OR a custom footerFormat
		// references the relevant variable. Mirrors the session-duration timer
		// pattern so format-only users still get data.
		const formatNeedsTag = /\$\{?(?:git_tag|tag)\b/.test(fmt);
		const formatNeedsCommit = /\$\{?(?:git_commit|commit)\b/.test(fmt);
		const formatNeedsMetrics = /\$\{?(?:git_metrics|git_added|git_deleted)\b/.test(fmt);
		const formatNeedsPackage = /\$\{?(?:package|package_version)\b/.test(fmt);
		const wantExactTag =
			((segments.gitCommit || formatNeedsCommit) && gitCommitConfig.showTag) || formatNeedsTag;
		const wantMetrics = segments.gitMetrics || formatNeedsMetrics;
		const wantPackage = segments.packageVersion || formatNeedsPackage;
		const [git, runtime, packageVersion, gitHost] = await Promise.all([
			readGitStatus(cwd, {
				readExactTag: wantExactTag,
				readMetrics: wantMetrics,
				ignoreSubmodules: gitMetricsConfig.ignoreSubmodules,
			}),
			readRuntimeInfo(cwd),
			wantPackage ? readPackageVersionResult(cwd) : Promise.resolve(undefined),
			currentConfig.gitHostIcon ? readGitHost(cwd) : Promise.resolve(undefined),
		]);
		if (!sessionLifecycle.isCurrent(generation)) return;
		lastProjectCwd = applyProjectRefreshToState(state, {
			cwd,
			previousCwd: lastProjectCwd,
			git,
			gitHost,
			runtime,
			packageVersion,
		});
	};

	const projectRefreshScheduler = createProjectRefreshScheduler(refreshProjectState, refresh);
	const scheduleProjectRefresh = (
		ctx: ExtensionContext,
		options?: ScheduleProjectRefreshOptions,
	) => {
		const generation = sessionLifecycle.currentGeneration();
		if (!sessionLifecycle.isCurrent(generation)) return;
		const cwd = ctx.cwd;
		projectRefreshScheduler.schedule({ cwd, generation }, options);
	};

	const refreshInteractiveState = (ctx: ExtensionContext, project = false) => {
		if (!sessionLifecycle.isCurrent() || !ctx.hasUI) return;
		syncFooterState(ctx);
		if (project && currentConfig.features.statusLine) scheduleProjectRefresh(ctx);
		refresh();
	};

	const stopProjectRefresh = () => {
		stopRefreshInterval();
		stopRefreshInterval = () => {};
		projectRefreshScheduler.stop();
	};

	const startSessionTimer = () => {
		stopSessionTimer();
		lastDurationLabel = "";
		const timer = setInterval(() => {
			if (!sessionLifecycle.isCurrent()) return;
			const segments = currentConfig.footerSegments;
			const formatNeedsTimer =
				currentConfig.footerFormat &&
				/\$\{?(?:time|session_duration|duration)\b/.test(currentConfig.footerFormat);
			if (
				!(
					currentConfig.features.statusLine &&
					(segments.sessionDuration || segments.time || formatNeedsTimer)
				)
			)
				return;
			if (segments.time || formatNeedsTimer) {
				refresh();
				return;
			}
			const label = state.sessionStartEpoch
				? buildSessionDurationLabel(state.sessionStartEpoch)
				: "";
			if (label === lastDurationLabel) return;
			lastDurationLabel = label;
			refresh();
		}, 1000);
		stopSessionTimer = () => {
			clearInterval(timer);
			stopSessionTimer = () => {};
		};
	};

	const installPrototypePatches = () => {
		if (prototypePatchesInstalled) return;
		const cleanupSelectorBorderStyle = installSelectorBorderStyle(getActiveTheme, getCurrentConfig);
		const cleanupUserMessageStyle = installUserMessageStyle(getActiveTheme, getCurrentConfig);
		cleanupPrototypePatches = () => {
			cleanupSelectorBorderStyle();
			cleanupUserMessageStyle();
		};
		prototypePatchesInstalled = true;
	};

	const uninstallPrototypePatches = () => {
		cleanupPrototypePatches();
		cleanupPrototypePatches = () => {};
		prototypePatchesInstalled = false;
	};

	const uninstallMouse = () => {
		disposeMouse?.();
		disposeMouse = undefined;
	};

	/**
	 * Install the mouse features on `TuiAltScreen.prototype`.
	 *
	 * The prototype, not an instance: from 0.84 Pi hands extensions a Proxy over
	 * the live renderer and swaps the renderer itself when the TUI mode changes,
	 * so an instance captured at session start is not necessarily the one drawing
	 * later. The shared prototype survives both.
	 *
	 * Reinstalling is already safe — `installPrototypePatch` keeps one wrapper per
	 * adapter and only swaps the behaviour behind it — but disposing first keeps
	 * exactly one live registration, so the disposer held here always removes
	 * everything this extension put on the prototype.
	 *
	 * `mouse.enabled` is read here rather than captured, and every sub-option is
	 * read inside the patches themselves, so `/starline` toggles apply without a
	 * restart.
	 */
	const installMousePatches = () => {
		uninstallMouse();
		if (!getCurrentConfig().mouse.enabled) return;
		// Repaints are not wired from here: each patch asks its own receiver —
		// the live renderer it is running inside — to render. Handing it the
		// extension's `refresh` instead tied the pending hint to the footer's
		// existence, and the hint is in the editor.
		disposeMouse = installMouse(TuiAltScreen.prototype, { getConfig: getCurrentConfig });
	};

	/**
	 * `editorCursor: "terminal"` hides the software cursor so the real one shows
	 * through, which needs the hardware cursor to actually be on. Pi re-applies
	 * its own setting at several points, so an extension cannot turn it on
	 * reliably everywhere — set it here for the user asking for the terminal
	 * cursor, which is exactly the intent. Nothing is touched in other modes.
	 */
	const syncHardwareCursor = (tui: TUI) => {
		if (getCurrentConfig().editorCursor !== "terminal") return;
		try {
			(tui as TUI & { setShowHardwareCursor?: (on: boolean) => void }).setShowHardwareCursor?.(
				true,
			);
		} catch {
			// Older Pi builds may not expose it; the software cursor stays hidden either way.
		}
	};

	/**
	 * Lower the paste-collapse threshold on a freshly built editor. Patching the
	 * instance rather than subclassing covers the wrapped path too, where the
	 * base editor is somebody else's. A no-op when the editor does not expose
	 * what it needs, or when the option is left at Pi's own threshold.
	 */
	const applyPasteCollapse = (editor: unknown) => {
		disposePasteCollapse?.();
		disposePasteCollapse = installPasteCollapse(
			editor,
			() => getCurrentConfig().pasteCollapseLines,
		);
	};

	const makeEditorFactory = (ctx: ExtensionContext): EditorFactory => {
		const sessionTheme = ctx.ui.theme;
		const factory = ((tui: TUI, theme: EditorTheme, keybindings: KeybindingsManager) => {
			syncHardwareCursor(tui);
			const editor = new PolishedEditor(
				tui,
				theme,
				keybindings,
				sessionTheme,
				getCurrentConfig,
				() => ({
					modelLabel: state.modelLabel,
					modelId: state.modelId,
					modelName: state.modelName,
					providerLabel: state.providerLabel,
					sessionName: ctx.sessionManager.getSessionName() ?? "",
				}),
				getThinkingLevel,
			);
			applyPasteCollapse(editor);
			// Nothing on Pi's renderer points at the live editor, and the
			// extension API hands out the factory rather than what it built — so
			// the mouse patches learn about it here, from the one place in the
			// process that has it. See `mouse/editor-mouse.ts`.
			setActiveEditor({ component: editor, scrollable: editor });
			return editor;
		}) as EditorFactory;
		return markEditorFactory(factory);
	};

	const makeWrappedEditorFactory = (
		ctx: ExtensionContext,
		baseFactory: EditorFactory,
	): EditorFactory => {
		const sessionTheme = ctx.ui.theme;
		const factory = ((tui: TUI, theme: EditorTheme, keybindings: KeybindingsManager) => {
			syncHardwareCursor(tui);
			const base = baseFactory(tui, theme, keybindings);
			applyPasteCollapse(base);
			const wrapped = new WrappedPolishedEditor(
				base,
				sessionTheme,
				getCurrentConfig,
				() => ({
					modelLabel: state.modelLabel,
					modelId: state.modelId,
					modelName: state.modelName,
					providerLabel: state.providerLabel,
					sessionName: ctx.sessionManager.getSessionName() ?? "",
				}),
				getThinkingLevel,
			);
			// Two references, because these are two different objects here: the
			// wrapper is what gets mounted and hit-tested, while the draft's
			// visual lines live on the base editor it delegates to.
			setActiveEditor({ component: wrapped, scrollable: base });
			return wrapped;
		}) as EditorFactory;
		return markEditorFactory(factory, baseFactory);
	};

	const installEditor = (ctx: ExtensionContext): boolean => {
		const currentFactory = ctx.ui.getEditorComponent();
		if (currentFactory && currentFactory === installedEditorFactory) {
			editorInstalled = true;
			return true;
		}

		installPrototypePatches();
		const currentStarlineBaseFactory = getStarlineEditorBaseFactory<EditorFactory>(currentFactory);
		if (currentFactory && isStarlineEditorFactory(currentFactory)) {
			wrappedEditorFactory = currentStarlineBaseFactory;
			const nextFactory = currentStarlineBaseFactory
				? makeWrappedEditorFactory(ctx, currentStarlineBaseFactory)
				: makeEditorFactory(ctx);
			ctx.ui.setEditorComponent(nextFactory);
			installedEditorFactory = nextFactory;
			editorInstallMode = currentStarlineBaseFactory ? "wrapper" : "standalone";
		} else if (currentFactory) {
			wrappedEditorFactory = currentFactory;
			const nextFactory = makeWrappedEditorFactory(ctx, currentFactory);
			ctx.ui.setEditorComponent(nextFactory);
			installedEditorFactory = nextFactory;
			editorInstallMode = "wrapper";
		} else {
			wrappedEditorFactory = undefined;
			const nextFactory = makeEditorFactory(ctx);
			ctx.ui.setEditorComponent(nextFactory);
			installedEditorFactory = nextFactory;
			editorInstallMode = "standalone";
		}
		editorInstalled = true;
		return true;
	};

	const uninstallEditor = (ctx: ExtensionContext): boolean => {
		const currentFactory = ctx.ui.getEditorComponent();
		if (currentFactory && !isStarlineEditorFactory(currentFactory)) return false;

		uninstallPrototypePatches();
		ctx.ui.setEditorComponent(
			editorInstallMode === "wrapper" && wrappedEditorFactory ? wrappedEditorFactory : undefined,
		);
		wrappedEditorFactory = undefined;
		installedEditorFactory = undefined;
		editorInstallMode = "none";
		editorInstalled = false;
		// Pi rebuilds the editor from whatever factory is now in place, and that
		// one is not ours. Leaving the old instance registered would point the
		// wheel patch at an editor no longer on screen.
		setActiveEditor(undefined);
		return true;
	};

	const installStatusLine = (ctx: ExtensionContext) => {
		if (footerInstalled) return;
		installFooter(ctx, state, getCurrentConfig, {
			setRequestRender: (fn) => {
				requestFooterRender = fn;
			},
			scheduleProjectRefresh,
			setExtensionStatusesGetter(fn) {
				getActiveExtensionStatuses = fn ?? (() => new Map());
			},
			getLiveContext: () => liveContext.get(),
			getThinkingLevel,
		});
		footerInstalled = true;
		stopProjectRefresh();
		stopRefreshInterval = startProjectRefreshInterval(currentConfig.projectRefreshIntervalMs, () =>
			scheduleProjectRefresh(ctx),
		);
		scheduleProjectRefresh(ctx, { force: true });
		refresh();
		startSessionTimer();
	};

	const uninstallStatusLine = (ctx: ExtensionContext) => {
		stopSessionTimer();
		stopProjectRefresh();
		ctx.ui.setFooter(undefined);
		footerInstalled = false;
		requestFooterRender = undefined;
		getActiveExtensionStatuses = () => new Map();
	};

	const applyConfiguredUi = (ctx: ExtensionContext): ApplyUiResult => {
		const result: ApplyUiResult = { editorBlocked: false };
		if (!isTuiContext(ctx)) return result;
		activeTheme = ctx.ui.theme;
		if (currentConfig.features.editor) {
			const currentFactory = ctx.ui.getEditorComponent();
			const editorMissingOrReplaced = !editorInstalled || !isStarlineEditorFactory(currentFactory);
			if (editorMissingOrReplaced) result.editorBlocked = !installEditor(ctx);
		} else if (editorInstalled || prototypePatchesInstalled) {
			result.editorBlocked = !uninstallEditor(ctx);
		}

		if (currentConfig.features.statusLine) {
			installStatusLine(ctx);
		} else if (footerInstalled) {
			uninstallStatusLine(ctx);
		}
		return result;
	};

	const installUi = (ctx: ExtensionContext) => {
		if (!isTuiContext(ctx)) return;
		activeTheme = ctx.ui.theme;
		uninstallPrototypePatches();
		footerInstalled = false;
		editorInstalled = false;
		installedEditorFactory = undefined;
		ensureConfigExists();
		currentConfig = loadConfig();
		syncFooterState(ctx);
		stopProjectRefresh();
		applyConfiguredUi(ctx);
		installMousePatches();
		refresh();
	};

	const scheduleEditorReconciliation = (ctx: ExtensionContext) => {
		sessionLifecycle.defer(() => {
			if (!isTuiContext(ctx) || !currentConfig.features.editor) return;
			const currentFactory = ctx.ui.getEditorComponent();
			if (currentFactory && currentFactory !== installedEditorFactory) {
				applyConfiguredUi(ctx);
				refresh();
			}
		});
	};

	const cleanupUi = (ctx?: ExtensionContext) => {
		if (!ctx || !sessionLifecycle.isCurrent()) return;
		sessionLifecycle.shutdown();
		try {
			uninstallMouse();
			uninstallPrototypePatches();
			stopSessionTimer();
			stopProjectRefresh();
			requestFooterRender = undefined;
			getActiveExtensionStatuses = () => new Map();
			if (isTuiContext(ctx)) {
				ctx.ui.setFooter(undefined);
				const currentFactory = ctx.ui.getEditorComponent();
				if (!currentFactory || isStarlineEditorFactory(currentFactory)) {
					ctx.ui.setEditorComponent(
						getStarlineEditorBaseFactory<EditorFactory>(currentFactory) ??
							(editorInstallMode === "wrapper" && wrappedEditorFactory
								? wrappedEditorFactory
								: undefined),
					);
				}
			}
			wrappedEditorFactory = undefined;
			installedEditorFactory = undefined;
			editorInstallMode = "none";
			footerInstalled = false;
			editorInstalled = false;
			activeTheme = undefined;
		} finally {
			requestFooterRender = undefined;
		}
	};

	const syncInteractiveState = (_event: unknown, ctx: ExtensionContext) => {
		refreshInteractiveState(ctx);
	};
	const syncInteractiveAndProjectState = (_event: unknown, ctx: ExtensionContext) => {
		refreshInteractiveState(ctx, true);
	};

	pi.on("session_start", async (_event, ctx) => {
		sessionLifecycle.start();
		liveContext.clear();
		state.sessionStartEpoch = Date.now();
		invalidateUsageTotalsCache();
		lastProjectCwd = undefined;
		installUi(ctx);
		scheduleEditorReconciliation(ctx);
	});

	registerStarlineSettingsCommand(pi, {
		sessionLifecycle,
		getConfig: getCurrentConfig,
		setColorSources(patch: Partial<ColorSourcesConfig>) {
			currentConfig = saveColorSourcesPatch(patch);
		},
		setUiFeatures(patch: Partial<UiFeaturesConfig>, ctx: ExtensionContext) {
			currentConfig = saveUiFeaturesPatch(patch);
			const result = applyConfiguredUi(ctx);
			return {
				applied: !(patch.editor !== undefined && result.editorBlocked),
				reason: result.editorBlocked
					? "another extension is currently managing the editor; reload Pi to apply this change"
					: undefined,
			};
		},
		setFooterSegments(patch: Partial<FooterSegmentsConfig>) {
			currentConfig = saveFooterSegmentsPatch(patch);
		},
		setFooterFormat(value: string) {
			currentConfig = saveFooterFormatPatch(value);
		},
		setIconMode(mode: IconMode) {
			currentConfig = saveIconsModePatch(mode);
		},
		setContextStyle(style: ContextStyle) {
			currentConfig = saveContextStylePatch(style);
		},
		setSeparator(separator: SeparatorStyle) {
			currentConfig = saveSeparatorPatch(separator);
		},
		setPathDisplay(patch: Partial<PathDisplayConfig>) {
			currentConfig = savePathDisplayPatch(patch);
		},
		setGitBranch(patch: Partial<GitBranchConfig>) {
			currentConfig = saveGitBranchPatch(patch);
		},
		getActiveExtensionStatuses() {
			return getActiveExtensionStatuses();
		},
		setExtensionStatusPlacement(key: string, placement: ExtensionStatusPlacement) {
			currentConfig = saveExtensionStatusPlacement(key, placement);
		},
		setExtensionStatusColorMode(key: string, colorMode: ExtensionStatusColorMode) {
			currentConfig = saveExtensionStatusColorMode(key, colorMode);
		},
		setMouseConfig(patch: Partial<MouseConfig>, _ctx: ExtensionContext) {
			currentConfig = saveMousePatch(patch);
			if (patch.enabled === true) {
				installMousePatches();
			} else if (patch.enabled === false) {
				uninstallMouse();
			}
			refresh();
		},
		requestRender() {
			refresh();
		},
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		liveContext.clear();
		cleanupUi(ctx);
	});

	const syncInteractiveAndProjectStateWithUsage = (_event: unknown, ctx: ExtensionContext) => {
		invalidateUsageTotalsCache();
		refreshInteractiveState(ctx, true);
	};

	pi.on("agent_start", (event, ctx) => {
		liveContext.clear();
		syncInteractiveState(event, ctx);
	});
	pi.on("agent_end", (event, ctx) => {
		liveContext.clear();
		syncInteractiveAndProjectState(event, ctx);
	});
	pi.on("model_select", (event, ctx) => {
		liveContext.clear();
		syncInteractiveState(event, ctx);
	});
	pi.on("thinking_level_select", syncInteractiveState);
	pi.on("session_info_changed", syncInteractiveState);
	pi.on("message_update", (event) => {
		liveContext.update(event.message);
	});
	pi.on("message_end", (event, ctx) => {
		// Pi notifies extensions before persisting a successful message, so retain its live
		// context until agent_end; failed messages clear immediately instead of showing stale usage.
		if (
			event.message.role === "assistant" &&
			(event.message.stopReason === "error" || event.message.stopReason === "aborted")
		) {
			liveContext.clear();
		}
		syncInteractiveAndProjectStateWithUsage(event, ctx);
	});
	pi.on("tool_execution_start", (event, ctx) => {
		liveContext.clear();
		syncInteractiveState(event, ctx);
	});
	pi.on("tool_execution_end", syncInteractiveAndProjectState);
	pi.on("session_compact", (event, ctx) => {
		liveContext.clear();
		syncInteractiveAndProjectStateWithUsage(event, ctx);
	});
	pi.on("session_tree", (event, ctx) => {
		liveContext.clear();
		syncInteractiveAndProjectStateWithUsage(event, ctx);
	});
}
