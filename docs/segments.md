# What the footer shows

Reference for the segments whose meaning is not obvious from the screen. How to
choose, order and colour them is in [configuration.md](configuration.md).

## Git status indicators

The `gitStatus` segment, inside brackets after the branch (`[!?↑]`):

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

## Runtime detection

Detects Starship Nerd Font runtime/language modules, uses the Starship Nerd Font symbols, and keeps Starship-style defaults such as `bold green` for Node.js. By default Starline maps those styles through your active Pi theme; switch the Starship/footer color source to `terminal` in `/starline` if you want your terminal colorscheme to supply the exact ANSI colors.

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
