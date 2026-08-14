# Changelog

What changed in each released version of Starline, and what you need to do about
it. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and versions follow [semantic versioning](https://semver.org/spec/v2.0.0.html).

The `## [x.y.z]` section for a version is what the publish workflow posts as that
version's [GitHub release](https://github.com/Andy8647/pi-starline/releases)
notes, so write it for someone reading the releases page, not for someone reading
the diff. A tag with no section here fails the release before anything reaches
npm.

## [0.3.1] - 2026-08-11

Click-to-expand now works on MCP tool boxes. pi-mcp-adapter renders its
collapsed-result hint as `(Ctrl+O to expand)` — capitalized, unlike the
lowercase `ctrl+o` Pi's own keybinding text yields — and Starline's hint
match was case-sensitive, so a click on an MCP box's hint row silently fell
through to selection. The match is now case-insensitive; core tool boxes are
unaffected.

## [0.3.0] - 2026-08-10

The mouse work: Starline now reads and drives Pi 0.84's own renderer instead of
running its own editor. The fixed editor is deleted.

### Removed

**The fixed editor is gone.** Pi 0.84's fullscreen mode (`tuiMode:
"fullscreen"` in `/settings`) provides the sticky editor and footer,
independent transcript scrolling, mouse selection and draggable scrollbars, so
Starline's own compositor is deleted: the `fixed-editor/` modules, the
`/starline fixed-editor enable/disable/toggle` commands, and the Fixed editor
guide. The editor and user-message styling, the statusline and the pill footer
all keep working exactly as before.

### Changed

**`fixedEditor` settings move to `mouse`.** The old `fixedEditor` config block
named a compositor that no longer exists. It is migrated automatically the
first time Starline loads — you do not need to edit anything by hand. The old
keys and where they land:

| Old (`fixedEditor`) | New (`mouse`) |
| --- | --- |
| `enabled` | `enabled` |
| `mouseScroll` | `wheelRouting` |
| `copyNotice` | `copyNotice` |
| `copyOnSelect` | `copyOnSelect` |
| `clickToExpandTools` | `clickToExpandTools` |

An explicit `mouse` key already in your config wins over the migration. The
old block is removed and the new one written back once, with a notice saying
so.

### Added

- **Mouse selection and copy.** Drag to select anywhere — the transcript and
the input box — with double-click word selection and triple-click line
selection. Releasing copies; or hold the selection for `ctrl+c` with
`mouse.copyOnSelect: false` — the same behaviour [Pi #7720][7720] asks for
upstream (a setting to disable select-to-copy in fullscreen mode). If Pi
ships its own `fullscreenCopyOnSelect`, Starline should prefer it and let
both settings agree rather than fight.
- **Clean copies.** Transcript selections drop Starline's message rails, rule
rows, and pi-toolbox frame borders before they reach the clipboard; editor
selections copy the draft's text, not the painted rows. Anything unrecognised
passes through byte-identical.
- **Click to move the caret** in the input box; **backspace/delete remove a
selected range**.
- **Wheel scrolling over the input box** scrolls the draft instead of the
transcript.
- **Click a tool box's hint row to expand just that box**, and collapse it
again through the `(ctrl+o to collapse)` anchor row (pi-toolbox 0.2.2+).
- **Paths and kebab-case stay whole** on double-click selection.
- **A pending selection's hint counts the exact characters `ctrl+c` will
copy**, and an editor selection's hint names the external editor —
`ctrl+g to edit in nvim`, with `$EDITOR`/`$VISUAL` resolved (unset, the
literal `$EDITOR` stays, itself the hint that nothing is configured).
- **A draft taller than the box keeps the `ctrl+g` hint on screen** — no
selection needed. There is no drag-scroll, so part of a long draft is
unreachable by mouse; the hint points at the external editor as the way to
act on the whole draft.

### Fixed

- **`ctrl+c` copies a pending selection on Pi 0.84 again.** Pi negotiates the
Kitty keyboard protocol (falling back to xterm modifyOtherKeys) on capable
terminals, which encodes the chord as an escape sequence rather than the raw
`\x03`. The pending copy now recognises every encoding, so `ctrl+c` no longer
falls through to clearing the editor.
- **Selections that end on a box's border rows no longer fail to select** —
the range is clamped instead of rejected.
- **Range delete installs even when click-to-caret is the only editor
feature.**

[7720]: https://github.com/earendil-works/pi/issues/7720

## [0.2.2] - 2026-08-07

Two things the 0.2.1 fallback took with it, put back.

### Fixed

**`paste again to expand` is visible again.** Collapsing a long paste and
expanding it by pasting the same text a second time never stopped working, but
the label saying so was drawn on the editor's bottom border by the fixed editor,
so it went away with it on Pi 0.84. It now sits on the right of the editor's
metadata row, beside the vim mode indicator. That row is rendered whether or not
`editorMetadataFormat` has anything in it, so blanking the template does not
hide the hint.

**The fallback message says what to do about it.** Starting Pi 0.84 with
`fixedEditor.enabled` still set printed `unsupported Pi TUI layout — falling
back to normal rendering`, which reads like a failure and tells you nothing. It
now names Pi's own fullscreen mode as the replacement and gives the command that
turns the message off.

### Changed

Releases are described in this file, and the publish workflow posts the matching
section as the GitHub release notes rather than an auto-generated commit list.

## [0.2.1] - 2026-08-07

Pi 0.84 broke Starline's fixed editor badly enough that the screen stopped
repainting. This release makes it notice and stay out of the way.

**On Pi 0.84 and later, use Pi's own fullscreen mode instead of the fixed
editor.** Pi now ships a sticky editor and footer, an independently scrolling
transcript, mouse selection and draggable scrollbars of its own — set `tuiMode`
to `"fullscreen"` in `/settings`. Starline's fixed editor cannot reach Pi's
renderer on those releases and will not turn itself on there, whatever
`fixedEditor.enabled` says. Nothing else has to change: the statusline, the
editor styling and the user-message styling all work in both TUI modes.

### Fixed

**The fixed editor no longer blanks the screen on Pi 0.84.** Pi 0.84 hands
extensions a Proxy over its renderer rather than the renderer itself, so it can
swap TUI modes mid-session. Every check the fixed editor made passed against
that Proxy while its render patches landed on an empty object behind it, so it
went ahead and hid the editor and footer that only those patches would have
drawn again — and Pi's own output was by then being swallowed by a compositor
nothing was driving. It now installs a sentinel patch and reads it back instead
of trusting a property descriptor, and hides the editor cluster only once the
patches are in place, so an unsupported layout falls back to Pi's own rendering
with a console warning rather than to a dead terminal.

## [0.2.0] - 2026-07-31

Everything in this release is the fixed editor's mouse handling, which now
covers the three things that made it feel unfinished: the wheel went to the
transcript wherever the pointer was, a selection could not leave the screen, and
a tool box could only be expanded along with every other one.

All of it needs `fixedEditor.enabled` and `fixedEditor.mouseScroll`. See
[the fixed editor guide](https://github.com/Andy8647/pi-starline/blob/main/docs/fixed-editor.md).

### Added

**Click a tool box to expand just that one** (`fixedEditor.clickToExpandTools`,
default on). `ctrl+o` expands every box in the transcript at once, which is a lot
of screen for one line of output you wanted to see. Click a box's border — the
rules or either vertical — or its `… ctrl+o to expand` hint, and only that box
opens; click again to close it. Body rows keep double click for a word and
triple click for the line. Works for every box Pi builds, restyled ones
included.

**The input box scrolls under the pointer.** A wheel notch over a draft taller
than the box scrolls the box instead of the conversation. Pi re-derives the
editor's scroll position from the caret on every frame, so the caret comes
along, exactly as holding the arrow keys would.

**A selection can cover a draft taller than the box.** Hold a drag past the text
— on the frame, the metadata row, or up over the transcript — and the box
scrolls, selecting the rows it brings in. What gets copied comes from the
editor's buffer, so rows that have scrolled out of view come with it, and
backspace or delete removes the whole range.

### Fixed

**The wheel now goes to whatever the pointer is over** rather than always to the
transcript.

**A selection can run past the edge of the screen.** Dragging to the top or
bottom row scrolls the transcript and keeps selecting, and keeps going while you
hold the pointer there — a trackpad reports nothing while your finger is still,
so the scrolling is on a timer. Dragging down into the pinned editor counts as
the bottom edge instead of handing the pointer to the input box mid-selection.

**The wheel no longer kills the drag it arrives during.** The selection's anchor
is an absolute transcript line, so scrolling under a drag extends it instead of
dropping it.

**Mouse reports that share an input chunk are no longer dropped.** A terminal
coalesces a burst of motion, wheel and release reports into one read, and only
the first was being parsed — which is how a wheel notch arriving mid-drag used
to vanish, and why fast dragging stuttered.

**Box frames stay out of a selection.** Dragging across a tool box copied the
box: every `│` down both sides and both rules came along, and the frame lit up
under the highlight. A markdown table keeps every one of its pipes — a frame is
only recognised as one when the run of rows is capped by a rule, which a table's
`┌─┬─┐` borders are not.

**`saveFixedEditorPatch` no longer drops `copyOnSelect`** when saving a partial
config patch.

## [0.1.1] - 2026-07-30

No behaviour changes. 0.1.0 went to npm just before the readme was split into a
[configuration reference](https://github.com/Andy8647/pi-starline/blob/main/docs/configuration.md)
and a
[fixed editor guide](https://github.com/Andy8647/pi-starline/blob/main/docs/fixed-editor.md),
and npm only refreshes a package's readme when a new version is published. This
release carries the current docs to the registry.

## [0.1.0] - 2026-07-29

First release under the Starline name. Starline is a fork of
[pi-zentui](https://github.com/lmilojevicc/pi-zentui) by Luka, renamed and
released on its own. It has diverged well past upstream, mostly in the editor
and selection internals.

```bash
pi install npm:pi-starline
```

### Coming from pi-zentui

The config file moved and is not read automatically:

```bash
mv ~/.pi/agent/zentui.json ~/.pi/agent/starline.json
```

Inside it, rename any `colorMode: "zentui"` value to `colorMode: "themed"`. The
slash command is now `/starline`.

Both packages can be installed at once without fighting over the same TUI
internals — Starline still reads the interop keys the old package writes, and
writes the keys it looks for.

### Added

What this fork adds over upstream:

- A powerline **pill footer** style, alongside the original text footer
- A colour **palette with `$ref` expansion**, and `model` / `thinking` footer
  segments
- A **git host icon** for the branch segment, and per-segment display options
- Configurable **editor cursor styles** and box padding
- **Mouse selection in the fixed editor** — drag, double-click a word,
  triple-click a line, click to move the caret, backspace/delete over a
  selection
- Paste collapsing, with paste-again-to-expand

[Unreleased]: https://github.com/Andy8647/pi-starline/compare/v0.2.2...HEAD
[0.2.2]: https://github.com/Andy8647/pi-starline/compare/v0.2.1...v0.2.2
[0.2.1]: https://github.com/Andy8647/pi-starline/compare/v0.2.0...v0.2.1
[0.2.0]: https://github.com/Andy8647/pi-starline/compare/v0.1.1...v0.2.0
[0.1.1]: https://github.com/Andy8647/pi-starline/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/Andy8647/pi-starline/releases/tag/v0.1.0
