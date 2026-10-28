/**
 * dsh-ask-first — 浏览器半部：设置里的一页「先问后干」。
 *
 * ── 为什么需要这一半 ──────────────────────────────────────────────────────
 * host 半部导出的 volatile `Config` 会被 settings 服务投影成表单，但 DSH 的
 * 「设置 → 插件」页只渲染**官方插件**的 companion 页面；第三方 bundle 的配置页
 * 必须由本包自己的浏览器 bundle 注册到 slot 上。所以这里注册一个
 * `settings.section`（设置侧栏的独立一页），直接读写 `ask-first` 命名空间。
 *
 * ── 数据通道 ──────────────────────────────────────────────────────────────
 * 全部走平台公开面，不碰宿主：
 *   · `ctx.configForms.get("ask-first")` → 该命名空间的表单 scope；
 *   · `scope.getSnapshot()` / `scope.subscribe(cb)` → 读取实时值（结构见 host
 *     半部 `Config`：{ enabled, threshold, askTool, mutatingTools, hardGate,
 *     irreversibleTools }）；
 *   · `scope.set(field, value)` / `scope.unset(field)` → 写入 profile 行并
 *     **热更新**运行中的 host 插件实例（volatile 字段，无需重启）。
 *
 * ── 防御性设计 ────────────────────────────────────────────────────────────
 * 平台模块（react）是 optional：本 bundle 手写、无构建步骤，缺 React 时退化为
 * inert 元素描述，绝不因一个 require 失败把整个设置面板拖垮。渲染/写入路径也包了
 * try/catch，失败只在本页显示一行错误。
 *
 * @module dsh-ask-first/client
 */
window.__ModuleLoader__.load({
  id: "dsh-ask-first",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

    /** 取第一个能解析的平台模块；全失败时返回 undefined（降级而非抛错）。 */
    function optionalRequire(...specifiers) {
      for (const specifier of specifiers) {
        try {
          const resolved = require(specifier);
          if (resolved !== undefined && resolved !== null) return resolved;
        } catch {}
      }
      return undefined;
    }

    const platformReact = optionalRequire("react");

    /** 构造一个元素：优先平台 React，缺 React 时退化为可被 slot 渲染器接受的描述。 */
    function element(type, props, ...children) {
      if (platformReact !== undefined && typeof platformReact.createElement === "function") {
        return platformReact.createElement(type, props, ...children);
      }
      return { type, props: { ...(props ?? {}), children: children.length > 1 ? children : children[0] } };
    }

    /** 平台 hooks；缺 React 时给 inert 实现，让模块求值永不出错。 */
    const useState =
      platformReact !== undefined && typeof platformReact.useState === "function"
        ? platformReact.useState
        : (initial) => [typeof initial === "function" ? initial() : initial, () => {}];
    const useEffect =
      platformReact !== undefined && typeof platformReact.useEffect === "function" ? platformReact.useEffect : () => {};

    /** 本插件在 settings 服务里注册的命名空间（= loader 行 id）。 */
    const SETTINGS_NS = "ask-first";

    /** 与 host 半部保持一致的默认值（只作展示与「恢复默认」的兜底）。 */
    const DEFAULTS = {
      enabled: true,
      alwaysRemind: true,
      /** 空串 = 用 host 半部的内置默认文本（不在这里复制一份，避免两边漂移）。 */
      standingReminder: "",
      selfCreatedExempt: true,
      respectSandboxMode: true,
      hardGate: true,
      threshold: 3,
      askTool: "ask_user_question",
      mutatingTools: [
        "write",
        "edit",
        "remove",
        "move",
        "publish",
        "spawn_teammate",
        "interrupt_agent",
        "subagent",
        "subagent_fork",
        "team_task_create",
        "team_task_update",
        "schedule_create",
        "schedule_update",
        "schedule_delete",
        "create_worktree",
        "create_goal",
        "update_goal",
        "terminal_send",
        "terminal_close",
        "terminal_signal"
      ],
      irreversibleTools: ["remove", "move", "publish"]
    };

    /** 从表单快照里安全取出完整配置。 */
    function readForm(snapshot) {
      const value = snapshot !== null && typeof snapshot === "object" ? snapshot.value : undefined;
      const object = value !== null && typeof value === "object" && !Array.isArray(value) ? value : {};
      const threshold =
        typeof object.threshold === "number" && Number.isFinite(object.threshold)
          ? Math.max(1, Math.floor(object.threshold))
          : DEFAULTS.threshold;
      const askTool =
        typeof object.askTool === "string" && object.askTool.trim().length > 0
          ? object.askTool.trim()
          : DEFAULTS.askTool;
      const mutatingTools = Array.isArray(object.mutatingTools)
        ? object.mutatingTools.filter((item) => typeof item === "string")
        : DEFAULTS.mutatingTools.slice();
      const irreversibleTools = Array.isArray(object.irreversibleTools)
        ? object.irreversibleTools.filter((item) => typeof item === "string")
        : DEFAULTS.irreversibleTools.slice();
      return {
        enabled: object.enabled !== false,
        alwaysRemind: object.alwaysRemind !== false,
        standingReminder: typeof object.standingReminder === "string" ? object.standingReminder : "",
        selfCreatedExempt: object.selfCreatedExempt !== false,
        respectSandboxMode: object.respectSandboxMode !== false,
        hardGate: object.hardGate !== false,
        threshold,
        askTool,
        mutatingTools: mutatingTools.length > 0 ? mutatingTools : DEFAULTS.mutatingTools.slice(),
        irreversibleTools: irreversibleTools.length > 0 ? irreversibleTools : DEFAULTS.irreversibleTools.slice()
      };
    }

    /** 把文本输入解析成工具名数组：逗号 / 顿号 / 空白 / 换行都算分隔符。 */
    function parseList(text) {
      return String(text ?? "")
        .split(/[\s,，、;；]+/u)
        .map((item) => item.trim())
        .filter((item) => item.length > 0);
    }

    /** 把数组渲染进编辑框。 */
    function joinList(list) {
      return Array.isArray(list) ? list.join(", ") : "";
    }

    /** 页面样式（内联，避免额外 CSS 资源；颜色走平台设计令牌并带回退）。 */
    const styles = {
      page: { maxWidth: "760px", paddingTop: "20px", display: "flex", flexDirection: "column", gap: "18px" },
      header: { display: "flex", flexDirection: "column", gap: "4px" },
      title: {
        fontSize: "14px",
        fontWeight: 500,
        lineHeight: "22px",
        color: "var(--dsw-alias-label-primary, inherit)"
      },
      hint: { fontSize: "12px", lineHeight: "18px", color: "var(--dsw-alias-label-tertiary, #888)" },
      card: {
        display: "flex",
        flexDirection: "column",
        gap: "10px",
        padding: "12px 14px",
        border: "0.5px solid var(--dsw-alias-border-l3, #ddd)",
        borderRadius: "8px",
        background: "var(--dsw-alias-bg-layer-1, transparent)"
      },
      cardTitle: {
        fontSize: "13px",
        fontWeight: 500,
        lineHeight: "20px",
        color: "var(--dsw-alias-label-primary, inherit)"
      },
      row: {
        display: "flex",
        alignItems: "center",
        gap: "10px",
        fontSize: "13px",
        color: "var(--dsw-alias-label-primary, inherit)"
      },
      block: { display: "flex", flexDirection: "column", gap: "6px" },
      input: {
        width: "100%",
        boxSizing: "border-box",
        padding: "6px 10px",
        fontSize: "13px",
        lineHeight: "20px",
        color: "var(--dsw-alias-label-primary, inherit)",
        background: "var(--dsw-alias-bg-layer-1, transparent)",
        border: "0.5px solid var(--dsw-alias-border-l3, #ccc)",
        borderRadius: "6px"
      },
      number: {
        width: "88px",
        boxSizing: "border-box",
        padding: "6px 10px",
        fontSize: "13px",
        lineHeight: "20px",
        color: "var(--dsw-alias-label-primary, inherit)",
        background: "var(--dsw-alias-bg-layer-1, transparent)",
        border: "0.5px solid var(--dsw-alias-border-l3, #ccc)",
        borderRadius: "6px"
      },
      textarea: {
        width: "100%",
        boxSizing: "border-box",
        minHeight: "72px",
        padding: "8px 10px",
        fontSize: "13px",
        lineHeight: "20px",
        fontFamily: "var(--ds-font-family-code, monospace)",
        color: "var(--dsw-alias-label-primary, inherit)",
        background: "var(--dsw-alias-bg-layer-1, transparent)",
        border: "0.5px solid var(--dsw-alias-border-l3, #ccc)",
        borderRadius: "6px",
        resize: "vertical"
      },
      actions: { display: "flex", alignItems: "center", gap: "10px", flexWrap: "wrap" },
      button: {
        cursor: "pointer",
        font: "inherit",
        fontSize: "13px",
        lineHeight: "20px",
        padding: "6px 14px",
        borderRadius: "6px",
        border: "0.5px solid var(--dsw-alias-border-l3, #ccc)",
        background: "var(--dsw-alias-bg-module-platform, transparent)",
        color: "var(--dsw-alias-label-primary, inherit)"
      },
      primary: {
        cursor: "pointer",
        font: "inherit",
        fontSize: "13px",
        lineHeight: "20px",
        padding: "6px 14px",
        borderRadius: "6px",
        border: "none",
        background: "var(--dsw-alias-state-business-primary, #4d6bfe)",
        color: "#fff"
      },
      notice: { fontSize: "12px", lineHeight: "18px", color: "var(--dsw-alias-label-tertiary, #888)" },
      error: { fontSize: "12px", lineHeight: "18px", color: "var(--dsw-alias-state-error-primary, #d33)" }
    };

    /**
     * 设置页本体：两个开关 + 阈值 + 两个工具名清单。
     *
     * @param props - slot 注入的面（`form`）与平台提供的公共面（可能含 `t`）。
     * @returns 页面元素树。
     */
    function AskFirstSection(props) {
      const form = props.form;
      let snapshot;
      let readError;
      try {
        snapshot = form !== undefined && typeof form.getSnapshot === "function" ? form.getSnapshot() : undefined;
      } catch (error) {
        readError = error instanceof Error ? error.message : String(error);
      }
      const [state, setState] = useState(() => snapshot);
      const current = readForm(state);
      const [draft, setDraft] = useState(() => ({
        threshold: String(current.threshold),
        askTool: current.askTool,
        standingReminder: current.standingReminder,
        mutatingTools: joinList(current.mutatingTools),
        irreversibleTools: joinList(current.irreversibleTools)
      }));
      const [notice, setNotice] = useState(null);
      const [failure, setFailure] = useState(readError ?? null);

      // 订阅 host 侧变化：设置被别处改动（或写入回执）时刷新表单。
      useEffect(() => {
        if (form === undefined || typeof form.subscribe !== "function") return undefined;
        const off = form.subscribe(() => {
          try {
            setState(form.getSnapshot());
          } catch {
            /* 读取失败时保留上一份快照 */
          }
        });
        return typeof off === "function" ? off : undefined;
      }, [form]);

      /** 执行一次写入，并把结果（成功/失败）显示在页面底部。 */
      const write = (action, okMessage) => {
        setFailure(null);
        setNotice(null);
        Promise.resolve()
          .then(() => action())
          .then(
            () => setNotice(okMessage),
            (error) => setFailure(`保存失败：${error instanceof Error ? error.message : String(error)}`)
          );
      };

      const toggleEnabled = (next) => {
        write(() => form.set("enabled", next), next ? "已启用（立即生效）" : "已停用插件：提示词、提醒、硬闸全部停止（立即生效）");
      };

      const toggleHardGate = (next) => {
        write(() => form.set("hardGate", next), next ? "硬闸已开启：不可逆操作必须先问（立即生效）" : "硬闸已关闭：只剩提示词与提醒（立即生效）");
      };

      const toggleSelfCreatedExempt = (next) => {
        write(() => form.set("selfCreatedExempt", next), next ? "已开启自建对象免授权：清理本会话自己写的文件不用先问（立即生效）" : "已关闭自建对象免授权：连自己的临时文件也要先问（立即生效）");
      };

      const toggleRespectSandboxMode = (next) => {
        write(() => form.set("respectSandboxMode", next), next ? "已开启沙箱让位：只读模式下硬闸与提醒静默（立即生效）" : "已关闭沙箱让位：只读模式下也照样拦（立即生效）");
      };

      const toggleAlwaysRemind = (next) => {
        write(() => form.set("alwaysRemind", next), next ? "已开启常驻提醒：每个请求都会带一条纪律提醒（立即生效）" : "已关闭常驻提醒：只在连续变更未提问时提醒（立即生效）");
      };

      const save = () => {
        const threshold = Math.max(1, Math.floor(Number(draft.threshold) || DEFAULTS.threshold));
        const askTool = draft.askTool.trim();
        const mutatingTools = parseList(draft.mutatingTools);
        const irreversibleTools = parseList(draft.irreversibleTools);
        const standingReminder = draft.standingReminder.trim();
        write(async () => {
          await form.set("threshold", threshold);
          if (standingReminder.length > 0) {
            await form.set("standingReminder", standingReminder);
          } else if (typeof form.unset === "function") {
            await form.unset("standingReminder");
          } else {
            await form.set("standingReminder", DEFAULTS.standingReminder);
          }
          await form.set("askTool", askTool.length > 0 ? askTool : DEFAULTS.askTool);
          await form.set("mutatingTools", mutatingTools.length > 0 ? mutatingTools : DEFAULTS.mutatingTools.slice());
          await form.set(
            "irreversibleTools",
            irreversibleTools.length > 0 ? irreversibleTools : DEFAULTS.irreversibleTools.slice()
          );
        }, "已保存（立即生效）");
      };

      const reset = () => {
        write(async () => {
          const unset = typeof form.unset === "function";
          for (const field of ["enabled", "alwaysRemind", "hardGate", "selfCreatedExempt", "respectSandboxMode", "threshold", "askTool", "standingReminder", "mutatingTools", "irreversibleTools"]) {
            if (unset) {
              await form.unset(field);
            } else if (field === "enabled" || field === "alwaysRemind" || field === "hardGate" || field === "selfCreatedExempt" || field === "respectSandboxMode") {
              await form.set(field, true);
            } else if (field === "threshold") {
              await form.set(field, DEFAULTS.threshold);
            } else if (field === "askTool") {
              await form.set(field, DEFAULTS.askTool);
            } else if (field === "standingReminder") {
              await form.set(field, DEFAULTS.standingReminder);
            } else if (field === "mutatingTools") {
              await form.set(field, DEFAULTS.mutatingTools.slice());
            } else {
              await form.set(field, DEFAULTS.irreversibleTools.slice());
            }
          }
        }, "已恢复默认配置（立即生效）");
      };

      if (form === undefined) {
        return element(
          "div",
          { style: styles.page },
          element("div", { style: styles.error }, "ask-first: 设置表单不可用（Host 未提供 ask-first 命名空间）")
        );
      }

      return element(
        "div",
        { style: styles.page },
        element(
          "div",
          { style: styles.header },
          element("div", { style: styles.title }, "先问后干（ask-first）"),
          element(
            "div",
            { style: styles.hint },
            "让 Agent 在替你做决定之前先问一句。三层机制：① 提示词纪律段（每次请求都带）② 连续变更未提问时的提醒 ③ 不可逆操作的硬闸。所有改动保存后立即生效，无需重启。"
          )
        ),

        // ① 总开关
        element(
          "div",
          { style: styles.card },
          element(
            "label",
            { style: styles.row },
            element("input", {
              type: "checkbox",
              checked: current.enabled,
              onChange: (event) => toggleEnabled(event.target.checked !== false)
            }),
            element("span", null, current.enabled ? "插件已启用" : "插件已停用（三层全部停止）")
          ),
          element(
            "div",
            { style: styles.hint },
            "关闭总开关只会让本插件停止工作，不会影响内核自带的 ask_user_question 工具本身。"
          )
        ),

        // ② 常驻提醒
        element(
          "div",
          { style: styles.card },
          element(
            "label",
            { style: styles.row },
            element("input", {
              type: "checkbox",
              checked: current.alwaysRemind,
              onChange: (event) => toggleAlwaysRemind(event.target.checked !== false)
            }),
            element("span", null, current.alwaysRemind ? "常驻提醒已开启：每个请求都带一条" : "常驻提醒已关闭：只在连续变更未提问时提醒")
          ),
          element(
            "div",
            { style: styles.hint },
            "开启后，每次模型请求前都会注入一条规则提醒（runtime context，每步重算，总在注意力最近的位置）。文本固定时不破坏 prompt 缓存；代价是每轮多约 150 字。"
          ),
          element(
            "div",
            { style: styles.block },
            element("div", { style: styles.hint }, "注入的提醒正文（留空 = 用内置的强硬版默认；改完点「保存」下一轮生效）："),
            element("textarea", {
              style: styles.textarea,
              value: draft.standingReminder,
              spellCheck: false,
              placeholder: "留空则使用内置默认：ask-first 硬规则（必须遵守…）",
              onChange: (event) => setDraft({ ...draft, standingReminder: event.target.value })
            })
          )
        ),

        // ③ 硬闸
        element(
          "div",
          { style: styles.card },
          element(
            "label",
            { style: styles.row },
            element("input", {
              type: "checkbox",
              checked: current.hardGate,
              onChange: (event) => toggleHardGate(event.target.checked !== false)
            }),
            element("span", null, current.hardGate ? "硬闸已开启：不可逆操作必须先问" : "硬闸已关闭：只剩提示词与提醒")
          ),
          element(
            "div",
            { style: styles.hint },
            "开启后，本回合还没问过你、且你的消息里也没点名目标时，这些操作会被直接拒绝（不执行），Agent 必须先用 ask_user_question 问你。"
          ),
          element(
            "label",
            { style: styles.row },
            element("input", {
              type: "checkbox",
              checked: current.selfCreatedExempt,
              onChange: (event) => toggleSelfCreatedExempt(event.target.checked !== false)
            }),
            element("span", null, current.selfCreatedExempt ? "自建对象免授权：清理自己刚写的文件不用先问" : "自建对象也要先问")
          ),
          element(
            "div",
            { style: styles.hint },
            "只认本会话里由 write 创建过、且路径完全相同的文件；编辑过用户既有文件不算。关掉后连自己生成的临时产物也一律拦截。"
          ),
          element(
            "label",
            { style: styles.row },
            element("input", {
              type: "checkbox",
              checked: current.respectSandboxMode,
              onChange: (event) => toggleRespectSandboxMode(event.target.checked !== false)
            }),
            element("span", null, current.respectSandboxMode ? "按 sandbox 模式让位：只读模式下静默" : "只读模式下也照样拦")
          ),
          element(
            "div",
            { style: styles.hint },
            "只读沙箱下变更请求本来就会被文件系统拒绝，硬闸再拦一次只是把同一个失败说两遍。关掉后无论沙箱模式都会拦。"
          )
        ),

        // ③ 提醒阈值
        element(
          "div",
          { style: styles.card },
          element("div", { style: styles.cardTitle }, "提醒阈值"),
          element(
            "div",
            { style: styles.row },
            element("span", null, "连续"),
            element("input", {
              type: "number",
              min: 1,
              max: 50,
              step: 1,
              style: styles.number,
              value: draft.threshold,
              onChange: (event) => setDraft({ ...draft, threshold: event.target.value })
            }),
            element("span", null, "次变更性操作没有提问后提醒一次（之后按 2 倍递进）")
          ),
          element(
            "div",
            { style: styles.hint },
            "1 = 最积极（几乎每次动手都提醒）；3 = 默认；5 以上更安静。只读工具（read / grep / web_fetch 等）永远不计。"
          )
        ),

        // ④ 工具名清单
        element(
          "div",
          { style: styles.card },
          element("div", { style: styles.cardTitle }, "工具名单"),
          element(
            "div",
            { style: styles.block },
            element("div", { style: styles.hint }, "被视为「已经向用户提问」的工具名："),
            element("input", {
              type: "text",
              style: styles.input,
              spellCheck: false,
              value: draft.askTool,
              onChange: (event) => setDraft({ ...draft, askTool: event.target.value })
            })
          ),
          element(
            "div",
            { style: styles.block },
            element("div", { style: styles.hint }, "计入「变更性操作」的工具名（逗号或换行分隔）——不在这里的 bash / python 会按参数特征判断："),
            element("textarea", {
              style: styles.textarea,
              value: draft.mutatingTools,
              spellCheck: false,
              onChange: (event) => setDraft({ ...draft, mutatingTools: event.target.value })
            })
          ),
          element(
            "div",
            { style: styles.block },
            element("div", { style: styles.hint }, "被硬闸拦截的工具名（逗号或换行分隔；bash / python 另按命令特征判断 rm、rmtree、git reset --hard 等）："),
            element("textarea", {
              style: styles.textarea,
              value: draft.irreversibleTools,
              spellCheck: false,
              onChange: (event) => setDraft({ ...draft, irreversibleTools: event.target.value })
            })
          )
        ),

        // ⑤ 操作
        element(
          "div",
          { style: styles.actions },
          element("button", { style: styles.primary, type: "button", onClick: save }, "保存"),
          element("button", { style: styles.button, type: "button", onClick: reset }, "恢复默认"),
          notice === null ? null : element("span", { style: styles.notice }, notice),
          failure === null ? null : element("span", { style: styles.error }, failure)
        )
      );
    }

    /** 唯一硬依赖：slots（设置面板的注册面）。 */
    const inject = ["slots"];

    /** 客户端插件入口：把页面挂到设置侧栏。 */
    function apply(ctx) {
      ctx.inject(["configForms"], (pageCtx) => {
        let form;
        try {
          form = pageCtx.configForms.get(SETTINGS_NS);
        } catch (error) {
          const logger = ctx.get("logger");
          logger?.warn?.("ask-first: 无法读取设置命名空间", error);
          return;
        }
        if (form === undefined || form === null) return;
        const register = () =>
          pageCtx.effect(
            () =>
              pageCtx.configForms.whileServed([SETTINGS_NS], () =>
                pageCtx.slots.inject("settings.section", () =>
                  pageCtx.slots.register(
                    {
                      name: "settings.section",
                      id: "ask-first",
                      order: 27,
                      label: () => "先问后干",
                      inject: () => ({ form })
                    },
                    AskFirstSection
                  )
                )
              ),
            "ask-first: settings page"
          );
        try {
          if (typeof pageCtx.configForms.whileServed === "function") {
            register();
          } else {
            pageCtx.slots.inject("settings.section", () =>
              pageCtx.slots.register(
                {
                  name: "settings.section",
                  id: "ask-first",
                  order: 27,
                  label: () => "先问后干",
                  inject: () => ({ form })
                },
                AskFirstSection
              )
            );
          }
        } catch (error) {
          const logger = ctx.get("logger");
          logger?.warn?.("ask-first: 设置页注册失败", error);
        }
      });
    }

    exports.apply = apply;
    exports.inject = inject;
    return module.exports;
  }
});
