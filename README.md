# Starline

A Starship-inspired statusline, Opencode-style editor chrome, and fullscreen mouse control for [Pi](https://pi.dev).

![Starline](https://raw.githubusercontent.com/Andy8647/pi-starline/main/assets/starline.png)

Starline makes Pi's fullscreen mode feel like a finished terminal app:

- **See the state:** a pill footer with directory, git, runtime, model, context and cost; click one for the details behind it.
- **Act on it:** click a pill to switch model or thinking level, see what is queued, or list running subagents.
- **Type comfortably:** a bordered input box with the model inside the frame, paste collapse, and a `ctrl+g` hint for your `$EDITOR`.
- **Drive with the mouse:** select and copy anywhere, click to move the caret, wheel to scroll the draft.

## Features

**Footer**

- Starship-style segments: directory, git (`main [!?↑]`), runtime `via  v5.5.0` (57 runtimes), context (click for tokens and cache), cost, plus optional session name, `user@host`, time, OS, session duration and project version.
- A colour palette with `$name` references; the bar is built from `pill.segments`, in your order.
- Other extensions' statuses from `ctx.ui.setStatus()` as pills, on either side, or on the editor row.
- One git pill: branch and dirty markers together; click it for the changed files (read-only).
- The model pill's icon spins while the agent works.

**Clickable pills**

- **Model:** pick from your scoped models (the ones ctrl+p cycles).
- **Thinking:** pick a level from the ones the model supports.
- **Queue:** an inbox icon and a count while messages wait; click to read them.
- **Subagents:** with [pi-subagents](https://github.com/nicobailon/pi-subagents), a count of running subagents; click for agent, model, time and tokens, live.
- **Your extension's pill:** a small published API lets any extension open the same bubble with its own content. See [Clickable pills for other extensions](https://github.com/Andy8647/pi-starline/blob/main/docs/pill-api.md).
- Every action also runs from the keyboard as `/starline <name>`, and the pointer turns into a hand over anything clickable.

**Editor**

- Bordered input box with an accent rail, the model and provider inside the frame, and matching user-message boxes.
- Copy-friendly mode drops the rail glyphs so terminal selection copies less chrome.

**Mouse** (Pi's `tuiMode: "fullscreen"`)

- Drag to select in the transcript or the draft; double-click keeps paths and kebab-case whole; triple-click takes a line.
- Clean copies: Starline's rails and rule rows and pi-toolbox frames are dropped before the clipboard.
- A selection hint says how many characters the copy key will copy.
- Click to move the caret; backspace/delete remove a selected range; the wheel scrolls the draft.

## Install

Needs **Pi 0.84.4 or newer** (0.85.0 or newer for clickable pills) and a [Nerd Font](https://www.nerdfonts.com/) (or set `icons.mode` to `"ascii"`).

```bash
pi install npm:pi-starline
# or from git
pi install git:github.com/Andy8647/pi-starline
```

What changed in each version: **[Changelog](https://github.com/Andy8647/pi-starline/blob/main/CHANGELOG.md)**.

## Configure

`/starline` opens a menu for the everyday settings: colour sources, feature toggles, the order of the bar (`Pills`), and where other extensions' statuses go.

Everything else lives in `~/.pi/agent/starline.json`. The file is optional; missing keys fall back to defaults.

```json
{
	"pill": { "segments": ["model", "cwd", "git", "context", "cost"] },
	"colors": { "gitBranch": "bold purple" },
	"mouse": { "transcriptCleanCopy": false }
}
```

## Docs

- [Configuration](https://github.com/Andy8647/pi-starline/blob/main/docs/configuration.md): every option and its default.
- [What the footer shows](https://github.com/Andy8647/pi-starline/blob/main/docs/segments.md): git status indicators and the detected runtimes.
- [Clickable pills for other extensions](https://github.com/Andy8647/pi-starline/blob/main/docs/pill-api.md): put your extension's content in a pill.
- [Clickable pills: design](https://github.com/Andy8647/pi-starline/blob/main/docs/clickable-pills.md): how the pills, bubbles and bridges work.

## Development

```bash
npm install
npm run verify       # lint, typecheck, tests
npm run pi:dev       # run Pi with this checkout and no other extensions
```

`pi:dev` uses the globally installed Pi; set `PI_BIN=/path/to/pi` to use another.

## Credits

Started as a fork of [pi-zentui](https://github.com/lmilojevicc/pi-zentui) by Luka. Inspired by [Starship](https://starship.rs/) and [Opencode](https://github.com/opencode-ai/opencode).

## License

MIT
