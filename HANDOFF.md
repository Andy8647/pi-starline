# Handoff

> 2026-07-27。分支 `combined`,基线 `upstream/main` = `0b2bdc7` (v0.13.0)。**未推送**。
> 背景与规格见 `SPEC.md`,分阶段计划与调研结论见 `PLAN.md`。本文件只讲**现在是什么状态、下一步做什么**。

## 1. 当前状态

- `npm run verify` → **686 tests / 27 files 全绿**
- `git log upstream/main..HEAD` → 18 个 commit,每个阶段一个
- 扩展已安装到本机 pi 并在实际使用中(见 §4)

### 硬约束(SPEC §6.7 / §6.8)

| 约束 | 状态 |
|---|---|
| `git diff upstream/main -- fixed-editor/compositor.ts` < 100 行 | **+37 −57**,净减 20 行 |
| `git merge upstream/main` 在合成器文件上无冲突 | 无冲突(上游尚未前进,真正的考验在上游发版后) |
| text 模式(`footerStyle: "text"`)与上游逐字节一致 | 守住。所有新段/新图标默认关或空;`renderStyle` / `renderThemeStyle` 一字节未动,4 条测试钉死其精确输出 |

合成器层总改动只有三个文件:`compositor.ts`(纯委托)、`types.ts`(+2 字段)、`index.ts`(+2 行)。新增的 `selection-controller.ts` 是纯新文件。

## 2. 已完成

| 阶段 | 内容 |
|---|---|
| P0 | pi-tui 等三个 devDep 0.80.10 → 0.82.1,对齐运行时 |
| P1 | `resolveColorSpec` / `resolveBackgroundSgr`:ColorSpec 解析成分离的 fg/bg SGR |
| P1b | `palette` 变量层 + `$name` 展开(带循环保护) |
| P2a | `model` / `thinking` footer 段(默认关) |
| P2 | **pill footer**:`footerStyle: "pill"`,无缝箭头、圆头 cap、`extensionStatus:<key>` 单列 |
| P3 | `gitHostIcon` + 五个新图标槽(默认空) |
| P4 | `segmentOptions.context.format` / `segmentOptions.tokens.cache` |
| P5 | `colors.userMessageBorder` / `colors.userMessageText` |
| P7 | `editorCursor: block \| underline \| terminal` |
| P6(部分) | 复制行为 9 条中的 7 条(1–6、9) |
| P10 | README 配色/pill/各选项文档,LICENSE 双版权 |
| 后续修复 | pill 同色分隔线、`extensionStatuses.colors` / `.icons`、硬件光标断言、`editorPaddingY` / `userMessagePaddingY`、vitest 测试隔离 |
| 追加 | `cacheHit` 独立段(`$cache_hit`);短 transcript 改为贴着编辑框对齐 |

### 追加的两项细节

**`cacheHit` 段**。命中率原本只能内嵌在 `tokens` 段里,读起来像第三个 token 计数。现在是独立的段:自己的 `footerSegments.cacheHit`(默认关)、`colors.cacheHit`、`icons.cacheHit`(该图标同时仍是内嵌模式的字形),可用于 `footerFormat` 的 `$cache_hit` 和 `pill.segments`。配合 `segmentOptions.tokens.cache: "off"` 使用,否则显示两遍。无缓存活动、或最新一轮无已知命中率时,整段渲染为空而不是 `0%`。

**短 transcript 的对齐**。`compositor.ts` 原先用 `visible.push("")` 把空白填在内容**下方**,于是短于滚动区的 transcript 会浮在屏幕顶端、空隙全落在编辑框上方。改为填在上方。**注意**:屏幕行 → transcript 索引的原点要同步回退 `padTop`(`renderScrollableRoot` 里的 `origin`),否则选区映射会整体错位;`SelectionController` 另加了 `line < 0` 的守卫,处理点在填充行上的情况。

## 3. 未完成 —— 下一轮的两件事

两件都卡在同一个地方:**pi-tui 把需要的东西声明为 `private`**。因此两者都必须写成 feature-detect + 探测不到就整个特性静默关闭,绝不能让编辑器崩。

### P6b · 编辑框内单击定位光标 + 拖选(SPEC §3.4 的第 7、8 条)

用户已多次提出,是当前最想要的缺失功能。

**为什么没做**:需要「屏幕列 → 编辑器文本偏移」的映射,而 pi-tui 0.82.1 `dist/components/editor.d.ts` 里:

- `buildVisualLineMap` —— 视觉行 → `{ logicalLine, startCol, length }` 的映射,**private**(d.ts:179)
- `state`(`lines` / `cursorLine` / `cursorCol`)—— 写光标位置要用,**private**(d.ts:34)
- 公开的只有 `getCursor()`(只读),**没有 setter**

**实现路线**:

1. 新建 `fixed-editor/box-chrome.ts`:给定 cluster 行,算出编辑框内容的列区间——要扣掉 rail(`icons.rail`,宽度来自 `ui.ts:getEditorChromeWidths`)、prompt 前缀、以及 `editorPaddingY` 带来的行偏移。纯边框行整行丢弃(第 7 条)。
2. 新建 `fixed-editor/editor-cursor-map.ts`:Reflect 取 `buildVisualLineMap`,把「cluster 行号 + 列」映射到 `{ logicalLine, col }`。
3. 单击定位:Reflect 写 `state.cursorLine` / `state.cursorCol`,然后 `requestRender`。**注意**还要同步 `preferredVisualCol`(d.ts 里的 sticky column),否则之后按上下键会跳。
4. 拖选:`SelectionController` 现在遇到 `ev.row > visibleScrollableRows` 直接 return(`selection-controller.ts:140`),把这个分支换成对 box-chrome 的委托。第 8 条(press 起选、release 时未移动才判定为单击)的状态机 `SelectionController` **已经有了**(`pressPoint` / `dragged`),transcript 区在用,直接复用。

**参考实现**:powerline fork `combined` 分支的 `00de497`(`git -C ../pi-powerline-footer show 00de497`)。

**风险**:`compositor.ts` 的 diff 预算还剩 ~70 行,委托调用应该只占几行,但要盯住。

### P8 · 粘贴折叠阈值 + 再粘展开(SPEC §3.5)

用户原 powerline 配置里有 `pasteCollapseLines: 3`,现在回到了 pi 默认的 >10 行。

**为什么没做**:正确性依赖真实粘贴事件在活的 pi TUI 里的行为,无头环境验证不了。写了也只能说"应该能跑"。

**已查清的事实**(PLAN.md §0.1):

- pi-tui **0.82.1 仍然没有** `getPasteContent` / `replacePaste`。SPEC 里"≥0.81 改用官方 API"这条分支不存在,别再去找。
- 私有字段形状与 0.80 完全一致:`pastes: Map<number,string>`、`pasteCounter: number`
- 折叠阈值硬编码在 `dist/components/editor.js:1005`:`pastedLines.length > 10 || totalChars > 1000`
- marker 正则:`/\[paste #(\d+)( (\+\d+ lines|\d+ chars))?\]/`
- **删除 marker 时 pi 会把后续 id 前移**(`editor.js:1086-1103`),自建 marker 必须与 pi 格式逐字节一致,否则 submit 时的 `expandPasteMarkers` 展不开

**参考实现**:powerline fork 的 `7ffc128`(阈值)、`9f1901b`(再粘展开)、`ce94fd6`(提示放到下边框)。

**好消息**:`ce94fd6` 需要的下边框提示基础设施 **P6 已经建好了** —— `selection-controller.ts` 的 `overlayHintOnBorder()`。只需让它接受两段提示并用 `⋅` 连接。

**移植时必须改掉**源码注释里"迁移到官方 `getPasteContent`/`replacePaste` API"的说法。

## 4. 本机安装状态

扩展已装,**不是从 npm,是本地路径**:`~/.pi/agent/settings.json` 的 `packages` 里第一项是 `/Users/andy/Projects/fork/pi/pi-zentui`。改了代码直接重开 pi 就生效,不用重装。

同时做了两处 pi 层面的改动:

- **移除了 `pi-powerline-footer-upstream`** —— 两个都是 footer 扩展,会抢 footer 和 editor 组件,不能共存
- **`showHardwareCursor: true`** —— `editorCursor: "terminal"` 必需;pi 默认关且会在多处从 settings 反复重新应用,扩展自己设不住

备份(还原用):

```fish
cp ~/.pi/agent/settings.json.before-zentui-fork ~/.pi/agent/settings.json
cp ~/.pi/agent/zentui.json.before-zentui-fork ~/.pi/agent/zentui.json
```

当前 `~/.pi/agent/zentui.json` 是从原 powerline 配置逐条映射来的:pill 单串、11 个段(含独立的 `cacheHit`)、`palette` + 逐段配色、`copyOnSelect: false`、`editorCursor: "terminal"`、`pathDisplay` 显示两级、两个盒子 `paddingY: 0`。

另外还建了 `~/.pi/agent/extensions/subagent/config.json`(原本不存在):

```json
{ "fleetViewPlacement": "aboveEditor" }
```

这是 **pi-subagents 自己的**配置项(`FleetViewPlacement`,见其 `src/shared/types.ts:1469`),把 fleet view 从编辑框下方挪到上方。与 zentui 无关 —— zentui 不能、也不应该去重排别的扩展注册的 widget。删掉该文件即回到 `belowEditor`。

## 5. 踩过的坑 —— 别再踩一遍

1. **`renderStyle` / `renderThemeStyle` 不能重构成 resolver 的薄封装。** theme 路径用 chalk(`\x1b[1m…\x1b[22m`)、收尾是 `\x1b[39m` 而非 `\x1b[0m`,用裸 SGR 重建必然产生字节差异,直接违反"text 模式与上游一致"。P1 因此改成纯增量。

2. **编辑框帧的行数不能随便改。** `splitPolishedFrame` / `unwrapPolishedFrameOnly` 按行号位置解析帧,改行数会让 wrapped editor 重复渲染自己的 chrome。想删那个空的 metadata 行时被上游 compliance 测试抓到并回退了。`editorPaddingY` 是把渲染端和解析端**同时**改才成立的。

3. **palette 展开必须在校验之前。** `$ref` 没展开就送进 `isSupportedColorSpec` 会被判非法然后静默丢弃。`colors` 和 `extensionStatuses.colors` 两处都栽过。

4. **测试会读你真实的 `~/.pi/agent/zentui.json`。** 已加 `vitest.config.ts` 把 `PI_CODING_AGENT_DIR` 指向临时目录。别删掉,否则 `npm run verify` 的结果取决于本机配置。

5. **pill 的实心箭头在两段同色时会隐形**(它就是「左色画在右色上」)。已自动降级为细分隔线。加新段时留意默认色是否与邻段撞车 —— zentui 默认里 `extensionStatus` / `tokens` / `contextNormal` 都是 `"bright-black"`。

6. **`icons.mode: "ascii"` 时用户显式覆盖仍然生效**,这是上游写在 `icons.ts` 里的规则(SPEC 说反了)。只有*默认值*会随模式变。

7. **compositor 会把 pi 的输出原样透传**(`compositor.ts:540` 的 `data`),里面可能含 `\x1b[?25l`。它的 `cursorVisible` 标志观察不到这个,所以任何依赖光标可见性的逻辑都不能靠追踪,要么断言要么别碰。

8. **改 `renderScrollableRoot` 里可见行的构造时,`visibleRootStart` 必须同步。** 它是「屏幕行 → transcript 绝对索引」的原点,选区高亮和鼠标映射都用它。加填充行而不改原点 = 选区静默错位,测试抓不到(没有覆盖该映射的测试)。

9. **不要试图去动别的扩展的 widget 位置。** 位置由注册方通过 `placement` 决定,通常它自己就有配置项(pi-subagents 的 `fleetViewPlacement` 即是)。zentui 唯一能做的是整体重排 cluster 的组成顺序,那会波及所有扩展,太粗暴。

## 6. 其余遗留

| 项 | 说明 |
|---|---|
| 改名 / 发 npm | 不做(自用 fork)。要发再单独立项 |
| 字面 hex 在非 truecolor 终端 | 已知限制,写进 README。修法:抄 pi 的 `rgbTo256`(`theme.ts:258`)+ 终端色彩模式探测 |
| pill 回馈上游 | 成型后可问 Luka |
| ColorSpec 点名主题 `vars` | 暂不做,现在只能点 ThemeColor 键 + 字面 hex |
| powerline 卡顿根因 | 已不影响本项目,值得给 nicobailon/pi-powerline-footer 提 issue |
