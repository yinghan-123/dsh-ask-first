/**
 * dsh-ask-first — 让 Agent 在「替用户做决定」之前，先问一句。
 *
 * ── 要解决什么 ────────────────────────────────────────────────────────────
 * DSH 内核本来就带 `ask_user_question`（@deepseek-ai/dsh-user-questions +
 * @deepseek-ai/dsh-tool-ask-user + @deepseek-ai/dsh-client-ui-user-questions，
 * standard preset 里 id=tool-ask-user），能力没有问题。真正的短板是**行为**：
 * 模型倾向于「自己挑一个默认值、改完再说」，把本该由用户拍板的决定默默做掉。
 * 工具存在 ≠ 模型会主动用。
 *
 * 本插件补的是行为层，分三层：
 *
 *   ① 提示词层（引导）：向系统提示注册一个 section（`app:ask-first`），把
 *      「什么情况必须先问 / 什么情况不该问 / 怎么问」写成模型可以直接执行的
 *      判断标准，而不是喊口号；
 *   ② 提醒层（纠偏）：监听 `tools/post-execute` 统计**每个 agent 连续做了多少次
 *      变更性操作却一次都没提问**；达到阈值（默认 3，之后 6、12…）就在这一次
 *      工具结果后面插入一条 notice 消息，把「先问」重新推回模型的注意力里。
 *      调用 `ask_user_question`、或用户发来新消息，计数清零；
 *   ③ 硬闸层（不可逆操作）：对删除 / 移动 / 发布这类**没有回滚路径**的操作注册
 *      `tools.guard()` —— 本回合还没问过用户、用户消息也没点名该目标时，直接
 *      拒绝这一次调用（不执行）。拒绝文案要求模型先 `ask_user_question` 确认，
 *      用户同意后重试即放行。
 *
 * ── 刻意不做的事 ─────────────────────────────────────────────────────────
 * · **不拦创作型操作**：`write` / `edit` / python 的 `open(...,'w')` 一律放行。
 *   它们可重写、可回滚，而开发任务里每一步都在用；拦了只会把正常任务卡死。
 *   真正不可逆的是「东西没了 / 位置变了 / 用户可见产物被换掉」。
 * · **不拦子代理**：硬闸只约束根代理。子代理的调用是父代理委派的产物，由父代理
 *   对用户负责；在子代理里拦会导致团队任务直接停住。
 * · **不新增提问工具**：提问能力复用内核的 `ask_user_question`，本插件只负责
 *   「让模型想起来用它」和「不许绕过它」。少一层 API 面，升级更安全。
 * · **不写客户端代码**：不碰 UI，只贡献系统提示与一条消息；设置项走 DSH 内置的
 *   「设置 → 插件 → ask-first」自动表单。
 * · **守卫自身绝不阻断**：`guard` 回调整体包在 try/catch 里，任何内部异常都返回
 *   `undefined`（放行）—— 插件的问题绝不该把工具链卡死。
 *
 * ── 配置（设置页热更新，volatile）────────────────────────────────────────
 *   · `enabled`           —— 总开关（false 时三层全部停止）；
 *   · `threshold`         —— 连续多少次变更性操作没提问后提醒（默认 3）；
 *   · `askTool`           —— 被视为「已经问过」的工具名（默认 ask_user_question）；
 *   · `mutatingTools`     —— 计入「变更性操作」的工具名（默认见 DEFAULT_MUTATING_TOOLS）；
 *   · `hardGate`          —— 硬闸开关（默认 true；关掉后只剩提示词与提醒）；
 *   · `irreversibleTools` —— 硬闸拦截的工具名（默认 remove / move / publish）。
 * 六个字段都标了 `volatile()`：设置页保存后立即生效，不重挂 fiber、不需要重启。
 *
 * ── 安装形态 ──────────────────────────────────────────────────────────────
 * 包放进 profile 的 node_modules，并在 `profiles/<name>/package.json` 的
 * `dsh.profile.bundles` 里加上 `dsh-ask-first`（其 package.json 的
 * `dsh.bundle.patch` 指向本包的 `cordis.patch.yml`，只 insert 自身一行）。
 * 实测 DSHM 会热 reconcile 出 `include:ask-first`（active），无需重启。
 *
 * @module dsh-ask-first
 */
import z from '@deepseek-ai/schemastery';

/** Cordis 插件名（Loader 行的插件身份；npm 包名是 `dsh-ask-first`）。 */
export const name = 'ask-first';

/**
 * 服务依赖在 `apply` 里用嵌套 `ctx.inject` 分支获取：缺 `systemPrompt` 时提醒层
 * 仍然生效，缺任何服务都不抛错（守卫的位置留给别人的插件，本插件只观察）。
 */
export const inject = [];

/** 系统提示 section 的注册名（全局唯一，避免与其它插件撞名）。 */
const SECTION_NAME = 'app:ask-first';

/** 注入消息的 producer source.kind —— 这个标签是有意义的：未标注的上下文会被渲染成用户消息。 */
const REMINDER_KIND = 'ask-first';

/** 每步常驻提醒的 system prompt context 名（每个模型请求都会带上它）。 */
const STANDING_REMINDER_NAME = 'app:ask-first-reminder';

/**
 * 常驻提醒的内置默认正文（强硬版：写成「必须 / 不得 / 禁止」的规则，而不是请求）。
 * 设置页的 `standingReminder` 可以整体覆盖它；留空则回到这份默认。
 */
const DEFAULT_STANDING_REMINDER = [
  'ask-first 硬规则（必须遵守，优先级高于「先做再说」）：',
  '· 用户该拍板的事——需求有多种解读、方案有取舍、要做不可逆或对外的操作、缺只有用户知道的信息——**必须先**用 `ask_user_question` 问清楚；拿到回答前**不得**擅自执行，也不得先做了再解释。',
  '· **禁止**用「我假设…」「默认按…处理」「先做再说」绕过确认。',
  '· 用户本轮已明确授权的范围可以自行决定，但**不得**外扩。'
].join('\n');

/** cosmokit 的 volatile 引用协议符号（`Symbol.for`，跨 ESM/CJS 副本一致）。 */
const VOLATILE_WRITE = Symbol.for('cosmokit.volatile.write');

/** 默认：被视为「已经向用户问过」的工具名。 */
const DEFAULT_ASK_TOOL = 'ask_user_question';

/** 同一条链（同一次未提问的连续操作）最多提醒几次 —— 之后模型已经读过同样的提醒还选择继续。 */
const MAX_REMINDERS_PER_CHAIN = 4;

/**
 * 默认「不可逆操作」工具名 —— 硬闸只拦这三类：删除、移动/改名、发布覆盖用户可见产物。
 *
 * 刻意**不拦** `write` / `edit` / python 的 `open(...,'w')`：它们是创作型操作，被拦一次
 * 写代码就断一次，会把正常任务卡死；真正不可逆的是「东西没了 / 位置变了 / 用户可见产物
 * 被换掉」。要更严就把名字加进设置页的 `irreversibleTools`。
 */
const DEFAULT_IRREVERSIBLE_TOOLS = Object.freeze(['remove', 'move', 'publish']);

/**
 * shell / python 文本里出现即视为不可逆操作的命令特征。
 * 这些命令一执行就没有回滚路径，必须由用户点头。
 */
const DANGER_PATTERNS = Object.freeze([
  /\brm\s+/i,
  /\brmdir\s+/i,
  /\bmkfs\b/i,
  /\bdd\s+if=/i,
  /\btruncate\s+-s\s*0/i,
  /\bgit\s+reset\s+--hard/i,
  /\bgit\s+clean\s+-[a-z]*[fx]/i,
  /\bgit\s+push\s+(?:-f|--force)/i,
  /shutil\.rmtree\s*\(/,
  /os\.remove\s*\(/,
  /os\.unlink\s*\(/,
  /os\.rmdir\s*\(/,
  /\.unlink\s*\(/,
  /\.rmtree\s*\(/
]);

/**
 * 默认计入「变更性操作」的工具名。
 *
 * 判据是**会不会留下副作用**：写文件、删/移、发布产物、对外发消息、派子代理、
 * 改团队任务、建定时任务、切工作树、动目标。只读工具（read/glob/grep/
 * web_fetch/session_search/todo_write…）一律不计 —— 读了十个文件不等于「擅自做主」。
 */
const DEFAULT_MUTATING_TOOLS = Object.freeze([
  'write',
  'edit',
  'remove',
  'move',
  'publish',
  'spawn_teammate',
  'interrupt_agent',
  'subagent',
  'subagent_fork',
  'team_task_create',
  'team_task_update',
  'schedule_create',
  'schedule_update',
  'schedule_delete',
  'create_worktree',
  'create_goal',
  'update_goal',
  'terminal_send',
  'terminal_close',
  'terminal_signal'
]);

/** shell 通道：名字本身不说明写没写，要看参数。 */
const SHELL_TOOLS = new Set(['bash', 'pwsh', 'terminal_send']);

/** python 通道：同样要看代码内容。 */
const PYTHON_TOOLS = new Set(['python']);

/** shell 里像「会改东西」的命令特征（宁可漏判，不要误伤只会读的命令）。 */
const SHELL_MUTATION_HINTS = [
  />/,
  /\brm\b/,
  /\brmdir\b/,
  /\bmv\b/,
  /\bcp\b/,
  /\bmkdir\b/,
  /\btouch\b/,
  /\btruncate\b/,
  /\btee\b/,
  /\bsed\s+-i\b/,
  /\bchmod\b/,
  /\bchown\b/,
  /\bln\s+-s\b/,
  /\bgit\s+(?:add|commit|push|checkout|switch|reset|clean|apply|merge|rebase|tag)\b/,
  /\b(?:pnpm|npm|yarn|pip|pip3)\s+(?:add|install|remove|uninstall|update|upgrade)\b/,
  /\bdocker\b/,
  /\bkill\b/
];

/** python 代码里像「会改东西」的特征。 */
const PYTHON_MUTATION_HINTS = [
  /open\s*\([^)]*['"](?:w|a|x|wb|ab|xb|r\+|w\+|a\+)['"]/,
  /os\.remove\s*\(/,
  /os\.unlink\s*\(/,
  /os\.rename\s*\(/,
  /os\.replace\s*\(/,
  /os\.rmdir\s*\(/,
  /os\.makedirs\s*\(/,
  /shutil\./,
  /subprocess\./,
  /os\.system\s*\(/,
  /\.unlink\s*\(/,
  /\.rmtree\s*\(/,
  /\.write_text\s*\(/,
  /\.write_bytes\s*\(/
];

/**
 * 读取一个配置字段的**当前值**。
 *
 * volatile 字段在 schema 解析后是引用对象，`get()` 才拿到值；设置页保存时由
 * settings 服务原地写入。非 volatile / 未解析的值原样返回，缺省时回退到 fallback
 * —— 任何形状的配置都不该让插件抛错。
 *
 * @param node - schema 解析后的字段（可能是 volatile 引用）。
 * @param fallback - 字段缺失时的默认值。
 * @returns 字段当前值。
 */
function readLive(node, fallback) {
  if (node === undefined || node === null) {
    return fallback;
  }
  if (typeof node === 'object' && VOLATILE_WRITE in node && typeof node.get === 'function') {
    const current = node.get();
    return current === undefined ? fallback : current;
  }
  return node;
}

/** 总开关的当前值（只有显式 `false` 才关闭；缺省 / 非法值一律视为开启）。 */
function liveEnabled(config) {
  return readLive(config?.enabled, true) !== false;
}

/** 提醒阈值的当前值（非法值回退到 3，并且永远不小于 1）。 */
function liveThreshold(config) {
  const raw = readLive(config?.threshold, 3);
  const value = typeof raw === 'number' && Number.isFinite(raw) ? Math.floor(raw) : 3;
  return value < 1 ? 1 : value;
}

/** 「已提问」工具名的当前值。 */
function liveAskTool(config) {
  const raw = readLive(config?.askTool, DEFAULT_ASK_TOOL);
  return typeof raw === 'string' && raw.trim().length > 0 ? raw.trim() : DEFAULT_ASK_TOOL;
}

/** 计入「变更性操作」的工具名集合（每次调用重新归一化，保证设置页改动立即生效）。 */
function liveMutatingTools(config) {
  const raw = readLive(config?.mutatingTools, DEFAULT_MUTATING_TOOLS);
  if (!Array.isArray(raw)) {
    return new Set(DEFAULT_MUTATING_TOOLS);
  }
  const names = raw
    .filter((item) => typeof item === 'string')
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
  return new Set(names.length > 0 ? names : DEFAULT_MUTATING_TOOLS);
}

/** 硬闸总开关的当前值（默认开启；只有显式 `false` 才关闭）。 */
function liveHardGate(config) {
  return readLive(config?.hardGate, true) !== false;
}

/** 常驻提醒开关的当前值（默认开启：每个模型请求都带一条纪律提醒）。 */
function liveAlwaysRemind(config) {
  return readLive(config?.alwaysRemind, true) !== false;
}

/** 自建对象免授权开关的当前值（默认开启）。 */
function liveSelfCreatedExempt(config) {
  return readLive(config?.selfCreatedExempt, true) !== false;
}

/** 「按 sandbox 模式让位」开关的当前值（默认开启）。 */
function liveRespectSandboxMode(config) {
  return readLive(config?.respectSandboxMode, true) !== false;
}

/**
 * 读出当前 agent 的 sandbox 执行模式。
 *
 * `ctx.sandboxPolicy.resolve()` 是同步的，返回 `{ mode, workspaceRoot, sessionId? }`；
 * 服务缺失或抛错时返回 `undefined`（调用方按「读不到」处理）。
 *
 * @param ctx - 插件上下文。
 * @param agent - 工具执行所属的 agent。
 * @returns sandbox 模式，或 undefined。
 */
function sandboxModeOf(ctx, agent) {
  try {
    const service = typeof ctx.get === 'function' ? ctx.get('sandboxPolicy') : undefined;
    if (!service || typeof service.resolve !== 'function') {
      return undefined;
    }
    const session = agent?.session;
    const resolved = service.resolve(session === undefined ? {} : { session });
    const mode = resolved?.mode;
    return typeof mode === 'string' ? mode : undefined;
  } catch {
    return undefined;
  }
}

/**
 * 当前执行环境是否已经让变更操作不可能成功（只读沙箱）。
 *
 * 只读模式下变更请求会被文件系统层直接拒绝，硬闸再拦一次只是把同一个失败原因说两遍；
 * 提醒层统计「变更未提问」也没有意义（根本没有生效的变更）。
 *
 * @param ctx - 插件上下文。
 * @param config - 插件配置。
 * @param agent - 工具执行所属的 agent。
 * @returns 是否应当让位（静默）。
 */
function sandboxMakesMutationImpossible(ctx, config, agent) {
  if (!liveRespectSandboxMode(config)) {
    return false;
  }
  return sandboxModeOf(ctx, agent) === 'read-only';
}

/**
 * 每步常驻提醒的正文。
 *
 * 与「变更 3 次后的那条提醒」不同：这条**每个请求**都会注入（由 `systemPrompt.context`
 * 承载），作用是让纪律在长会话里始终在场——模型对 system prompt 里靠前段落的注意力会
 * 随对话变长而衰减，而 runtime context 每步都重算、总是出现在最近的位置。
 *
 * 正文可由设置页的 `standingReminder` 覆盖（volatile，改完下一轮就生效）；留空则用
 * 内置默认。文本固定时不破坏 prompt 缓存 —— 只有用户改它的时候才变。
 *
 * @param config - 插件配置（可能含 set 页面写入的覆盖文本）。
 * @returns 常驻提醒正文。
 */
function standingReminderText(config) {
  const raw = readLive(config?.standingReminder, DEFAULT_STANDING_REMINDER);
  return typeof raw === 'string' && raw.trim().length > 0 ? raw.trim() : DEFAULT_STANDING_REMINDER;
}

/** 硬闸拦截的工具名集合（每次调用重新归一化）。 */
function liveIrreversibleTools(config) {
  const raw = readLive(config?.irreversibleTools, DEFAULT_IRREVERSIBLE_TOOLS);
  if (!Array.isArray(raw)) {
    return new Set(DEFAULT_IRREVERSIBLE_TOOLS);
  }
  const names = raw
    .filter((item) => typeof item === 'string')
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
  return new Set(names.length > 0 ? names : DEFAULT_IRREVERSIBLE_TOOLS);
}

/**
 * 从消息里抽出纯文本（`content` 是 ContentBlock[]，只取 type === 'text' 的块）。
 *
 * @param message - 一条用户消息。
 * @returns 纯文本；形状不认识时返回空串。
 */
function messageText(message) {
  const content = message?.content;
  if (typeof content === 'string') {
    return content;
  }
  if (!Array.isArray(content)) {
    return '';
  }
  return content
    .map((block) =>
      block !== null && typeof block === 'object' && block.type === 'text' && typeof block.text === 'string'
        ? block.text
        : ''
    )
    .join('\n');
}

/**
 * 从工具参数里收集「目标标识」：所有字符串值，以及它们的 basename。
 *
 * 用途只有一个：判断用户这条消息里**有没有点名**这次操作要动的东西。点名了就算授权，
 * 不必再拦（否则用户说"删掉 a.txt"时模型还得再问一遍，纯属折腾）。
 *
 * @param args - 工具参数（任意 JSON）。
 * @param out - 累积集合。
 * @param depth - 递归深度保护。
 * @returns 目标标识集合。
 */
function collectTargets(args, out = new Set(), depth = 0) {
  if (args === null || args === undefined || depth > 4) {
    return out;
  }
  if (typeof args === 'string') {
    const value = args.trim();
    if (value.length >= 3) {
      out.add(value);
      const base = value.split(/[\\/]/).pop();
      if (base !== undefined && base.length >= 3) {
        out.add(base);
      }
    }
    return out;
  }
  if (Array.isArray(args)) {
    for (const item of args) {
      collectTargets(item, out, depth + 1);
    }
    return out;
  }
  if (typeof args === 'object') {
    for (const value of Object.values(args)) {
      collectTargets(value, out, depth + 1);
    }
  }
  return out;
}

/**
 * 用户本条消息是否点名了本次操作的目标（点名 = 已授权）。
 *
 * @param exec - 工具执行对象。
 * @param userText - 用户本条消息的纯文本。
 * @returns 是否视为已授权。
 */
function authorizedByUserText(exec, userText) {
  if (typeof userText !== 'string' || userText.trim().length === 0) {
    return false;
  }
  const haystack = userText.toLowerCase();
  for (const target of collectTargets(exec?.arguments)) {
    if (haystack.includes(target.toLowerCase())) {
      return true;
    }
  }
  return false;
}

/**
 * 取出一次提问调用里的正文：问题、标题、每个选项的 label 与 description。
 *
 * 硬闸用它判断「模型问的是不是这件事」——只记「问过」不够，授权只对请求的那个动作有效
 * （`dsh-user-approval` 的 grants 语义）。
 *
 * @param exec - `ask_user_question` 的工具执行对象。
 * @returns 提问正文；形状不认识时返回空串。
 */
function askedText(exec) {
  const questions = exec?.arguments?.questions;
  if (!Array.isArray(questions)) {
    return '';
  }
  const parts = [];
  for (const question of questions) {
    if (question === null || typeof question !== 'object') {
      continue;
    }
    if (typeof question.question === 'string') parts.push(question.question);
    if (typeof question.header === 'string') parts.push(question.header);
    if (Array.isArray(question.options)) {
      for (const option of question.options) {
        if (option === null || typeof option !== 'object') {
          continue;
        }
        if (typeof option.label === 'string') parts.push(option.label);
        if (typeof option.description === 'string') parts.push(option.description);
      }
    }
  }
  return parts.join('\n');
}

/**
 * 从工具参数里取出**显式**的目标路径字段（用于自建对象比对）。
 *
 * 刻意只认结构化的路径参数，不用 `collectTargets` 的宽松递归——自建对象免授权是一条
 * 放行捷径，宁可漏判（多问一次）也不能误判（放行删除用户资产）。
 *
 * @param exec - 工具执行对象。
 * @returns 路径字符串数组。
 */
function explicitTargets(exec) {
  const args = exec?.arguments;
  if (args === null || typeof args !== 'object') {
    return [];
  }
  const out = [];
  for (const key of ['path', 'file_path', 'source', 'destination', 'target', 'dir']) {
    const value = args[key];
    if (typeof value === 'string' && value.trim().length > 0) {
      out.push(value.trim());
    }
  }
  return out;
}

/**
 * 本会话是否自己创建过这次要动的对象（清理自己的临时产物免授权）。
 *
 * @param ownerSet - 该 agent 的「本会话写过的路径」集合。
 * @param exec - 工具执行对象。
 * @returns 是否属于自建对象。
 */
function isSelfCreated(ownerSet, exec) {
  if (!(ownerSet instanceof Set) || ownerSet.size === 0) {
    return false;
  }
  for (const path of explicitTargets(exec)) {
    if (ownerSet.has(path)) {
      return true;
    }
  }
  return false;
}

/**
 * 记录本会话由 `write` 创建/写过的路径（按 agent 弱持有）。
 *
 * 只记 `write`：`edit` 的对象可能是用户既有资产，不能因为「编辑过一次」就允许删除。
 *
 * @param store - `WeakMap<agent, Set<string>>`。
 * @param exec - 工具执行对象。
 */
function recordSelfCreated(store, exec) {
  const agent = exec?.agent;
  if (!agent) {
    return;
  }
  const toolName = typeof exec?.name === 'string' ? exec.name : '';
  if (toolName !== 'write') {
    return;
  }
  const args = exec?.arguments;
  const raw =
    typeof args?.file_path === 'string'
      ? args.file_path
      : typeof args?.path === 'string'
        ? args.path
        : '';
  const path = raw.trim();
  if (path.length === 0) {
    return;
  }
  let owner = store.get(agent);
  if (owner === undefined) {
    owner = new Set();
    store.set(agent, owner);
  }
  owner.add(path);
}

/**
 * 本回合的提问正文是否点到了本次操作的目标。
 *
 * @param asked - 提问正文（可能为空）。
 * @param targets - 本次操作的目标集合。
 * @returns 是否覆盖。
 */
function askedCoversTargets(asked, targets) {
  if (typeof asked !== 'string' || asked.trim().length === 0) {
    return false;
  }
  if (!(targets instanceof Set) || targets.size === 0) {
    return false;
  }
  const haystack = asked.toLowerCase();
  for (const target of targets) {
    const needle = target.toLowerCase();
    if (needle.length >= 3 && haystack.includes(needle)) {
      return true;
    }
  }
  return false;
}

/**
 * 判断一次工具调用是否属于硬闸要拦的不可逆操作。
 *
 * @param exec - 工具执行对象。
 * @param irreversible - 当前生效的不可逆工具名集合。
 * @returns 是否拦。
 */
function isIrreversible(exec, irreversible) {
  const toolName = typeof exec?.name === 'string' ? exec.name : '';
  if (toolName.length === 0) {
    return false;
  }
  if (irreversible.has(toolName)) {
    return true;
  }
  const args = exec?.arguments;
  if (SHELL_TOOLS.has(toolName)) {
    const text = `${stringArg(args, 'command')}\n${stringArg(args, 'text')}`;
    return DANGER_PATTERNS.some((pattern) => pattern.test(text));
  }
  if (PYTHON_TOOLS.has(toolName)) {
    const text = `${stringArg(args, 'code')}\n${searchable(args?.file)}`;
    return DANGER_PATTERNS.some((pattern) => pattern.test(text));
  }
  return false;
}

/**
 * 硬闸的拒绝文案。守卫返回的字符串会成为工具结果的失败原因，模型下一轮就能读到，
 * 所以文案必须**可行动**：说清被拒的是什么、改成用什么、怎么才会放行。
 *
 * @param exec - 被拒绝的工具执行对象。
 * @returns 面向模型的拒绝理由。
 */
function denialText(exec) {
  const toolName = typeof exec?.name === 'string' ? exec.name : '该操作';
  return `ask-first 硬闸：\`${toolName}\` 属于不可逆操作，本次调用已被拒绝，**没有执行**。

放行的三条路（满足任意一条就不再拦）：
1. 本回合已经问过用户，且**提问内容里点到了这次的目标**（只问了个无关问题不算）；
2. 用户这条消息里点名了该目标；
3. 它只是本会话自己用 \`write\` 创建的文件（清理自己的临时产物不需要确认）。

否则请先调用 \`ask_user_question\`：说清要动哪个目标、做什么、能否回滚，拿到明确同意后再重试。`;
}

/**
 * 「读不出目标」时的拒绝文案（UNKNOWN 即确认）。
 *
 * @param exec - 被拒绝的工具执行对象。
 * @returns 面向模型的拒绝理由。
 */
function unknownTargetText(exec) {
  const toolName = typeof exec?.name === 'string' ? exec.name : '该操作';
  return `ask-first 硬闸：\`${toolName}\` 属于不可逆操作，但这次调用的参数里读不出被操作的目标，无法确认授权范围，因此拒绝执行（「不知道」不等于「安全」）。

请把目标写进参数里（路径 / 文件名），并先用 \`ask_user_question\` 向用户确认后再重试。`;
}

/**
 * 系统提示正文：把「该问 / 不该问 / 怎么问」写成判断标准。
 *
 * 措辞刻意区分「必须问」与「不该问」两类 —— 只写「要主动提问」会让模型在查一个
 * 文件路径时也停下来问，那同样不是用户想要的结果。
 *
 * @returns 系统提示 section 正文。
 */
function sectionText() {
  return `# 先问后干（ask-first）

本环境安装了 \`ask-first\` 插件。它要求你在**替用户做决定之前先问一句**，而不是自己挑一个默认值、做完再解释。

## 出现下面任何一条，先用 \`ask_user_question\` 确认，再动手
- 需求有不止一种都说得通的解读：做 A 还是 B、给谁用、交付成什么格式、做到什么程度。
- 要做**不可逆或有外部副作用**的事：删除或覆盖文件、改配置或系统状态、安装或卸载插件、提交/推送/发布、对外发消息、花钱、调用有代价的接口。
- 方案取舍会影响结果或成本：快而糙 vs 慢而稳、全量 vs 局部、自研 vs 复用现成、现在做 vs 以后做。
- 缺少只有用户知道的信息：验收标准、目标产物、账号或权限、业务规则、时间与预算约束。
- 用户只给了开放要求（"帮我弄一下""优化一下""看着办"）：先用 2~4 个选项把范围问清楚，再动手。
- 你将代表用户做出会长期留存的决定：命名、目录结构、依赖选型、文案口径、接口契约。

## 不要问的（问了只会打断用户）
- 能从代码、文档、git 历史、运行结果里直接查到的事实 —— 自己查。
- 用户已经明确授权过的范围（"按这个方案实现""全部改掉""你决定"）。
- 纯机械、可回退、没有分支的既定步骤：读文件、跑测试、按已确认的方案落地。
- 只为确认"我可以开始了吗"的礼节性问题。

## 提问怎么写
- 用 \`ask_user_question\` 一次把相关问题一起问（questions 数组合并成一次调用），不要一问一答来回确认。
- 每题给 2~4 个选项，推荐项放第一个并在 label 末尾加 "(Recommended)"，description 写清代价与影响。
- 需要自由回答就不给 options；允许多选就 multi_select: true。
- 问题要自包含：用用户能懂的话，不出现内部代号、缩写或背景猜测。

## 硬性要求
- 不允许用"我假设……""默认按……处理""为了省事先……"跳过上面的确认。
- 如果你已经决定了一个假设，动手前把它变成问题问出来；用户回"你决定"之后才可自行选择。
- 不可逆操作先说明影响范围与回滚办法，等用户确认。`;
}

/**
 * 触发提醒时的消息正文。
 *
 * @param count - 本回合累计的变更性操作次数。
 * @param toolName - 刚刚执行的工具名（让模型知道是哪一次触发）。
 * @param reminderIndex - 本回合第几次提醒（1 起）；第二次之后语气更直接。
 * @returns 面向模型的提醒正文。
 */
function reminderText(count, toolName, reminderIndex) {
  const head =
    reminderIndex <= 1
      ? `⚠ ask-first 提醒：本回合你已经连续做了 ${count} 次变更性操作（最近一次：\`${toolName}\`），却还没有向用户确认过任何一次。`
      : `⚠ ask-first 提醒（本回合第 ${reminderIndex} 次）：你已经做了 ${count} 次变更性操作（最近一次：\`${toolName}\`），仍然一次都没有向用户确认。`;
  return `${head}

如果目标、范围或取舍仍有不确定，请**现在**调用 \`ask_user_question\` 问清楚再继续；如果你已经拿到用户对本方案与范围的明确授权，可以忽略这条提醒直接往下做。`;
}

/**
 * 下一次提醒的计数点：threshold → 2× → 4× → 8× …（递进，不是每 N 次都刷）。
 *
 * @param triggeredAt - 本次触发时的计数。
 * @param threshold - 当前阈值。
 * @returns 下一次触发提醒的计数点（不设上限时可能很大，调用方按上限收口）。
 */
function nextReminderAt(triggeredAt, threshold) {
  const base = threshold < 1 ? 1 : threshold;
  return Math.max(base, triggeredAt) * 2;
}

/**
 * 深冻结一个值（消息进入会话前必须不可变，与内核 `freezeMessage` 的做法一致）。
 *
 * @param value - 任意值。
 * @returns 同一个值，已冻结。
 */
function deepFreeze(value) {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const key of Object.keys(value)) {
      deepFreeze(value[key]);
    }
  }
  return value;
}

/**
 * 生成一条注入到工具结果之后的 notice 消息。
 *
 * 形状与内核 `@deepseek-ai/dsh-repeat-tool-reminder` 注入的提醒完全一致：
 * user 角色 + 单一 text 块 + 带 producer `source.kind`（未标注的上下文会被
 * 渲染成用户消息，所以 `kind` 是必填语义）；发布前 deep-freeze，与消息层的不变式对齐。
 *
 * @param text - 提醒正文。
 * @param summary - 客户端展示用的一行摘要。
 * @returns 冻结后的消息对象。
 */
function createNotice(text, summary) {
  return deepFreeze(
    structuredClone({
      id: newMessageId(),
      role: 'user',
      content: [{ type: 'text', text }],
      source: { kind: REMINDER_KIND, form: 'notice', summary }
    })
  );
}

/** 生成消息 id；WebCrypto 不可用时退化为时间戳 + 随机串（不影响语义）。 */
function newMessageId() {
  try {
    const value = globalThis.crypto?.randomUUID?.();
    if (typeof value === 'string' && value.length > 0) {
      return value;
    }
  } catch {
    /* fall through */
  }
  return `ask-first-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

/** 从工具参数里取一个字符串字段（参数可能是任意 JSON）。 */
function stringArg(args, key) {
  if (args === null || typeof args !== 'object') {
    return '';
  }
  const value = args[key];
  return typeof value === 'string' ? value : '';
}

/** 任意值转成可搜索的字符串（只用于启发式判断，不参与任何输出）。 */
function searchable(value) {
  if (typeof value === 'string') {
    return value;
  }
  try {
    return JSON.stringify(value) ?? '';
  } catch {
    return '';
  }
}

/**
 * 判断一次工具调用是否属于「变更性操作」。
 *
 * 分三类：结构性变更工具（白名单直接算）、shell 通道（看命令特征）、python 通道
 * （看代码特征）。启发式宁可漏判也不误伤 —— 漏判的代价是少提醒一次，误伤的代价
 * 是模型在只读查询后也被打断。
 *
 * @param exec - 工具执行对象（含 name / arguments）。
 * @param mutating - 当前生效的白名单集合。
 * @returns 是否计入变更性操作。
 */
function isMutating(exec, mutating) {
  const toolName = typeof exec?.name === 'string' ? exec.name : '';
  if (toolName.length === 0) {
    return false;
  }
  if (mutating.has(toolName)) {
    return true;
  }
  const args = exec?.arguments;
  if (SHELL_TOOLS.has(toolName)) {
    const text = `${stringArg(args, 'command')}\n${stringArg(args, 'text')}`;
    return SHELL_MUTATION_HINTS.some((pattern) => pattern.test(text));
  }
  if (PYTHON_TOOLS.has(toolName)) {
    const text = `${stringArg(args, 'code')}\n${searchable(args?.file)}`;
    return PYTHON_MUTATION_HINTS.some((pattern) => pattern.test(text));
  }
  return false;
}

/**
 * 插件配置 schema —— 同时是设置页（client 半部）表单字段的来源。
 *
 * 七个字段都声明 `volatile()`：设置页保存时通过 volatile 引用原地更新运行中的
 * 实例，下一轮立即生效。
 *
 * @property enabled - 总开关。
 * @property alwaysRemind - 每个模型请求前是否都注入一条常驻提醒。
 * @property threshold - 连续多少次变更性操作没有提问后提醒，默认 3。
 * @property askTool - 被视为「已经问过」的工具名，默认 ask_user_question。
 * @property mutatingTools - 计入「变更性操作」的工具名列表。
 * @property hardGate - 硬闸开关。
 * @property irreversibleTools - 被硬闸拦截的工具名列表。
 */
export const Config = z.object({
  enabled: z
    .boolean()
    .default(true)
    .description('总开关：关闭后不再注入提问纪律，也不再发「该问没问」的提醒')
    .volatile(),
  alwaysRemind: z
    .boolean()
    .default(true)
    .description('常驻提醒：每个模型请求前都注入一条简短的提问纪律提醒（固定文本，不破坏 prompt 缓存）')
    .volatile(),
  standingReminder: z
    .string()
    .default(DEFAULT_STANDING_REMINDER)
    .description('常驻提醒的正文（留空 = 用内置默认；改完下一轮生效，不用重启）')
    .volatile(),
  threshold: z
    .number()
    .default(3)
    .description('连续多少次变更性操作没有向用户提问后发一次提醒（默认 3，最小 1）')
    .volatile(),
  askTool: z
    .string()
    .default(DEFAULT_ASK_TOOL)
    .description('被视为「已经向用户提问」的工具名')
    .volatile(),
  mutatingTools: z
    .array(z.string())
    .default([...DEFAULT_MUTATING_TOOLS])
    .description('计入「变更性操作」的工具名（不含 bash/python —— 它们按参数启发式判断）')
    .volatile(),
  hardGate: z
    .boolean()
    .default(true)
    .description('硬闸：不可逆操作在本回合没问过用户时直接拒绝执行（关掉就只剩提醒）')
    .volatile(),
  irreversibleTools: z
    .array(z.string())
    .default([...DEFAULT_IRREVERSIBLE_TOOLS])
    .description('被硬闸拦截的工具名（默认 remove / move / publish；bash 与 python 额外按命令特征判断）')
    .volatile(),
  selfCreatedExempt: z
    .boolean()
    .default(true)
    .description('自建对象免授权：本会话 write 创建过的文件，删除/移动时不再要求先问')
    .volatile(),
  respectSandboxMode: z
    .boolean()
    .default(true)
    .description('按 sandbox 模式让位：只读模式下变更本来就不可能执行，硬闸与提醒静默')
    .volatile()
});

/**
 * 插件入口。
 *
 * @param ctx - Host 插件上下文。
 * @param config - schema 解析后的配置；volatile 字段是活引用，读取一律走 {@link readLive}。
 */
export function apply(ctx, config) {
  // 提示词层：一条常驻 section（完整规则）+ 一条常驻 context（每个请求都重申）。
  // 两者的 text 都是函数：每次提示词装配时重新读取 live 配置，设置页改动立即反映。
  ctx.inject(['systemPrompt'], (promptCtx) => {
    try {
      promptCtx.systemPrompt.section({
        name: SECTION_NAME,
        order: 120,
        text: () => (liveEnabled(config) ? sectionText() : '')
      });
    } catch (error) {
      warn(ctx, 'ask-first: 注册系统提示 section 失败', error);
    }
    // 常驻提醒：runtime context 每一步都会重算并渲染在快照里，所以它总是出现在
    // 模型注意力的最近位置——长会话里 system prompt 前段的纪律会衰减，这条不会。
    try {
      promptCtx.systemPrompt.context({
        name: STANDING_REMINDER_NAME,
        order: 130,
        text: () => (liveEnabled(config) && liveAlwaysRemind(config) ? standingReminderText(config) : '')
      });
    } catch (error) {
      warn(ctx, 'ask-first: 注册常驻提醒 context 失败', error);
    }
  });

  // 提醒层：按 agent 记录「连续变更但没提问」的链。
  // 用 WeakMap 而不是 Map —— agent 销毁后状态自然消失，不需要额外清理。
  const chains = new WeakMap();

  /** 本回合是否已经调用过提问工具（硬闸的放行条件之一）。 */
  const askedThisTurn = new WeakMap();

  /** 本回合用户消息的正文（用于判断用户有没有点名不可逆操作的目标）。 */
  const lastUserText = new WeakMap();

  /** 本会话由 `write` 创建过的路径（清理自己的临时产物时免授权）。 */
  const selfCreated = new WeakMap();

  /**
   * 观察一次工具执行，必要时返回要注入的提醒消息。
   *
   * 计数放在 post-execute 而不是 guard：守卫是**单调拒绝**语义，不该被用来计账；
   * 而 post-execute 能看到包括被拦截调用在内的全部尝试。
   *
   * @param exec - 工具执行对象。
   * @returns 要注入的提醒消息，或 `undefined`。
   */
  function observe(exec) {
    if (!exec || typeof exec !== 'object' || !exec.agent) {
      return undefined;
    }
    if (!liveEnabled(config)) {
      return undefined;
    }
    // 只读沙箱下变更不会真的发生：计数没有意义，提醒也让位。
    if (sandboxMakesMutationImpossible(ctx, config, exec.agent)) {
      return undefined;
    }
    const toolName = typeof exec.name === 'string' ? exec.name : '';
    if (toolName.length === 0) {
      return undefined;
    }
    // 已经问过用户 —— 这条链到此为止；同时记下这次提问的正文，硬闸靠它判断
    // 「问的是不是这件事」（授权只对请求的那个动作有效）。
    if (toolName === liveAskTool(config)) {
      chains.delete(exec.agent);
      askedThisTurn.set(exec.agent, askedText(exec));
      return undefined;
    }
    if (!isMutating(exec, liveMutatingTools(config))) {
      return undefined;
    }
    const previous = chains.get(exec.agent);
    const count = (typeof previous?.count === 'number' ? previous.count : 0) + 1;
    const threshold = liveThreshold(config);
    const nextAt = typeof previous?.nextAt === 'number' ? previous.nextAt : threshold;
    const reminders = typeof previous?.reminders === 'number' ? previous.reminders : 0;
    // 还没到下一个提醒点 —— 只记数。
    if (count < nextAt) {
      chains.set(exec.agent, { count, nextAt, reminders });
      return undefined;
    }
    // 递进提醒：threshold → 2× → 4× → 8×；一条链最多 4 次，之后不再打扰模型
    // （它已经读过两三轮同样的提醒还选择继续，再刷只会浪费上下文）。
    if (reminders >= MAX_REMINDERS_PER_CHAIN) {
      chains.set(exec.agent, { count, nextAt: Number.POSITIVE_INFINITY, reminders });
      return undefined;
    }
    const reminderIndex = reminders + 1;
    chains.set(exec.agent, {
      count,
      nextAt: nextReminderAt(count, threshold),
      reminders: reminderIndex
    });
    return createNotice(
      reminderText(count, toolName, reminderIndex),
      `${toolName} × ${count} 次变更未提问`
    );
  }

  ctx.on('tools/post-execute', async (exec, _result, next) => {
    try {
      recordSelfCreated(selfCreated, exec);
    } catch {
      /* 记录失败不影响工具结果 */
    }
    let reminder;
    try {
      reminder = observe(exec);
    } catch (error) {
      warn(ctx, 'ask-first: 统计工具调用失败', error);
      reminder = undefined;
    }
    const downstream = await next();
    if (!reminder) {
      return downstream;
    }
    try {
      const existing = Array.isArray(downstream?.additionalContexts)
        ? downstream.additionalContexts
        : [];
      return { ...downstream, additionalContexts: [reminder, ...existing] };
    } catch {
      return downstream;
    }
  });

  // 用户发来新消息 = 新的一轮：链条清零、本回合的提问确认作废、记下这条消息的正文
  // （正文用于判断用户有没有点名接下来不可逆操作的目标）。判定与 repeat-tool-reminder 同源。
  ctx.on('agent/pre-step', (payload, next) => {
    try {
      const agent = payload?.agent;
      const messages = payload?.messages;
      if (agent && Array.isArray(messages)) {
        const userMessages = messages.filter((message) => message?.source?.kind === 'user');
        if (userMessages.length > 0) {
          chains.delete(agent);
          askedThisTurn.delete(agent);
          const text = messageText(userMessages[userMessages.length - 1]);
          if (text.length > 0) {
            lastUserText.set(agent, text);
          } else {
            lastUserText.delete(agent);
          }
        }
      }
    } catch {
      /* 统计失败不该影响这一步 */
    }
    return next();
  });

  // 硬闸：不可逆操作在本回合没问过用户时，直接拒绝这一次调用（不执行）。
  //
  // 守卫是**同步**的（返回字符串即拒绝），所以这里不能自己弹提问卡片；拒绝文案让模型
  // 去调 `ask_user_question`，用户同意后模型重试，守卫看到 askedThisTurn 就放行。
  // 只约束「根代理」：子代理的调用由委派它的父代理负责确认，否则团队任务会被卡死。
  ctx.inject(['tools'], (toolsCtx) => {
    try {
      if (typeof toolsCtx.tools?.guard !== 'function') {
        warn(ctx, 'ask-first: tools.guard() 不可用，硬闸不会生效（仅提示词与提醒生效）');
        return;
      }
      toolsCtx.tools.guard((exec) => {
        try {
          if (!liveEnabled(config) || !liveHardGate(config)) {
            return undefined;
          }
          const irreversible = liveIrreversibleTools(config);
          if (!isIrreversible(exec, irreversible)) {
            return undefined;
          }
          const agent = exec?.agent;
          if (!agent) {
            return undefined;
          }
          // 只读沙箱下变更本来就会被文件系统拒绝：硬闸静默，避免同一个失败说两遍。
          if (sandboxMakesMutationImpossible(ctx, config, agent)) {
            return undefined;
          }
          // 子代理的调用由委派它的父代理负责确认；硬闸只约束会跟用户对话的根代理。
          const agents = typeof ctx.get === 'function' ? ctx.get('agents') : undefined;
          if (agents && typeof agents.roots === 'function') {
            const roots = agents.roots();
            if (Array.isArray(roots) && !roots.includes(agent)) {
              return undefined;
            }
          }
          const toolName = typeof exec?.name === 'string' ? exec.name : '';

          // ① 本会话自己创建的对象：清理自己的临时产物不需要再问
          //    （照抄 auto-review 的 low 规则）。只认 write 写过的、路径完全相等的文件。
          if (liveSelfCreatedExempt(config) && isSelfCreated(selfCreated.get(agent), exec)) {
            return undefined;
          }

          const targets = collectTargets(exec.arguments);

          // ② UNKNOWN 即确认：名单内的工具读不出目标时，无法确认授权范围 → 拦。
          //    OpenHands 的原则：「不知道」不等于「安全」。
          if (irreversible.has(toolName) && targets.size === 0) {
            return unknownTargetText(exec);
          }

          // ③ 授权只对请求的那个动作有效：本回合的提问正文必须点到这次的目标，
          //    而不是「随便问了一个问题」就解锁全部。
          if (askedCoversTargets(askedThisTurn.get(agent), targets)) {
            return undefined;
          }

          // ④ 用户这条消息里点名了目标（「删掉 a.txt」不必再问一遍）。
          if (authorizedByUserText(exec, lastUserText.get(agent))) {
            return undefined;
          }

          return denialText(exec);
        } catch {
          // 守卫自身出问题时放行：插件的问题绝不该把工具链卡死。
          return undefined;
        }
      });
    } catch (error) {
      warn(ctx, 'ask-first: 注册工具守卫失败，硬闸不会生效', error);
    }
  });
}

/**
 * 尽力而为的告警：logger 服务可缺失，缺失时静默（本插件的问题不该变成会话噪音）。
 *
 * @param ctx - 插件上下文。
 * @param message - 告警文案。
 * @param error - 原始错误。
 */
function warn(ctx, message, error) {
  try {
    const logger = typeof ctx.get === 'function' ? ctx.get('logger') : undefined;
    logger?.warn?.(`${message}: %o`, error);
  } catch {
    /* ignore */
  }
}

/** 导出给自检脚本 / 其它插件使用：默认值、判定函数与渲染函数。 */
export {
  askedCoversTargets,
  askedText,
  authorizedByUserText,
  collectTargets,
  DANGER_PATTERNS,
  DEFAULT_ASK_TOOL,
  DEFAULT_IRREVERSIBLE_TOOLS,
  DEFAULT_MUTATING_TOOLS,
  denialText,
  explicitTargets,
  isIrreversible,
  isMutating,
  isSelfCreated,
  liveAlwaysRemind,
  liveAskTool,
  liveEnabled,
  liveHardGate,
  liveIrreversibleTools,
  liveMutatingTools,
  liveRespectSandboxMode,
  liveSelfCreatedExempt,
  liveThreshold,
  messageText,
  PYTHON_MUTATION_HINTS,
  readLive,
  recordSelfCreated,
  reminderText,
  sandboxMakesMutationImpossible,
  sandboxModeOf,
  sectionText,
  SHELL_MUTATION_HINTS,
  STANDING_REMINDER_NAME,
  standingReminderText,
  unknownTargetText
};
