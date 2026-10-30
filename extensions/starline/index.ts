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
	type GitBranchConfig,
	type IconMode,
	loadConfig,
	type MouseConfig,
	type PathDisplayConfig,
	type PolishedTuiConfig,
	saveColorSourcesPatch,
	saveContextStylePatch,
	saveExtensionStatusColorMode,
	saveExtensionStatusPlacement,
	saveGitBranchPatch,
	saveIconsModePatch,
	saveMousePatch,
	savePathDisplayPatch,
	savePillSegmentsPatch,
	saveUiFeaturesPatch,
	type UiFeaturesConfig,
} from "./config";
import { setContextApi } from "./context-breakdown";
import { setActiveContextSnapshot } from "./context-live";
import {
	getStarlineEditorBaseFactory,
	isStarlineEditorFactory,
	markEditorFactory,
} from "./editor-factory-marker";
import { installFooter } from "./footer";
import {
	buildSessionDurationLabel,
	compactionFailureNotice,
	invalidateUsageTotalsCache,
	resolveSessionStartEpoch,
} from "./format";
import { emptyGitStatus } from "./git";
import { setActiveGitStatus } from "./git-live";
import { LiveContextController } from "./live-context";
import { forgetLiveSession, installLiveSessionCapture } from "./live-session";
import { LiveTpsController } from "./live-tps";
import { installMouse } from "./mouse";
import { setActiveEditor } from "./mouse/editor-mouse";
import { installPasteCollapse } from "./paste-collapse";
import { setModelSwitcher } from "./pill-actions";
import { publishPillApi } from "./pill-api";
import { setPillBubbleAnimation } from "./pill-bubble";
import { probeProject } from "./project-probe";
import {
	createProjectRefreshScheduler,
	type ScheduleProjectRefreshOptions,
	type StopProjectRefreshInterval,
	startProjectRefreshInterval,
} from "./project-refresh";
import { applyProjectRefreshToState } from "./project-state";
import { installNativeQueueRowHiding } from "./queue-rows";
import { installSelectorBorderStyle } from "./selector-border";
import { SessionLifecycle } from "./session-lifecycle";
import { registerStarlineSettingsCommand } from "./settings-command";
import { createInitialState, type FooterState, syncState } from "./state";
import {
	createSubagentFleet,
	type EventBusLike,
	getActiveSubagentFleet,
	SUBAGENT_TOOL_NAME,
	setActiveSubagentFleet,
} from "./subagent-fleet";
import { TurnClock } from "./turn-clock";
import { PolishedEditor, WrappedPolishedEditor } from "./ui";
import { setWorkingIndicator } from "./working-indicator";

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

/**
 * How long a pill's bubble takes to unfold from the pill: long enough to read as
 * growing out of it, short enough never to be waited on.
 */
const BUBBLE_ANIMATION_MS = 60;

export default function (pi: ExtensionAPI) {
	// Published before anything else so a bridge that registers in `session_start`
	// finds it, whichever order the extensions were loaded in.
	publishPillApi();
	// The context bubble needs the tool schemas and the compaction reserve, and
	// neither is on the context a pill action gets; hold on to the API instead.
	setContextApi({
		allTools: () => pi.getAllTools(),
		activeTools: () => pi.getActiveTools(),
		reserveTokens: () => {
			const compaction = pi.getSettings().compaction;
			return compaction?.enabled === false ? undefined : compaction?.reserveTokens;
		},
	});

	const state: FooterState = createInitialState(emptyGitStatus());
	// The git pill's bubble reads the same object the footer draws from, so a
	// click costs no extra \`git status\`.
	setActiveGitStatus(state);
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
	let cleanupSessionCapture: (() => void) | undefined;
	let cleanupQueueRows: (() => void) | undefined;

	const refresh = () => {
		if (sessionLifecycle.isCurrent()) requestFooterRender?.();
	};
	const liveContext = new LiveContextController(sessionLifecycle, refresh);
	const liveTps = new LiveTpsController();
	const turnClock = new TurnClock();
	const getActiveTheme = () => activeTheme;
	const getCurrentConfig = () => currentConfig;
	/**
	 * The session's own header, or nothing. Read through a guard because this runs on
	 * whatever `sessionManager` the running Pi build provides — the header is where a
	 * resumed session keeps its original start time.
	 */
	const readSessionHeader = (ctx: ExtensionContext): { timestamp?: string } | undefined => {
		try {
			return ctx.sessionManager.getHeader() ?? undefined;
		} catch {
			return undefined;
		}
	};
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
		// A bar with no git pill reads no git: `probeProject` answers an empty
		// status rather than starting `git status` and `git stash list` every
		// interval.
		const probe = await probeProject(cwd, currentConfig);
		if (!sessionLifecycle.isCurrent(generation)) return;
		lastProjectCwd = applyProjectRefreshToState(state, {
			cwd,
			previousCwd: lastProjectCwd,
			...probe,
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
			const shown = currentConfig.pill.segments;
			const wantsTime = shown.includes("time");
			if (!(currentConfig.features.statusLine && (wantsTime || shown.includes("sessionDuration"))))
				return;
			if (wantsTime) {
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
		cleanupPrototypePatches = installSelectorBorderStyle(getActiveTheme, getCurrentConfig);
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
	 * Capture the live `AgentSession` so the queue bubble can list what is waiting.
	 * The context only carries a boolean; the messages are on the session, and one
	 * wrapper on its `prompt` is enough to hold the instance. See `live-session.ts`.
	 */
	const installSessionCapture = () => {
		cleanupSessionCapture?.();
		cleanupSessionCapture = installLiveSessionCapture();
	};

	const uninstallSessionCapture = () => {
		cleanupSessionCapture?.();
		cleanupSessionCapture = undefined;
		forgetLiveSession();
	};

	/**
	 * Pi's own `Steering:` rows above the editor are the same information the queue
	 * pill carries, so they are hidden exactly while the pill is on screen. The
	 * predicate is read on every queue update, so `/starline` changes apply without
	 * a restart.
	 */
	const queuePillCarriesTheQueue = () =>
		currentConfig.features.statusLine && currentConfig.pill.segments.includes("queue");

	const installQueueRowHiding = () => {
		cleanupQueueRows?.();
		cleanupQueueRows = installNativeQueueRowHiding(queuePillCarriesTheQueue);
	};

	const uninstallQueueRowHiding = () => {
		cleanupQueueRows?.();
		cleanupQueueRows = undefined;
	};

	/**
	 * Follow what pi-subagents is running, for the `subagents` pill. Its public RPC
	 * answers on `pi.events`; without the package nothing answers and the pill
	 * stays off. One request now picks up runs restored with the session.
	 */
	const installSubagentFleet = () => {
		const bus = (pi as { events?: EventBusLike }).events;
		if (!bus) return;
		const fleet = createSubagentFleet(bus, { onChange: refresh });
		setActiveSubagentFleet(fleet);
		fleet.refresh();
	};

	/**
	 * The model pill's picker switches through `pi`, which actions do not get.
	 * A scoped model that pins a thinking level brings it along, as ctrl+p does.
	 */
	const installModelSwitcher = () => {
		setModelSwitcher(async ({ model, thinkingLevel }) => {
			const switched = await pi.setModel(model as Parameters<typeof pi.setModel>[0]);
			if (switched && thinkingLevel) {
				pi.setThinkingLevel(thinkingLevel as Parameters<typeof pi.setThinkingLevel>[0]);
			}
			return switched;
		});
	};

	/** A foreground run starts with no event of its own, only the tool call. */
	const refreshFleetForTool = (event: { toolName?: string }) => {
		if (event.toolName === SUBAGENT_TOOL_NAME) getActiveSubagentFleet()?.refresh();
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
		// `TuiAltScreen` only ships with pi-tui >= 0.84.0 (the peer range below
		// already says so). This guard is for environments that bypass peer
		// resolution: fail with a readable hint instead of a TypeError on
		// `TuiAltScreen.prototype`.
		if (!TuiAltScreen) {
			console.warn(
				"starline: mouse support needs @earendil-works/pi-tui >= 0.84.0 (" +
					"TuiAltScreen is not exported by the installed pi-tui). Upgrade Pi, " +
					"or wait for your distribution to bundle a newer one.",
			);
			return;
		}
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
			const editor = new PolishedEditor(tui, theme, keybindings, sessionTheme, getCurrentConfig);
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
			const wrapped = new WrappedPolishedEditor(base, sessionTheme, getCurrentConfig);
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
		// Pi only clears the indicator it handed to the editor it is replacing, and
		// this editor is on its way out; leaving the stale reference behind would
		// keep a spinner in the footer forever.
		setWorkingIndicator(undefined);
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
			getLiveTps: () => liveTps.value(),
			getTurnTiming: () => turnClock.timing(),
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
		installSessionCapture();
		installQueueRowHiding();
		installSubagentFleet();
		installModelSwitcher();
		setPillBubbleAnimation(currentConfig.pill.bubbleAnimation ? BUBBLE_ANIMATION_MS : 0);
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
			uninstallSessionCapture();
			uninstallQueueRowHiding();
			setActiveSubagentFleet(undefined);
			setActiveGitStatus(undefined);
			setActiveContextSnapshot(undefined);
			setModelSwitcher(undefined);
			uninstallPrototypePatches();
			setWorkingIndicator(undefined);
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
		liveTps.clear();
		turnClock.clear();
		// A resumed session keeps its original header, and reporting the moment this
		// process attached to it would make the elapsed-time segment read 0s forever.
		state.sessionStartEpoch = resolveSessionStartEpoch(readSessionHeader(ctx));
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
		setIconMode(mode: IconMode) {
			currentConfig = saveIconsModePatch(mode);
		},
		setContextStyle(style: ContextStyle) {
			currentConfig = saveContextStylePatch(style);
		},
		setPathDisplay(patch: Partial<PathDisplayConfig>) {
			currentConfig = savePathDisplayPatch(patch);
		},
		setGitBranch(patch: Partial<GitBranchConfig>) {
			currentConfig = saveGitBranchPatch(patch);
		},
		setPillSegments(segments: readonly string[]) {
			currentConfig = savePillSegmentsPatch(segments);
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
		liveTps.clear();
		turnClock.clear();
		cleanupUi(ctx);
	});

	const syncInteractiveAndProjectStateWithUsage = (_event: unknown, ctx: ExtensionContext) => {
		invalidateUsageTotalsCache();
		refreshInteractiveState(ctx, true);
	};

	pi.on("agent_start", (event, ctx) => {
		liveContext.clear();
		// The window resets per run; the value it already measured stays on the pill.
		liveTps.beginTurn();
		turnClock.begin();
		syncInteractiveState(event, ctx);
	});
	pi.on("agent_end", (event, ctx) => {
		liveContext.clear();
		turnClock.end();
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
		if (liveTps.observe(event.assistantMessageEvent)) refresh();
	});
	pi.on("message_end", (event, ctx) => {
		// Pi notifies extensions before persisting a successful message, so retain its live
		// context until agent_end; failed messages clear immediately instead of showing stale usage.
		if (
			event.message.role === "assistant" &&
			(event.message.stopReason === "error" || event.message.stopReason === "aborted")
		) {
			liveContext.clear();
		} else if (event.message.role === "assistant") {
			// The stream's `done` event never reaches an extension, so the output count
			// has to be closed here, where the finished message arrives with its usage.
			liveTps.complete(event.message.usage?.output ?? 0);
		}
		syncInteractiveAndProjectStateWithUsage(event, ctx);
	});
	pi.on("tool_execution_start", (event, ctx) => {
		liveContext.clear();
		refreshFleetForTool(event);
		syncInteractiveState(event, ctx);
	});
	pi.on("tool_execution_end", (event, ctx) => {
		refreshFleetForTool(event);
		syncInteractiveAndProjectState(event, ctx);
	});
	pi.on("session_compact", (event, ctx) => {
		liveContext.clear();
		syncInteractiveAndProjectStateWithUsage(event, ctx);
	});
	// Pi emits this and draws nothing for it: a failed compaction late in a long
	// session otherwise looks like the agent forgetting the conversation.
	pi.on("session_compact_failed", (event, ctx) => {
		const notice = compactionFailureNotice(event);
		if (notice) ctx.ui.notify(notice, "error");
	});
	pi.on("session_tree", (event, ctx) => {
		liveContext.clear();
		syncInteractiveAndProjectStateWithUsage(event, ctx);
	});
}
