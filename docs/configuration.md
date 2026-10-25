# Starline configuration

Every option Starline has.

## All options

| Key | Type | Default | What it does |
| --- | --- | --- | --- |
| `projectRefreshIntervalMs` | number | `30000` | How often git and runtime state are re-read. Minimum 5000. |
| `pill` | object | see [Pill footer](#pill-footer) | Segment order, separator glyph, boldness, and cap style for the pill footer. |
| `editorMetadataFormat` | string | `"$model  $provider(  $thinking)"` | Template for the left side of the editor metadata row, see [Editor Metadata Format](#editor-metadata-format). |
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
| `git` | object | see [Git](#git) | Branch length, forge logo, commit and line-metric options. |
| `icons` | object | see the JSON block below | Per-icon glyph overrides and the icon mode (`auto`, `nerd`, `ascii`). |
| `colors` | object | see [Colors](#colors) | Style string for every themeable segment and editor element. |
| `colorSources` | object | `{ "starship": "theme", "editor": "theme", "userMessages": "theme" }` | Whether each area's colours come from the Pi theme or the terminal palette. |
| `features` | object | `{ "editor": true, "statusLine": true, "copyFriendly": false }` | Toggles the custom editor, the custom footer, and copy-friendly mode. |
| `extensionStatuses` | object | see [Pill footer](#pill-footer) | Placement, colour, and icon for third-party extension statuses. |
| `mouse` | object | see [Mouse features](#mouse-features) | Wheel routing, click-to-expand tool boxes, path-aware word selection, and Starline's own copy behaviour. |

User config lives at `~/.pi/agent/starline.json`. The file is optional: missing or invalid known values fall back to Starline defaults, unknown keys are ignored at runtime, and `/starline` can patch color-source settings, UI feature toggles, and active third-party status placements.

The interactive `/starline` menu is split into five sections. Use `Tab` and `Shift+Tab` to switch between `Coloring`, `Features`, `Layout`, `Pills`, and `Extension segments`.

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
```

Default config values — copy this and change any value you want:

```json
{
	"projectRefreshIntervalMs": 30000,
	"pill": {
		"segments": [
			"model",
			"thinking",
			"cwd",
			"git",
			"context",
			"cost",
			"extensionStatus"
		],
		"separator": "powerline",
		"bold": true,
		"caps": "round"
	},
	"editorMetadataFormat": "$model  $provider(  $thinking)",
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
	"git": {
		"counts": false,
		"hostIcon": false,
		"branch": {
			"maxLength": "full"
		},
		"commit": {
			"hashLength": 7,
			"onlyDetached": true,
			"showTag": true
		},
		"metrics": {
			"onlyNonzero": true,
			"ignoreSubmodules": false
		}
	},
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
		"queue": "\uf01c",
		"subagents": "\uf0c0",
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
		"transcriptCleanCopy": true
	}
}
```

- Style values can be Starship/terminal strings (`bold purple`, `fg:202`, `#89b` / `#89b4fa`, `bg:blue fg:bright-green`) or Pi theme tokens (`accent`, `borderMuted`, `thinkingHigh`). Short `#rgb` hex values expand to `#rrggbb`.
- `projectRefreshIntervalMs`: project status polling interval; `0` disables polling. Values `1..4999` clamp up to `5000` (minimum 5s); invalid/non-finite values fall back to `30000`.
- `contextStyle`: `text` (default), `gauge`, or `text+gauge` for the context segment. Context usage refreshes during assistant streaming; token and cost totals remain canonical and finalize at turn boundaries.
- `editorModelLabel`: controls the model shown in the editor frame. `id` (default) shows the model id; `name` shows the model's display name (including custom `name` values set in `models.json`), falling back to the id when no name is set.
- `editorMetadataFormat`: JSON-only template for the left side of the editor metadata row. Missing, non-string, or empty values restore the default `$model  $provider(  $thinking)` layout; non-empty strings, including whitespace-only strings, are preserved. See [Editor Metadata Format](#editor-metadata-format) below.
- `contextThresholds`: `{ warning, error }` percentages (default `70` / `90`) that select contextNormal / contextWarning / contextError colors.
- `pathDisplay`: controls how the cwd/`$cwd` path is shown. `mode` is `basename` (default, last segment only) or `full` (path with home contracted to `~`). In `full` mode, `depth` keeps only the last N trailing directories (`0` = entire path after `~`, max `5`); when parents are dropped the path is prefixed with `…/` (Starship-style). The `/starline` **Layout** tab cycles path mode and path depth (`0`–`5`; depth is ignored for basename). Example: `~/Projects/foo/bar` with `depth: 2` → `…/foo/bar`.
- `icons`: every shown icon key is configurable; omit any key to use the Starline default. `icons.mode` is `auto` | `nerd` | `ascii` (default `auto`, same glyphs as nerd). ASCII mode swaps in plain fallbacks for statusline icons and runtime symbols — useful without a Nerd Font. Custom per-icon strings always win over mode defaults. Custom `icons.os` always wins; when left at the mode default, Starline maps the OS icon by platform. `rail` sets the vertical glyph drawn as the left rail of the active editor frame and previous user messages when `copyFriendly` is disabled (default `│`; any single Unicode vertical or block glyph). `editorPrompt` controls an optional copy-friendly editor prompt glyph; the default is `""` so copy-friendly mode stays rail-free.
- `colorSources`: `theme` maps styles through Pi theme tokens; `terminal` emits terminal colors. `/starline` switches these sources; manual JSON controls specific style values.
- `features`: `editor` enables Starline's custom editor, selector borders, and previous-message chrome. `statusLine` enables Starline's custom footer/status line. `copyFriendly` hides editor and previous-message rail glyphs so native terminal selection copies less chrome. All three can be changed from `/starline` or direct slash-command arguments.
- `git`: everything the git segments read, see [Git](#git). Also drives which optional probes run: a tag lookup only happens when `gitCommit` or `gitTag` is in `pill.segments`, `git diff --numstat` only for `gitMetrics`, and the remote lookup only for the `git` pill with `hostIcon` on.
- `extensionStatuses`: controls third-party statuses published by other Pi extensions through `ctx.ui.setStatus()`. `defaultPlacement` and each `placements` value can be `off`, `left`, `middle`, `right`, or `editor`. The `Extension segments` tab in `/starline` lists only statuses that are currently active. `editor` puts the status on the right-hand side of the editor's metadata row, next to the copy and paste hints — it is drawn there as one muted line, so `colors`, `icons`, and `colorMode` do not apply, and it needs both `features.editor` and `features.statusLine` on (the status map only reaches Starline through its footer). Publishing extensions can also make their pill clickable and open a bubble with their own detail through the pill API — see [Clickable pills for other extensions](pill-api.md).
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

A reference that does not resolve is left as written, so the segment renders unstyled and the typo is visible rather than silently becoming empty. Palette expansion applies to `colors` only — `editorMetadataFormat` uses `$name` for its own variables and is never rewritten.

**Known limitation:** hex literals are always emitted as truecolor. On a terminal without truecolor support they may render incorrectly, where theme colour keys degrade correctly because Pi picks the encoding. Use theme keys if you need 256-colour terminals to look right.

## Pill footer

The footer is a bar of coloured pills joined by seamless powerline arrows. `pill.segments` decides what is on it and in which order; there is no second layout.

```json
{
	"pill": {
		"segments": [
			"model",
			"thinking",
			"queue",
			"cwd",
			"git",
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
| `segments` | segment names (`cwd`, `git`, `context`, `cost`, …), plus `queue`, `subagents`, `extensionStatus`, `extensionStatus:<key>` | Order, left to right |
| `separator` | `powerline` (default), `powerline-thin`, `none` | Glyph between pills |
| `bold` | `true` (default), `false` | Bold segment text |
| `caps` | `round` (default), `right`, `none` | How the bar's ends are closed |
| `bubbleAnimation` | `true` (default), `false` | Unfold a clicked pill's bubble upward from the pill (60 ms) instead of showing it at once. Applies from the next session or `/reload`. |

Order and visibility of the bar live in `pill.segments`. The **Pills** tab in
`/starline` edits the same list: one row per segment, and its value is the
position it holds (`1` is leftmost, `off` is not drawn). Space cycles `off → 1
→ 2 → …`, picking a number inserts the segment there and shifts the rest along.
Per-status `extensionStatus:<key>` entries are JSON-only; the *Extension
segments* tab owns those keys.

Notes:

- **The `queue` pill is clickable.** It exists only while messages are waiting for the current turn to end, so it costs no space the rest of the time. Clicking it, or running `/starline queue`, opens a bubble on the pill that says how many messages are queued and shows their first lines. The pill shows an inbox icon and the count (`icons.queue`); when Pi does not let the count be read it says `queued` instead, and with icons off it reads `3 queued`. Clicking the pill again closes the bubble. While the queue pill is enabled, Pi's own `Steering: …` rows above the editor are hidden, so the queue is shown once rather than twice; remove `queue` from `pill.segments` (or switch the status line off) and Pi's rows come back. `colors.queue` (default `bold yellow`) colours the pill and the bubble
- **The `model` pill is clickable.** A click lists the session's scoped models — the ones ctrl+p cycles, from `enabledModels` or `--models` — with the current one marked; click another to switch. A scoped model that pins a thinking level (`provider/model:high`) brings it along, as ctrl+p does. Without a scope it lists up to eight available models and points at `/model` for the rest. `/starline model` steps to the next one from the keyboard.
- **The `subagents` pill is clickable.** With [`pi-subagents`](https://github.com/nicobailon/pi-subagents) installed, it appears while subagents are running and says how many (`2 agents`); it disappears when they finish, and without pi-subagents it never appears. Clicking it, or running `/starline subagents`, opens the bubble with one line per run: agent (and step label), model, time running and tokens so far. `/subagents-fleet` still opens pi-subagents' own inspector for steering and stopping. The numbers come from pi-subagents' public in-process RPC, refreshed when a run starts or ends rather than on a timer. If the pill replaces pi-subagents' FleetView and async widget for you, turn those off in `~/.pi/agent/extensions/subagent/config.json` with `"fleetView": false` and `"asyncWidget": false`. `colors.subagents` (default `bold green`) colours the pill and the bubble
- **The `thinking` pill is clickable.** A click opens the same bubble with every thinking level the model supports, the current one marked; click another level to switch. Opening it changes nothing. `off` is not offered, so the pill stays on screen. `/starline thinking` steps to the next level from the keyboard and reports the step (`medium → high`).
- **Colours need no extra configuration.** A segment's existing `colors.*` entry becomes the pill background. Text colour is picked automatically for legibility unless you set `fg:` yourself.
- `extensionStatus` is not one segment but however many other extensions have registered (balance, automode, mcp, …). Listing it expands to all of them; `extensionStatus:<key>` places one specific status, and it is not repeated by a later `extensionStatus`.
- A status configured with `colorMode: "themed"` (the default) recolours the extension's status segment to match the rest of the bar. `colorMode: "original"` keeps the colours its own extension chose, on a neutral background.
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
		},
		"formats": {
			"mcp-status": "value"
		}
	}
}
```

`extensionStatuses.formats` keeps a status to its number, so an icon plus that
number reads as one compact pill instead of `MCP: 3 servers`:

| Format | `Tavily: 41.1%` | `1 proc` | `ready` |
| --- | --- | --- | --- |
| `full` (default) | `Tavily: 41.1%` | `1 proc` | `ready` |
| `value` | `41.1%` | `1` | `ready` |

A status with no number keeps its text under `value`: blanking `ready` would leave
an icon that says nothing. The format changes only what the bar draws, not what
the publishing extension sent (its own `setStatus` text stays as it was).

## Segment display options

```json
{
	"segmentOptions": {
		"context": { "format": "full" },
		"tokens": { "cache": "percent" },
		"subagents": { "format": "agents" }
	}
}
```

- `context.format` — `full` (default, `6%/200k`) or `percent` (`6%`). Orthogonal to `contextStyle`: the gauge is unaffected.
- `tokens.cache` — `percent` (default, cache hit rate), `tokens` (raw cache-read count), or `off`.
- `subagents.format` — `agents` (default, `2 agents`) or `count` (`2`). Use `count` when `icons.subagents` already says what the number counts.

The cache hit rate can also stand on its own rather than riding inside the tokens
segment. Add `cacheHit` to `pill.segments` and set `tokens.cache` to `off` so it
is not shown twice:

```json
{
	"pill": { "segments": ["cwd", "context", "tokens", "cacheHit", "cost"] },
	"segmentOptions": { "tokens": { "cache": "off" } },
	"icons": { "cacheHit": "" }
}
```

`icons.cacheHit` is the glyph for that segment, and doubles as the inline glyph
when the rate rides inside `tokens`. The segment renders nothing when there was no
cache activity, or when the latest turn has no known rate, so it disappears rather
than claiming a miss.

## Git

```json
{
	"git": {
		"counts": false,
		"hostIcon": false,
		"branch": { "maxLength": "full" },
		"commit": { "hashLength": 7, "onlyDetached": true, "showTag": true },
		"metrics": { "onlyNonzero": true, "ignoreSubmodules": false }
	}
}
```

| Key | Default | What it does |
| --- | --- | --- |
| `counts` | `false` | Show numbers beside the ahead/behind and stash glyphs (`!3`) instead of the glyph alone (`!`). |
| `hostIcon` | `false` | Replace the branch icon with the `origin` remote's forge logo: GitHub, GitLab, Bitbucket, or a generic git mark for anything else, including self-hosted instances recognised by subdomain (`gitlab.acme.com`). Repos with no `origin` keep the plain branch icon. The remote is read once and cached for ten minutes, and only read when this is on. Disabled in `icons.mode: "ascii"`. |
| `branch.maxLength` | `"full"` | Caps the visible width of the branch name. `full` keeps the whole name; a positive integer truncates to that width including the trailing `…`. The **Layout** tab cycles `full`, `10`, `20`, `30`, `40`, `50`. |
| `commit.hashLength` | `7` | Short-hash width for the `gitCommit` pill, clamped to `4`–`40`. |
| `commit.onlyDetached` | `true` | Show the hash mainly on a detached HEAD, where the branch name is gone. |
| `commit.showTag` | `true` | Append the exact-match tag (`git describe --tags --exact-match HEAD`). The lookup only runs while a tag can be shown. |
| `metrics.onlyNonzero` | `true` | Omit each zero side of `+added −deleted` independently, and hide the pill entirely at `0/0`. |
| `metrics.ignoreSubmodules` | `false` | Pass `--ignore-submodules=all` to the numstat diff. |

The numstat diff is the Starship “total dirty” view: staged and unstaged combined. It piggybacks on the git refresh with a hard 2 s timeout; a metrics-only failure degrades silently without discarding fresh branch/status data. On very large monorepos the diff may lag or be omitted on timeout.

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
		"transcriptCleanCopy": true
	}
}
```

`mouse` replaces the old `fixedEditor` namespace: what it named stopped being either fixed or only about the editor once Starline moved to patching Pi 0.84's own renderer instead of running its own compositor. A `fixedEditor` block from an older config is migrated automatically the first time Starline loads it — every old key is carried over under its new name, the old block is removed, and the change is written back once with a warning. An explicit `mouse` key already present in the config always wins over whatever the migration would have written for it. (`fixedEditor.copyOnSelect` is dropped, not migrated: Pi 0.84.4 owns select-without-copy as `fullscreenCopyOnSelect`. `fixedEditor.clickToExpandTools` is dropped the same way: Pi 0.86.0 toggles a single tool box on click natively. Starline no longer has keys for either.)

- `enabled` — master switch for every mouse feature below. On by default.
- `wheelRouting` — routes the mouse wheel to scroll the transcript instead of leaving it to the terminal.
- `copyNotice` — shows a "Copied to clipboard" flash for a copy **Starline** performs, such as a clean copy. Pi confirms its own copy-on-release with its own flash regardless of this setting.
Single-box click-to-toggle is **Pi's own** since 0.86.0 — a click anywhere in a tool box's result region toggles just that box (the renderer only synthesizes a click when press and release land on the same cell, so drag-selection is unaffected), and thinking blocks, branch/compaction summaries and skill invocations toggle the same way. Starline's hint-row patch and its `clickToExpandTools` key are retired; a `mouse.clickToExpandTools` key in an old config is ignored at runtime.

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

The syntax follows the same conventions as `editorMetadataFormat`: `$variable` and `${variable}` references, literal text and spaces, and conditional groups `( ... )` that disappear when all variables inside are empty. Unknown variables and `$fill` render empty; `$fill` never creates an editor layout zone because the right side remains reserved for structural Vim status.

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
