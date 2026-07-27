# 实施 plan

> 2026-07-27。基线 `upstream/main` = `0b2bdc7` (v0.13.0)。配套规格见 `SPEC.md`。
> 本文件是 SPEC 的执行计划,并**订正** SPEC 中若干经代码核实后不成立的假设(见 §0)。

## 进度

| 阶段 | 状态 |
|---|---|
| P0 基线对齐(pi-tui → 0.82.1) | ✅ |
| P1 ColorSpec 结构化 resolver | ✅ |
| P1b palette 变量层 | ✅ |
| P2a model / thinking 段 | ✅ |
| P2 pill 渲染 | ✅ |
| P3 图标 + gitHostIcon | ✅ |
| P4 segmentOptions | ✅ |
| P5 编辑框颜色补齐 | ✅ |
| P7 editorCursor 三档 | ✅ |
| P6 复制行为 | ⚠️ 9 条交付 7 条(1–6、9) |
| P6b 编辑框内选区与单击定位(#7 #8) | ⬜ 未做,见下 |
| P8 粘贴折叠 + 再粘展开 | ⬜ 未做 |
| P10 文档 | ✅ |

**P6b** 拆出来的原因:#7(编辑框内选区排除边框/prompt)和 #8(编辑框内单击定位光标)都需要「屏幕列 → 编辑器文本偏移」的映射,依赖 pi 编辑器内部,与 P6 其余七条的风险面完全不同。其余七条只作用在 transcript 区,那里本来就参与选择。

**P8 未做的原因**:它的正确性依赖真实粘贴事件在活的 pi TUI 中的行为(影子 `handlePaste`、marker id 重编号、submit 时的 `expandPasteMarkers`),无法在无头环境中验证。设计已在 §3 写清,实现时务必先做 feature-detect + 静默降级。

**当前约束状态**:`compositor.ts` 对 `upstream/main` 的 diff 为 **+20 −52**(净减 32 行,§6.7 上限 100);`git merge upstream/main` 无冲突(§6.8);`npm run verify` 654 tests / 26 files 全绿。

---

## 0. 先决调研结论(已完成,订正 SPEC)

实现开始前 SPEC §5 列了三个未知数,已全部查清。另外查证过程中发现四处 SPEC 与代码不符,一并订正。

### 0.1 pi-tui 版本(SPEC §5 #4)→ 官方 paste API **不存在**,只能走 Reflect

| 事实 | 证据 |
|---|---|
| repo 锁 pi-tui **0.80.10**(dev),peer `>=0.80.3` | `package-lock.json:1280` |
| 实际运行时是 **0.82.1** | `pi --version` = 0.82.1;其 `npm-shrinkwrap.json:14` 依赖 `@earendil-works/pi-tui: ^0.82.1` |
| 0.82.1 是 npm 最新版 | `npm view @earendil-works/pi-tui versions` |
| **0.82.1 无 `getPasteContent` / `replacePaste`** | 0.82.1 tarball `dist/components/editor.d.ts:56-57,99,130`:`pastes` `pasteCounter` `expandPasteMarkers` `handlePaste` 全部 `private`,零公开 paste API |
| 私有字段形状与 0.80 **完全一致** | `pastes: Map<number,string>`、`pasteCounter: number`、marker 正则 `/\[paste #(\d+)( (\+\d+ lines\|\d+ chars))?\]/`、折叠阈值仍硬编码 `pastedLines.length > 10 \|\| totalChars > 1000`(`dist/components/editor.js:1005-1015`) |

**订正 SPEC §3.5**:"若 pi-tui ≥ 0.81 改用官方 API"这条分支不成立,0.81/0.82 根本没引入该 API。`9f1901b` / `7ffc128` 的 Reflect 做法原样移植,验证范围由 0.74–0.80 按代码比对顺延到 0.82.1。移植时**必须改掉源码注释里指向该 API 的迁移说明**。

### 0.2 cache read 段(SPEC §5 #5)→ 不需要加段

zentui 无独立 cache 段,但 `format.ts:207 buildTokenLabel()` 已在 `tokens` 段里输出 `↑12k ↓3k 󰆼 87.3%` —— **命中率百分比本来就在显示**。powerline 的"裸计数"反倒是 zentui 没有的。

**订正 SPEC §3.7**:不加新段。缩成两个 `segmentOptions` 键:`context.format`(真新功能)和 `tokens.cache`(给已有的内嵌命中率加档位)。

### 0.3 editorCursor 三档(SPEC §5 #6)→ 成立,且**零 compositor 改动**

- powerline `00de497` 是**纯字符串后处理**:把 `\x1b[7m<单 grapheme>\x1b[0m` 换成 `\x1b[4m$1\x1b[0m`(underline)或 `$1`(terminal)。
- pi-tui 0.82.1 `dist/components/editor.js:429-445` 仍精确输出该形状,正则照样匹配。
- zentui compositor **本来就把真实终端光标定位在 `cluster.cursor` 并 `SHOW_CURSOR`**(`compositor.ts:505-513`),所以 `terminal` 档只需擦掉软光标,真光标自然透出,连 powerline 那边的 `setShowHardwareCursor` 调用都省了。
- 落点 `fixed-editor/index.ts`,**不在** SPEC §2.1 的"逐字节一致"清单里。`cluster.ts` / `compositor.ts` 零改动。

风险从"存疑"降级为低。

### 0.4 其余四处订正

| # | SPEC 的说法 | 实际 | 影响 |
|---|---|---|---|
| a | §6.9「现有 `test/` 用 node:test」 | 实为 **vitest**(`package.json: "test": "vitest run"`,17 个 `test/*.test.ts`) | 新测试沿用 vitest |
| b | §3.3「新增 `colors.editorPrompt`」 | **上游已有**(`config.ts:160,470`;`ui.ts:93`) | P5 缩到只剩 `userMessageBorder` |
| c | §3.3「`colorSources: "theme"` 时才跟随主题,设为其他值才读显式颜色」 | 不准确。hex / 256 索引命中 `isExplicitTerminalColorToken`(`style.ts:163-168`)后在 `renderThemeStyle:279` 直接分流走终端路径,**与 `colorSources` 无关** | 这正是 §2 配色模型的基础 |
| d | §2.3 改名 5 处 + §5 #1/#7 | 本轮**不做**(自用 fork) | P9 整个删除 |

### 0.5 扩展状态位(balance / automode / mcp / tavily)已可用,无需移植

参考图里的 `5h·15%↺4h22m 7d·77%↺5d23h`(pi-balance)和 `AM●`(automode)**不是 footer 段**,是 pi 的通用扩展状态表:

```
pi-balance 扩展 ──按 provider 自查余额──▶ pi footerData 状态表 Map<string,string>
                                                  │
                       zentui footer.ts:558-575 ──▶ 原样渲染
```

- pi 侧:`pi/packages/coding-agent/src/core/footer-data-provider.ts`
- zentui 侧:`extension-status.ts:60 collectExtensionStatusSegments(statuses, config)`,对 key 零硬编码
- powerline fork **全仓没有 balance/quota 代码**,它也只是消费同一张表

**结论:这两段现在就能显示,不移植任何东西。** 但对 pill 有两个后果,见 §3 的 P2。

---

## 1. 已确认的设计决策

| 主题 | 决定 |
|---|---|
| 改名 / 发 npm | **不做**。`package.json` name、`/zentui` 命令、`zentui.json`、目录名全部不动 |
| pill 布局 | **单串左对齐**,一条连续 bar,右侧留终端背景。**不做左右分区**(SPEC §3.1 的 `layout.left/right` 作废) |
| pill 两端 | **左右都圆头**(`` / ``)。`icons.mode: "ascii"` 时与 `separator` 一起退化 |
| pill 字色 | **不做 `textColor` 配置**。固定加粗;字色由 `fg:` 显式给,或从背景推一个对比色 |
| pill 垂直位置 | **不动**。仍在编辑框下方那一行,pill 只替换该行的渲染内容,不碰 placement |
| model / thinking | **从编辑框移到 footer pill**(不是两处都显示) |
| 配色模型 | 字面色(hex / 256 / 终端色名)**逐键覆盖** theme 键;不配 = 跟随 pi theme。两层共存,不做全局开关 |
| powerline 独有段 | 除 model / thinking 外**不移植**(额度 / automode / token 明细走扩展状态位) |
| 性能改造 | **一律不移植**(SPEC §3.2 / §4) |

---

## 2. 配色模型(P1 / P1b 的设计依据)

### 2.1 现状:hex 与 `bg:` 前缀今天就能解析,只是没有渲染路径去用

| 能力 | 位置 |
|---|---|
| hex `#rgb` / `#rrggbb` | `isHexColor` (style.ts:30)、`hexToAnsi(hex, isBackground)` (:44) |
| `fg:` / `bg:` 前缀 | `renderTerminalStyle` (:242-262) → `terminalColorToAnsi(name, isBackground)` (:150-160) |
| 字面色优先于 theme | `isExplicitTerminalColorToken` (:163-168) 命中即在 `renderThemeStyle:279` 分流 |
| 配置校验已认该语法 | `isSupportedStyleToken` (:170-181) |

所以 `{"colors": {"gitBranch": "bold #cba6f7"}}` **今天就生效**;`"bg:#1e1e2e"` 也已能解析出正确 SGR,只是无人消费。

### 2.2 缺口:解析结果是「包好的字符串」,pill 需要「结构化的 fg/bg」

段间箭头要拿**左段 bg 当前景、右段 bg 当背景**,必须拿到分离的两半。P1 因此把 ColorSpec 解析重构成统一 resolver,四种色源一个出口:

```
theme 键 (accent / syntaxKeyword)  → theme.getFgAnsi(key)      → 需要 bg 时 38→48 翻转
终端色名 (cyan / bright-black)      → terminalColorCodes         → 背景码 = 前景码 + 10
256 索引 (208)                      → 38;5;N / 48;5;N
hex (#cba6f7)                       → hexToAnsi(hex, isBg)
```

`theme.getFgAnsi(color: ThemeColor)` 是 **pi 的公开方法**(`pi/packages/coding-agent/src/modes/interactive/theme/theme.ts`),返回 pi 已按终端能力挑好编码的 SGR(truecolor `\x1b[38;2;r;g;bm` / 256 色 `\x1b[38;5;Nm`)。把 `38` 换成 `48` 即得同色背景——两种色彩模式自动正确,**不需要 RGB 提取,也不需要 Reflect**。

> pi 另有 `getBgAnsi(color: ThemeBg)`,但 `ThemeBg` 仅 `selectedBg` / `userMessageBg` / `customMessageBg` / `toolPending|Success|ErrorBg` 加三个可选键,太少,撑不起一条 bar。故走 fg 键翻转。

`renderStyle` / `renderThemeStyle` 降级为该 resolver 的薄封装,**text 模式输出逐字节不变**(§6.2 验收锁死)。
`style.ts:4-9` 的 `ThemeLike` 需加可选成员 `getFgAnsi?`。

### 2.3 `palette` 变量层(P1b)

让「agent 把配色改成 tokyo night storm」这类需求只改一处,而不是往 20 个段里重复写 hex。结构照抄 pi 主题文件的 `vars` + 引用:

```jsonc
{
  "palette": {
    "bg": "#24283b", "fg": "#c0caf5", "blue": "#7aa2f7",
    "purple": "#bb9af7", "green": "#9ece6a", "yellow": "#e0af68",
    "red": "#f7768e", "cyan": "#7dcfff", "gray": "#414868"
  },
  "colors": {
    "cwd":       "bold bg:$blue fg:$bg",
    "gitBranch": "bold bg:$purple fg:$bg",
    "context":   "bold bg:$gray fg:$fg",
    "cost":      "bold bg:$green fg:$bg"
  }
}
```

实现 = 解析前一遍 `$name` 展开,带循环引用保护(参考 pi 的 `resolveVarRefs`,`theme.ts:293-310`)。换配色方案只改 `palette`。

### 2.4 已知限制(本轮不修)

zentui 的 `hexToAnsi`(style.ts:44-51)**永远输出 truecolor** `38;2;r;g;b`,不像 pi 的 `fgAnsi` 会在非 truecolor 终端下经 `hexTo256` 降采样;zentui 也没有终端色彩模式探测。

- **theme 键**:pi 已挑好编码,256 色终端正确降级
- **字面 hex**:256 色终端下发 truecolor 序列,可能显示错乱

开发机是 Ghostty(truecolor),不受影响。写进 README known limitation。真要修 = 抄 pi 的 `rgbTo256`(`theme.ts:258-261`)+ 色彩模式探测,**不放进本轮,以免拖慢 pill**。

### 2.5 可点名的 theme 键

ColorSpec 除终端色名外可直接写 ThemeColor 键(`style.ts:101-147` 的 `themeColorTokens`,约 50 个)。以本机 `~/.pi/agent/themes/catppuccin-mocha.json` 为例:

| ColorSpec | 解析成 | 色值 |
|---|---|---|
| `accent` / `borderAccent` | sky | `#89dceb` |
| `syntaxKeyword` | mauve | `#cba6f7` |
| `syntaxFunction` | blue | `#89b4fa` |
| `success` / `warning` / `error` | green / yellow / red | `#a6e3a1` / `#f9e2af` / `#f38ba8` |
| `muted` / `dim` | overlay1 / overlay0 | `#7f849c` / `#6c7086` |
| `border` / `borderMuted` | surface2 / surface1 | `#585b70` / `#45475a` |

限制:**点不到主题的 `vars`**(`peach` `teal` `lavender` 等),除非某个 ThemeColor 键正好指过去。需要完整调色板时用字面 hex + `palette`。

> 注:编辑框 prompt 当前显示为蓝色,是因为该主题文件 `"accent": "sky"`,而非代码硬编码。想要 mauve 可配 `{"colors": {"editorPrompt": "syntaxKeyword"}}`。

---

## 3. 阶段拆分

每阶段一个 commit,可独立验证。收尾动作固定两条:

1. `npm run verify`(lint + typecheck + vitest)
2. `git fetch upstream && git merge --no-commit --no-ff upstream/main && git merge --abort` 演练

---

### P0 · 基线对齐

**无功能变更。**

- **改**:`package.json`(devDep `@earendil-works/pi-tui` / `pi-ai` / `pi-coding-agent` → `^0.82.1`)、`package-lock.json`
- **依赖**:无
- **验证**:`npm run verify` 全绿。这是后续所有阶段的回归基线。
- **风险**:0.80 → 0.82 可能有 pi-tui 内部结构变化导致 `pi-compat.ts` 的 probe 失效。**若此处即失败,说明上游尚未跟进 0.82,需先决定「等上游」还是「自行 patch pi-compat」** —— 这个信息越早拿到越好,故排第一。

---

### P1 · ColorSpec 结构化 resolver

- **改**:`style.ts`(统一 resolver,输出 `{ fgSgr, bgSgr, mods }`;`ThemeLike` 加 `getFgAnsi?`;`renderStyle` / `renderThemeStyle` 改为薄封装)、`config.ts`(校验放宽)
- **新增**:`test/style-resolver.test.ts`
- **依赖**:P0
- **验证**:§6.2 后半 —— 不含 `bg:` 的旧值渲染输出与改造前**逐字节相同**;四种色源 × fg/bg 各有断言
- **风险**:`renderThemeStyle:279` 的 `isExplicitTerminalColorToken` 分流逻辑要保持原语义,`bg:blue` 不能被误判后走错分支

---

### P1b · `palette` 变量层

- **改**:`config.ts`(新增 `palette` 块;解析前做 `$name` 展开)
- **新增**:`test/palette.test.ts`
- **依赖**:P1
- **验证**:`$name` 展开正确;循环引用不死循环、降级为原字面量;无 `palette` 时行为不变
- **风险**:低。独立可测,不依赖 pill。

---

### P2a · model / thinking 段

把 model / thinking 从编辑框搬进 footer。**数据全部现成**:

| 事实 | 位置 |
|---|---|
| `EditorMetadataValues` 已含 `model` / `modelId` / `modelName` / `provider` / `thinking` / `sessionName` | `editor-metadata-format.ts:6-13` |
| 值来自 `state.modelLabel` / `state.providerLabel` + `getThinkingLevel()` | `index.ts:120-121, 246-252` |
| `installFooter(ctx, state, ...)` **已拿到 `state`**,只缺 `getThinkingLevel` | `index.ts:333` |
| thinking 分档主题色键 `thinkingOff/Minimal/Low/Medium/High/Xhigh` 已存在 | `style.ts:141-146` |
| footer 变量表里 `model` / `thinking` 名字未被占用 | `footer.ts` 的 20+ 个 `case` |

- **改**:`footer.ts`(加 `case "model"` / `case "thinking"`)、`index.ts:333`(多传 `getThinkingLevel`)、`config.ts`(两个 `footerSegments` 键 + 两个 `colors` 键)
- **依赖**:P0(与 P1 正交)
- **验证**:`footerStyle: "text"` 下 `footerFormat` 里写 `$model` / `$thinking` 能渲染;thinking 按档位取到对应主题色
- **从编辑框拿掉 = 零代码**:`editorMetadataFormat` 本就是用户可配的格式串(默认 `"$model  $provider(  $thinking)"`),改成 `""` 或只留 `$provider` 即可
- **风险**:低。顺带白送 `$provider` 也可接入。

---

### P2 · pill 渲染

- **新增**:`extensions/zentui/pill.ts`(色块 + 箭头串联 + 两端圆头 cap)、`extensions/zentui/pill-config.ts`、`test/pill.test.ts`
- **改**:`footer.ts`(**只加一个按 `footerStyle` 分派的分支**;`"text"` 走现有 `renderFormatSplit` 路径不动)、`config.ts`
- **依赖**:P1、P2a
- **配置形态**:

```jsonc
{
  "footerStyle": "pill",          // "text"(默认,行为与上游一致) | "pill"
  "pill": {
    "segments": ["model", "thinking", "cwd", "gitBranch", "gitStatus",
                 "extensionStatus:balance", "context", "cost", "extensionStatus"],
    "separator": "powerline",
    "bold": true,
    "caps": "round"               // round(默认) | right | none
  }
}
```

颜色不必单独配 —— 复用 `colors.*` 已有的值,text 模式当前景、pill 模式当背景。

- **两个必须处理的细节**(源自 §0.5):
  1. **`extensionStatus` 不是一个段,是一组动态段**。支持按 key 单列(`extensionStatus:balance`,可控顺序与配色)+ 兜底项(剩余按 key 序展开)。
  2. **`colorMode: "original"` 与 pill 冲突** —— 该模式保留扩展自己的前景 SGR(`sanitizeExtensionStatusOriginalText` 专门做了保护性还原),配上 pill 背景大概率对比度失败。**pill 模式下自动降级为中性底色 + 保留原前景。**
- **验证**:§6.1(truecolor 与 256 色下箭头不断裂)、§6.2、§6.5
- **风险**:`footerSegments` 的布尔开关与 pill 的 `segments` 数组是两套段来源。**约定:开关仍生效** —— `segments` 里列了但开关关掉的段跳过,避免两套真值来源。

---

### P3 · 图标逐段覆盖 + gitHostIcon

- **改**:`icons.ts`(允许 `icons.<segment>` 覆盖;`mode: "ascii"` 时一律忽略)、`git.ts`(origin remote host 检测,**复用现有缓存层**,长 TTL)、`config.ts`
- **新增**:`test/git-host-icon.test.ts`
- **依赖**:P2(技术上不依赖,但 pill 下收益最大)
- **验证**:§6.2 的图标部分;`gitHostIcon: false` 默认下 git 相关测试无回归
- **风险**:低。唯一要守的是"不产生每帧成本"——检测必须走 `git.ts` 已有缓存层,不新起 spawn 路径。

---

### P4 · segmentOptions:context / tokens 格式

```jsonc
{
  "segmentOptions": {
    "context": { "format": "full" },     // full(默认) | percent
    "tokens":  { "cache": "percent" }    // percent(默认,现状) | tokens | off
  }
}
```

- **改**:`format.ts`(`buildTokenLabel` 加 cache 档位参数;context 百分比模式)、`footer.ts`(`case "context"` / `case "tokens"`)、`config.ts`、`state.ts`
- **新增**:`test/segment-options.test.ts`
- **依赖**:P0
- **验证**:默认值下 `test/format.test.ts` / `test/state.test.ts` 零改动通过;`contextStyle` / `contextThresholds` 与 `format` 的正交组合逐档有断言
- **风险**:低

---

### P5 · 编辑框 / user message 颜色补齐

- **改**:`config.ts`(新增 `colors.userMessageBorder`)、`user-message.ts`
- **依赖**:P0
- **验证**:默认下渲染与改造前一致
- **风险**:低。`colors.editorPrompt` 已存在(§0.4b),**不引入** `editorBox` 开关(SPEC §3.3)。

---

### P7 · editorCursor 三档

```jsonc
{ "editorCursor": "block" }   // block(默认) | underline | terminal
```

- **新增**:`fixed-editor/editor-cursor.ts`(行变换)、`test/editor-cursor.test.ts`
- **改**:`fixed-editor/index.ts`(probe 拿到 cluster 后包装 editor 组件的 render 输出)、`config.ts`
- **不改**:`cluster.ts`、`compositor.ts` —— 硬约束 §2.2 的净胜局
- **依赖**:P0(与 P6 无耦合)
- **验证**:三档目视 + 单测锁正则(只匹配单 grapheme 反显块;`\x1b[7mabc\x1b[0m` 不得误伤,照搬 powerline 已有断言);变换后 `CURSOR_MARKER` 仍存在
- **风险**:低-中。唯一的雷是**变换必须作用在 `renderCluster` 剥离 `CURSOR_MARKER` 之前**,且不得吞掉 marker,否则 `capEditorLines` 的光标居中与 compositor 的硬件光标定位一起失效。**不移植 `editorCursorBlink`**(SGR 闪烁被 Ghostty 等终端忽略)。

---

### P6 · 复制行为九条 ⚠️ 硬约束的考场

移植 SPEC §3.4 表格的 1–9 条。

- **新增**:`fixed-editor/selection-controller.ts`(九条行为的状态机、`copyOnSelect`、提示文案、auto/explicit 来源区分)、`fixed-editor/box-chrome.ts`(第 7 条:裁掉 `│ ╭─╮ ╰─╯` 与 prompt 前缀,纯边框行整行丢弃)、`test/selection-controller.test.ts`、`test/box-chrome.test.ts`
- **改**:
  - `fixed-editor/compositor.ts` —— **只做三件事**:① `handleMouseEvent` 中 `if (ev.row > this.visibleScrollableRows) return;`(现 `:446`)之后的整段选择逻辑替换为对 controller 的**单次委托**;② 右键分支(现 `:429-440`)委托;③ 构造函数多接 config getter / 回调。**目标 diff < 100 行**
  - `fixed-editor/index.ts` —— 构造 controller、接配置、下边框提示文本注入点
  - `fixed-editor/input.ts` —— 第 4 条 ctrl+c、第 9 条"编辑按键清高亮",**同样只加委托**
  - `config.ts` —— `fixedEditor.copyOnSelect`
- **配置**:`{ "fixedEditor": { "enabled": true, "mouseScroll": true, "copyOnSelect": true, "copyNotice": true } }`(`copyNotice` 语义收窄为"仅 auto 复制时提示")
- **依赖**:P0
- **验证**:§6.3 逐条 + **§6.7(`git diff upstream/main -- fixed-editor/compositor.ts` < 100 行)** + **§6.8(合成器文件 merge 无冲突)**。本阶段结束**必须**实跑一次 merge 演练。
- **风险(最高)**:
  1. **OSC 8 提取会被顺手覆盖。** 现状 `selection.ts:126` 的 `getSelectedText` 内部先 `extractOsc8Links` 再 `stripAnsi`。移植 powerline 的取文逻辑时极易整体替换掉。**对策:controller 不自己实现取文,一律回调进 `SelectionState.getSelectedText`;新增 OSC 8 回归测试锁死**(SPEC §6.3 后半)。
  2. 编辑框区域取文的坐标系与 transcript 不同(`visibleRootStart + ev.row - 1` 只对 transcript 成立),box-chrome 裁剪须在 cluster 行坐标系里做。
  3. 第 8 条(press 起选 / release 判单击)会与现有 `pauseMouseReporting` 的右键路径交叉,须保证点在选区外仍走原有暂停逻辑。

---

### P8 · 粘贴折叠 + 再粘展开 ⚠️ 最脆

移植 SPEC §3.5 全表。

- **新增**:`fixed-editor/paste-expand.ts`(Reflect 访问 `pastes` / `pasteCounter`,shadow `handlePaste`,阈值下调,再粘展开状态机)、`test/paste-expand.test.ts`
- **改**:`fixed-editor/index.ts`(安装 shadow + 暴露 hint 文本)、`config.ts`(`pasteCollapseLines` 2–10,越界归一化回 11 = pi 默认)、P6 建立的下边框提示合成点(两个提示以 `⋅` 连接)
- **依赖**:**P6**(提示必须挂在 P6 建立的下边框 overlay 上,不另造一个)
- **验证**:§6.4 —— 折叠/展开在两种边框下都工作、两个提示能共存;pi-tui 0.82.1 上的运行时冒烟(§0.1 的顺延是代码比对得出的,尚未实跑)
- **风险(最脆)**:
  1. 依赖 pi-tui **私有**字段。0.82.1 已确认形状不变,但每次 pi 升级都可能失效。**必须 feature-detect + 静默降级**:探测不到字段就整个特性关掉,绝不能让编辑器炸。
  2. shadow `handlePaste` 须处理 id 重编号(pi 删除 marker 时会把后续 id 前移,`editor.js:1086-1103`),自建 marker 必须与 pi 的格式**逐字节一致**,否则 submit 时的 `expandPasteMarkers` 展不开。
  3. 源码注释中"迁移到官方 `getPasteContent`/`replacePaste`"须改为"官方 API 至 0.82.1 仍不存在"(§0.1)。

---

### P10 · 文档

- **改**:`README.md`
  - 新增「配色」一节:hex / `bg:`+`fg:` 前缀 / `palette` / theme 键**四种写法与优先级**(这套语法大部分今天就能用,只是从未写进文档)
  - `footerStyle` / `pill` / `segmentOptions` / `editorCursor` / `gitHostIcon` / `copyOnSelect` / `pasteCollapseLines` 配置说明
  - 顶部标注 "Forked from [pi-zentui](https://github.com/lmilojevicc/pi-zentui)"
  - known limitation:字面 hex 在非 truecolor 终端不降采样(§2.4)
- **改**:`LICENSE` —— 保留 `Copyright (c) 2025-2026 Luka` + MIT 全文,追加 `Copyright (c) 2026 Andy`。`fixed-editor/compositor.ts` 顶部署名链(`@tifan/pi-fixed-editor` ← `pi-powerline-footer` by Nico Bailon)保留不动
- **依赖**:P8
- **验证**:§6.10

---

## 4. 依赖图与执行顺序

```
P0 ──┬── P1 ── P1b ── P2 ── P3
     │         └──────┘
     ├── P2a ──────────┘
     ├── P4
     ├── P5
     ├── P7
     └── P6 ── P8 ── P10
```

**建议顺序**:`P0 → P1 → P1b → P2a → P2 → P3 → P4 → P5 → P7 → P6 → P8 → P10`

理由:

- pill 链路(P1 → P1b → P2a → P2 → P3)一口气走完,最想要的功能先落地
- P7 排在 P6 前:零风险、零 compositor 改动,先把编辑框手感摸出来
- 硬骨头 P6 / P8 留最后,彼时 merge 演练已跑通多轮
- **性能验收(§6.6)在 P6 与 P8 之后各做一次** —— 这两个阶段是唯一碰热路径的

## 5. 验收对照

| SPEC §6 | 由哪个阶段交付 |
|---|---|
| 1 pill 无缝箭头,truecolor 与 256 色不断裂 | P2 |
| 2 段 bg/fg/图标可独立配置;text 模式与上游一致 | P1 / P2 / P3 |
| 3 §3.4 九条 + OSC 8 未退化 | P6 |
| 4 粘贴折叠/展开 + 提示共存 | P8 |
| 5 四个扩展状态位在 pill 下正常 | P2 |
| 6 滚动流畅度与改造前无可感差异 | P6 后、P8 后各一次 |
| 7 compositor.ts diff < 100 行 | P6 |
| 8 合成器文件 merge 无冲突 | 每阶段演练,P6 重点 |
| 9 新增行为有测试(**vitest**,非 node:test) | 各阶段 |
| 10 LICENSE 保留 Luka 版权;README 标注 fork 来源 | P10 |

## 6. 遗留

| 项 | 状态 |
|---|---|
| 改名 / 发 npm | 不做(自用 fork)。将来要发再单独立项 |
| 字面 hex 的 256 色降采样 | 已知限制,写进 README,暂不修(§2.4) |
| pill 回馈上游 zentui | 成型后再问 Luka(SPEC §5 #3) |
| powerline 卡顿根因 | 已不影响本项目;值得单独给 nicobailon/pi-powerline-footer 提 issue |
| ColorSpec 点名主题 `vars` | 暂不做,先用 ThemeColor 键 + 字面 hex(§2.5) |
