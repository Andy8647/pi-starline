# Handoff

> 2026-07-27。分支 `combined`,基线 `upstream/main` = `0b2bdc7` (v0.13.0)。**未推送**。
> 背景与规格见 `SPEC.md`,分阶段计划与调研结论见 `PLAN.md`。本文件只讲**现在是什么状态、下一步做什么**。

## 1. 当前状态

- `npm run verify` → **756 tests / 29 files 全绿**
- `git log upstream/main..HEAD` → 25 个 commit
- **有一个未修复的显示 bug,见 §3.0。已经改了三次都没修好,不要在没拿到数据前再改第四次。**
- 扩展已安装到本机 pi 并在实际使用中(见 §4)

### 硬约束(SPEC §6.7 / §6.8)

| 约束 | 状态 |
|---|---|
| `git diff upstream/main -- fixed-editor/compositor.ts` < 100 行 | **+69 −63** |
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
| P6b | **编辑框内单击定位光标 + 拖选**,两个 commit。已可用 |
| P8(一半) | `pasteCollapseLines`(2–10)。**"再粘一次展开"未做** |
| 追加 | `cacheHit` 独立段(`$cache_hit`)、`extensionStatuses.icons` |

### 追加的两项细节

**`cacheHit` 段**。命中率原本只能内嵌在 `tokens` 段里,读起来像第三个 token 计数。现在是独立的段:自己的 `footerSegments.cacheHit`(默认关)、`colors.cacheHit`、`icons.cacheHit`(该图标同时仍是内嵌模式的字形),可用于 `footerFormat` 的 `$cache_hit` 和 `pill.segments`。配合 `segmentOptions.tokens.cache: "off"` 使用,否则显示两遍。无缓存活动、或最新一轮无已知命中率时,整段渲染为空而不是 `0%`。

**短 transcript 的对齐**。`compositor.ts` 原先用 `visible.push("")` 把空白填在内容**下方**,于是短于滚动区的 transcript 会浮在屏幕顶端、空隙全落在编辑框上方。改为填在上方。**注意**:屏幕行 → transcript 索引的原点要同步回退 `padTop`(`renderScrollableRoot` 里的 `origin`),否则选区映射会整体错位;`SelectionController` 另加了 `line < 0` 的守卫,处理点在填充行上的情况。

## 3. 未完成

### 3.0 ⚠️ 未修复的 bug:transcript 与编辑框之间有大片空隙

**现象**:会话内容很少时(比如只有一行 `∴ Working...`),那一行浮在屏幕**顶端**,它和编辑框上边框之间留着好几行空白。期望是内容贴着编辑框,像 pi 原生 scrollback 那样。

**改了三次,三次都没修好。** 记录如下,避免重复:

| # | 改了什么 | 结果 |
|---|---|---|
| 1 | `renderScrollableRoot` 里空白填充从 `push`(填在内容下方)改成 `unshift`(填在上方) | 逻辑正确,但该路径没被走到 |
| 2 | 窗口长度改为「按最后一行有内容的位置量」,不再用 `lines.length` | 逻辑正确,但"有内容"的判断是错的 |
| 3 | blank 的定义从 `visibleWidth(line) === 0` 改成「剥样式后 trim 为空」 | 仍未修好 |

第 3 次是有依据的:pi 把每一行都用空格填满整个终端宽度,所以 `visibleWidth` 判断确实是错的。改完两条新测试(空格填充行、纯样式行)在旧判断下失败、新判断下通过。**但用户实测仍有空隙**,说明这不是(或不只是)原因。

**唯一一次拿到的真实数据**(启动瞬间,`ZENTUI_DEBUG_LAYOUT` 一次性 dump):

```
rawRows=51 scrollableRows=46 padTop=23
rootLines=24 contentLength=23 clusterLines=5
```

启动帧是**正常的**——`padTop=23` 说明填充生效了。问题出在 "Working..." 那一帧,而那次 dump 是一次性的(`didDumpLayout`),抓的是启动帧,**没抓到出问题的那一帧**。这是当时最大的失误。

**最有价值的未验证假设:空隙可能根本不在滚动区,而在 cluster 里。**

`renderCluster`(`cluster.ts`)把 `[status, aboveWidget, editor, belowWidget, footer]` 拼起来,然后**只剥掉开头的空行**:

```ts
while (start < allLines.length - 1 && visibleWidth(allLines[start]) === 0) start++;
```

如果 `∴ Working...` 是 **cluster 的 status 组件**渲染的,而该组件输出的是 `["∴ Working...", "", "", ""]`,那么开头不是空行、剥不掉,中间那几行空白会原样留在 status 和 editor 之间 —— **正好就是观察到的现象**,而且完美解释了为什么三次改滚动区的代码全都无效。

那次 dump 里有 `--- cluster ---` 段(`clusterLines=5`),但**当时只看了根渲染那段就把文件删了**,cluster 的内容始终没看过。这是下一步第一件要做的事。

**下一步怎么做(不要跳过)**:

1. 把诊断加回 `compositor.ts`(上一版实现见 commit `cdc4533` 的父提交),但改成**按布局签名变化时才 dump**,而不是一次性 —— 一次性只会抓到启动帧。签名用 `rootLines/contentLength/scrollableRows/padTop/clusterLines` 拼一下即可。
2. 让用户在**出现空隙的那一帧**跑,然后**先看 `--- cluster ---` 段**。
3. 如果空隙在 cluster 里 → 改 `renderCluster` 的空行处理(注意 `cluster.ts` 在「尽量跟上游逐字节一致」的清单里,但既然要动,同样只留最小改动)。
4. 如果空隙在滚动区 → 看 `contentLength` 与 `scrollableRows` 的实际关系再判断。
5. **先写一条能复现该帧的测试再改代码。** 前两次失败都是因为没有;第三次有测试,但测试数据(`""`)不是 pi 真实输出的形态(空格填充行),所以测试通过而 bug 仍在。

### 3.1 未完成的功能:再粘一次展开(P8 的另一半)

`pasteCollapseLines` 已经做了(阈值 2–10,你的配置设的 3)。**没做的是**:折叠后出现「再粘一次可展开」提示,再粘同样内容时占位符就地变回全文。

它才是真正碰 pi 私有 `pastes` map 的 id 重编号的部分,也是「悄悄丢内容」风险的所在。参考实现 `9f1901b`(展开)、`ce94fd6`(提示放到下边框)。

好消息:`ce94fd6` 需要的下边框提示基础设施已经有了 —— `selection-controller.ts` 的 `overlayHintOnBorder()`,只需让它接受两段提示并用 `⋅` 连接。

**移植时必须改掉**源码注释里"迁移到官方 `getPasteContent`/`replacePaste` API"的说法:0.82.1 仍然没有该 API。

### 3.2 P6b 和 P8 前半的实现要点(已完成,供参考)

两者都靠 Reflect 进 pi 的私有成员,都写成了 feature-detect + 探测不到就静默关闭:

- `editor-hit-test.ts` —— 屏幕行列 → 编辑器视觉坐标。**行算术依赖 `editorPaddingY`**,配错就点哪都不对
- `editor-text-cursor.ts` —— 写光标位置。`resolveEditorInternals` 会往下走过容器和 `WrappedPolishedEditor` 的 `base`,因为 compositor 记的是**容器**不是编辑器
- `paste-collapse.ts` —— 影子 `handlePaste`。清洗流程逐字对着 pi 0.82.1 抄,任何 pi 会区别对待的情况一律原样交还

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

9. **测试数据必须是 pi 真实输出的形态。** 修「空隙」那个 bug 时,测试用 `""` 当空行,而 pi 实际输出的是**填满整行宽度的空格**。测试通过了,bug 还在。写涉及渲染输出的测试前,先 dump 一份真实的行看看长什么样。

10. **一次性诊断会抓错帧。** 用 `didDumpLayout` 之类的标志只 dump 第一帧,拿到的是启动画面,不是出问题的那一帧。要按状态签名变化 dump。

11. **不要试图去动别的扩展的 widget 位置。** 位置由注册方通过 `placement` 决定,通常它自己就有配置项(pi-subagents 的 `fleetViewPlacement` 即是)。zentui 唯一能做的是整体重排 cluster 的组成顺序,那会波及所有扩展,太粗暴。

## 6. 其余遗留

| 项 | 说明 |
|---|---|
| 改名 / 发 npm | 不做(自用 fork)。要发再单独立项 |
| 字面 hex 在非 truecolor 终端 | 已知限制,写进 README。修法:抄 pi 的 `rgbTo256`(`theme.ts:258`)+ 终端色彩模式探测 |
| pill 回馈上游 | 成型后可问 Luka |
| ColorSpec 点名主题 `vars` | 暂不做,现在只能点 ThemeColor 键 + 字面 hex |
| powerline 卡顿根因 | 已不影响本项目,值得给 nicobailon/pi-powerline-footer 提 issue |
