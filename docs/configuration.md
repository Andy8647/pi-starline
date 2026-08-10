# Starline configuration

Every option Starline has.

## All options

| Key | Type | Default | What it does |
| --- | --- | --- | --- |
| `projectRefreshIntervalMs` | number | `30000` | How often git and runtime state are re-read. Minimum 5000. |
| `footerStyle` | string | `"text"` | Chooses the classic text footer or the pill footer, see [Pill footer](#pill-footer). |
| `pill` | object | see [Pill footer](#pill-footer) | Segment order, separator glyph, boldness, and cap style for the pill footer. |
| `footerFormat` | string | `""` | Starship-style template that fully replaces the built-in footer layout, see [Footer Format Template](#footer-format-template). |
| `editorMetadataFormat` | string | `"$model  $provider(  $thinking)"` | Template for the left side of the editor metadata row, see [Editor Metadata Format](#editor-metadata-format). |
| `separator` | string | `"pipe"` | Glyph drawn between footer segments and extension-status connectors. |
| `contextStyle` | string | `"text"` | Whether the context segment shows text, a gauge, or both. |
| `segmentOptions` | object | see [Segment display options](#segment-display-options) | Formatting details for the context and tokens segments. |
| `editorModelLabel` | string | `"id"` | Whether the editor frame shows the model id or its display name. |
| `editorCursor` | string | `"block"` | Cursor style in the editor, see [Editor cursor](#editor-cursor). |
| `editorClickCursor` | boolean | `true` | Clicking in the editor text moves the caret there, see [Mouse](#mouse). |
| `pasteCollapseLines` | number | `11` | Line count at which a paste collapses into a marker, see [Paste collapse threshold](#paste-collapse-threshold). |
| `editorPaddingY` | number | `1` | Blank rows inside the editor box, see [Box height](#box-height). |
| `userMessagePaddingY` | number | `1` | Blank rows inside the previous-message box, see [Box height](#box-height). |
| `contextThresholds` | object | `{ "warning": 70, "error": 90 }` | Percentages that select the context segment's normal/warning/error colours. |
| `pathDisplay` | object | `{ "mode": "basename", "depth": 0 }` | Whether the cwd segment shows the basename or a full path, and how many trailing directories to keep. |
| `gitBranch` | object | `{ "maxLength": "full" }` | Caps the visible width of the branch name. |
| `gitHostIcon` | boolean | `false` | Replaces the branch icon with the origin remote's forge logo, see [Git host icon](#git-host-icon). |
| `icons` | object | see the JSON block below | Per-icon glyph overrides and the icon mode (`auto`, `nerd`, `ascii`). |
| `colors` | object | see [Colors](#colors) | Style string for every themeable segment and editor element. |
| `colorSources` | object | `{ "starship": "theme", "editor": "theme", "userMessages": "theme" }` | Whether each area's colours come from the Pi theme or the terminal palette. |
| `features` | object | `{ "editor": true, "statusLine": true, "copyFriendly": false }` | Toggles the custom editor, the custom footer, and copy-friendly mode. |
| `footerSegments` | object | see the JSON block below | Shows or hides each built-in footer segment individually. |
| `gitCommit` | object | `{ "hashLength": 7, "onlyDetached": true, "showTag": true }` | Starship `git_commit`-style options for the `gitCommit` footer segment. |
| `gitMetrics` | object | `{ "onlyNonzero": true, "ignoreSubmodules": false }` | Starship `git_metrics`-style options for the `gitMetrics` footer segment. |
| `extensionStatuses` | object | see [Pill footer](#pill-footer) | Placement, colour, and icon for third-party extension statuses. |
| `mouse` | object | see [Mouse features](#mouse-features) | Wheel routing, click-to-expand tool boxes, path-aware word selection, and Starline's own copy behaviour. |

User config lives at `~/.pi/agent/starline.json`. The file is optional: missing or invalid known values fall back to Starline defaults, unknown keys are ignored at runtime, and `/starline` can patch color-source settings, UI feature toggles, built-in footer segment visibility, and active third-party status placements.

The interactive `/starline` menu is split into five sections. Use `Tab` and `Shift+Tab` to switch between `Coloring`, `Features`, `Layout`, `Built-in segments`, and `Extension segments`.

Useful slash-command shortcuts:

```text
/starline editor enable
/starline editor disable
/starline statusline enable
/starline statusline disable
/starline editor toggle
/starline statusline toggle
/starline copy-friendly enable
/starline copy-friendly disable
/starline copy-friendly toggle
/starline format "$cwd on branch $git_branch$git_status using $runtime $fill $context"
/starline format clear
```

Default config values — copy this and change any value you want:

```json
{
	"projectRefreshIntervalMs": 30000,
	"footerStyle": "text",
	"pill": {
		"segments": [
			"model",
			"thinking",
			"cwd",
			"gitBranch",
			"gitStatus",
			"context",
			"cost",
			"extensionStatus"
		],
		"separator": "powerline",
		"bold": true,
		"caps": "round"
	},
	"footerFormat": "",
	"editorMetadataFormat": "$model  $provider(  $thinking)",
	"separator": "pipe",
	"contextStyle": "text",
	"segmentOptions": {
		"context": {
			"format": "full"
		},
		"tokens": {
			"cache": "percent"
		}
	},
	"editorModelLabel": "id",
	"editorCursor": "block",
	"editorPaddingY": 1,
	"userMessagePaddingY": 1,
	"contextThresholds": {
		"warning": 70,
		"error": 90
	},
	"pathDisplay": {
		"mode": "basename",
		"depth": 0
	},
	"gitBranch": {
		"maxLength": "full"
	},
	"gitHostIcon": false,
	"icons": {
		"mode": "auto",
		"cwd": "",
		"git": "",
		"ahead": "↑",
		"behind": "↓",
		"diverged": "⇕",
		"conflicted": "=",
		"untracked": "?",
		"stashed": "$",
		"modified": "!",
		"staged": "+",
		"renamed": "»",
		"deleted": "✘",
		"typechanged": "T",
		"cacheHit": "󰆼",
		"editorPrompt": "",
		"rail": "│",
		"username": "",
		"time": "",
		"os": "",
		"package": "",
		"model": "",
		"thinking": "",
		"context": "",
		"cost": "",
		"tokens": "",
		"gitHostGithub": "",
		"gitHostGitlab": "",
		"gitHostBitbucket": "",
		"gitHostGeneric": ""
	},
	"colors": {
		"model": "bold blue",
		"cwd": "bold cyan",
		"sessionName": "bold green",
		"gitBranch": "bold purple",
		"gitStatus": "bold red",
		"contextNormal": "bright-black",
		"contextWarning": "bold yellow",
		"contextError": "bold red",
		"tokens": "bright-black",
		"cacheHit": "bright-black",
		"cost": "bold green",
		"separator": "bright-black",
		"runtimePrefix": "",
		"extensionStatus": "bright-black",
		"sessionDuration": "yellow",
		"packageVersion": "208",
		"gitCommit": "bold green",
		"gitMetricsAdded": "bold green",
		"gitMetricsDeleted": "bold red",
		"username": "bold yellow",
		"time": "bold yellow",
		"os": "bold white"
	},
	"colorSources": {
		"starship": "theme",
		"editor": "theme",
		"userMessages": "theme"
	},
	"features": {
		"editor": true,
		"statusLine": true,
		"copyFriendly": false
	},
	"footerSegments": {
		"model": false,
		"thinking": false,
		"cwd": true,
		"sessionName": true,
		"gitBranch": true,
		"gitStatus": true,
		"gitCounts": false,
		"runtime": true,
		"context": true,
		"tokens": true,
		"cacheHit": false,
		"cost": true,
		"sessionDuration": false,
		"username": false,
		"time": false,
		"os": false,
		"packageVersion": false,
		"gitCommit": false,
		"gitMetrics": false
	},
	"gitCommit": {
		"hashLength": 7,
		"onlyDetached": true,
		"showTag": true
	},
	"gitMetrics": {
		"onlyNonzero": true,
		"ignoreSubmodules": false
	},
	"extensionStatuses": {
		"defaultPlacement": "right",
		"placements": {},
		"colorModes": {},
		"colors": {},
		"icons": {}
	},
	"mouse": {
		"enabled": true,
		"wheelRouting": true,
		"copyNotice": true,
		"copyOnSelect": true,
		"clickToExpandTools": true,
		"pathAwareWords": true,
		"transcriptCleanCopy": true
	}
}
```

- Style values can be Starship/terminal strings (`bold purple`, `fg:202`, `#89b` / `#89b4fa`, `bg:blue fg:bright-green`) or Pi theme tokens (`accent`, `borderMuted`, `thinkingHigh`). Short `#rgb` hex values expand to `#rrggbb`.
- `projectRefreshIntervalMs`: project status polling interval; `0` disables polling. Values `1..4999` clamp up to `5000` (minimum 5s); invalid/non-finite values fall back to `30000`.
- `contextStyle`: `text` (default), `gauge`, or `text+gauge` for the context segment. Context usage refreshes during assistant streaming; token and cost totals remain canonical and finalize at turn boundaries.
- `editorModelLabel`: controls the model shown in the editor frame. `id` (default) shows the model id; `name` shows the model's display name (including custom `name` values set in `models.json`), falling back to the id when no name is set.
- `editorMetadataFormat`: JSON-only template for the left side of the editor metadata row. Missing, non-string, or empty values restore the default `$model  $provider(  $thinking)` layout; non-empty strings, including whitespace-only strings, are preserved. See [Editor Metadata Format](#editor-metadata-format) below.
- `separator`: controls the default footer layout and extension-status connectors: `pipe` (default, ` | `), `dot` (` · `), `chevron` (` › `), or `none` (one space). Cycle it from the `/starline` **Layout** tab. This selects the separator glyph; `colors.separator` controls its color. Custom `footerFormat` literals and `$sep` keep their existing behavior.
- `contextThresholds`: `{ warning, error }` percentages (default `70` / `90`) that select contextNormal / contextWarning / contextError colors.
- `pathDisplay`: controls how the cwd/`$cwd` path is shown. `mode` is `basename` (default, last segment only) or `full` (path with home contracted to `~`). In `full` mode, `depth` keeps only the last N trailing directories (`0` = entire path after `~`, max `5`); when parents are dropped the path is prefixed with `…/` (Starship-style). The `/starline` **Layout** tab cycles path mode and path depth (`0`–`5`; depth is ignored for basename). Example: `~/Projects/foo/bar` with `depth: 2` → `…/foo/bar`.
- `gitBranch.maxLength`: visible width of the built-in branch name and `$git_branch` / `$branch`. The default `full` preserves the complete name; any positive integer uses that width including the trailing `…`. `/starline` **Layout** cycles `full`, `10`, `20`, `30`, `40`, and `50`; custom positive integers can be set in JSON.
- `icons`: every shown icon key is configurable; omit any key to use the Starline default. `icons.mode` is `auto` | `nerd` | `ascii` (default `auto`, same glyphs as nerd). ASCII mode swaps in plain fallbacks for statusline icons and runtime symbols — useful without a Nerd Font. Custom per-icon strings always win over mode defaults. Custom `icons.os` always wins; when left at the mode default, Starline maps the OS icon by platform. `rail` sets the vertical glyph drawn as the left rail of the active editor frame and previous user messages when `copyFriendly` is disabled (default `│`; any single Unicode vertical or block glyph). `editorPrompt` controls an optional copy-friendly editor prompt glyph; the default is `""` so copy-friendly mode stays rail-free.
- `colorSources`: `theme` maps styles through Pi theme tokens; `terminal` emits terminal colors. `/starline` switches these sources; manual JSON controls specific style values.
- `features`: `editor` enables Starline's custom editor, selector borders, and previous-message chrome. `statusLine` enables Starline's custom footer/status line. `copyFriendly` hides editor and previous-message rail glyphs so native terminal selection copies less chrome. All three can be changed from `/starline` or direct slash-command arguments.
- `footerSegments`: show or hide individual built-in footer segments (`cwd`, `sessionName`, `gitBranch`, `gitStatus`, `gitCounts`, `gitCommit`, `gitMetrics`, `runtime`, `packageVersion`, `sessionDuration`, `username`, `time`, `os`, `context`, `tokens`, `cost`). Toggle them from the `Built-in segments` tab in `/starline`.
- `footerFormat`: optional Starship-style template string that fully controls the footer layout. When set, it overrides `footerSegments`. See [Footer Format Template](#footer-format-template) below. The `/starline` **Layout** tab configures context style, separator, path display mode/depth, branch length, and icon mode; set or clear custom formats with `/starline format`.
- `gitCommit`: Starship [`git_commit`](https://starship.rs/config/#git-commit)-style options for the `gitCommit` footer segment. `hashLength` (default `7`, clamped to `4`–`40`) controls the short-hash display length. `onlyDetached` (default `true`) shows the hash mainly on detached HEAD. `showTag` (default `true`) appends an exact-match tag (`git describe --tags --exact-match HEAD`). The tag probe piggybacks on the existing git refresh — it only runs when both the segment and `showTag` are on, and misses/failures degrade silently.
- `gitMetrics`: Starship [`git_metrics`](https://starship.rs/config/#git-metrics)-style options for the `gitMetrics` footer segment. Uses `git diff HEAD --numstat` (staged + unstaged combined — the Starship “total dirty” view) to show aggregate `+added −deleted` line counts. `onlyNonzero` (default `true`) omits each zero component independently and hides the segment entirely at `0/0`. `ignoreSubmodules` (default `false`) adds `--ignore-submodules=all`. The numstat diff piggybacks on the existing git refresh and uses a hard 2s timeout; a metrics-only failure degrades silently without discarding fresh branch/status data. On very large monorepos the diff may lag or be omitted on timeout.
- `extensionStatuses`: controls third-party statuses published by other Pi extensions through `ctx.ui.setStatus()`. `defaultPlacement` and each `placements` value can be `off`, `left`, `middle`, or `right`. The `Extension segments` tab in `/starline` lists only statuses that are currently active.
- The shown `editor*` values match the default `theme` source. Omit those keys to keep Starline's source-aware defaults when switching between `theme` and `terminal`.
- `editorAccent` styles the active editor rail and previous user-message rail when `features.copyFriendly` is disabled.
- `editorPrompt` styles the copy-friendly editor prompt glyph. Omit it to use `editorAccent`, then the default accent fallback.
- `editorBorder` styles the active editor and previous user-message top/bottom border color only; the border glyph stays `─`.
- `editorModel`, `editorProvider`, and `editorThinking*` style the editor metadata. `editorThinking` applies to every non-`off` thinking level unless a level-specific key is set.

- `userMessageBorder` styles the previous user-message border on its own. Omit it to keep borrowing `editorBorder`, which is the upstream behaviour.
- `userMessageText` styles previous user-message body text. Omit it to follow the theme's `userMessageText` colour.
- `model` styles the `model` footer segment; `thinking` styles the `thinking` segment. Omit `thinking` to colour it by level from the theme's `thinkingOff`/`thinkingMinimal`/`thinkingLow`/`thinkingMedium`/`thinkingHigh`/`thinkingXhigh` keys.

Tip: when using copy-friendly mode, setting Pi's `editorPaddingX` to `1` in `~/.pi/agent/settings.json` keeps a small left gutter without copying a rail glyph.

## Colors

Every `colors.*` value is a space-separated style string. Four kinds of colour are accepted, and they have a defined precedence.

| Written as | Example | Resolves to |
| --- | --- | --- |
| Theme colour key | `"accent"`, `"syntaxKeyword"` | Whatever your Pi theme maps that key to |
| Terminal colour name | `"bold cyan"` | The theme key the name maps to, or the raw terminal colour when `colorSources` is `terminal` |
| 256-colour index | `"208"` | That palette entry |
| Hex literal | `"#cba6f7"` | Exactly that colour |

**A hex literal or 256 index always wins over the theme, regardless of `colorSources`.** That is what lets you override one segment without leaving theme-driven colours everywhere else. Attributes `bold`, `italic`, `underline` and `dim` can be combined with any of them.

Backgrounds use a `bg:` prefix, and `fg:` sets the foreground explicitly:

```json
{
	"colors": {
		"gitBranch": "bold bg:#cba6f7 fg:#1e1e2e",
		"cwd": "bold syntaxFunction"
	}
}
```

### Palette

Declare a scheme once and reference it, so switching schemes means editing one block rather than every segment. Both `$name` and `${name}` work, and palette entries may reference each other.

```json
{
	"palette": {
		"bg": "#24283b",
		"fg": "#c0caf5",
		"blue": "#7aa2f7",
		"purple": "#bb9af7",
		"green": "#9ece6a",
		"gray": "#414868"
	},
	"colors": {
		"cwd": "bold bg:$blue fg:$bg",
		"gitBranch": "bold bg:$purple fg:$bg",
		"context": "bold bg:$gray fg:$fg",
		"cost": "bold bg:$green fg:$bg"
	}
}
```

A reference that does not resolve is left as written, so the segment renders unstyled and the typo is visible rather than silently becoming empty. Palette expansion applies to `colors` only — `footerFormat` and `editorMetadataFormat` use `$name` for their own variables and are never rewritten.

**Known limitation:** hex literals are always emitted as truecolor. On a terminal without truecolor support they may render incorrectly, where theme colour keys degrade correctly because Pi picks the encoding. Use theme keys if you need 256-colour terminals to look right.

## Pill footer

`footerStyle: "pill"` renders the footer as coloured blocks joined by seamless powerline arrows instead of as coloured text. `footerStyle: "text"` is the default and leaves `footerFormat` and all existing behaviour untouched.

```json
{
	"footerStyle": "pill",
	"pill": {
		"segments": [
			"model",
			"thinking",
			"cwd",
			"gitBranch",
			"gitStatus",
			"extensionStatus:balance",
			"context",
			"cost",
			"extensionStatus"
		],
		"separator": "powerline",
		"bold": true,
		"caps": "round"
	}
}
```

| Key | Values | Meaning |
| --- | --- | --- |
| `segments` | `footerSegments` keys, `extensionStatus`, `extensionStatus:<key>` | Order, left to right |
| `separator` | `powerline` (default), `powerline-thin`, `none` | Glyph between pills |
| `bold` | `true` (default), `false` | Bold segment text |
| `caps` | `round` (default), `right`, `none` | How the bar's ends are closed |

Notes:

- **Colours need no extra configuration.** A segment's existing `colors.*` entry, which is a foreground in text mode, becomes the pill background here. Text colour is picked automatically for legibility unless you set `fg:` yourself.
- `extensionStatus` is not one segment but however many other extensions have registered (balance, automode, mcp, …). Listing it expands to all of them; `extensionStatus:<key>` places one specific status, and it is not repeated by a later `extensionStatus`.
- A status configured with `colorMode: "themed"` (the default) recolours the extension's status segment to match the rest of the bar. `colorMode: "original"` keeps the colours its own extension chose, on a neutral background.
- `footerSegments` toggles still apply: a segment listed here but switched off there is skipped.
- Unknown segment names are dropped rather than drawn as empty pills.
- Where two neighbouring pills resolve to the same background, the solid arrow would be invisible (it is the left colour drawn on the right colour), so a thin divider is drawn in the text colour instead. Several segments share a default colour, so this comes up more often than it sounds.
- In `icons.mode: "ascii"` the arrows and caps disappear; the background transitions still separate the segments.

Give each status its own icon with `extensionStatuses.icons`, keyed by status key (statuses set to `colorMode: "original"` are left alone, since their text arrives pre-styled — `colorMode: "themed"` statuses take the icon). Give each its own colour with `extensionStatuses.colors`, keyed the same way — otherwise they all take `colors.extensionStatus` and read as one block:

```json
{
	"extensionStatuses": {
		"icons": {
			"provider-balance": "",
			"mcp-status": ""
		},
		"colors": {
			"provider-balance": "bg:$yellow",
			"pi-automode": "bg:$lavender",
			"mcp-status": "bg:$sky"
		}
	}
}
```

## Segment display options

```json
{
	"segmentOptions": {
		"context": { "format": "full" },
		"tokens": { "cache": "percent" }
	}
}
```

- `context.format` — `full` (default, `6%/200k`) or `percent` (`6%`). Orthogonal to `contextStyle`: the gauge is unaffected.
- `tokens.cache` — `percent` (default, cache hit rate), `tokens` (raw cache-read count), or `off`.

The cache hit rate can also stand on its own rather than riding inside the tokens
segment. Enable the `cacheHit` segment and set `tokens.cache` to `off` so it is
not shown twice:

```json
{
	"footerSegments": { "cacheHit": true },
	"segmentOptions": { "tokens": { "cache": "off" } },
	"icons": { "cacheHit": "" }
}
```

`icons.cacheHit` is the glyph for that segment, and doubles as the inline glyph
when the rate rides inside `tokens`. The segment renders nothing when there was no
cache activity, or when the latest turn has no known rate, so it disappears rather
than claiming a miss.

## Git host icon

```json
{ "gitHostIcon": false }
```

When enabled, the branch segment's icon becomes the `origin` remote's forge logo: GitHub, GitLab, Bitbucket, or a generic git mark for anything else, including self-hosted instances recognised by subdomain (`gitlab.acme.com`). Repos with no `origin` keep the plain branch icon. The remote is read once and cached for ten minutes, and only read at all when the option is on. Disabled in `icons.mode: "ascii"`.

## Box height

The editor and previous-message boxes each carry a blank row above and below
their content. Set either to `0` to reclaim those rows:

```json
{
	"editorPaddingY": 1,
	"userMessagePaddingY": 1
}
```

Only `0` and `1` are accepted. The editor frame is parsed back by position when
one editor wraps another, so the padding the renderer emits and the padding the
parser assumes have to agree — a second padding row has nowhere to be described.

## Paste collapse threshold

Pi collapses a pasted block into a `[paste #N +L lines]` marker at more than ten
lines. `pasteCollapseLines` lowers that:

```json
{ "pasteCollapseLines": 3 }
```

Accepts 2 through 10; `11` (the default) and anything else leaves Pi's own
threshold alone. Above Pi's threshold, and for pasted paths, Pi still handles it.

What gets stored is cleaned exactly the way Pi cleans it, so the marker expands
to the right text on submit and behaves the same when deleted. If the editor
does not expose what this needs, nothing is patched and Pi's threshold stands.

### Paste again to expand

While a collapsed paste is fresh, `paste again to expand` sits on the right of
the editor's metadata row, beside the vim mode indicator when there is one.
Pasting the same content again replaces the placeholder with the full text in
place, rather than adding a second one.

That row is drawn whether or not `editorMetadataFormat` has anything in it, so
blanking the template does not take the hint with it. The hint used to sit on
the editor's bottom border, drawn there by the fixed editor that Pi 0.84
superseded; it moved so that it no longer depends on that.

This works for both kinds of collapse — the ones lowered by `pasteCollapseLines`
and the ones Pi does itself above its own threshold — and needs no configuration.
Any other keystroke puts the offer away, as does deleting the placeholder.

Expansion refuses if the text behind the placeholder is no longer what was
collapsed: Pi renumbers paste ids when a marker is deleted, so an id can come to
point somewhere else. The cost of refusing is a second placeholder; the cost of
guessing would be silently pasting the wrong thing.

## Mouse features

```json
{
	"mouse": {
		"enabled": true,
		"wheelRouting": true,
		"copyNotice": true,
		"copyOnSelect": true,
		"clickToExpandTools": true,
		"pathAwareWords": true,
		"transcriptCleanCopy": true
	}
}
```

`mouse` replaces the old `fixedEditor` namespace: what it named stopped being either fixed or only about the editor once Starline moved to patching Pi 0.84's own renderer instead of running its own compositor. A `fixedEditor` block from an older config is migrated automatically the first time Starline loads it — every old key is carried over under its new name, the old block is removed, and the change is written back once with a warning. An explicit `mouse` key already present in the config always wins over whatever the migration would have written for it.

- `enabled` — master switch for every mouse feature below. On by default.
- `wheelRouting` — routes the mouse wheel to scroll the transcript instead of leaving it to the terminal.
- `copyNotice` — shows a "Copied to clipboard" flash for a copy **Starline** performs, such as `ctrl+c` in pending selection mode. Pi confirms its own copy-on-release with its own flash regardless of this setting.
- `copyOnSelect` — copy on mouse release. When `false`, a highlight waits for `ctrl+c` instead (pending selection mode).
- `clickToExpandTools` — clicking a tool box's `… ctrl+o to expand` hint row expands just that box, instead of `ctrl+o` expanding every box in the transcript. Only the hint row toggles; a press anywhere else in the box still starts a selection, and the row follows whatever key you have bound to `app.tools.expand`. Two things worth knowing before they surprise you:
  - **Clicking does not always close what it opened.** Bash boxes keep a `ctrl+o to collapse` hint on screen when open, and clicking it closes them. With `pi-toolbox` installed, `read`, `grep`, `ls`, `write` and `find` boxes get the same row appended inside the frame when expanded (pi-toolbox's `collapseAnchor`), so those close with one click too. Skill blocks, branch summaries and compaction summaries still drop the hint entirely once expanded — nothing is left to click, and `ctrl+o` (which closes every box) is the way back.
  - **A box whose output contains the literal text `(ctrl+o to expand)` makes that line clickable too** — printing this page, say, or `cat`-ing a file that documents the keybinding. Pi draws a box's output and its hint the same way, so they cannot be told apart without matching theme colours. Clicking such a line toggles the box it is already inside; nothing else happens.
- `pathAwareWords` — double/triple-click word selection stops at path separators (`/`, `.`) instead of only at whitespace.

## Editor cursor

```json
{ "editorCursor": "block" }
```

- `block` (default) — Pi's reverse-video block
- `underline` — an underline instead of the block
- `terminal` — hide the software cursor and let the real terminal cursor show through, so its shape and blink follow your terminal's own configuration

**`terminal` requires Pi's own hardware cursor to be on.** Pi defaults it off (`showHardwareCursor`, or `PI_HARDWARE_CURSOR=1`) and re-applies that setting at several points, so an extension cannot turn it on reliably. Set it in `~/.pi/agent/settings.json`:

```json
{ "showHardwareCursor": true }
```

## Editor Metadata Format

Set `editorMetadataFormat` in `~/.pi/agent/starline.json` to customize the left side of the editor metadata row. Set it to `""` to show nothing there — useful when `$model` and `$thinking` have moved to the pill footer. The row itself stays (the frame is parsed back by position, so its line count is fixed); it just renders blank.

```json
{
	"editorMetadataFormat": "$model_name ($model_id)( · $provider)( · $thinking)( · $session_name)"
}
```

The syntax follows the relevant `footerFormat` conventions: `$variable` and `${variable}` references, literal text and spaces, and conditional groups `( ... )` that disappear when all variables inside are empty. Unknown variables and `$fill` render empty; `$fill` never creates an editor layout zone because the right side remains reserved for structural Vim status.

| Token           | Renders                                                                                       |
| --------------- | --------------------------------------------------------------------------------------------- |
| `$model`        | label selected by `editorModelLabel` (`id`, or name with ID fallback)                        |
| `$model_id`     | active Pi model ID                                                                            |
| `$model_name`   | active Pi model display name; empty when no name is set                                       |
| `$provider`     | provider label using Starline's existing formatting                                             |
| `$thinking`     | current thinking level; empty when thinking is `off`                                          |
| `$session_name` | current Pi session name; empty when unnamed                                                    |

Model variables use `editorModel`, provider uses `editorProvider`, and thinking uses the matching `editorThinking*` style. Literal text and `$session_name` use the neutral editor border theme style. The template controls spacing. ANSI/VT sequences, control characters, and line-breaking whitespace are sanitized before rendering without collapsing ordinary spaces.

Missing, non-string, or empty values use the default `$model  $provider(  $thinking)`. A non-empty format that resolves to no visible metadata keeps the normal blank spacer and metadata rows so the editor frame height remains stable. This option is configured only through JSON in its first version; `/starline format` continues to control the footer only.

## Footer Format Template

For full control, set a Starship-style `footerFormat` template string. It supports `$variable` and `${variable}` tokens, a special `$fill` token that splits the line into left and right zones, and conditional groups `( ... )` that drop entirely when every nested variable is empty. When set, it overrides the built-in `footerSegments` layout; when empty or omitted, the segment layout above is used.

A second `$fill` creates a **centered middle zone** — content between the two fills is true-centered (`floor((gap - middle) / 2)`), just like third-party statuses placed `middle`.

```json
{
	"footerFormat": "$os $username $cwd($sep$session_name)( on $git_branch)( $git_status)( via $runtime)$fill($context)($sep$tokens)($sep$cost)($sep$time)"
}
```

Center the branch between directory and cost:

```json
{
	"footerFormat": "$cwd $fill $git_branch $fill $cost"
}
```

### Variables

| Token               | Aliases      | Renders                                                             |
| ------------------- | ------------ | ------------------------------------------------------------------- |
| `$cwd`              | `$directory` | current directory                                                   |
| `$session_name`     |              | current Pi session name                                             |
| `$git_branch`       | `$branch`    | git branch with icon                                                |
| `$git_status`       | `$status`    | `[!?↑]` status block                                                |
| `$git_state`        | `$state`     | `REBASING` / `MERGING` / … (optional `n/m`)                         |
| `$git_commit`       | `$commit`    | short commit hash (+ exact-match tag when present)                  |
| `$git_tag`          | `$tag`       | exact-match tag at HEAD                                             |
| `$git_metrics`      |              | aggregate line changes `+added −deleted`                            |
| `$git_added`        |              | added line count (`+N`)                                             |
| `$git_deleted`      |              | deleted line count (`−N`)                                           |
| `$runtime`          |              | runtime icon + version                                              |
| `$package`          |              | project package version, `is <glyph> <version>` (manifest-derived)  |
| `$package_version`  |              | raw project package version (no icon)                               |
| `$session_duration` | `$duration`  | session running time                                                |
| `$username`         |              | `user@host`                                                         |
| `$os`               |              | operating-system icon                                               |
| `$time`             |              | current time `HH:MM`                                                |
| `$context`          |              | context usage (text and/or gauge via config)                        |
| `$tokens`           |              | input/output token counts                                           |
| `$cost`             |              | session cost                                                        |
| `$sep`              | `$separator` | themed `\|` using `colors.separator`            |
| `$fill`             | —            | special: splits zones                                               |

### `$fill` behavior

| `$fill` count | Layout                                                                   |
| ------------- | ------------------------------------------------------------------------ |
| 0             | everything left-aligned                                                  |
| 1             | tokens before → left, tokens after → right                               |
| 2             | before first → left, between → **centered middle**, after second → right |
| 3+            | first two count; extras ignored                                          |

- Literal text (`on branch`, `using`, `\|`, spaces) is rendered verbatim — you control all spacing.
- Each variable renders its core value only (no `on`/`via` prefixes); add those words as literal text.
- Conditional groups: wrap optional pieces in parentheses, e.g. `$cwd( on $git_branch)($git_status)$fill($context)`. If every `$var` inside a group is empty, the whole group (including its literals) is dropped.
- `$session_name` is available whenever `footerFormat` is set, independently of `footerSegments.sessionName`; use a conditional group such as `($sep$session_name)` so unnamed sessions leave no separator.
- Unknown `$variables` render empty.
- Set or clear at runtime: `/starline format "<template>"` and `/starline format clear`.
