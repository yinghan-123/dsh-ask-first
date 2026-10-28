# dsh-ask-first（先问后干）

> GitHub：https://github.com/yinghan-123/dsh-ask-first · 一行安装：`pnpm add github.com/yinghan-123/dsh-ask-first`

让 DeepSeek Harness 的 Agent 在**替用户做决定之前先问一句**，而不是自己挑个默认值把事做完。

## 起因

DSH 内核本来就带「随时向用户提问」的能力，而且默认启用：

| 组件 | 作用 |
| --- | --- |
| `@deepseek-ai/dsh-user-questions` | 提问服务 `ctx.userQuestions`（校验 + 等待用户作答） |
| `@deepseek-ai/dsh-tool-ask-user` | 把服务暴露成模型工具 `ask_user_question`（standard preset 里 `id: tool-ask-user`） |
| `@deepseek-ai/dsh-client-ui-user-questions` | 在 Web GUI 里渲染提问卡片（选项 / 多选 / 自由作答） |

**问题不在能力，在行为**：模型倾向于「自己拍板」——需求有歧义时不问、方案有取舍时不问、
要动不可逆的东西时也不问，做完才解释。工具存在 ≠ 模型会主动用。

本插件补的就是这一层，分三层，强度递增。

## 一、提示词层（每次请求都带）

向系统提示注入两部分，互相配合：

1. **纪律段**（`app:ask-first`，system prompt section）：把「什么必须问 / 什么不该问 / 怎么问」
   写成可直接执行的判断标准（含例外清单，避免变成「凡事都要问」的噪音）。
2. **常驻提醒**（`app:ask-first-reminder`，runtime context）：**每个模型请求前**都注入一条
   约 150 字的规则（默认是「必须 / 不得 / 禁止」的强硬版）。runtime context 每一步都会重算
   并渲染在快照里，所以长会话里纪律段在 prompt 前段的注意力衰减时，这条仍然在场。文本固定
   （不带计数）时不破坏 prompt 缓存；正文可在设置页的 `standingReminder` 里整体改写。

常驻提醒可在设置页单独关掉（`alwaysRemind`），关掉后只剩纪律段 + 变更提醒 + 硬闸。

## 二、提醒层

监听 `tools/post-execute`，按 agent 统计「连续做了多少次**变更性**操作却一次都没提问」。
达到阈值（默认 3，之后 6、12、24）时，在这一次工具结果后面插入一条 notice 消息：

```
⚠ ask-first 提醒：本回合你已经连续做了 3 次变更性操作（最近一次：`write`），却还没有向用户确认过任何一次。
```

以下任一情况计数清零：调用 `ask_user_question`；用户发来新消息。

### 什么算「变更性操作」

- **结构性变更**（默认名单）：`write` `edit` `remove` `move` `publish` `spawn_teammate`
  `interrupt_agent` `subagent` `subagent_fork` `team_task_create` `team_task_update`
  `schedule_create` `schedule_update` `schedule_delete` `create_worktree` `create_goal`
  `update_goal` `terminal_send` `terminal_close` `terminal_signal`
- **shell 通道**（`bash` / `pwsh` / `terminal_send`）：按命令特征判断（`>`、`rm`、`mv`、
  `git commit`、`pnpm add`、`chmod`…），只读命令不计。
- **python 通道**：按代码特征判断（`open(...,'w')`、`os.remove`、`shutil.`、`subprocess.`…），
  纯计算与只读脚本不计。

只读工具（`read` `glob` `grep` `web_fetch` `web_search` `session_search` `todo_write` …）
**永远不计**——读十个文件不等于擅自做主。

## 三、硬闸层（不可逆操作必须先问）

对**没有回滚路径**的操作注册 `tools.guard()`：本回合还没问过用户时，直接拒绝这一次调用，
**不执行**，并返回一条可行动的拒绝理由：

```
ask-first 硬闸：`remove` 属于不可逆操作，本次调用已被拒绝，没有执行。
请先调用 `ask_user_question` 向用户确认……拿到明确同意后再重试这一次调用。
```

模型随后调 `ask_user_question` → 用户同意 → 重试 → 守卫放行。

### 什么算「不可逆操作」

- 工具名（默认）：`remove`、`move`、`publish`
- shell / python 文本里命中危险模式：`rm`、`rmdir`、`mkfs`、`dd if=`、`truncate -s 0`、
  `git reset --hard`、`git clean -fdx`、`git push --force`、`shutil.rmtree(`、`os.remove(`、
  `os.unlink(`、`os.rmdir(`、`.unlink(`、`.rmtree(`

### 放行条件（满足任意一条就不拦）

1. **本回合问过，且问的就是这件事**：`ask_user_question` 的提问正文（问题 / 标题 / 选项
   label 与 description）里必须出现这次操作的目标。只问了一个无关问题不解锁——这是
   `user-approval` 的「授权只对请求的那个动作有效」语义；
2. **用户这条消息里点名了该目标**（参数里的路径 / basename 出现在用户消息里）——
   用户说「删掉 a.txt」就直接放行，不必再问一遍；
3. **它只是本会话自己创建的文件**：本会话由 `write` 创建过、且路径完全相同的文件，
   清理自己的临时产物不需要确认（照抄官方 auto-review 的 low 规则）；
4. 调用者是**子代理**（委派它出来的父代理对用户负责，在子代理里拦会把团队任务卡死）。

### 只读沙箱下让位

`ctx.sandboxPolicy.resolve()` 读出当前 `mode`。当它是 `read-only` 时，变更请求本来就会被
文件系统层拒绝，硬闸再拦一次只是把同一个失败原因说两遍；提醒层统计「变更未提问」也没有意义
（根本没有生效的变更）。所以两层都静默。开关：`respectSandboxMode`（默认 true）。

### UNKNOWN 即确认

名单内的工具若**参数里读不出被操作的目标**，视为「不知道」，直接拒绝而不是放行——
「不知道」≠「安全」（OpenHands 的默认）。拒绝文案会要求模型把目标写进参数并先问用户。

总开关 `hardGate` 关掉后，硬闸完全不参与，只剩前两层。

## 刻意不做

- **不拦创作型操作**：`write` / `edit` / python 的 `open(...,'w')` 一律放行。它们可重写、
  可回滚，而开发任务里每一步都在用；拦了只会把正常任务卡死。
- **不拦子代理**（理由见上）。
- **不新增提问工具**：提问复用内核 `ask_user_question`，少一层 API 面，跟随上游升级。
- **不写客户端代码**：不碰 UI，只贡献系统提示与一条消息；设置项走 DSH 内置的
  「设置 → 插件 → ask-first」自动表单。
- **守卫自身绝不阻断**：`guard` 回调整体包在 try/catch 里，内部任何异常都放行——插件的问题
  不该把工具链卡死。

## 安装

**一行安装**（DSHM 端侧的 `pnpm` 是 Host 布置的假壳，`add` 会走安装队列并同步返回结果）：

```bash
pnpm add github.com/yinghan-123/dsh-ask-first
```

手工落盘时：包放进 profile 的 `node_modules` 后，在 profile 的 `package.json` 里把包名加进
`dsh.profile.bundles`：

```json
"dsh": {
  "profile": {
    "bundles": [
      "…",
      "dsh-ask-first"
    ]
  }
}
```

本包的 `package.json` 声明了 `dsh.bundle.patch` → `./cordis.patch.yml`，后者只 insert
自身一行（`id: ask-first` / `name: dsh-ask-first`），不改写任何官方装载行。

**实测（2026-10-24，DSHM 0.2.1-rc.2+dshm.73）**：包放进 `node_modules` 并在
`dsh.profile.bundles` 追加一行后，DSHM 的 loader 会 reconcile 出 `include:ask-first`
（`fiberPhase: active`），**不需要重启应用**；下一次请求的 system prompt 就带上了纪律段，
提醒层也当场触发验证通过。旧版本或改法不同的环境若没热挂载，重启一次 DSHM 即可。

## 回滚

1. 从 `dsh.profile.bundles` 删掉 `dsh-ask-first` 一行，重启即可（包文件留着不影响）；
2. 只想停某种行为：设置页把「硬闸」单独关掉（只剩提示词 + 提醒），或把总开关关掉；
3. 彻底删除：删掉 `node_modules/dsh-ask-first/` 目录。

## 设置界面

DSH 的「设置 → 插件」页只渲染**官方插件的 companion 页面**；第三方 bundle 的配置必须由
本包自己的浏览器半部注册到 slot 上。所以本包带一个手写、无构建步骤的 `lib/client.js`
（`window.__ModuleLoader__.load` 协议）：它把一页「先问后干」挂到 `settings.section`，
通过 `ctx.configForms.get("ask-first")` 读写本插件命名空间。

页面内容：**总开关**、**常驻提醒开关**、**硬闸开关**、**自建对象免授权**、**按 sandbox 模式让位**（五个开关，点完立即生效）、
**提醒正文编辑框**（多行，留空 = 内置强硬版默认）、
**提醒阈值**（数字输入）、以及三份**工具名单**（已提问工具 / 计入变更的工具 / 硬闸拦截的
工具，逗号或换行分隔）。底部「保存」一次写入全部字段，「恢复默认」把所有字段 unset 回默认值。

| 字段 | 默认 | 说明 |
| --- | --- | --- |
| `enabled` | `true` | 总开关（三层全部受它控制） |
| `alwaysRemind` | `true` | 每个模型请求前都注入一条常驻纪律提醒 |
| `standingReminder` | 内置强硬版 | 常驻提醒的正文（留空 = 内置默认；改完下一轮生效，不用重启） |
| `hardGate` | `true` | 硬闸开关：不可逆操作没问过就拒绝执行 |
| `threshold` | `3` | 连续多少次变更性操作没提问后提醒（最小 1） |
| `askTool` | `ask_user_question` | 哪个工具算「已经问过」 |
| `mutatingTools` | 见上文 | 计入变更性操作的工具名列表 |
| `irreversibleTools` | `remove` `move` `publish` | 硬闸拦截的工具名列表 |
| `selfCreatedExempt` | `true` | 自建对象免授权：本会话 `write` 创建过的文件，删除/移动不再要求先问 |
| `respectSandboxMode` | `true` | 按 sandbox 模式让位：只读模式下变更本来就不可能执行，硬闸与提醒静默 |

七个字段都是 volatile：保存后立即生效（写入 profile 行 + 热更新运行中的 host 实例），
不需要重启。

**首次加载 client 半部需要重启一次 DSHM**：loader 要重新扫描该包的 `dsh.client` 声明，
之后刷新页面就能看到设置侧栏的「先问后干」一页；此后改配置都是热的。

## 边界（如实声明）

- 判断是**启发式**：shell / python 的写入与危险命令靠特征匹配，可能漏判（少拦一次 /
  少提醒一次），也可能在等价场景下多判。阈值与名单都能在设置页调。
- 硬闸的放行靠「本回合问过」而不是「问的就是这件事」：模型理论上可以问一个无关问题来
  解锁。这是刻意的取舍——要做到语义级绑定，就得解析提问内容，脆且难维护；提示词层已经
  要求「问题里说清要动什么」。
- 提醒与硬闸都是**面向行为**的，不改权限策略：DSHM 端侧仍是
  `danger-full-access` + `approval = never`，硬闸是插件自己的判断，不是沙箱或审批。
- 真正「随时提问」的通道（选项 / 多选 / 自由作答、等待与超时语义）仍由内核提供，
  本插件不改变它。
