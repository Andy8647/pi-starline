# Fixed editor

Experimental and opt-in. For the rest of Starline's settings, see [Configuration](configuration.md).

The fixed editor pins the Starline editor and footer at the bottom of the terminal while the transcript scrolls above. This enables composing follow-up messages while referencing earlier conversation history.

## How to enable

```text
/starline fixed-editor enable
```

Or in `~/.pi/agent/starline.json`:

```json
{
	"fixedEditor": {
		"enabled": true
	}
}
```

## Keyboard controls

| Key | Action |
| --- | ------ |
| `PageUp` / `PageDown` | Scroll transcript one viewport up/down |
| `Ctrl+Shift+↑` / `Ctrl+Shift+↓` | Scroll transcript up/down (Kitty protocol variants supported) |
| `Enter` | Jump to bottom (and submit message) |

## Mouse scroll (default on)

Mouse wheel scrolling is enabled by default when the fixed editor is on. Disable it via `/starline` Features or:

```json
{
	"fixedEditor": {
		"enabled": true,
		"mouseScroll": true
	}
}
```

A wheel notch goes to whatever the pointer is over:

- **Over the transcript** — scrolls the transcript, as it always did.
- **Over the input box** — scrolls the input box, when your message is longer than the box can show. Pi sizes that box at 30% of the terminal height (five lines at minimum) and re-derives its scroll position from the caret on every frame, so scrolling it moves the caret along with the text — the same thing holding the arrow keys would do. Once the box is scrollable the wheel stays with it, including at its top and bottom, rather than sliding on to the transcript mid-gesture.
- **Over a one-line input box** — scrolls the transcript. With nothing to scroll in the box there is no point holding the notch.

**Warning**: Mouse scroll enables SGR mouse reporting, which disables native terminal text selection, URL click-through, and tmux/Herdr scrollback for the Pi session. Toggle off if you need those features.

## Selection and copying

Drag-select in the transcript area works whenever the fixed editor is on.

```json
{
	"fixedEditor": {
		"enabled": true,
		"copyOnSelect": true,
		"copyNotice": true
	}
}
```

- `copyOnSelect: true` (default) — releasing the mouse copies the selection and clears the highlight. `copyNotice` controls the "copied to clipboard" toast.
- `copyOnSelect: false` — the highlight stays after release and nothing is written to the clipboard. The editor's bottom border shows `N characters selected, ctrl+c to copy` until you act on it.
- **Double click selects a word, triple click selects the line.** A word keeps `_-./` in it, so a path, a filename or a `src/foo.ts` reference comes out whole. A fourth click starts over as a plain click. Both follow the same `copyOnSelect` rule as a drag, and both work in the input box too. Pi has no mouse selection of its own; because Starline turns on mouse reporting to do this, the terminal's own double click no longer reaches the screen — in most terminals holding shift while dragging bypasses reporting and gives you the native selection back.
- **A selection can run past the edge of the screen.** Dragging to the top or bottom row scrolls the transcript and keeps selecting, and it keeps going while you hold the pointer there — a trackpad reports nothing while your finger is still, so the scrolling is on a timer rather than on movement. Dragging down into the pinned editor counts as the bottom edge; the input box does not steal the pointer halfway through a selection.
- **The wheel works during a drag too.** The selection's anchor is an absolute transcript line, so scrolling under it extends the selection instead of dropping it. Only an idle highlight is cleared by the wheel.
- `ctrl+c` copies the current selection under either setting. With no selection it falls through to Pi's normal ctrl+c, so interrupting still works.
- Right-clicking inside a selection copies it outright; right-clicking anywhere else falls through to the terminal's native context menu as before.
- Any other keystroke dismisses the highlight, so it never lingers over text that has scrolled on.
- An explicit copy (ctrl+c, right click) shows no toast — the hint disappearing is the confirmation.
- OSC 8 hyperlink targets are copied along with the visible text.

Inside the input box:

- Clicking in your text moves the caret there. `editorClickCursor` (default on) turns it off.
- Dragging selects the text, following the same `copyOnSelect` rule as the transcript. The rail, the borders and the metadata row are never part of a selection — neither highlighted nor copied — and a drag off the bottom stops at the last line of your input.
- Dragging backwards selects the same range as dragging forwards: the cell you pressed on and the cell you released on are both in.
- **Backspace or delete removes the selected text**, as one undoable step — `ctrl+z` puts it back. Pi's editor has no selection of its own, so this splices the range straight out of its buffer; if the editor is not the shape Starline expects, the key falls through to Pi and deletes a character as usual. Typing replaces the selection the same way — the text goes, then your character lands where it was. A paste does not: that goes through Pi's own paste path, threshold and all.

Both need the fixed editor, and both reach into Pi internals that carry no compatibility promise. If a Pi release moves them, the click simply stops doing anything rather than breaking the editor.

## Conflicts and limitations

- **Incompatible with** `pi-powerline-footer`, `@tifan/pi-fixed-editor`, and `pi-sticky-input`. These packages patch the same Pi TUI internals; only one rendering owner can be active at a time.
- **Alternate screen**: Uses the terminal's alternate screen buffer. Native scrollback history is not accessible while the fixed editor is active.
- **Pi version fragility**: Patches internal TUI methods (`doRender`, `render`, `terminal.write`, `terminal.rows`) that may change across Pi versions. If the TUI layout is unsupported, Starline falls back to normal rendering with a console warning.
- If your terminal is stuck after a crash, run `reset` or restart the terminal.
