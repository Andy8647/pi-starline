/**
 * TerminalSplitCompositor — pins editor/footer at the bottom of the terminal
 * while the transcript scrolls above, using terminal scroll regions + alt screen.
 *
 * This patches Pi's internal TUI methods. It is inherently fragile across Pi
 * versions. All patches include capability checks and silent fallback.
 *
 * Adapted from @tifan/pi-fixed-editor (MIT) by Tifan Dwi Avianto, which was
 * itself adapted from pi-powerline-footer (MIT) by Nico Bailon.
 *
 * @internal
 */

import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

import { isBlankRow, renderCluster } from "./cluster";
import { scrollEditorBy } from "./editor-scroll";
import { resolveEditorInternals } from "./editor-text-cursor";
import { toggleExpanded } from "./expandable";
import { clampScrollOffset, parseKeyboardScroll, parseMouseEvents } from "./input";
import type {
	PiFixedEditorCapabilities,
	PiMethodCapability,
	PiRenderableCapability,
} from "./pi-compat";
import { highlightSelection, SelectionState } from "./selection";
import { overlayHintOnBorder, SelectionController } from "./selection-controller";
import {
	CLEAR_LINE,
	cursorTo,
	DISABLE_ALT_SCROLL,
	DISABLE_AUTOWRAP,
	DISABLE_MOUSE,
	ENABLE_ALT_SCROLL,
	ENABLE_AUTOWRAP,
	ENABLE_MOUSE_SGR,
	ENTER_ALT_SCREEN,
	EXIT_ALT_SCREEN,
	emergencyTerminalReset,
	HIDE_CURSOR,
	RESET_SCROLL_REGION,
	SHOW_CURSOR,
	SYNC_BEGIN,
	SYNC_END,
	setScrollRegion,
} from "./terminal-modes";
import { TranscriptIndex } from "./transcript-index";
import type { ClusterRender, CompositorConfig } from "./types";

/** Visual lines one wheel notch moves, for the transcript and the editor alike. */
const WHEEL_STEP = 3;

function replaceMethod(
	capability: PiMethodCapability,
	method: (...args: unknown[]) => unknown,
): void {
	const descriptor = capability.ownDescriptor;
	Object.defineProperty(capability.target, capability.key, {
		...(descriptor ?? { configurable: true, enumerable: false, writable: true }),
		value: method,
	});
}

function restoreMethod(capability: PiMethodCapability): void {
	if (capability.ownDescriptor) {
		Object.defineProperty(capability.target, capability.key, capability.ownDescriptor);
	} else {
		Reflect.deleteProperty(capability.target, capability.key);
	}
}

function hideRenderable(capability: PiRenderableCapability | null): void {
	if (!capability) return;
	Object.defineProperty(capability.target, "render", {
		...(capability.ownDescriptor ?? { configurable: true, enumerable: false, writable: true }),
		value: () => [],
	});
}

function restoreRenderable(capability: PiRenderableCapability | null): void {
	if (!capability) return;
	if (capability.ownDescriptor) {
		Object.defineProperty(capability.target, "render", capability.ownDescriptor);
	} else {
		Reflect.deleteProperty(capability.target, "render");
	}
}

function sanitizeLine(line: string, width: number): string {
	return visibleWidth(line) > width ? truncateToWidth(line, width, "", true) : line;
}

export class TerminalSplitCompositor {
	private readonly capabilities: PiFixedEditorCapabilities;
	private readonly getConfig: () => CompositorConfig;
	private inputListener:
		| ((data: string) => { consume?: boolean; data?: string } | undefined)
		| null = null;
	private inputListenerDisposer: (() => void) | null = null;
	private emergencyCleanup: (() => void) | null = null;

	private installed = false;
	private disposed = false;
	private terminalModesEntered = false;
	private writing = false;
	private renderingCluster = false;
	private checkingOverlay = false;

	private scrollOffset = 0;
	private maxScrollOffset = 0;
	private lastRootLineCount = 0;

	/** Root lines from last renderScrollableRoot — used for selection text extraction. */
	private rootLines: string[] = [];
	/** Absolute start index of visible window in rootLines. */
	private visibleRootStart = 0;
	/** Height of the scrollable region in last render. */
	private visibleScrollableRows = 0;

	/** Selection state for app-level drag-to-select. */
	private readonly selection = new SelectionState();
	/** Selection and copy policy. Kept out of here so this file stays near upstream. */
	private readonly selectionController: SelectionController;
	/** Cluster lines from the last paint, for locating the editor box on click. */
	private lastClusterLines: string[] = [];
	/** Timer for right-click context menu mouse reporting pause. */
	private mouseResumeTimer: ReturnType<typeof setTimeout> | null = null;
	private cursorVisible = true;

	/** Line ranges of the components behind the transcript, for click-to-expand. */
	private readonly transcriptIndex: TranscriptIndex;

	private readonly onCopy: (() => void) | null;
	private readonly onDismissNotice: (() => void) | null;

	private cachedClusterRender: { width: number; rows: number; render: ClusterRender } | null = null;

	constructor(
		capabilities: PiFixedEditorCapabilities,
		getConfig: () => CompositorConfig,
		onCopy?: () => void,
		onDismissNotice?: () => void,
	) {
		this.capabilities = capabilities;
		this.getConfig = getConfig;
		this.onCopy = onCopy ?? null;
		this.onDismissNotice = onDismissNotice ?? null;
		this.transcriptIndex = new TranscriptIndex(
			[
				capabilities.cluster.status,
				capabilities.cluster.aboveWidget,
				capabilities.cluster.editor,
				capabilities.cluster.belowWidget,
				capabilities.cluster.footer,
			].map((component) => component?.target),
		);
		this.selectionController = new SelectionController({
			selection: this.selection,
			getRootLines: () => this.rootLines,
			getVisibleRootStart: () => this.visibleRootStart,
			getVisibleScrollableRows: () => this.visibleScrollableRows,
			getConfig: () => this.getConfig(),
			getClusterLines: () => this.lastClusterLines,
			getEditorPaddingY: () => this.getConfig().editorPaddingY,
			getEditorTextColumn: () => this.getConfig().editorTextColumn,
			getEditorComponent: () => resolveEditorInternals(this.capabilities.cluster.editor?.target),
			requestRender: () => this.capabilities.requestRender?.(),
			pauseMouseReporting: () => this.pauseMouseReporting(),
			showCopyNotice: () => this.onCopy?.(),
			scrollTranscriptBy: (delta) => this.scrollBy(delta),
			toggleExpandableAt: (line) => this.toggleExpandableAt(line),
		});
	}

	install(): boolean {
		if (this.installed) return true;
		if (this.disposed) return false;
		const cluster = this.capabilities.cluster;
		try {
			for (const component of [
				cluster.status,
				cluster.aboveWidget,
				cluster.editor,
				cluster.belowWidget,
				cluster.footer,
			]) {
				hideRenderable(component);
			}
			Object.defineProperty(this.capabilities.terminal, "rows", {
				configurable: true,
				get: () => this.getScrollableRows(),
			});
			replaceMethod(this.capabilities.renderMethod, (width) =>
				this.renderScrollableRoot(Number(width)),
			);
			replaceMethod(this.capabilities.doRenderMethod, () => {
				this.cachedClusterRender = null;
				try {
					this.callOriginalDoRender();
					this.requestRepaint();
				} catch {
					// If doRender throws, the original write already happened.
				}
			});
			replaceMethod(this.capabilities.writeMethod, (data) => this.write(String(data)));

			this.inputListener = (data) => this.handleInput(data);
			const inputListenerDisposer = this.capabilities.addInputListener(this.inputListener);
			if (typeof inputListenerDisposer !== "function") {
				throw new TypeError("Invalid input listener disposer");
			}
			this.inputListenerDisposer = inputListenerDisposer as () => void;
			this.emergencyCleanup = () => {
				if (!this.disposed) this.restoreForExit();
			};
			process.once("exit", this.emergencyCleanup);

			this.terminalModesEntered = true;
			this.callOriginalWrite(
				SYNC_BEGIN +
					ENTER_ALT_SCREEN +
					DISABLE_ALT_SCROLL +
					(this.getConfig().mouseScroll ? ENABLE_MOUSE_SGR : DISABLE_MOUSE) +
					SYNC_END,
			);
			this.installed = true;
		} catch {
			this.rollbackInstallation();
			return false;
		}
		try {
			this.capabilities.requestRender?.(true);
		} catch {}
		return true;
	}

	dispose(): void {
		if (this.disposed) return;
		this.disposed = true;
		if (!this.installed) return;
		this.clearInputListener();
		if (this.mouseResumeTimer) {
			clearTimeout(this.mouseResumeTimer);
			this.mouseResumeTimer = null;
		}
		if (this.emergencyCleanup) {
			process.removeListener("exit", this.emergencyCleanup);
			this.emergencyCleanup = null;
		}
		this.restorePatchedCapabilities();
		this.restoreForExit();
		this.terminalModesEntered = false;
		this.installed = false;
		try {
			this.capabilities.requestRender?.(true);
		} catch {}
	}

	private rollbackInstallation(): void {
		this.clearInputListener();
		if (this.emergencyCleanup) {
			process.removeListener("exit", this.emergencyCleanup);
			this.emergencyCleanup = null;
		}
		this.restorePatchedCapabilities();
		if (this.terminalModesEntered) this.restoreForExit();
		this.terminalModesEntered = false;
		this.installed = false;
	}

	private clearInputListener(): void {
		const listener = this.inputListener;
		const disposer = this.inputListenerDisposer;
		this.inputListener = null;
		this.inputListenerDisposer = null;
		let disposed = false;
		if (disposer) {
			try {
				disposer();
				disposed = true;
			} catch {}
		}
		if (!disposed && listener) {
			try {
				this.capabilities.removeInputListener(listener);
			} catch {}
		}
	}

	private restorePatchedCapabilities(): void {
		this.selectionController.dispose();
		const rootChildren = this.rootChildren();
		if (rootChildren) this.transcriptIndex.restore(rootChildren);
		restoreMethod(this.capabilities.writeMethod);
		restoreMethod(this.capabilities.doRenderMethod);
		restoreMethod(this.capabilities.renderMethod);
		for (const component of [
			this.capabilities.cluster.status,
			this.capabilities.cluster.aboveWidget,
			this.capabilities.cluster.editor,
			this.capabilities.cluster.belowWidget,
			this.capabilities.cluster.footer,
		]) {
			restoreRenderable(component);
		}
		if (this.capabilities.rowsOwnDescriptor) {
			Object.defineProperty(
				this.capabilities.terminal,
				"rows",
				this.capabilities.rowsOwnDescriptor,
			);
		} else {
			Reflect.deleteProperty(this.capabilities.terminal, "rows");
		}
	}

	private callOriginalWrite(data: string): void {
		Reflect.apply(this.capabilities.writeMethod.method, this.capabilities.terminal, [data]);
	}

	private callOriginalDoRender(): void {
		Reflect.apply(this.capabilities.doRenderMethod.method, this.capabilities.tui, []);
	}

	private callOriginalRender(width: number): string[] {
		return Reflect.apply(this.capabilities.renderMethod.method, this.capabilities.tui, [
			width,
		]) as string[];
	}

	private getRawRows(): number {
		return Math.max(2, this.capabilities.readRawRows());
	}

	private getClusterRender(width: number, rawRows: number): ClusterRender {
		if (this.cachedClusterRender?.width === width && this.cachedClusterRender?.rows === rawRows) {
			return this.cachedClusterRender.render;
		}
		const wasRendering = this.renderingCluster;
		this.renderingCluster = true;
		try {
			const render = renderCluster(this.capabilities.cluster, width, rawRows);
			this.cachedClusterRender = { width, rows: rawRows, render };
			return render;
		} finally {
			this.renderingCluster = wasRendering;
		}
	}

	private getScrollableRows(): number {
		if (
			this.disposed ||
			this.writing ||
			this.renderingCluster ||
			this.checkingOverlay ||
			this.hasVisibleOverlay()
		) {
			return this.getRawRows();
		}
		const rawRows = this.getRawRows();
		const width = Math.max(1, this.capabilities.getColumns() || 80);
		const cluster = this.getClusterRender(width, rawRows);
		return Math.max(1, rawRows - cluster.lines.length);
	}

	private hasVisibleOverlay(): boolean {
		if (this.checkingOverlay) return false;
		this.checkingOverlay = true;
		try {
			return this.capabilities.hasVisibleOverlay();
		} finally {
			this.checkingOverlay = false;
		}
	}

	private renderScrollableRoot(width: number): string[] {
		if (this.disposed) return this.callOriginalRender(width);

		if (this.hasVisibleOverlay()) return this.callOriginalRender(width);

		const rawRows = this.getRawRows();
		const cluster = this.getClusterRender(Math.max(1, width), rawRows);
		const scrollableRows = Math.max(1, rawRows - cluster.lines.length);

		const lines = this.renderIndexedRoot(Math.max(1, width));

		// Pi's root render ends with rows of its own that carry nothing. Counting
		// them as content pins the transcript to the top of the region and leaves
		// the gap under it, so measure by the last row that actually shows
		// something. Pi pads its lines out to the full width, so "blank" has to
		// mean whitespace-only, not zero-width.
		let contentLength = lines.length;
		while (contentLength > 0 && isBlankRow(lines[contentLength - 1] ?? "")) {
			contentLength--;
		}

		// Adjust scroll offset when new content arrives while scrolled up.
		if (
			this.scrollOffset > 0 &&
			this.lastRootLineCount > 0 &&
			contentLength > this.lastRootLineCount
		) {
			this.scrollOffset += contentLength - this.lastRootLineCount;
		}
		this.lastRootLineCount = contentLength;
		this.maxScrollOffset = Math.max(0, contentLength - scrollableRows);
		this.scrollOffset = clampScrollOffset(this.scrollOffset, this.maxScrollOffset);

		const start = Math.max(0, contentLength - scrollableRows - this.scrollOffset);
		const visible = lines.slice(start, Math.min(start + scrollableRows, contentLength));
		// Pad above rather than below, so a transcript shorter than the region sits
		// against the editor the way Pi's native scrollback does.
		const padTop = Math.max(0, scrollableRows - visible.length);
		for (let i = 0; i < padTop; i++) visible.unshift("");

		// Store for selection mapping and text extraction. The origin shifts back by
		// the padding so screen row -> transcript index stays a plain offset.
		const origin = start - padTop;
		this.rootLines = lines;
		this.visibleRootStart = origin;
		this.visibleScrollableRows = scrollableRows;

		// Apply selection highlight to visible lines.
		return visible.map((line, i) => highlightSelection(line, origin + i, this.selection));
	}

	/**
	 * Pi's root render, with the per-component line ranges recorded alongside it.
	 *
	 * The index is only as good as the pass that built it, so a throw leaves the
	 * previous frame's ranges standing rather than a half-built set.
	 */
	private renderIndexedRoot(width: number): string[] {
		const rootChildren = this.rootChildren();
		if (!rootChildren) return this.callOriginalRender(width);
		this.transcriptIndex.beginPass(rootChildren);
		try {
			const lines = this.callOriginalRender(width);
			this.transcriptIndex.endPass();
			return lines;
		} catch (error) {
			this.transcriptIndex.abortPass();
			throw error;
		}
	}

	private rootChildren(): unknown[] | null {
		const children = Reflect.get(this.capabilities.tui, "children");
		return Array.isArray(children) ? children : null;
	}

	/**
	 * Expand or collapse the component covering this transcript line. Returns
	 * false when the line belongs to nothing expandable, so the click can go on
	 * to behave as it always did.
	 */
	private toggleExpandableAt(line: number): boolean {
		if (!this.getConfig().clickToExpandTools) return false;
		const node = this.transcriptIndex.hitTest(line);
		if (!node) return false;
		if (!toggleExpanded(node)) return false;
		// The cluster is unaffected, but its cache is keyed on width and rows —
		// neither of which changed — so drop it rather than let it go stale.
		this.cachedClusterRender = null;
		this.capabilities.requestRender?.();
		return true;
	}

	private handleInput(data: string): { consume?: boolean; data?: string } | undefined {
		if (this.disposed || this.hasVisibleOverlay()) return undefined;
		this.onDismissNotice?.();

		const mouseScroll = this.getConfig().mouseScroll;
		if (mouseScroll) {
			// One stdin chunk can carry a burst of reports; all of them count.
			const mouseEvents = parseMouseEvents(data);
			if (mouseEvents.length > 0) {
				for (const mouseEv of mouseEvents) this.handleMouseEvent(mouseEv);
				return { consume: true };
			}
		}

		const keyboard = parseKeyboardScroll(data);
		if (!keyboard) return this.selectionController.handleKey(data) ? { consume: true } : undefined;

		if (keyboard.action === "jumpBottom") {
			this.scrollOffset = 0;
			this.selection.clear();
			this.capabilities.requestRender?.();
			return undefined; // Let Enter propagate to the editor.
		}

		const rawRows = this.getRawRows();
		const scrollableRows = Math.max(
			1,
			rawRows - this.getClusterRender(this.capabilities.getColumns() || 80, rawRows).lines.length,
		);

		if (keyboard.action === "pageUp") {
			const before = this.scrollOffset;
			this.selection.clear();
			this.scrollBy(scrollableRows);
			return this.scrollOffset !== before ? { consume: true } : undefined;
		}
		if (keyboard.action === "pageDown") {
			const before = this.scrollOffset;
			this.selection.clear();
			this.scrollBy(-scrollableRows);
			return this.scrollOffset !== before ? { consume: true } : undefined;
		}

		return { consume: true };
	}

	private handleMouseEvent(ev: { button: string; action: string; col: number; row: number }): void {
		if (ev.button === "wheel-up" || ev.button === "wheel-down") {
			this.handleWheel(ev, ev.button === "wheel-up" ? -1 : 1);
			return;
		}

		this.selectionController.handleMouse(ev);
	}

	/**
	 * A wheel notch, given to whatever the pointer is over.
	 *
	 * `sign` is +1 for a downward notch. The transcript's offset counts backwards
	 * from the bottom, so it moves against the sign; the editor's counts forwards
	 * from the top of its own text, so it moves with it.
	 */
	private handleWheel(
		ev: { button: string; action: string; col: number; row: number },
		sign: number,
	): void {
		// Below the transcript is the cluster. An input box with more text than it
		// can show takes the wheel; anything else passes it on, so a wheel over a
		// one-line editor still scrolls the transcript as before.
		if (this.visibleScrollableRows > 0 && ev.row > this.visibleScrollableRows) {
			const editor = resolveEditorInternals(this.capabilities.cluster.editor?.target);
			if (scrollEditorBy(editor, sign * WHEEL_STEP, this.getRawRows())) {
				this.cachedClusterRender = null;
				this.capabilities.requestRender?.();
				return;
			}
		}

		// A drag in progress keeps its selection: the anchor is an absolute
		// transcript line, so scrolling under it is exactly how you reach text
		// off screen. Only an idle selection is dropped, as it always was.
		if (this.selectionController.isDragging()) {
			const applied = this.scrollBy(-sign * WHEEL_STEP);
			if (applied !== 0) this.selectionController.shiftDragEnd(applied);
			return;
		}

		this.selectionController.clearSelection();
		this.scrollBy(-sign * WHEEL_STEP);
	}

	/** Temporarily disable mouse reporting so the terminal's native context menu works. */
	private pauseMouseReporting(): void {
		if (this.mouseResumeTimer) clearTimeout(this.mouseResumeTimer);
		this.callOriginalWrite(SYNC_BEGIN + DISABLE_MOUSE + SYNC_END);
		this.mouseResumeTimer = setTimeout(() => {
			this.mouseResumeTimer = null;
			if (!this.disposed) {
				this.callOriginalWrite(SYNC_BEGIN + ENABLE_MOUSE_SGR + SYNC_END);
			}
		}, 1200);
		if (typeof this.mouseResumeTimer === "object" && "unref" in this.mouseResumeTimer) {
			(this.mouseResumeTimer as { unref: () => void }).unref();
		}
	}

	/**
	 * Scroll the transcript. Returns how much of `delta` was actually applied,
	 * which a drag needs in order to follow the text it is selecting.
	 */
	private scrollBy(delta: number): number {
		const next = clampScrollOffset(this.scrollOffset + delta, this.maxScrollOffset);
		if (next === this.scrollOffset) return 0;
		const applied = next - this.scrollOffset;
		this.scrollOffset = next;
		this.capabilities.requestRender?.();
		return applied;
	}

	private paintCluster(cluster: ClusterRender, rawRows: number, width: number): string {
		if (cluster.lines.length === 0) return "";
		const startRow = Math.max(1, rawRows - cluster.lines.length + 1);
		this.lastClusterLines = cluster.lines;
		const lines = overlayHintOnBorder(
			this.selectionController.highlightCluster(cluster.lines),
			this.selectionController.hintText(),
			width,
		);
		let buf = RESET_SCROLL_REGION;
		for (let i = 0; i < lines.length; i++) {
			buf += cursorTo(startRow + i, 1) + CLEAR_LINE + sanitizeLine(lines[i] ?? "", width);
		}
		if (cluster.cursor) {
			buf += cursorTo(startRow + cluster.cursor.row, Math.max(1, cluster.cursor.col + 1));
			// Pi's own output passes through this write untouched and may contain a
			// hide-cursor sequence we never see, leaving cursorVisible wrong. When the
			// real cursor is the only cursor there is, assert it every frame instead.
			if (this.getConfig().hardwareCursor) {
				buf += SHOW_CURSOR;
				this.cursorVisible = true;
			} else if (!this.cursorVisible) {
				buf += SHOW_CURSOR;
				this.cursorVisible = true;
			}
		} else if (this.cursorVisible) {
			buf += HIDE_CURSOR;
			this.cursorVisible = false;
		}
		return buf;
	}

	/**
	 * Restore the cursor to the row Pi's differential renderer expects.
	 *
	 * `setScrollRegion` (DECSTBM) homes the cursor to row 1, col 1, but Pi's
	 * `doRender` emits *relative* cursor moves (CUU/CUD/`\r`) computed from
	 * its tracked `hardwareCursorRow`. Without repositioning, a sparse
	 * differential update (e.g. one selection-highlighted line) is written
	 * at the wrong row because the relative move departs from (1,1)
	 * instead of the tracked row.
	 */
	private syncTuiCursor(scrollBottom: number): string {
		const { hardwareCursorRow, previousViewportTop: viewportTop } =
			this.capabilities.getCursorBookkeeping();
		const row = Math.max(1, Math.min(scrollBottom, hardwareCursorRow - viewportTop + 1));
		return cursorTo(row, 1);
	}

	private requestRepaint(): void {
		if (this.disposed || this.hasVisibleOverlay()) return;
		const rawRows = this.getRawRows();
		const width = Math.max(1, this.capabilities.getColumns() || 80);
		const cluster = this.getClusterRender(width, rawRows);
		if (cluster.lines.length === 0) return;
		this.callOriginalWrite(
			SYNC_BEGIN +
				DISABLE_AUTOWRAP +
				this.paintCluster(cluster, rawRows, width) +
				ENABLE_AUTOWRAP +
				(this.getConfig().mouseScroll ? ENABLE_MOUSE_SGR : DISABLE_MOUSE) +
				SYNC_END,
		);
	}

	private write(data: string): void {
		if (this.disposed || this.writing || this.hasVisibleOverlay()) {
			this.callOriginalWrite(data);
			return;
		}
		this.writing = true;
		try {
			const rawRows = this.getRawRows();
			const width = Math.max(1, this.capabilities.getColumns() || 80);
			const cluster = this.getClusterRender(width, rawRows);
			const reservedRows = cluster.lines.length;
			if (reservedRows === 0 || rawRows <= 2) {
				this.callOriginalWrite(data);
				return;
			}
			const scrollBottom = Math.max(1, rawRows - reservedRows);
			this.callOriginalWrite(
				SYNC_BEGIN +
					DISABLE_AUTOWRAP +
					setScrollRegion(1, scrollBottom) +
					this.syncTuiCursor(scrollBottom) +
					data +
					this.paintCluster(cluster, rawRows, width) +
					ENABLE_AUTOWRAP +
					(this.getConfig().mouseScroll ? ENABLE_MOUSE_SGR : DISABLE_MOUSE) +
					SYNC_END,
			);
		} finally {
			this.writing = false;
		}
	}

	private restoreTerminalState(): void {
		this.callOriginalWrite(
			SYNC_BEGIN +
				RESET_SCROLL_REGION +
				DISABLE_MOUSE +
				ENABLE_ALT_SCROLL +
				EXIT_ALT_SCREEN +
				SHOW_CURSOR +
				SYNC_END,
		);
	}

	private restoreForExit(): void {
		try {
			this.restoreTerminalState();
		} catch {
			// Process-exit cleanup cannot report errors and must not throw.
		}
	}
}

/** Export for the emergency reset test. */
export { emergencyTerminalReset };
