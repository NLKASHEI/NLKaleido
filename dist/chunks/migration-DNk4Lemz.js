import { h as hash64 } from './entry-BSIO7ML2.js';

/**
 * M9 MVU 存量卡迁移脚手架（§24，作者可选、默认关闭；纯字符串扫描，禁 eval/new Function）。
 *
 * 硬性约束（§24.1）：
 * - 只存在导入流程，绝不参与运行时链路（onMessageReceived/dueFields/buildTail/requestVariableUpdate）；
 * - 零 tavern-helper 依赖；`_.xxx()` / `[mvu_update]` / `[initvar]` 只出现在导入器输出文本中；
 * - 定位「辅助脚手架」：自动翻译 + 显式标注「需人工确认」，不做静默丢弃、不做无损承诺；
 * - 生成物全部人类可读文本；本模块经动态 import 分包（默认关闭不加载，§24.1 代码分包）。
 *
 * 参考（MVU-Innovation / MagVarUpdate-beta，逐行核对）：
 * - [initvar] 检测：variable_init.ts:263 comment?.toLowerCase().includes('[initvar]')；
 * - ZOD 检测：agent_zod.ts:17-20 /registerMvuSchema/|/mvu_zod(?:\.js)?/、:117 /Schema\s*=\s*z\.object\(/；
 * - [mvu_update] 检测：variable_def.ts:316 /\[mvu_update\]/i（名字+内容联合匹配，agent_worldbook.ts:51-53）；
 * - 命令检测：update_variables.ts:317 /_\.(set|insert|assign|remove|unset|delete|add)\(/；
 * - JSON Patch 块：update_variables.ts:286 /<(json_?patch)>…<\/\1>/；
 * - ZOD 解析骨架（agent_zod.ts:23-103）：findMatchingClose（引号/括号感知）+ splitTopLevelItems + findTopLevelColon + kindOfValue；
 * - 关键对照：parseCommandValue（update_variables.ts:86-173）的 new Function/mathjs 是反面教材——本模块绝不引入。
 */
const MVU_INITVAR_RE = /\[initvar\]/i;
const MVU_ZOD_SCRIPT_RE = /registerMvuSchema|mvu_zod(?:\.js)?/;
const MVU_ZOD_SCHEMA_RE = /Schema\s*=\s*z\.object\(/;
const MVU_UPDATE_RE = /\[mvu_update\]/i;
const MVU_COMMAND_RE = /_\.(set|insert|assign|remove|unset|delete|add)\(/g;
const MVU_JSON_PATCH_RE = /<(json_?patch)>(?:(?!<json_?patch>)[\s\S])*?<\/\1>/gim;
/** 风险特征（§24.2/蒸馏 §E 表：难翻译构造 → 需人工确认） */
const RISK_PATTERNS = [
    { name: 'UI 渲染占位符 <StatusPlaceHolderImpl/>（丢弃）', re: /<StatusPlaceHolderImpl\/>/ },
    { name: 'VWD 二元组 [值, 描述]（描述即触发规则）', re: /\[\s*[^\]]+,\s*[^\]]+\s*\]/ },
    { name: 'mathjs 表达式（math.evaluate 不迁移）', re: /math\.evaluate|derivative\(|matrix\(/ },
    { name: '结构模板 $meta.template / $__META_EXTENSIBLE__$', re: /\$meta|template|\$__META_EXTENSIBLE__\$/ },
    { name: 'ST 宏 {{random::}} / {{get_message_variable::}}', re: /\{\{(?:random|get_message_variable)::/ },
    { name: 'ejs 条件块（getvar/setvar，脚本不迁移）', re: /<%[=_-]?[\s\S]*?%>|getvar\(|setvar\(/ },
    { name: 'new Function / eval（MVU 风险点，绝不带入）', re: /new\s+Function|eval\s*\(/ },
    { name: 'JSON Patch move 语义（未实现项）', re: /"move"|\bmove\b/ },
];
/** 检测（§24.2 阶段一）：四特征各 1 分；低(1)/中(2)/高(≥3) */
function detectMvuCard(source) {
    const combined = [
        ...source.worldbookEntries.map((entry) => `${entry.name}\n${entry.content}\n${entry.comment ?? ''}`),
        ...source.scripts.map((script) => script.content),
        ...(source.messages ?? []),
    ].join('\n');
    const features = {
        F1_initvar: MVU_INITVAR_RE.test(combined),
        F2_zod: source.scripts.some((script) => MVU_ZOD_SCRIPT_RE.test(script.content) && MVU_ZOD_SCHEMA_RE.test(script.content)),
        F3_mvu_update: source.worldbookEntries.some((entry) => MVU_UPDATE_RE.test(`${entry.name}\n${entry.content}`)),
        F4_commands: source.worldbookEntries.some((entry) => MVU_COMMAND_RE.test(entry.content)) || MVU_JSON_PATCH_RE.test(combined),
    };
    MVU_COMMAND_RE.lastIndex = 0;
    MVU_JSON_PATCH_RE.lastIndex = 0;
    const hits = Object.values(features).filter(Boolean).length;
    const confidence = hits >= 3 ? '高' : hits === 2 ? '中' : '低';
    const risks = [];
    for (const { name, re } of RISK_PATTERNS) {
        re.lastIndex = 0;
        if (re.test(combined))
            risks.push(name);
    }
    const names = Object.entries(features).filter(([, hit]) => hit).map(([key]) => key.slice(3));
    const summary = `MVU 特征命中 ${hits}/4（${names.join('、') || '无'}）→ 置信度「${confidence}」${confidence === '低' ? '：可能不是 MVU 卡，建议确认后继续' : ''}`;
    return { isMvu: hits > 0, confidence, features, hits, risks, summary };
}
/** 找配对闭括号（引号/括号感知；agent_zod.ts:23-46 findMatchingClose 同构） */
function findMatchingClose(text, openIndex) {
    const open = text[openIndex];
    const close = open === '{' ? '}' : open === '[' ? ']' : open === '(' ? ')' : '';
    if (!close)
        return -1;
    let depth = 0;
    let inString = false;
    let quote = '';
    for (let i = openIndex; i < text.length; i += 1) {
        const ch = text[i];
        if (inString) {
            if (ch === '\\') {
                i += 1;
                continue;
            }
            if (ch === quote)
                inString = false;
            continue;
        }
        if (ch === '"' || ch === "'" || ch === '`') {
            inString = true;
            quote = ch;
            continue;
        }
        if (ch === open)
            depth += 1;
        else if (ch === close) {
            depth -= 1;
            if (depth === 0)
                return i;
        }
    }
    return -1;
}
/** 顶层逗号切分（深度 + 引号感知；agent_zod.ts:49-79 splitTopLevelItems 同构） */
function splitTopLevelItems(text) {
    const items = [];
    let depth = 0;
    let start = 0;
    let inString = false;
    let quote = '';
    for (let i = 0; i < text.length; i += 1) {
        const ch = text[i];
        if (inString) {
            if (ch === '\\') {
                i += 1;
                continue;
            }
            if (ch === quote)
                inString = false;
            continue;
        }
        if (ch === '"' || ch === "'" || ch === '`') {
            inString = true;
            quote = ch;
            continue;
        }
        if (ch === '{' || ch === '[' || ch === '(')
            depth += 1;
        else if (ch === '}' || ch === ']' || ch === ')')
            depth -= 1;
        else if (ch === ',' && depth === 0) {
            items.push(text.slice(start, i));
            start = i + 1;
        }
    }
    const tail = text.slice(start).trim();
    if (tail)
        items.push(tail);
    return items.map((item) => item.trim()).filter(Boolean);
}
/** 顶层冒号（键值分界；agent_zod.ts:192-212 findTopLevelColon 同构） */
function findTopLevelColon(text) {
    let depth = 0;
    let inString = false;
    let quote = '';
    for (let i = 0; i < text.length; i += 1) {
        const ch = text[i];
        if (inString) {
            if (ch === '\\') {
                i += 1;
                continue;
            }
            if (ch === quote)
                inString = false;
            continue;
        }
        if (ch === '"' || ch === "'" || ch === '`') {
            inString = true;
            quote = ch;
            continue;
        }
        if (ch === '{' || ch === '[' || ch === '(')
            depth += 1;
        else if (ch === '}' || ch === ']' || ch === ')')
            depth -= 1;
        else if (ch === ':' && depth === 0)
            return i;
    }
    return -1;
}
function stripQuotes(value) {
    const trimmed = value.trim();
    if ((trimmed.startsWith('"') && trimmed.endsWith('"')) || (trimmed.startsWith("'") && trimmed.endsWith("'"))) {
        return trimmed.slice(1, -1);
    }
    return trimmed;
}
/** kindOfValue（agent_zod.ts:87-103）：z.object → 递归；z.record → kv；z.array → list；其余 leaf */
function kindOfZodValue(valueExpr) {
    if (/z\.object\s*\(/.test(valueExpr))
        return 'object';
    if (/z\.record\s*\(/.test(valueExpr))
        return 'kv';
    if (/z\.array\s*\(/.test(valueExpr))
        return 'list';
    if (/z\.number\(|z\.coerce\.number\(|z\.int\(/.test(valueExpr))
        return 'number';
    if (/z\.boolean\(/.test(valueExpr))
        return 'boolean';
    return 'string';
}
/** 从 z.* 链提取 prefault/catch 默认值与 describe 描述与 enum（无求值，纯文本） */
function extractZodMeta(valueExpr) {
    const meta = {};
    const prefault = /\.prefault\(\s*('([^']*)'|"([^"]*)"|(-?[\d.]+)|true|false)\s*\)/.exec(valueExpr);
    if (prefault) {
        if (prefault[2] !== undefined || prefault[3] !== undefined)
            meta.default = prefault[2] ?? prefault[3];
        else if (prefault[4] !== undefined)
            meta.default = Number(prefault[4]);
        else if (prefault[0].includes('true'))
            meta.default = true;
        else if (prefault[0].includes('false'))
            meta.default = false;
    }
    const describe = /\.describe\(\s*('([^']*)'|"([^"]*)")\s*\)/.exec(valueExpr);
    if (describe)
        meta.description = describe[2] ?? describe[3];
    const enumMatch = /z\.enum\(\s*\[([\s\S]*?)\]\s*\)/.exec(valueExpr);
    if (enumMatch) {
        meta.enum = splitTopLevelItems(enumMatch[1]).map(stripQuotes).filter(Boolean);
    }
    return meta;
}
function parseZodObjectBody(body, prefix, startLine, out) {
    const items = splitTopLevelItems(body);
    for (const item of items) {
        const colon = findTopLevelColon(item);
        if (colon < 0)
            continue;
        const key = stripQuotes(item.slice(0, colon));
        if (!key)
            continue;
        const valueExpr = item.slice(colon + 1).trim();
        const line = startLine + countLinesBefore(body, item);
        const path = prefix ? `${prefix}.${key}` : key;
        const meta = extractZodMeta(valueExpr);
        // record 必须先于 object 判定：z.record(键, z.object({...})) 内部含 z.object(；
        // startsWith 保证只认顶层（嵌套 record/object 不误判）
        if (valueExpr.startsWith('z.record')) {
            // record(键 schema, 值 schema)：值 schema 为 object → 子字段路径.<键> 模板（agent_zod.ts:161-179）
            const open = valueExpr.indexOf('(');
            const close = findMatchingClose(valueExpr, open);
            const args = close > open ? splitTopLevelItems(valueExpr.slice(open + 1, close)) : [];
            const valueSchema = args[1] ?? '';
            if (/z\.object\s*\(/.test(valueSchema)) {
                const objOpen = valueSchema.indexOf('{');
                const objClose = findMatchingClose(valueSchema, objOpen);
                if (objClose > objOpen)
                    parseZodObjectBody(valueSchema.slice(objOpen + 1, objClose), `${path}.<键>`, line, out);
            }
            out.push({ path, type: 'kv', default: meta.default, description: meta.description, line });
            continue;
        }
        if (valueExpr.startsWith('z.object')) {
            const open = valueExpr.indexOf('{');
            if (open >= 0) {
                const close = findMatchingClose(valueExpr, open);
                if (close > open)
                    parseZodObjectBody(valueExpr.slice(open + 1, close), path, line, out);
            }
            out.push({ path, type: 'object', default: meta.default, enum: meta.enum, description: meta.description, line });
            continue;
        }
        out.push({ path, type: kindOfZodValue(valueExpr), default: meta.default, enum: meta.enum, description: meta.description, line });
    }
}
function countLinesBefore(haystack, needle) {
    const index = haystack.indexOf(needle);
    if (index < 0)
        return 0;
    return haystack.slice(0, index).split('\n').length - 1;
}
/** 解析 ZOD Schema = z.object({...})（§24.2 阶段二；含来源行号追溯） */
function parseZodSchema(scriptContent) {
    const match = MVU_ZOD_SCHEMA_RE.exec(scriptContent);
    if (!match)
        return [];
    const openIndex = scriptContent.indexOf('{', match.index);
    if (openIndex < 0)
        return [];
    const closeIndex = findMatchingClose(scriptContent, openIndex);
    if (closeIndex < 0)
        return [];
    const body = scriptContent.slice(openIndex + 1, closeIndex);
    const startLine = scriptContent.slice(0, openIndex).split('\n').length;
    const out = [];
    parseZodObjectBody(body, '', startLine, out);
    return out;
}
const INTENT_PATTERNS = [
    { intent: '增量修改', re: /_\.add\(|每发生一次|递增|op['"]?\s*:\s*['"]delta|delta/ },
    { intent: '随机取值', re: /范围为|取值|\[\s*-?\d+\s*,\s*-?\d+\s*\]|\{\{random::/ },
    { intent: '条件分支', re: /<%|if\s*\(|当.{0,8}时|>=|>=|阈值|阶段/ },
    { intent: '字符串拼接/格式化', re: /格式为|拼接|模板|\$\{path\}|\$\{old\}|\$\{new\}/ },
    { intent: '跨变量引用', re: /getvar\(|\{\{get_message_variable::|_\.set\s*\(\s*['"]<user>/ },
    { intent: '值覆盖', re: /_\.set\(/ },
];
/** 提取命令（update_variables.ts:281-400 语义：括号配对状态机 + `//reason`；绝无求值） */
function extractMvuCommands(content) {
    const commands = [];
    const re = /_\.(set|insert|assign|remove|unset|delete|add)\(/g;
    let match;
    while ((match = re.exec(content)) !== null) {
        const command = match[1];
        const openIndex = match.index + match[0].length - 1;
        const closeIndex = findMatchingClose(content, openIndex);
        if (closeIndex < 0)
            continue;
        const argsText = content.slice(openIndex + 1, closeIndex);
        const args = splitTopLevelItems(argsText);
        let reason;
        const after = content.slice(closeIndex + 1, closeIndex + 200);
        const reasonMatch = /^\s*;?\s*\/\/([\s\S]*?)(?:\n|$)/.exec(after);
        if (reasonMatch)
            reason = reasonMatch[1].trim();
        const path = args[0] ? stripQuotes(args[0]) : '';
        if (path.includes('${'))
            continue; // 格式模板行（${path}/${old}/${new}）非真实更新命令
        commands.push({
            command,
            path: path.replace(/\[0\]$/, ''), // VWD [0] 归一（蒸馏 §F4）
            oldValue: args[1] !== undefined ? stripQuotes(args[1]) : undefined,
            newValue: args.length >= 3 ? stripQuotes(args[2]) : (args.length === 2 && command !== 'remove' && command !== 'unset' && command !== 'delete' ? stripQuotes(args[1]) : undefined),
            reason,
        });
    }
    return commands;
}
/** 提取规则表（§24.2 阶段三：意图分类 + 触发条件 + 目标变量 + 需人工确认标注） */
function extractMvuUpdateRules(entryTexts) {
    const rows = [];
    for (const text of entryTexts) {
        const commands = extractMvuCommands(text);
        const lower = text.toLowerCase();
        if (commands.length) {
            for (const command of commands) {
                const intent = detectIntent(text, command);
                const { needsHumanConfirm, confirmReason } = needsConfirm(text);
                rows.push({
                    intent,
                    target: command.path || undefined,
                    trigger: extractTrigger(text),
                    original: `_.${command.command}('${command.path}'${command.newValue !== undefined ? `, ${command.newValue}` : ''});${command.reason ? `//${command.reason}` : ''}`,
                    needsHumanConfirm,
                    confirmReason,
                });
            }
        }
        else if (lower.includes('格式') || lower.includes('format')) {
            rows.push({ intent: '字符串拼接/格式化', original: text.slice(0, 200), needsHumanConfirm: true, confirmReason: '格式强调条目：无命令可提取，需人工确认注入方式' });
        }
        else {
            rows.push({ intent: detectIntent(text, undefined), original: text.slice(0, 200), needsHumanConfirm: needsConfirm(text).needsHumanConfirm, confirmReason: needsConfirm(text).confirmReason });
        }
    }
    return rows;
}
function detectIntent(text, command) {
    if (command?.command === 'add')
        return '增量修改';
    // 命令存在时以命令为锚：条件/随机信号优先，其余命令默认值覆盖
    if (/<%|if\s*\(|getvar\(/.test(text))
        return '条件分支';
    if (/范围为|\{\{random::/.test(text))
        return '随机取值';
    if (command)
        return '值覆盖';
    for (const { intent, re } of INTENT_PATTERNS) {
        if (intent !== '值覆盖' && re.test(text))
            return intent;
    }
    return '未识别';
}
function needsConfirm(text) {
    const hits = [];
    for (const { name, re } of RISK_PATTERNS) {
        if (re.test(text))
            hits.push(name);
    }
    return hits.length ? { needsHumanConfirm: true, confirmReason: hits.join('；') } : { needsHumanConfirm: false };
}
function extractTrigger(text) {
    const vwd = /^\s*['"]?[^'":]+['"]?\s*:\s*\[\s*[^,\]]+,\s*([^\]]+)\s*\]/m.exec(text);
    if (vwd)
        return vwd[1].trim();
    // ejs 条件：捕获到比较算子（getvar(...) 内层括号不截断）
    const ejs = /if\s*\(\s*([\s\S]{0,120}?)\s*(>=|<=|==|!=|>|<)\s*(-?[\d.]+)/.exec(text);
    if (ejs)
        return `条件：${ejs[1].trim()} ${ejs[2]} ${ejs[3]}`;
    return undefined;
}
const TYPE_MAP = {
    string: 'string', number: 'number', boolean: 'boolean', list: 'list', object: 'object', kv: 'kv',
};
/** 组装契约骨架（§24.2 阶段四：变量清单 → FieldDef；规则表 → change_rule；难翻译 → 标注不丢弃） */
function assembleContractSkeleton(input) {
    const updateRules = {};
    const humanConfirm = [];
    for (const variable of input.variables) {
        const description = variable.description ?? '';
        updateRules[variable.path] = {
            path: variable.path,
            type: TYPE_MAP[variable.type],
            default: variable.default,
            updateMode: 'every_turn',
            dynamic: true,
            display: true,
            changeRule: description || '（原卡未提供更新描述，需人工补充）',
            ownership: { owner: 'agent', writers: ['agent', 'manual'], priority: 0, merge: 'last_write', audit: true },
        };
        if (variable.enum?.length)
            updateRules[variable.path]['enum'] = variable.enum;
        if (variable.type === 'kv') {
            humanConfirm.push(`变量 ${variable.path}：ZOD z.record 动态键容器 → type:kv（子路径模板 ${variable.path}.<键>），需人工确认键语义`);
        }
    }
    for (const rule of input.rules) {
        if (!rule.target) {
            humanConfirm.push(`规则「${rule.intent}」无目标变量可提取：原文 ${rule.original.slice(0, 80)}`);
            continue;
        }
        const field = updateRules[rule.target];
        if (field) {
            const existing = String(field['changeRule'] ?? '');
            const addition = rule.needsHumanConfirm
                ? `【需人工确认】${rule.confirmReason ?? '难翻译构造'}；原文：${rule.original}`
                : `意图「${rule.intent}」${rule.trigger ? `；触发：${rule.trigger}` : ''}；原文：${rule.original}`;
            field['changeRule'] = existing ? `${existing}\n${addition}` : addition;
        }
        else {
            humanConfirm.push(`规则指向未声明变量 ${rule.target}（ZOD/[initvar] 未提取到）：原文 ${rule.original.slice(0, 80)}`);
        }
        if (rule.needsHumanConfirm) {
            humanConfirm.push(`规则 ${rule.target}「${rule.intent}」：${rule.confirmReason ?? '难翻译构造'}（原文已保留在 changeRule）`);
        }
    }
    const contract = {
        version: 1,
        id: input.cardId || `mvu-migrated-${hash64(JSON.stringify(Object.keys(updateRules))).slice(0, 8)}`,
        schema: { type: 'object', loose: true },
        updateRules,
        displayRules: [],
        guardrails: { maxStatusTokens: 1500, maxOpsPerTurn: 20, minConfidence: 'medium', maxRetries: 1, maxSteps: 0, maxTokensPerStep: 2048, maxDependencyDepth: 3 },
        invariants: [],
    };
    return {
        contract,
        humanConfirm,
        stats: { variables: input.variables.length, rules: input.rules.length, confirmCount: humanConfirm.length },
    };
}
/** 迁移报告（§24.2 阶段五预览用：人类可读全文） */
function renderMigrationReport(draft) {
    const lines = [
        `# MVU 存量卡迁移报告`,
        `- 变量数：${draft.stats.variables}；规则数：${draft.stats.rules}；需人工确认：${draft.stats.confirmCount}`,
        `- 契约初稿（JSON）：`,
        '```json',
        JSON.stringify(draft.contract, null, 2),
        '```',
    ];
    if (draft.humanConfirm.length) {
        lines.push('## 需人工确认（不静默丢弃）');
        for (const item of draft.humanConfirm)
            lines.push(`- ${item}`);
    }
    else {
        lines.push('## 无需人工确认项');
    }
    return lines.join('\n');
}

export { MVU_COMMAND_RE, MVU_INITVAR_RE, MVU_JSON_PATCH_RE, MVU_UPDATE_RE, MVU_ZOD_SCHEMA_RE, MVU_ZOD_SCRIPT_RE, assembleContractSkeleton, detectMvuCard, extractMvuCommands, extractMvuUpdateRules, findMatchingClose, findTopLevelColon, parseZodSchema, renderMigrationReport, splitTopLevelItems };
