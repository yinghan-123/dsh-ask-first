#!/usr/bin/env python3
"""dsh-ask-first 静态自检（无 node 环境时能做的最强检查）。

检查项：
1. package.json 是合法 JSON，关键字段齐全且路径存在；
2. cordis.patch.yml 结构符合 bundle 约定；
3. lib/index.js 的括号/字符串/注释/模板字符串/正则字面量严格平衡（自写词法扫描）；
4. 必需导出（name / inject / Config / apply）都在；
5. 文本里不含 `{{...}}`（systemPrompt 会把它当变量插值，缺变量会抛错）；
6. import 的依赖在目标 profile 的 node_modules 里存在。
"""
import json
import os
import re
import sys

PKG = 'dsh-ask-first'
WS = '/storage/Users/currentUser/Download/com.dshm.dshclient/DSH插件'
SRC = os.path.join(WS, PKG)
PROFILE = '/data/storage/el2/base/haps/entry/files/dsh/home/profiles/ondevice'

failures = []
notes = []


def fail(msg):
    failures.append(msg)


def note(msg):
    notes.append(msg)


# ── 1. package.json ─────────────────────────────────────────────────────────
pj_path = os.path.join(SRC, 'package.json')
try:
    pj = json.load(open(pj_path, encoding='utf-8'))
except Exception as exc:  # noqa: BLE001
    fail(f'package.json 不是合法 JSON: {exc}')
    pj = {}
else:
    for key in ('name', 'version', 'type', 'main', 'exports', 'dsh'):
        if key not in pj:
            fail(f'package.json 缺字段 {key}')
    if pj.get('name') != PKG:
        fail(f"package.json name 应为 {PKG}，实际 {pj.get('name')!r}")
    if pj.get('type') != 'module':
        fail('package.json type 必须是 module（纯 ESM）')
    patch_rel = pj.get('dsh', {}).get('bundle', {}).get('patch')
    if patch_rel != './cordis.patch.yml':
        fail(f'dsh.bundle.patch 应为 ./cordis.patch.yml，实际 {patch_rel!r}')
    main_rel = pj.get('main')
    if not main_rel or not os.path.isfile(os.path.join(SRC, main_rel)):
        fail(f'package.json main 指向的文件不存在: {main_rel!r}')
    exports = pj.get('exports', {})
    if '.' not in exports:
        fail('package.json exports 缺 "." 入口')
    for spec, rel in exports.items():
        if isinstance(rel, str) and not rel.startswith('./'):
            fail(f'exports[{spec!r}] 应以 ./ 开头')
        elif isinstance(rel, str) and not os.path.isfile(os.path.join(SRC, rel)):
            fail(f'exports[{spec!r}] 指向的文件不存在: {rel}')
    deps = pj.get('dependencies', {})
    for dep in deps:
        if not os.path.isdir(os.path.join(PROFILE, 'node_modules', dep)):
            fail(f'依赖 {dep} 不在 profile 的 node_modules 里')

# ── 2. cordis.patch.yml ────────────────────────────────────────────────────
patch_path = os.path.join(SRC, 'cordis.patch.yml')
try:
    patch_text = open(patch_path, encoding='utf-8').read()
except Exception as exc:  # noqa: BLE001
    fail(f'读不到 cordis.patch.yml: {exc}')
    patch_text = ''
else:
    meaningful = [ln for ln in patch_text.splitlines() if ln.strip() and not ln.lstrip().startswith('#')]
    if not meaningful or meaningful[0].strip() != '- insert:':
        fail('cordis.patch.yml 必须以 `- insert:` 开头（新增行只能用 insert）')
    joined = '\n'.join(meaningful)
    if 'id: ask-first' not in joined:
        fail('cordis.patch.yml 缺 `id: ask-first`')
    if 'name: dsh-ask-first' not in joined:
        fail('cordis.patch.yml 缺 `name: dsh-ask-first`')
    if not re.search(r'^- insert:\n\s+- id: ask-first\n\s+name: dsh-ask-first\s*$', joined.strip() + '\n'):
        fail('cordis.patch.yml 的缩进形状与 insert 约定不符')

# ── 3. JS 词法平衡扫描 ─────────────────────────────────────────────────────
JS_PATH = os.path.join(SRC, 'lib', 'index.js')
try:
    src = open(JS_PATH, encoding='utf-8').read()
except Exception as exc:  # noqa: BLE001
    fail(f'读不到 lib/index.js: {exc}')
    src = ''

# 正则字面量只可能出现在这些前导符之后（简化但覆盖本文件的用法）
REGEX_PREFIX = set('([{,;:=!&|?+-*/%<>^~')
REGEX_KEYWORDS = ('return', 'typeof', 'instanceof', 'in', 'of', 'new', 'delete', 'void', 'case', 'do', 'else', 'yield', 'await')


def scan_js(text):
    """严格检查字符串/注释/模板字符串/正则/括号平衡，返回错误列表。"""
    errors = []
    stack = []
    tpl_stack = []
    i, line, n = 0, 1, len(text)
    state = 'code'
    last_sig = ''       # 上一个有效字符（跳过空白），用于判断 / 是不是正则起点
    last_word = ''      # 上一个标识符，用于关键字判断

    while i < n:
        ch = text[i]

        if state == 'code':
            nxt = text[i + 1] if i + 1 < n else ''
            if ch == '\n':
                line += 1
                i += 1
                continue
            if ch in ' \t\r':
                i += 1
                continue
            if ch == '/' and nxt == '/':
                state = 'linecomment'
                i += 2
                continue
            if ch == '/' and nxt == '*':
                state = 'blockcomment'
                i += 2
                continue
            if ch == '/':
                starts_regex = last_sig == '' or last_sig in REGEX_PREFIX or last_word in REGEX_KEYWORDS
                if starts_regex:
                    # 扫到未转义的 /，跳过 [...] 字符类
                    j = i + 1
                    in_class = False
                    closed = False
                    while j < n:
                        c = text[j]
                        if c == '\\':
                            if j + 1 < n and text[j + 1] == '\n':
                                line += 1
                            j += 2
                            continue
                        if c == '\n':
                            break
                        if in_class:
                            if c == ']':
                                in_class = False
                        elif c == '[':
                            in_class = True
                        elif c == '/':
                            closed = True
                            break
                        j += 1
                    if not closed:
                        errors.append(f'第 {line} 行：正则字面量没有闭合')
                    i = j + 1
                    # 跳过 flags
                    while i < n and text[i].isalpha():
                        i += 1
                    last_sig = '/'
                    last_word = ''
                    continue
            if ch == "'":
                state = 'sq'
                i += 1
                continue
            if ch == '"':
                state = 'dq'
                i += 1
                continue
            if ch == '`':
                state = 'tpl'
                tpl_stack.append(line)
                i += 1
                continue
            if ch == '{':
                stack.append(('{', line))
            elif ch == '}':
                if not stack or stack[-1][0] != '{':
                    errors.append(f'第 {line} 行：多余的 }}')
                else:
                    stack.pop()
            elif ch == '(':
                stack.append(('(', line))
            elif ch == ')':
                if not stack or stack[-1][0] != '(':
                    errors.append(f'第 {line} 行：多余的 )')
                else:
                    stack.pop()
            elif ch == '[':
                stack.append(('[', line))
            elif ch == ']':
                if not stack or stack[-1][0] != '[':
                    errors.append(f'第 {line} 行：多余的 ]')
                else:
                    stack.pop()
            if ch.isalnum() or ch in '_$':
                word = ch
                j = i + 1
                while j < n and (text[j].isalnum() or text[j] in '_$'):
                    word += text[j]
                    j += 1
                last_word = word
                last_sig = word[-1]
                i = j
                continue
            last_sig = ch
            last_word = ''
            i += 1
            continue

        if state == 'linecomment':
            if ch == '\n':
                state = 'code'
                line += 1
            i += 1
            continue

        if state == 'blockcomment':
            if ch == '*' and i + 1 < n and text[i + 1] == '/':
                state = 'code'
                i += 2
                continue
            if ch == '\n':
                line += 1
            i += 1
            continue

        if state in ('sq', 'dq'):
            quote = "'" if state == 'sq' else '"'
            if ch == '\\':
                if i + 1 < n and text[i + 1] == '\n':
                    line += 1
                i += 2
                continue
            if ch == '\n':
                errors.append(f'第 {line} 行：普通字符串里出现裸换行（引号未闭合）')
                state = 'code'
                line += 1
                i += 1
                continue
            if ch == quote:
                state = 'code'
                last_sig = quote
                last_word = ''
            i += 1
            continue

        if state == 'tpl':
            if ch == '\\':
                if i + 1 < n and text[i + 1] == '\n':
                    line += 1
                i += 2
                continue
            if ch == '\n':
                line += 1
                i += 1
                continue
            if ch == '`':
                state = 'code'
                tpl_stack.pop()
                last_sig = '`'
                last_word = ''
                i += 1
                continue
            if ch == '$' and i + 1 < n and text[i + 1] == '{':
                # 内插值：递归扫描到配对的 }，尊重嵌套字符串/模板
                depth = 1
                j = i + 2
                while j < n and depth > 0:
                    c = text[j]
                    if c == '\n':
                        line += 1
                        j += 1
                        continue
                    if c in "'\"":
                        q = c
                        j += 1
                        while j < n:
                            if text[j] == '\\':
                                j += 2
                                continue
                            if text[j] == q:
                                break
                            j += 1
                    elif c == '`':
                        j += 1
                        while j < n:
                            if text[j] == '\\':
                                j += 2
                                continue
                            if text[j] == '`':
                                break
                            j += 1
                    elif c == '{':
                        depth += 1
                    elif c == '}':
                        depth -= 1
                        if depth == 0:
                            break
                    j += 1
                if depth != 0:
                    errors.append(f'第 {line} 行：模板字符串里的 ${{ 没有闭合')
                i = j + 1
                continue
            i += 1
            continue

    if state in ('sq', 'dq'):
        errors.append(f'文件结尾仍在 {state} 字符串里（引号未闭合）')
    if state == 'blockcomment':
        errors.append('文件结尾仍在块注释里（/* 未闭合）')
    if state == 'tpl':
        errors.append(f'文件结尾仍在模板字符串里（从第 {tpl_stack[-1] if tpl_stack else "?"} 行开始）')
    for ch, ln in stack:
        errors.append(f'第 {ln} 行：{ch} 没有闭合')
    return errors


def strip_comments(text):
    """把 // 与 /* */ 注释替换成空白（保留换行），用于「代码里有没有 X」这类检查。"""
    out = []
    i, n = 0, len(text)
    state = 'code'
    while i < n:
        ch = text[i]
        if state == 'code':
            if ch == '/' and i + 1 < n and text[i + 1] == '/':
                state = 'line'
                out.append(' ')
                i += 2
                continue
            if ch == '/' and i + 1 < n and text[i + 1] == '*':
                state = 'block'
                out.append(' ')
                i += 2
                continue
            if ch in "'\"`":
                state = ch
            out.append(ch)
            i += 1
            continue
        if state == 'line':
            if ch == '\n':
                state = 'code'
                out.append('\n')
            else:
                out.append(' ')
            i += 1
            continue
        if state == 'block':
            if ch == '*' and i + 1 < n and text[i + 1] == '/':
                state = 'code'
                out.append(' ')
                i += 2
                continue
            out.append('\n' if ch == '\n' else ' ')
            i += 1
            continue
        # 字符串内部原样保留
        if ch == '\\':
            out.append(text[i:i + 2])
            i += 2
            continue
        if ch == state:
            state = 'code'
        out.append(ch)
        i += 1
    return ''.join(out)


if src:
    errors = scan_js(src)
    if errors:
        for item in errors:
            fail('JS 词法：' + item)
    else:
        note(f'JS 词法扫描通过（{src.count(chr(10)) + 1} 行，含正则/模板/注释）')

    code_only = strip_comments(src)

    # ── 4. 必需导出 ───────────────────────────────────────────────────────
    for pattern, label in [
        (r'export const name\s*=\s*[\'"]ask-first[\'"]', 'export const name = "ask-first"'),
        (r'export const inject', 'export const inject'),
        (r'export const Config', 'export const Config'),
        (r'export function apply\s*\(', 'export function apply('),
    ]:
        if not re.search(pattern, code_only):
            fail(f'缺必需导出：{label}')

    # ── 5. prompt 插值风险（只在字符串字面量里找，注释不算）────────────────
    for m in re.finditer(r'\[\{2\}|\{\{', src):
        start = src.rfind('\n', 0, m.start()) + 1
        end = src.find('\n', m.start())
        fail(f'出现 {{{{ 序列（systemPrompt 会尝试插值，变量不存在会抛错）：{src[start:end].strip()[:80]}')
        break

    # ── 6. 关键 API 用法 ──────────────────────────────────────────────────
    for pattern, label in [
        (r'ctx\.inject\(\[[\'"]systemPrompt[\'"]\]', "ctx.inject(['systemPrompt'])"),
        (r'systemPrompt\.section\(', 'systemPrompt.section()'),
        (r'systemPrompt\.context\(', 'systemPrompt.context()（每步常驻提醒）'),
        (r'ctx\.on\([\'"]tools/post-execute[\'"]', "ctx.on('tools/post-execute')"),
        (r'ctx\.on\([\'"]agent/pre-step[\'"]', "ctx.on('agent/pre-step')"),
    ]:
        if not re.search(pattern, code_only):
            fail(f'缺关键 API 用法：{label}')

    section_block = re.search(r'systemPrompt\.section\(\{(.*?)\n\s*\}\);', code_only, re.S)
    if not section_block:
        fail('找不到 systemPrompt.section({...}) 调用块')
    else:
        block = section_block.group(1)
        for key in ('name:', 'order:', 'text:'):
            if key not in block:
                fail(f'systemPrompt.section 缺 {key}')

    if not re.search(r"ctx\.inject\(\[['\"]tools['\"]\]", code_only):
        fail("缺 ctx.inject(['tools']) —— 硬闸无处注册")
    if not re.search(r'tools\.guard\(', code_only):
        fail('缺 tools.guard() 注册 —— 硬闸层没有实现')
    else:
        note('已注册 tools.guard()（硬闸层）')

    for pattern, label in [
        (r'askedThisTurn', 'askedThisTurn（本回合提问标记）'),
        (r'askedCoversTargets', 'askedCoversTargets（授权只对请求的目标有效）'),
        (r'isSelfCreated', 'isSelfCreated（自建对象免授权）'),
        (r'recordSelfCreated', 'recordSelfCreated（记录本会话写过的路径）'),
        (r'unknownTargetText', 'unknownTargetText（UNKNOWN 即确认文案）'),
        (r'liveSelfCreatedExempt', 'liveSelfCreatedExempt（自建豁免开关）'),
        (r'liveRespectSandboxMode', 'liveRespectSandboxMode（沙箱让位开关）'),
        (r'sandboxMakesMutationImpossible', 'sandboxMakesMutationImpossible（只读模式让位）'),
        (r'sandboxModeOf', 'sandboxModeOf（读取 sandbox 模式）'),
        (r'authorizedByUserText', 'authorizedByUserText（用户点名授权检测）'),
        (r'denialText', 'denialText（硬闸拒绝文案）'),
        (r'isIrreversible', 'isIrreversible（不可逆判定）'),
        (r'liveHardGate', 'liveHardGate（硬闸开关）'),
        (r'liveAlwaysRemind', 'liveAlwaysRemind（常驻提醒开关）'),
        (r'standingReminderText', 'standingReminderText（常驻提醒正文）'),
        (r'STANDING_REMINDER_NAME', 'STANDING_REMINDER_NAME（常驻提醒 context 名）'),
        (r'DEFAULT_STANDING_REMINDER', 'DEFAULT_STANDING_REMINDER（常驻提醒默认正文）'),
        (r'standingReminder:', 'standingReminder 配置字段（可覆盖提醒正文）'),
    ]:
        if not re.search(pattern, code_only):
            fail(f'缺硬闸要素：{label}')

    # post-execute 注入的上下文必须带 producer source.kind
    if 'additionalContexts' not in code_only:
        fail('没有通过 additionalContexts 注入提醒')
    if not re.search(r"kind:\s*REMINDER_KIND|kind:\s*'ask-first'|kind:\s*\"ask-first\"", code_only):
        fail('注入消息缺 source.kind（会被渲染成用户消息）')

# ── 7. 浏览器半部（设置界面）──────────────────────────────────────────────
CLIENT_PATH = os.path.join(SRC, 'lib', 'client.js')
if not os.path.isfile(CLIENT_PATH):
    fail('缺 lib/client.js —— 第三方插件的设置页必须由自己的 client 半部注册')
else:
    client_src = open(CLIENT_PATH, encoding='utf-8').read()
    client_errors = scan_js(client_src)
    for item in client_errors:
        fail('client.js 词法：' + item)
    if not client_errors:
        note(f'client.js 词法扫描通过（{client_src.count(chr(10)) + 1} 行）')

    for pattern, label in [
        (r'window\.__ModuleLoader__\.load\(\{', 'window.__ModuleLoader__.load({...}) 外壳'),
        (r'id:\s*[\'"]dsh-ask-first[\'"]', '模块 id "dsh-ask-first"'),
        (r'exports\.apply\s*=', 'exports.apply'),
        (r'exports\.inject\s*=', 'exports.inject'),
        (r'const\s+SETTINGS_NS\s*=\s*[\'"]ask-first[\'"]', 'SETTINGS_NS = "ask-first"（= loader 行 id）'),
        (r'[\'"]settings\.section[\'"]', 'settings.section slot'),
        (r'configForms\.get\(', 'configForms.get()'),
        (r'configForms\.whileServed', 'configForms.whileServed()（Host serve 后才注册）'),
        (r'slots\.register\(', 'slots.register()'),
        (r'alwaysRemind', 'alwaysRemind（常驻提醒开关的界面字段）'),
        (r'standingReminder', 'standingReminder（提醒正文编辑框）'),
        (r'selfCreatedExempt', 'selfCreatedExempt（自建对象免授权开关）'),
        (r'respectSandboxMode', 'respectSandboxMode（沙箱让位开关）'),
    ]:
        if not re.search(pattern, client_src):
            fail(f'client.js 缺要素：{label}')

    if re.search(r'\{\{', client_src):
        fail('client.js 出现 {{ 序列（提示词插值风险）')

    pj_json = json.load(open(pj_path, encoding='utf-8'))
    exports_map = pj_json.get('exports', {})
    if exports_map.get('./client') != './lib/client.js':
        fail('package.json exports["./client"] 必须指向 ./lib/client.js')
    client_decl = pj_json.get('dsh', {}).get('client')
    if not isinstance(client_decl, dict):
        fail('package.json 缺 dsh.client 声明 —— loader 不会加载 client 半部')
    else:
        if client_decl.get('platform') != 'web':
            fail('dsh.client.platform 必须是 "web"')
        if '@deepseek-ai/dsh-client-ui-settings' not in (client_decl.get('inject') or []):
            fail('dsh.client.inject 缺 @deepseek-ai/dsh-client-ui-settings（configForms 的来源）')

# ── 输出 ───────────────────────────────────────────────────────────────────
print('=' * 68)
print(f'dsh-ask-first 静态自检  ({SRC})')
print('=' * 68)
for item in notes:
    print(f'  · {item}')
if failures:
    print(f'\n✗ {len(failures)} 项失败：')
    for item in failures:
        print(f'  - {item}')
    sys.exit(1)
print('\n✓ 全部检查通过')
