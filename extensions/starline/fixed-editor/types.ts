/**
 * Shared types for the fixed/sticky editor compositor.
 *
 * @internal
 */

/** Result of parsing a mouse SGR wheel sequence. */
export type MouseScrollInput = {
	direction: "up" | "down";
	amount: number;
};

/** Full parsed SGR mouse event. */
export type MouseEvent = {
	button: "left" | "middle" | "right" | "wheel-up" | "wheel-down" | "other";
	action: "press" | "drag" | "release";
	col: number; // 1-indexed
	row: number; // 1-indexed
};

/** Result of parsing a keyboard scroll sequence. */
export type KeyboardScrollInput = {
	action: "pageUp" | "pageDown" | "jumpBottom" | "lineUp" | "lineDown";
};

/** Compositor configuration provided by a getter. */
export type CompositorConfig = {
	enabled: boolean;
	mouseScroll: boolean;
	copyNotice: boolean;
	copyOnSelect: boolean;
	/** editorCursor "terminal": the real cursor is the only cursor, so assert it. */
	hardwareCursor: boolean;
	/** Clicking in the editor text moves the caret there. */
	editorClickCursor: boolean;
	/** Clicking a tool box's frame or its expand hint toggles that one box. */
	clickToExpandTools: boolean;
	/** Blank rows inside the editor box; needed to find its text rows. */
	editorPaddingY: number;
	/** Visible column where editor text starts, past the rail or prompt. */
	editorTextColumn: number;
};

/** Result of rendering the pinned cluster. */
export type ClusterRender = {
	lines: string[];
	cursor: { row: number; col: number } | null;
};
