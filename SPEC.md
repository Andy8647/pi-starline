# Fork spec

> 2026-07-27。基线 `upstream/main` = `0b2bdc7` (v0.13.0)。
> 目标:在 pi-zentui 上加 pill footer,并把 pi-powerline-footer fork 里值得留下的行为移植过来。

## 1. 为什么是 fork zentui,而不是继续修 powerline

实测证据链(同一个 session `019f9ca3…`,1004 KB,同一个 Ghostty,同样 12 个其他扩展):

| 被测对象 | 结果 |
|---|---|
| 我们的 `perf/viewport-diff-hardware-scroll`,三种 `scrollStrategy` | 三种**完全一致**地卡 |
| pi-powerline-footer upstream v0.7.0(原版) | **更卡**,滚到顶后停顿更长 |
| pi-zentui | **流畅,体感与终端原生 scrollback 无差别** |

结论:

1. 卡顿不在滚动绘制路径上 —— SU/SD、自定义节流、立即重绘三个嫌疑被 `scrollStrategy` 实验一次排除。
2. 卡顿不是我们引入的 —— upstream 原版更卡。
3. 卡顿不是其他扩展造成的 —— zentui 带着同样 12 个扩展依然流畅。
4. **卡顿是 pi-powerline-footer 自身架构的问题,根因未定位。**

第 4 条是放弃它的理由,也是**不从零新写**的理由:根因未知的情况下重写,有相当概率把同一个问题再造一遍。zentui 的合成器是目前唯一被实证为"对"的那个。

体量参考:zentui 9,574 行 TS / 30 文件;我们的 powerline fork 11,624 行 / 29 文件。从零写 = 重新产出约 9,000 行,并重趟 alt-screen 合成器的全部坑(光标记账、scroll region、overlay、kitty 图片、mouse reporting 暂停、pi 版本兼容)。

## 2. 分叉策略

### 2.1 三层分类

| 层 | 文件 | 策略 |
|---|---|---|
| **合成器**(最脆弱、最值钱) | `fixed-editor/compositor.ts` `pi-compat.ts` `terminal-modes.ts` `cluster.ts` `input.ts` `types.ts` | **尽量跟上游逐字节一致**。它们 patch pi 内部方法,pi 每次升级都可能挂,上游会持续修,这些修复要能 `git merge upstream/main` 白嫖 |
| **可分叉** | `footer.ts` `config.ts` `style.ts` `icons.ts` `user-message.ts` `settings-command.ts` | 本来就要大改,冲突不可避免,放手改 |
| **新增** | 见 §3 各节标注的新文件 | 纯新文件,零冲突 |

### 2.2 合成器改动的硬约束

移植复制行为(§3.4)**必然**要改 `compositor.ts` —— 它现在的 `handleMouseEvent` 直接 `if (ev.row > this.visibleScrollableRows) return;`,编辑框区域根本不参与选择。

约束:**compositor.ts 里只留最小钩子,逻辑一律放新文件。**

允许的改动形态:
- 把 `handleMouseEvent` 里选择相关的分支替换为对新模块 `selection-controller.ts` 的单次委托调用
- 构造函数多接几个 option(回调、配置 getter)
- 其余一律不动

不允许:在 compositor.ts 里内联复制逻辑、box chrome 裁剪、提示文本合成。

判据:改完之后 `git diff upstream/main -- extensions/zentui/fixed-editor/compositor.ts` 应当**在 100 行以内**,且都是委托调用与参数传递。

### 2.3 改名(5 处,目录名不动)

| 位置 | 现在 | 改 |
|---|---|---|
| `package.json` → `name` | `pi-zentui` | `@andy8647/pi-<新名>` |
| GitHub repo | `Andy8647/pi-zentui` | 新名 |
| `settings-command.ts:599` | `pi.registerCommand("zentui")` | 新命令名 |
| `config.ts:223` | `join(getAgentDir(), "zentui.json")` | `<新名>.json` |
| `config.ts:94,115,557` | `ExtensionStatusColorMode = "zentui" \| "original"` | 新名 \| `"original"` |

**`extensions/zentui/` 目录名保持不动。** pi 靠 `package.json` 的 `pi.extensions: ["./extensions"]` 找入口(pi loader.ts:572),子目录名不是身份标识。改目录名会让此后每次合上游都变成手工 cherry-pick。

内部 identifier(变量名、类型名里的 zentui)同样不做全局改名 —— 全仓 `extensions/` 下 "zentui" 只出现 58 次,收益远小于冲突成本。

### 2.4 License

zentui 是 MIT,`Copyright (c) 2025-2026 Luka`。硬性义务:保留原版权行 + MIT 全文。

`LICENSE` 改成:

```
MIT License

Copyright (c) 2025-2026 Luka
Copyright (c) 2026 Andy

Permission is hereby granted, ...
```

`fixed-editor/compositor.ts` 顶部的署名链(`@tifan/pi-fixed-editor` ← `pi-powerline-footer` by Nico Bailon)保留不动。README 加一行 "Forked from [pi-zentui](https://github.com/lmilojevicc/pi-zentui)"。

### 2.5 同步节奏

- `upstream` remote 已配好(`git@github.com:lmilojevicc/pi-zentui.git`)
- 每次上游发版:`git fetch upstream && git merge upstream/main`
- 冲突预期集中在 `footer.ts` / `config.ts`,合成器应当自动合上;若合成器出现冲突,说明 §2.2 的约束被破坏了,回头收紧

---

## 3. 功能规格

### 3.1 Pill footer

**背景冲突**:zentui 的 footer 是 starship 风格的格式串(`footerFormat`,内含 `$cwd` `$gitBranch` 等变量,可夹任意字面文本)。powerline 的 pill 是有序段列表 + 左右分区。两个模型不兼容 —— 格式串里的字面文本没法 pill 化。

**决定**:pill 不改造 `footerFormat`,而是**并列的第二种渲染样式**,走独立的布局配置。

```jsonc
{
  "footerStyle": "text",        // "text"(默认,现有行为) | "pill"
  "pill": {
    "layout": {
      "left":  ["model", "thinking", "cwd", "gitBranch"],
      "right": ["extensionStatus", "context", "cost"]
    },
    "separator": "powerline",   // powerline | powerline-thin | slash | pipe | block | none | ascii | dot | chevron | star
    "textColor": "dark",        // dark(默认) | light | contrast | #rrggbb
    "bold": true,
    "endCap": true              // 右端封口
  }
}
```

`footerStyle: "text"` 时 `pill` 整块被忽略,`footerFormat` 行为与上游完全一致。`footerStyle: "pill"` 时 `footerFormat` 被忽略。

**段的取值范围** = zentui 现有 `footerSegments` 的键 + `extensionStatus`。不引入 powerline 自己的段体系,避免维护两套。

**颜色配置(starship 风格)**

zentui 现有的 `colors.*` 是前景色规格串(`"bold cyan"` / `"208"` / `""`)。pill 需要背景色。扩展 ColorSpec 解析器,接受 starship 的 `bg:` / `fg:` 前缀:

```jsonc
{
  "colors": {
    "gitBranch": "bg:#a6e3a1 fg:#1e1e2e bold",   // pill 模式:背景 + 前景
    "cwd": "bg:blue",                             // 只给 bg,fg 由 pill.textColor 推导
    "cost": "bold green"                          // 无 bg 前缀:text 模式原样;pill 模式用中性底色
  }
}
```

规则:
- 解析器向后兼容 —— 不含 `bg:`/`fg:` 前缀的旧值在 text 模式下行为不变
- pill 模式下没有 `bg:` 的段,回退到中性底色(沿用 powerline 的 `#45475a`),保证整条 bar 不断裂
- 支持的颜色写法沿用 zentui 现有 ColorSpec(命名色、256 索引、`#rrggbb`)+ `bold` 等属性

**无缝过渡**:相邻 pill 之间的分隔箭头,前景取左段背景色、背景取右段背景色。实现要点(取自我们 fork 的 `936e50f`):复用运行时主题已解析的背景 SGR 序列,把 `48` 换成 `38` 得到对应前景,**不做 RGB 提取**,这样 truecolor 和 256 色终端都能正确串联。

**图标配置**:zentui 已有 `icons` 配置(`mode: "auto"` + `NERD_DEFAULT_ICONS`)。扩展为允许逐段覆盖:

```jsonc
{ "icons": { "mode": "auto", "gitBranch": "", "cwd": "" } }
```

`mode: "ascii"` 时所有自定义图标一律忽略,走 ASCII 回退。

**新文件**:`extensions/zentui/pill.ts`(渲染)、`pill-config.ts`(配置解析)。`footer.ts` 只加一个按 `footerStyle` 分派的入口。

### 3.2 渲染层:不动

`fixed-editor/` 下的合成器**按原样使用**,不做任何性能改造。

明确的 non-goal:**不移植** powerline fork 上 `perf/viewport-diff-hardware-scroll` 的 5 个 commit(视口差分、SU/SD 硬件滚动、前沿合并、复用根渲染、复用 cluster)。zentui 在没有这些的情况下已经流畅,加进来只会增加与上游的分叉面和出错概率。

同样不移植:`scrollRepaintThrottleMs`、`scrollStrategy`、`paintedViewport` 影子缓冲。

### 3.3 编辑框与 user message box

zentui 现有实现(`user-message.ts` + `cluster.ts`)**保留为默认**。补齐颜色可配置性:

```jsonc
{
  "colors": {
    "editorBorder": "#585b70",
    "editorAccent": "#cba6f7",
    "editorPrompt": "#6c7086",        // 新增:prompt 前缀颜色
    "userMessageBorder": "#585b70",   // 新增:与编辑框分开配
    "userMessageText": "#cdd6f4"
  },
  "colorSources": { "editor": "theme", "userMessages": "theme" }
}
```

`colorSources` 现有语义保留:`"theme"` 表示跟随 pi 主题,设为其他值时才读上面的显式颜色。新增的三个键遵循同样规则。

**不引入** powerline 的 `editorBox: "flat" | "rounded"` 开关 —— zentui 的 box 就是目标形态,不需要第二种。

### 3.4 复制行为(从 powerline fork 移植)

zentui 现状:只有 transcript 区拖选 → 松手即复制 + 右键复制。没有开关、没有 ctrl+c、没有提示、编辑框区域不参与选择。

移植后的完整行为:

| # | 行为 | 来源 |
|---|---|---|
| 1 | `copyOnSelect: true`(默认)= 松手自动复制,与 zentui 现状一致 | `358b14f` |
| 2 | `copyOnSelect: false` = 松手后保持高亮,不写剪贴板 | `358b14f` |
| 3 | `copyOnSelect: false` 时在编辑框下边框显示 `N characters selected, ctrl+c to copy` | `c4e8abf` |
| 4 | `ctrl+c` 复制当前选区(两种设置下都生效);无选区时透传给 pi 的正常 ctrl+c | `c4e8abf` |
| 5 | 右键点在选区**内**always 显式复制;点在选区外走原有的 context menu 暂停逻辑 | `c4e8abf` |
| 6 | 复制来源区分 `auto` / `explicit`,显式复制**不弹 toast**(提示消失本身就是反馈) | `c4e8abf` `9847e83` |
| 7 | 编辑框内可拖选,且选区**排除 box 边框(`│` `╭─╮` `╰─╯`)和 prompt 前缀**;纯边框行整行丢弃 | `0df3a78` |
| 8 | 编辑框内:press 起选,release 时若未拖动则判定为单击(移动光标);拖动则选中文本 | `00de497` |
| 9 | 任何编辑按键(透传给编辑器的键)清掉拖选高亮 | `e2445a4` |

保留 zentui 已有的、我们没有的:**OSC 8 超链接提取**(`selection.ts` 的 `extractOsc8Links`,复制时把 URL 一并带出)。这是 zentui 比我们强的地方,不要在移植中丢掉。

**新文件**:`fixed-editor/selection-controller.ts`(第 1–9 条的状态机)、`fixed-editor/box-chrome.ts`(第 7 条的裁剪)。`compositor.ts` 只加委托调用,见 §2.2。

配置:

```jsonc
{ "fixedEditor": { "enabled": true, "mouseScroll": true, "copyOnSelect": true, "copyNotice": true } }
```

`copyNotice` 沿用 zentui 现有键,语义收窄为"仅 auto 复制时提示"(第 6 条)。

### 3.5 粘贴折叠 + 再粘展开

| 行为 | 来源 |
|---|---|
| 长粘贴折叠成 `[paste #N +L lines]` 标记 | pi 内置(> 10 行) |
| `pasteCollapseLines`(2–10)下调阈值;越界值归一化回 11 = pi 默认 | `7ffc128` |
| 折叠后显示 dim 的 "paste again to expand" 提示 | `9f1901b` |
| 再粘一次相同内容 → 就地展开为全文,而不是叠第二个标记 | `9f1901b` |
| 任何非粘贴输入、或删除该占位符 → 提示解除 | `9f1901b` |
| 提示显示在**编辑框下边框上**,与选区提示共存,用 `⋅` 连接 | `ce94fd6` |

组合示例:`paste again to expand ⋅ 636 characters selected, ctrl+c to copy`

**风险(必须在实现前验证)**:`9f1901b` 的展开是 Reflect-based,依赖 pi-tui 内部稳定的 paste id,当时验证范围是 **pi-tui 0.74–0.80**。zentui 锁的是哪个版本要先确认;若 pi-tui ≥ 0.81,改用官方 `getPasteContent` / `replacePaste` API。**这条是整个移植里最脆的一项。**

### 3.6 editorCursor

```jsonc
{ "editorCursor": "block" }   // block(默认) | underline | terminal
```

- `block`:pi-tui 的软光标(反色),现状
- `underline`:软光标画成下划线
- `terminal`:隐藏软光标,让真实终端光标透出来 —— 形状和闪烁跟随终端自身配置(Ghostty 的闪烁竖线)

来源 `00de497`。注意该 commit 同时删掉了失效的 `editorCursorBlink`(SGR 闪烁被 Ghostty 等终端忽略),**不要移植那个选项**。

需先确认 zentui `cluster.ts` 的 `cluster.cursor` 与 `compositor.ts:paintCluster` 的光标处理能否直接承载三档 —— 现有代码只有"显示/隐藏"二态。

### 3.7 context / cache 段显示格式

来源 `d703db0`。映射到 zentui 的段名:

```jsonc
{
  "segmentOptions": {
    "context": { "format": "full" },      // full(默认,"12k/200k (6.2%)") | percent(裸百分比,带阈值色,无图标)
    "cacheRead": { "format": "tokens" }   // tokens(默认,原始计数) | percent(命中率 = cacheRead/(input+cacheRead))
  }
}
```

zentui 现有的 `contextStyle: "text"` 与 `contextThresholds` 保留,`format` 与它们正交组合。

**待确认**:zentui 是否已有独立的 cache read 段。若没有,需要先加段本身,再加 format —— 工作量比"移植一个格式选项"大。

### 3.8 git host 图标

来源 `777a134`。

```jsonc
{ "gitHostIcon": false }   // 默认关
```

开启时 `gitBranch` 段的分支图标替换为 origin remote 的站点 logo:GitHub / GitLab / Bitbucket / 其他(通用 git logo)。无 origin remote 的仓库保持普通分支图标;`icons.mode: "ascii"` 时整个特性失效。

检测方式:`git remote get-url origin`(SSH 与 HTTPS 两种写法),**长 TTL 缓存**,不产生每帧成本。zentui 的 `git.ts` 已有 remote 相关逻辑,复用其缓存层。

---

## 4. 明确不做(non-goals)

| 不做 | 理由 |
|---|---|
| 移植 powerline 的合成器 / 5 个 perf commit | zentui 已流畅;增加分叉面且无收益(§3.2) |
| 移植 powerline 的 preset / layout / customItems 体系 | 与 zentui 的 `footerSegments` + `extensionStatuses` 重复,维护两套配置模型是负债 |
| 移植 `editorBox: flat` | zentui 的 box 就是目标形态 |
| 移植 welcome 屏、bash-mode、scroll-away 导航卡、键盘滚动快捷键 | 本次未点名,且都是独立特性,想要可以后续单独立项 |
| 全局 identifier 改名 | 冲突成本 >> 收益(§2.3) |
| 定位 powerline 卡顿的根因 | 已不影响本项目;值得单独给 nicobailon/pi-powerline-footer 提 issue |

---

## 5. 待定 / 存疑

| # | 问题 | 影响 | 建议 |
|---|---|---|---|
| 1 | **新名字叫什么** | package name / repo / 命令名 / 配置文件名 | 需要你定 |
| 2 | 要不要发 npm | 只自用的话,`packages` 里直接写本地路径即可,省掉发版流程 | 先本地路径,稳定后再发 |
| 3 | pill 要不要回馈给 zentui 上游 | 若上游接受,分叉面会小很多 | 先自己做出来,成型后再问 Luka |
| 4 | **pi-tui 版本** | 决定 §3.5 的粘贴展开走 Reflect 还是官方 API | 实现前第一件事就查 |
| 5 | zentui 有没有独立的 cache read 段 | 决定 §3.7 是"加选项"还是"加段" | 实现前查 |
| 6 | zentui 的光标处理能否承载三档 | 决定 §3.6 工作量 | 实现前查 |
| 7 | `/zentui` 命令改名后,旧的 `zentui.json` 要不要自动迁移 | 你自己一台机器,手动改一次即可 | 不做自动迁移 |

---

## 6. 验收标准

功能:

1. `footerStyle: "pill"` 下 footer 渲染为无缝箭头串联的色块,truecolor 与 256 色终端都不断裂
2. 每段的 bg/fg/图标可通过 `colors.*` / `icons.*` 独立配置,`footerStyle: "text"` 时行为与上游 `0b2bdc7` 完全一致
3. §3.4 的 9 条复制行为逐条可验证,且 OSC 8 链接提取未退化
4. §3.5 的粘贴折叠/展开在 flat 与 rounded 两种边框下都工作,提示与选区提示能共存
5. 现有 4 个扩展状态位(balance / automode / mcp / tavily)在 pill 模式下正常显示

性能(这是本项目存在的理由,必须守住):

6. 在 `019f9ca3…` 这个 session 上,滚动流畅度与改造前的 zentui **无可感差异**
7. `git diff upstream/main -- extensions/zentui/fixed-editor/compositor.ts` 在 100 行以内(§2.2)
8. `git merge upstream/main` 在合成器文件上无冲突

工程:

9. 新增行为有测试(zentui 现有 `test/` 用 node:test,沿用)
10. LICENSE 保留 Luka 的版权行,README 标注 fork 来源
