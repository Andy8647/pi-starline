# Starline

A Starship-inspired statusline and Opencode-style TUI for [Pi](https://pi.dev).

> Starline is a fork of [pi-zentui](https://github.com/lmilojevicc/pi-zentui) by Luka, renamed and released on its own. It has diverged well past upstream and adds a pill footer style, a colour palette with `$ref` expansion, `model`/`thinking` footer segments, a git host icon, per-segment display options, configurable editor cursor styles, and mouse selection in the fixed editor.

## Screenshots

![Starline](https://raw.githubusercontent.com/Andy8647/pi-starline/main/assets/starline.png)

## What is this?

Starline brings two popular aesthetics to Pi:

- **[Starship](https://starship.rs/) footer** — shows your current directory, git branch, git status indicators, and runtime/version detection in a compact, icon-rich format
- **[Opencode](https://github.com/opencode-ai/opencode) editor** — clean bordered input box with accent rail, copy-friendly mode, and model/provider display inside the editor frame

## Features

### Footer (Starship-inspired)

- `dirname` — current directory (`basename` by default; optional `full` path with directory depth via `pathDisplay`)
- `on  branch` — git branch with icon
- `[!?↑]` — git status indicators (modified, untracked, ahead/behind, stashed, etc.)
- `via  v5.5.0` — runtime detection with version and Starship-style Nerd Font runtime/language modules
- Optional segments (off by default): session name, `user@host`, current time, OS icon, session duration, and the **project package version** (e.g. `package.json` → `0.6.0`) — distinct from the runtime segment, which shows the installed toolchain
- Right side shows context usage, token counts, and cost
- Built-in footer segments can be shown or hidden individually from `/starline`
- Fully custom Starship-style layout via a `footerFormat` template string — see [Footer Format Template](https://github.com/Andy8647/pi-starline/blob/main/docs/configuration.md#footer-format-template)
- Third-party Pi extension statuses from `ctx.ui.setStatus()` can be shown on the left,
  middle, or right side, or hidden per status key from `/starline`

### Editor (Opencode-inspired)

- Bordered input box with configurable accent rail and border colors
- Model name and provider displayed inside the editor frame
- Configurable model, provider, and thinking-level indicator colors
- Prompt-box-style user messages matching the Starline input chrome
- Copy-friendly mode hides editor and previous-message rail glyphs so terminal selection copies less chrome
- **Fixed editor** (experimental, opt-in): Pin the editor and footer at the bottom of the terminal while the transcript scrolls above

### Git Status Icons

<details>
<summary>The indicators and what they mean</summary>

| Icon | Meaning    |
| ---- | ---------- |
| `!`  | Modified   |
| `?`  | Untracked  |
| `+`  | Staged     |
| `✘`  | Deleted    |
| `»`  | Renamed    |
| `=`  | Conflicted |
| `$`  | Stashed    |
| `↑`  | Ahead      |
| `↓`  | Behind     |
| `⇕`  | Diverged   |

</details>

### Runtime Detection

Detects Starship Nerd Font runtime/language modules, uses the Starship Nerd Font symbols, and keeps Starship-style defaults such as `bold green` for Node.js. By default Starline maps those styles through your active Pi theme; switch the Starship/footer color source to `terminal` in `/starline` if you want your terminal colorscheme to supply the exact ANSI colors.

<details>
<summary>All 57 detected runtimes and how they are recognised</summary>

| Runtime/language | Detection examples                                            |
| ---------------- | ------------------------------------------------------------- |
| Buf              | `buf.yaml`, `buf.gen.yaml`, `buf.work.yaml`                   |
| Bun              | `bun.lock`, `bun.lockb`                                       |
| C                | `.c`, `.h` files                                              |
| C++              | `.cpp`, `.cc`, `.cxx`, `.hpp` files                           |
| CMake            | `CMakeLists.txt`, `CMakeCache.txt`                            |
| COBOL            | `.cbl`, `.cob` files                                          |
| Conda            | `CONDA_DEFAULT_ENV` environment                               |
| Crystal          | `.cr` files, `shard.yml`                                      |
| Dart             | `.dart` files, `pubspec.yaml`, `.dart_tool/`                  |
| Deno             | `deno.json`, `deno.jsonc`, `deno.lock`                        |
| .NET             | `.csproj`, `.fsproj`, `global.json`, `Directory.Build.*`      |
| Elixir           | `mix.exs`                                                     |
| Elm              | `.elm` files, `elm.json`, `elm-stuff/`                        |
| Erlang           | `rebar.config`, `erlang.mk`                                   |
| Fennel           | `.fnl` files                                                  |
| Fortran          | `.f`, `.f90`, `.f95`, `.f03`, `.f08`, `.f18`, `fpm.toml`      |
| Gleam            | `.gleam` files, `gleam.toml`                                  |
| Go               | `go.mod`                                                      |
| Gradle           | `build.gradle`, `build.gradle.kts`, `gradle/`                 |
| Guix shell       | `GUIX_ENVIRONMENT` environment                                |
| Haskell          | `.hs`, `.cabal`, `stack.yaml`, `cabal.project`                |
| Haxe             | `.hx`, `.hxml`, `haxelib.json`, `.haxerc`                     |
| Helm             | `helmfile.yaml`, `Chart.yaml`                                 |
| Java             | `.java-version`                                               |
| Julia            | `.jl` files, `Project.toml`, `Manifest.toml`                  |
| Kotlin           | `.kt`, `.kts` files                                           |
| Lua              | `.lua` files, `stylua.toml`, `.luarc.json`, `lua/` dir        |
| Maven            | `pom.xml`                                                     |
| Meson            | `MESON_DEVENV=1` and `MESON_PROJECT_NAME` environment         |
| Mojo             | `.mojo` files                                                 |
| Nim              | `.nim`, `.nims`, `.nimble`, `nim.cfg`                         |
| Nix shell        | `IN_NIX_SHELL=pure` or `IN_NIX_SHELL=impure` environment      |
| Node.js          | `package.json`, `.nvmrc`, `.node-version`                     |
| OCaml            | `.opam`, `.ml`, `.mli`, `dune`, `_opam/`, `esy.lock/`         |
| Odin             | `.odin` files                                                 |
| OPA/Rego         | `.rego` files                                                 |
| Perl             | `.pl`, `.pm`, `Makefile.PL`, `cpanfile`, `META.*`             |
| PHP              | `composer.json`                                               |
| Pixi             | `pixi.toml`, `pixi.lock`, `PIXI_ENVIRONMENT_NAME` environment |
| Pulumi           | `Pulumi.yaml`, `Pulumi.yml`                                   |
| PureScript       | `.purs` files, `spago.dhall`, `spago.yaml`, `spago.lock`      |
| Python           | `pyproject.toml`, `requirements.txt`, `setup.py`, `Pipfile`   |
| R                | `.R`, `.Rmd`, `.Rproj`, `DESCRIPTION`, `.Rproj.user/`         |
| Raku             | `.raku`, `.rakumod`, `.p6`, `.pm6`, `META6.json`              |
| Red              | `.red`, `.reds` files                                         |
| Ruby             | `Gemfile`, `.ruby-version`                                    |
| Rust             | `Cargo.toml`                                                  |
| Scala            | `.scala`, `.sbt`, `build.sbt`, `.metals/`                     |
| Solidity         | `.sol` files                                                  |
| Spack            | `SPACK_ENV` environment                                       |
| Swift            | `.swift` files, `Package.swift`                               |
| Terraform        | `.tf`, `.tfplan`, `.tfstate`, `.terraform/`                   |
| Typst            | `.typ` files, `template.typ`                                  |
| Vagrant          | `Vagrantfile`                                                 |
| V                | `.v` files, `v.mod`, `vpkg.json`                              |
| Xmake            | `xmake.lua`                                                   |
| Zig              | `.zig` files, `build.zig`                                     |

</details>

## Install

```bash
# From npm
pi install npm:pi-starline

# From git
pi install git:github.com/Andy8647/pi-starline
```

Coming from pi-zentui? Run `mv ~/.pi/agent/zentui.json ~/.pi/agent/starline.json` to carry your config over — Starline does not read the old file automatically. Inside it, rename any `colorMode: "zentui"` value to `colorMode: "themed"`.

What changed in each version: **[Releases](https://github.com/Andy8647/pi-starline/releases)**.

## Config

Settings live in `~/.pi/agent/starline.json`. The file is optional — anything missing falls back to a default, and unknown keys are ignored at runtime.

```json
{
	"footerStyle": "pill",
	"colors": { "gitBranch": "bold purple" },
	"fixedEditor": { "enabled": true }
}
```

`/starline` opens an interactive menu for the settings worth changing day to day: colour sources, feature toggles, which built-in segments show, and where third-party extension statuses go. `Tab` and `Shift+Tab` move between its five sections.

**[Full configuration reference →](https://github.com/Andy8647/pi-starline/blob/main/docs/configuration.md)** — every option with its default: the pill footer, the colour palette and its `$name` references, footer format templates, per-segment display options, icon overrides, and editor styling.

## Fixed editor (experimental, opt-in)

Pins the editor and footer to the bottom of the terminal while the transcript scrolls above, and adds mouse handling Pi has none of: drag to select (the transcript scrolls when the drag reaches an edge), double-click a word, triple-click a line, click to move the caret, click a tool box's border to expand just that box, and a wheel that scrolls whichever of the transcript or the input box the pointer is over.

```text
/starline fixed-editor enable
```

**[Fixed editor guide →](https://github.com/Andy8647/pi-starline/blob/main/docs/fixed-editor.md)** — keyboard controls, copy behaviour, and the extensions it cannot run alongside.

## Requirements

- [Pi](https://pi.dev) coding agent 0.80.3 or newer
- A [Nerd Font](https://www.nerdfonts.com/) for icons (or set `icons.mode` to `"ascii"`)

## Development

```bash
npm install
npm run verify
npm run fmt
npm run pack:check
```

### Test in Pi

The project keeps Pi core packages as peer dependencies for runtime and dev dependencies for
typechecking. To avoid accidentally running the local `node_modules/.bin/pi` shim, the dev scripts use
the globally installed Pi binary by default:

```bash
npm run pi:dev
npm run pi:install-local
```

Override the binary if your Pi install is somewhere else:

```bash
PI_BIN=/path/to/pi npm run pi:dev
```

## Credits

Forked from [pi-zentui](https://github.com/lmilojevicc/pi-zentui) by Luka, whose work is the foundation of this project.

Inspired by:

- [Starship](https://starship.rs/) — the minimal, blazing-fast, and infinitely customizable prompt
- [Opencode](https://github.com/opencode-ai/opencode) — terminal-based AI coding assistant

## License

MIT
