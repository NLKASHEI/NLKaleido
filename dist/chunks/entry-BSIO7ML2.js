/**
 * hash64 —— 64 位双通道混合哈希（§7 G2）。
 * 算法以《研究代码.txt》第 4 行原文 `q()` 为准（2026-08-14 直接核对）：
 * - 双种子：0xDEADBEEF ^ len（t）、0x41C6CE57 ^ len（n）——原文十进制 1103547991；
 *   ⚠️ 还原文档写 0x41C64E6D 系转写错误，已按原文改正；
 * - 循环：imul(t ^ ch, 0x9E3779B1) / imul(n ^ ch, 0x5F356495)（32 位乘法）；
 * - 雪崩：0x85EBCA6B / 0xC2B2AE35 交叉混合（t 先更新，n 用新 t）；
 * - 输出 `${n}${t}` 各 8 位 hex（16 位）。
 * 黄金向量（原文 q() 实测）：'' → 488bdcb81aee8d83；'abc' → 9bd099588f6f1534（单测锁定）。
 * 纯 TS、同步、无 crypto 依赖（浏览器端可用）。
 *
 * 【实现决策】KaleidoState.revision.hash（§7 声明 sha256）在浏览器同步路径下改走 hash64；
 * 需要密码学强度时（P2 checkpoint 校验）由存储层用 Web Crypto `crypto.subtle.digest('SHA-256')`
 * （异步）另行计算。
 */
/** 64 位双通道混合哈希（研究代码.txt 行 4 原文 q() 逐位复刻） */
function hash64(text) {
    const input = String(text ?? '');
    let t = (0xdeadbeef ^ input.length) >>> 0;
    let n = (0x41c6ce57 ^ input.length) >>> 0;
    for (let i = 0; i < input.length; i += 1) {
        const code = input.charCodeAt(i);
        t = Math.imul(t ^ code, 0x9e3779b1);
        n = Math.imul(n ^ code, 0x5f356495);
    }
    t = (Math.imul(t ^ (t >>> 16), 0x85ebca6b) ^ Math.imul(n ^ (n >>> 13), 0xc2b2ae35)) >>> 0;
    n = (Math.imul(n ^ (n >>> 16), 0x85ebca6b) ^ Math.imul(t ^ (t >>> 13), 0xc2b2ae35)) >>> 0;
    return `${n.toString(16).padStart(8, '0')}${t.toString(16).padStart(8, '0')}`;
}

const VALID_OPS = new Set(['replace', 'delta', 'add', 'remove', 'move']);
const VALID_CONFIDENCE = new Set(['high', 'medium', 'low']);
/** 容错 JSON 解析：多层修复后仍失败 → undefined */
function tolerantJsonParse(text) {
    let s = String(text ?? '').trim();
    if (!s)
        return undefined;
    // 第 0 层：直接 parse
    try {
        return JSON.parse(s);
    }
    catch {
        /* 继续修复 */
    }
    // 第 1 层：去代码围栏与包裹标签（G5 <nlkaleido_patch> 兜底）
    s = s.replace(/^```(?:json|JSON)?\s*/u, '').replace(/\s*```$/u, '');
    s = s.replace(/^<nlkaleido_patch>\s*/u, '').replace(/\s*<\/nlkaleido_patch>$/u, '');
    try {
        return JSON.parse(s);
    }
    catch {
        /* 继续修复 */
    }
    // 第 2 层：散文夹带 → 截取首个 { 或 [ 到最后一个 } 或 ]
    const firstBrace = s.search(/[[{]/u);
    const lastBrace = Math.max(s.lastIndexOf('}'), s.lastIndexOf(']'));
    if (firstBrace >= 0 && lastBrace > firstBrace) {
        s = s.slice(firstBrace, lastBrace + 1);
    }
    try {
        return JSON.parse(s);
    }
    catch {
        /* 继续修复 */
    }
    // 第 3 层：常见语法修复
    let fixed = s;
    fixed = fixed.replace(/,\s*([}\]])/gu, '$1'); // 尾逗号
    fixed = fixed.replace(/[“”]/gu, '"'); // 中文引号
    fixed = fixed.replace(/'/gu, '"'); // 单引号 → 双引号（启发式）
    fixed = fixed.replace(/([{,]\s*)([\p{L}\p{N}_]+)(\s*:)/gu, '$1"$2"$3'); // 裸键加引号
    // 补未闭合括号
    let opens = 0;
    let closes = 0;
    for (const ch of fixed) {
        if (ch === '{' || ch === '[')
            opens += 1;
        if (ch === '}' || ch === ']')
            closes += 1;
    }
    if (opens > closes)
        fixed += '}'.repeat(opens - closes);
    try {
        return JSON.parse(fixed);
    }
    catch {
        return undefined;
    }
}
/** 从 Agent 产出中提取 json_patch：支持 {analysis, json_patch} 包装、裸数组、JSON 字符串 */
function extractJsonPatch(raw) {
    if (Array.isArray(raw)) {
        return { patch: raw, errors: [] };
    }
    if (raw && typeof raw === 'object') {
        const record = raw;
        if (Array.isArray(record.json_patch)) {
            return { patch: record.json_patch, errors: [] };
        }
        if (record.json_patch == null && Object.keys(record).length === 0) {
            return { patch: [], errors: [] };
        }
    }
    if (typeof raw === 'string') {
        const parsed = tolerantJsonParse(raw);
        if (parsed == null) {
            return { patch: [], errors: [`json_patch 解析失败（无法修复）`] };
        }
        if (Array.isArray(parsed)) {
            return { patch: parsed, errors: [] };
        }
        if (parsed && typeof parsed === 'object') {
            const record = parsed;
            if (Array.isArray(record.json_patch)) {
                return { patch: record.json_patch, errors: [] };
            }
        }
        return { patch: [], errors: ['json_patch 结构不合法（期望数组或 {json_patch:[...]}）'] };
    }
    return { patch: [], errors: ['json_patch 缺失或类型不合法'] };
}
/** 路径修正（§4.8 ①-2）：去空白、`]` 后缺 `.` 补点、空白序列补点 */
function repairPath(path) {
    let p = String(path ?? '').trim();
    if (!p)
        return p;
    p = p.replace(/\s+/gu, ''); // 空白 → 无
    p = p.replace(/\](\S)/gu, '].$1'); // 'a[0]b' → 'a[0].b'
    p = p.replace(/\[['"]/gu, '[').replace(/['"]\]/gu, ']'); // 索引引号规整
    return p;
}
/** 按 FieldDef.type coerce 值（§4.8 ①-2）：number "5"→5；boolean "true"/"false"→bool */
function coerceValue(fieldType, value) {
    if (fieldType === 'number' && typeof value === 'string' && value.trim() !== '' && Number.isFinite(Number(value))) {
        return Number(value);
    }
    if (fieldType === 'boolean' && typeof value === 'string') {
        if (value === 'true')
            return true;
        if (value === 'false')
            return false;
    }
    return value;
}
/** 单条 op 结构规整；不合法返回 null + 原因 */
function normalizeOp(raw, index, contract) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
        return { op: raw, error: `op[${index}] 不是对象` };
    }
    const record = raw;
    const opKind = String(record.op ?? '').trim().toLowerCase();
    if (!VALID_OPS.has(opKind)) {
        return { op: raw, error: `op[${index}] 操作类型不合法：${opKind || '(空)'}` };
    }
    if (typeof record.path !== 'string' || !record.path.trim()) {
        return { op: raw, error: `op[${index}] 缺少 path` };
    }
    const path = repairPath(record.path);
    const field = contract?.updateRules[path];
    const confidence = VALID_CONFIDENCE.has(String(record.confidence)) ? String(record.confidence) : undefined;
    const rationale = typeof record.rationale === 'string' ? record.rationale.trim() : undefined;
    const base = { path, confidence, rationale };
    switch (opKind) {
        case 'replace':
        case 'add':
        case 'remove':
            if (opKind !== 'remove' && record.value === undefined) {
                return { op: raw, error: `op[${index}] ${opKind} 缺少 value` };
            }
            return {
                op: {
                    ...base,
                    op: opKind,
                    value: opKind === 'remove' ? undefined : coerceValue(field?.type, record.value),
                },
            };
        case 'delta': {
            const value = coerceValue('number', record.value);
            if (typeof value !== 'number' || !Number.isFinite(value)) {
                return { op: raw, error: `op[${index}] delta 的 value 必须是有限数值` };
            }
            return { op: { ...base, op: 'delta', value } };
        }
        case 'move': {
            if (typeof record.from !== 'string' || !record.from.trim()) {
                return { op: raw, error: `op[${index}] move 缺少 from` };
            }
            return { op: { ...base, op: 'move', from: repairPath(record.from) } };
        }
        default:
            return { op: raw, error: `op[${index}] 操作类型不合法：${opKind}` };
    }
}
/**
 * JSON Patch 语法清洗（§10.1）：修复常见语法错误后返回合法 PatchOp 列表。
 * 修复失败 → ops 为空 + errors 结构化失败原因（喂回 Agent 自纠，§10.2 失败重试复用）。
 */
function sanitizeJsonPatchDetailed(raw, contract) {
    const { patch, errors } = extractJsonPatch(raw);
    const ops = [];
    const seen = new Set();
    patch.slice(0, 256).forEach((item, index) => {
        const { op, error } = normalizeOp(item, index, contract);
        if (error) {
            errors.push(error);
            return;
        }
        const dedupeKey = `${op.op}|${op.path}|${JSON.stringify(op.value ?? '')}`;
        if (seen.has(dedupeKey)) {
            return; // 重复 op 去重（§9.1 来源去重）
        }
        seen.add(dedupeKey);
        ops.push(op);
    });
    if (patch.length > 256) {
        errors.push(`op 数量超过上限，已截断到前 256 条（原始 ${patch.length} 条）`);
    }
    return { ops, errors };
}

/** 字段池分类（§7.1）：static=fixed；lowfreq=every_n_turns/trigger/沿用值；dynamic=every_turn&dynamic */
function classifyField(f) {
    if (f.updateMode === 'fixed')
        return 'static';
    if (f.updateMode === 'every_turn' && f.dynamic !== false)
        return 'dynamic';
    return 'lowfreq';
}
/**
 * 本轮到期字段列表（§10.1 dueFields）。纯函数、确定性。
 * 输入 meta.lastUpdated（每字段最近更新轮，applyOps 维护）用于 every_n_turns 与 ttl 判定。
 */
function dueFields(meta, c, turnId) {
    const due = [];
    const lastUpdated = meta.lastUpdated ?? {};
    for (const field of Object.values(c.updateRules)) {
        const last = lastUpdated[field.path];
        // ttl 到期 → 失效，跳过（§4.2 生命周期）
        if (field.ttl != null && last != null && turnId - last > field.ttl)
            continue;
        switch (field.updateMode) {
            case 'fixed':
                break;
            case 'every_turn':
                if (field.dynamic !== false)
                    due.push(field.path);
                break;
            case 'every_n_turns': {
                const n = field.everyN ?? 1;
                if (last == null || turnId - last >= n)
                    due.push(field.path);
                break;
            }
            case 'trigger':
                // AI 待判定区（§6.3）：每轮列入候选
                due.push(field.path);
                break;
        }
    }
    return due;
}
/**
 * Fast Demote（CFS real_takeover.js:320-331）：stable 字段本轮值变了 → 立即降 volatile
 * （值改为进 L3 delta 暴露真实新值，而非 L1 STABLE_BATCH 引用）。
 * thrash lock（默认 3 次）：同一字段反复降级达阈值 → 永久 volatile（抖动锁定）。
 * 返回 { demoted, locked }。Slow Promote 不做自动（CFS 有，万花筒保留人工：
 * learnFieldPools 建议 + 面板一键采纳——contractVersion+1 才改前缀，防止意外击穿缓存）。
 */
function stabilityDemotion(contract, changedPaths, demoteCounts, thrashLock = 3) {
    const demoted = [];
    const locked = [];
    for (const path of changedPaths) {
        const field = contract.updateRules[path];
        if (!field || field.stability !== 'stable')
            continue;
        const count = (demoteCounts[path] ?? 0) + 1;
        demoteCounts[path] = count;
        if (count >= thrashLock) {
            field.stability = 'volatile';
            locked.push(path);
            continue;
        }
        field.stability = 'volatile'; // Fast Demote：立即降级
        demoted.push(path);
    }
    return { demoted, locked };
}

class DependencyCycleError extends Error {
    cycle;
    constructor(cycle) {
        super(`dependencies cycle: ${cycle.join('→')}`);
        this.name = 'DependencyCycleError';
        this.cycle = cycle;
    }
}
/** 归一化引用路径：剥掉 `stat_data.` 前缀，与 FieldDef.path 对齐 */
function normalizeRefPath(ref) {
    const trimmed = ref.trim();
    return trimmed.startsWith('stat_data.') ? trimmed.slice('stat_data.'.length) : trimmed;
}
/** 从文本提取 ${path} / $<path> 引用（去重；matchAll 无共享正则状态） */
function extractRefs(text) {
    const refs = new Set();
    for (const pattern of [/\$\{([^}]+)\}/g, /\$<([^>]+)>/g]) {
        for (const match of text.matchAll(pattern)) {
            const ref = normalizeRefPath(match[1]);
            if (ref)
                refs.add(ref);
        }
    }
    return [...refs];
}
/** 从 derived.expr 提取引用（PredicateExpr 的 var 字段 / 字符串表达式） */
function extractDerivedRefs(expr, acc) {
    if (typeof expr === 'string') {
        for (const ref of extractRefs(expr))
            acc.add(ref);
        return;
    }
    if (Array.isArray(expr)) {
        for (const item of expr)
            extractDerivedRefs(item, acc);
        return;
    }
    if (expr && typeof expr === 'object') {
        const record = expr;
        if (typeof record.var === 'string') {
            acc.add(normalizeRefPath(record.var));
        }
        if (typeof record.args === 'object' && record.args != null) {
            for (const item of Object.values(record.args)) {
                if (typeof item === 'string') {
                    const ref = normalizeRefPath(item);
                    if (ref)
                        acc.add(ref);
                }
            }
        }
        for (const value of Object.values(record)) {
            if (value && typeof value === 'object')
                extractDerivedRefs(value, acc);
        }
    }
}
/**
 * 构建邻接表：path → 其依赖（A 依赖 B = A 的 changeRule/derived/dependencies 引用了 B）。
 * 只保留指向「已声明字段」的边；未声明引用忽略（误报可接受、漏报靠显式声明兜底，§0.2）。
 */
function buildAdjacency(c) {
    const paths = Object.keys(c.updateRules);
    const pathSet = new Set(paths);
    const adjacency = new Map();
    for (const path of paths) {
        adjacency.set(path, []);
    }
    for (const field of Object.values(c.updateRules)) {
        const deps = new Set();
        if (field.changeRule) {
            for (const ref of extractRefs(field.changeRule))
                if (pathSet.has(ref))
                    deps.add(ref);
        }
        const derivedExpr = c.derived?.[field.path]?.expr;
        if (derivedExpr != null) {
            const refs = new Set();
            extractDerivedRefs(derivedExpr, refs);
            for (const ref of refs)
                if (pathSet.has(ref))
                    deps.add(ref);
        }
        for (const dep of field.dependencies ?? [])
            if (pathSet.has(dep))
                deps.add(dep);
        adjacency.set(field.path, [...deps]);
    }
    return adjacency;
}
/**
 * Kahn 拓扑排序检测环；返回一条环路径（A→B→C→A）或 null。
 * 全图（非 dueFields 子图），用于 validateContract 校验期报错。
 */
function topologicalCyclePath(adjacency, nodes) {
    const indegree = new Map();
    const outEdges = new Map();
    for (const node of nodes) {
        indegree.set(node, 0);
        outEdges.set(node, []);
    }
    for (const [from, deps] of adjacency) {
        for (const to of deps) {
            if (indegree.has(to)) {
                indegree.set(to, (indegree.get(to) ?? 0) + 1);
                outEdges.get(from)?.push(to);
            }
        }
    }
    const queue = [];
    for (const [node, deg] of indegree)
        if (deg === 0)
            queue.push(node);
    const processed = new Set();
    while (queue.length) {
        const node = queue.shift();
        processed.add(node);
        for (const to of outEdges.get(node) ?? []) {
            const deg = (indegree.get(to) ?? 1) - 1;
            indegree.set(to, deg);
            if (deg === 0)
                queue.push(to);
        }
    }
    if (processed.size === nodes.length)
        return null;
    // 存在环：在剩余节点中 DFS 找一条环路径
    const remaining = nodes.filter((n) => !processed.has(n));
    const visitState = new Map(); // 0 未访问 / 1 在栈 / 2 完成
    const stack = [];
    let cycle = null;
    const dfs = (node) => {
        visitState.set(node, 1);
        stack.push(node);
        for (const to of outEdges.get(node) ?? []) {
            if (cycle)
                return true;
            const state = visitState.get(to) ?? 0;
            if (state === 1) {
                const start = stack.indexOf(to);
                cycle = [...stack.slice(start), to];
                return true;
            }
            if (state === 0 && dfs(to))
                return true;
        }
        stack.pop();
        visitState.set(node, 2);
        return false;
    };
    for (const node of remaining) {
        if (cycle)
            break;
        if ((visitState.get(node) ?? 0) === 0)
            dfs(node);
    }
    return cycle;
}
/**
 * 计算 dueFields 的可达依赖子图（§0.2）。
 * BFS 自 due 出发，深度 ≤ maxDependencyDepth（默认 3，运行时截断）；
 * 返回 { field → 其依赖（仅含子图内节点）}。深于上限的传递依赖保留在图中可 O(1) 查询，
 * 但不进 Observation/Agent 上下文。
 */
function computeDependencies(c, due, maxDepth) {
    const adjacency = buildAdjacency(c);
    const depth = new Map();
    const queue = [];
    const limit = c.guardrails.maxDependencyDepth ?? 3;
    for (const path of due) {
        if (!adjacency.has(path))
            continue;
        depth.set(path, 0);
        queue.push(path);
    }
    while (queue.length) {
        const node = queue.shift();
        const nodeDepth = depth.get(node);
        if (nodeDepth >= limit)
            continue;
        for (const dep of adjacency.get(node) ?? []) {
            if (!depth.has(dep)) {
                depth.set(dep, nodeDepth + 1);
                queue.push(dep);
            }
        }
    }
    const result = new Map();
    for (const [path, nodeDepth] of depth) {
        result.set(path, (adjacency.get(path) ?? []).filter((dep) => depth.has(dep)));
    }
    return result;
}

/**
 * 点分路径工具（KaleidoCore 纯函数模块）。
 *
 * 路径 DSL（§4.1）：`角色.络络.好感度`、`背包[0].名称`、`状态.世界阶段`。
 * - 字段名允许中文/字母/数字/下划线，禁止 `.`（路径分隔符）与 `[`/`]`（索引定界）。
 * - 数组用 `path[i]`（数字索引）或 `path.<key>`（对象键）访问。
 *
 * 安全约束（§17.4 / 借鉴 wanzai state-contract）：
 * - 拒绝 `__proto__`/`constructor`/`prototype` 键（原型链污染防护）；
 * - 一切寻址用自有属性遍历（Object.hasOwn），不走 `in` 链式查找。
 */
const FORBIDDEN_KEYS = new Set(['__proto__', 'prototype', 'constructor']);
class PathError extends Error {
    constructor(message) {
        super(message);
        this.name = 'PathError';
    }
}
const PART_RE = /^([^\[\]]*)((?:\[[^\[\]]*\])*)$/;
const NAME_RE = /^[\p{L}\p{N}_]+$/u;
const NUMERIC_SEG_RE = /^\d+$/;
/**
 * 解析点分路径为 token 序列。
 * `背包[0].名称` → ['背包', 0, '名称']；`a.0.c`（数字裸段）→ ['a', 0, 'c']（MVU pathFix 语义）。
 * 段名为空、含非法字符、含禁止键 → 抛 PathError。
 */
function parsePath$1(path) {
    const raw = String(path ?? '').trim();
    if (!raw)
        throw new PathError('路径为空');
    const tokens = [];
    for (const seg of raw.split('.')) {
        const match = PART_RE.exec(seg);
        if (!match || match[0] !== seg)
            throw new PathError(`路径段非法：${JSON.stringify(seg)}`);
        const name = match[1];
        if (!name)
            throw new PathError(`路径段缺少字段名：${JSON.stringify(seg)}`);
        if (!NAME_RE.test(name))
            throw new PathError(`字段名含非法字符：${JSON.stringify(name)}（允许中文/字母/数字/下划线）`);
        if (FORBIDDEN_KEYS.has(name))
            throw new PathError(`字段名禁止：${name}`);
        tokens.push(NUMERIC_SEG_RE.test(name) ? Number(name) : name);
        if (match[2]) {
            // matchAll：无共享 lastIndex 状态（避免异常路径下正则状态残留）
            for (const idxMatch of match[2].matchAll(/\[([^\[\]]*)\]/g)) {
                const rawIdx = idxMatch[1].trim();
                let token;
                if (NUMERIC_SEG_RE.test(rawIdx)) {
                    token = Number(rawIdx);
                    if (!Number.isSafeInteger(token))
                        throw new PathError(`索引超出安全整数：${rawIdx}`);
                }
                else {
                    const key = rawIdx.replace(/^(['"])(.*)\1$/, '$2');
                    if (FORBIDDEN_KEYS.has(key))
                        throw new PathError(`索引键禁止：${key}`);
                    token = key;
                }
                tokens.push(token);
            }
        }
    }
    return tokens;
}
/**
 * 校验契约声明字段路径（FieldDef.path 级，§4.1 命名规则）。
 * 返回 null 表示合法；否则返回错误信息。
 */
function validateFieldPath(path) {
    try {
        const tokens = parsePath$1(path);
        for (const token of tokens) {
            if (typeof token === 'string' && !NAME_RE.test(token)) {
                return `字段名含非法字符：${JSON.stringify(token)}（允许中文/字母/数字/下划线）`;
            }
        }
        return null;
    }
    catch (error) {
        return error instanceof Error ? error.message : String(error);
    }
}
/** 自有属性安全读取；路径不存在或中途非对象 → undefined */
function getAtPath(obj, path) {
    let current = obj;
    for (const token of parsePath$1(path)) {
        if (current == null || typeof current !== 'object')
            return undefined;
        if (typeof token === 'number') {
            if (!Array.isArray(current) || !(token >= 0 && token < current.length))
                return undefined;
            current = current[token];
        }
        else {
            if (!Object.hasOwn(current, token))
                return undefined;
            current = current[token];
        }
    }
    return current;
}
function hasAtPath(obj, path) {
    return getAtPath(obj, path) !== undefined;
}
/**
 * 写入路径（自动创建中间对象/数组）；返回写入后的根对象。
 * 中途遇「非对象的已有值」时按对象语义替换为空容器（与 JSON Patch add 惯例一致）。
 */
function setAtPath(obj, path, value) {
    const tokens = parsePath$1(path);
    if (tokens.length === 0)
        throw new PathError('路径为空');
    let current = obj;
    for (let i = 0; i < tokens.length - 1; i += 1) {
        const token = tokens[i];
        const next = tokens[i + 1];
        if (typeof token === 'number') {
            if (!Array.isArray(current))
                throw new PathError(`路径中段不是数组：${JSON.stringify(token)}`);
            if (typeof current[token] !== 'object' || current[token] === null || Array.isArray(current[token]) !== (typeof next === 'number')) {
                current[token] = typeof next === 'number' ? [] : {};
            }
            current = current[token];
        }
        else {
            if (!current || typeof current !== 'object' || Array.isArray(current)) {
                throw new PathError(`路径中段不可写：${JSON.stringify(token)}`);
            }
            if (typeof current[token] !== 'object' || current[token] === null || Array.isArray(current[token]) !== (typeof next === 'number')) {
                current[token] = typeof next === 'number' ? [] : {};
            }
            current = current[token];
        }
    }
    const last = tokens[tokens.length - 1];
    if (typeof last === 'number') {
        if (!Array.isArray(current))
            throw new PathError('目标容器不是数组');
        current[last] = value;
    }
    else {
        if (!current || typeof current !== 'object' || Array.isArray(current))
            throw new PathError('目标容器不是对象');
        if (FORBIDDEN_KEYS.has(last))
            throw new PathError(`字段名禁止：${last}`);
        current[last] = value;
    }
    return obj;
}
/** 删除路径；路径不存在或中途断裂 → false */
function removeAtPath(obj, path) {
    const tokens = parsePath$1(path);
    if (tokens.length === 0)
        return false;
    let current = obj;
    for (let i = 0; i < tokens.length - 1; i += 1) {
        const token = tokens[i];
        if (current == null || typeof current !== 'object')
            return false;
        if (typeof token === 'number') {
            if (!Array.isArray(current) || !(token >= 0 && token < current.length))
                return false;
            current = current[token];
        }
        else {
            if (!Object.hasOwn(current, token))
                return false;
            current = current[token];
        }
    }
    const last = tokens[tokens.length - 1];
    if (current == null || typeof current !== 'object')
        return false;
    if (typeof last === 'number') {
        if (!Array.isArray(current) || !(last >= 0 && last < current.length))
            return false;
        current.splice(last, 1);
        return true;
    }
    if (!Object.hasOwn(current, last))
        return false;
    return delete current[last];
}
/**
 * 值安全断言（借鉴 wanzai assertFiniteValue）：
 * 数值必须有限；对象/数组键必须无禁止键；嵌套深度与规模上限。
 */
function assertFiniteValue(value, depth = 0) {
    if (depth > 12)
        throw new PathError('值嵌套过深（>12 层）');
    if (typeof value === 'number' && !Number.isFinite(value))
        throw new PathError('数值必须有限');
    if (Array.isArray(value)) {
        if (value.length > 200)
            throw new PathError('数组过长（>200）');
        for (const item of value)
            assertFiniteValue(item, depth + 1);
    }
    else if (value && typeof value === 'object') {
        const entries = Object.entries(value);
        if (entries.length > 200)
            throw new PathError('对象字段过多（>200）');
        for (const [key, item] of entries) {
            if (FORBIDDEN_KEYS.has(key))
                throw new PathError(`值包含非法对象键：${key}`);
            assertFiniteValue(item, depth + 1);
        }
    }
}

/**
 * Agent 观察层（§3.6，位于 dueFields 与 requestVariableUpdate 之间）。
 *
 * 职责：状态投影 + 可见性控制——决定 Agent 看到哪些字段、以何格式/顺序、脱敏/截断/聚合。
 * 绝不把完整 StatePreview 直接暴露给模型。
 * - 字段选择：dueFields + dependencies + pending 为基础，叠加 ownership 可见性（§4.7）与
 *   display:'hidden' 排除（§3.6）。
 * - 格式与顺序：契约声明顺序（due 优先、依赖随后、pending 末尾），输出结构化 Observation。
 * - 脱敏/截断：长文本按 maxFieldLen 截断（保留前缀 + 长度标记）；非 agent 属主字段 masked。
 * - 聚合/权重过滤：超过 topK 的同构字段折叠为摘要行（§3.6 top-K）。
 * - 可覆盖：§18.3 OB-1 中间件点（observe.project），默认实现走契约声明。
 *
 * 纯函数、确定性（同输入同输出，§15 观察层可测标准）。
 */
const DEFAULT_MAX_FIELD_LEN = 200;
const DEFAULT_TOP_K = 20;
/** 字段是否对 agent 可见（§3.6：非 owner/writers 不进观察；display:'hidden' 排除） */
function isFieldVisibleToAgent(field) {
    if (!field.display)
        return false;
    const writers = field.ownership?.writers ?? [];
    return writers.includes('*') || writers.includes('agent') || field.ownership?.owner === 'agent';
}
/** 截断长文本（保留前缀 + 长度标记，§3.6） */
function truncateValue(value, maxLen) {
    if (typeof value === 'string' && value.length > maxLen) {
        return `${value.slice(0, maxLen)}…（共 ${value.length} 字符，已截断）`;
    }
    if (Array.isArray(value)) {
        return value.slice(0, Math.max(1, Math.floor(maxLen / 16))).map((item) => truncateValue(item, Math.floor(maxLen / 8)));
    }
    if (value && typeof value === 'object') {
        const out = {};
        for (const [key, item] of Object.entries(value)) {
            out[key] = truncateValue(item, Math.floor(maxLen / 4));
        }
        return out;
    }
    return value;
}
/** 读字段当前值（含 pending 建议值）；不存在的字段跳过 */
function readFieldValue(state, path) {
    return hasAtPath(state.stat_data, path) ? getAtPath(state.stat_data, path) : undefined;
}
/**
 * 观察层输出（§3.6/§10.1 observe）。
 * @param c        契约
 * @param state    运行时状态
 * @param due      本轮到期字段（dueFields 输出）
 * @param deps     computeDependencies 的可达依赖图（due ∪ 传递依赖，深度 ≤ maxDependencyDepth）
 * @param pending  pending op 路径（Agent 待复核项）
 * @param opts     观察参数（maxFieldLen/topK/sensitiveMask/includePending）
 */
function observe(c, state, due, deps = new Map(), pending = [], opts = {}) {
    const maxFieldLen = opts.maxFieldLen ?? DEFAULT_MAX_FIELD_LEN;
    const topK = opts.topK ?? DEFAULT_TOP_K;
    // 字段选择顺序：due（按契约声明序）→ 依赖（去重，按契约声明序）→ pending
    const ordered = [];
    const seen = new Set();
    const declarationOrder = Object.keys(c.updateRules);
    const rank = new Map(declarationOrder.map((path, index) => [path, index]));
    const push = (path) => {
        if (seen.has(path))
            return;
        seen.add(path);
        ordered.push(path);
    };
    // due 优先（保持契约声明顺序）
    for (const path of declarationOrder)
        if (due.includes(path))
            push(path);
    // 依赖随后（深度 ≤ maxDependencyDepth 的传递依赖，已由 deps 图给出）
    const depSet = new Set();
    for (const depsOf of deps.values())
        for (const dep of depsOf)
            depSet.add(dep);
    for (const path of [...depSet].sort((a, b) => (rank.get(a) ?? 0) - (rank.get(b) ?? 0)))
        push(path);
    const fields = [];
    let visibleCount = 0;
    let foldedCount = 0;
    for (const path of ordered) {
        const field = c.updateRules[path];
        if (!field)
            continue;
        // 可见性控制（§3.6）：display:'hidden' 与 ownership 越权字段不进观察
        if (!isFieldVisibleToAgent(field))
            continue;
        const value = readFieldValue(state, path);
        if (value === undefined && !pending.some((p) => p.op.path === path))
            continue;
        // top-K 聚合（§3.6）：超出的字段折叠为摘要行（按契约声明序截断，due 优先故前排安全）
        if (visibleCount >= topK) {
            foldedCount += 1;
            continue;
        }
        const masked = opts.sensitiveMask === true && (field.ownership?.owner ?? 'agent') !== 'agent';
        fields.push({
            path,
            value: masked ? undefined : truncateValue(value, maxFieldLen),
            masked,
        });
        visibleCount += 1;
    }
    // pending（Agent 待复核项，§3.6 includePending）
    const includePending = opts.includePending ?? true;
    if (includePending) {
        for (const item of pending) {
            fields.push({
                path: `${item.op.path} [pending]`,
                value: {
                    op: item.op.op,
                    value: item.op.value,
                    rationale: item.rationale ?? '',
                    reason: item.reason ?? '',
                },
            });
        }
    }
    const foldedSummary = foldedCount > 0 ? `另有 ${foldedCount} 个字段未变化/未展示（top-K=${topK} 折叠）` : undefined;
    return { fields, foldedSummary };
}

function buildStateTableView(c, state, mode) {
    const fields = [];
    const lastTurn = state.meta.lastTurnId;
    for (const field of Object.values(c.updateRules)) {
        if (mode === 'incremental' && (state.meta.lastUpdated?.[field.path] ?? -1) !== lastTurn)
            continue;
        if (!hasAtPath(state.stat_data, field.path))
            continue;
        fields.push({ path: field.path, value: getAtPath(state.stat_data, field.path) });
    }
    return { mode, fields, contract: c };
}
const MODE_MARKERS = {
    every_turn: '[每轮]',
    fixed: '[固定]',
    every_n_turns: '[每N轮]',
    trigger: '[触发]',
};
/**
 * 状态表注入文本（§10.1 renderStateTable）。
 * 格式（默认视图）：`路径: 类型 = 当前值`；summary 模式只给 `路径: 类型`（§8 高级视图）。
 */
function renderStateTable(c, state, mode = 'full') {
    const view = buildStateTableView(c, state, mode);
    const lines = [];
    for (const item of view.fields) {
        const field = c.updateRules[item.path];
        const type = field?.type ?? 'unknown';
        const marker = field ? (MODE_MARKERS[field.updateMode] ?? '') : '';
        if (mode === 'summary') {
            lines.push(`${item.path}: ${type}${marker ? ` ${marker}` : ''}`);
        }
        else {
            lines.push(`${item.path}: ${type} = ${JSON.stringify(item.value)}${marker ? ` ${marker}` : ''}`);
        }
    }
    return lines.join('\n');
}
/** 简易 token 估算：约 1.5 字符/token（±20% 精度即可，§10.1 方向 6 同口径） */
function estimateTokens(text) {
    return Math.ceil(text.length / 1.5);
}

var render = /*#__PURE__*/Object.freeze({
    __proto__: null,
    buildStateTableView: buildStateTableView,
    estimateTokens: estimateTokens,
    renderStateTable: renderStateTable
});

/**
 * KaleidoCache 核心（§5/§10.3，前缀分片缓存，纯 TS）。
 *
 * 分层（§5.1）：
 * - L0 任务/破限模板（全社区统一，字节恒定）
 * - L1 契约 + STABLE_BATCH 静态引用（只列 path_id 不携值，§17.13-C1）
 * - L2 低频池未到期沿用值（字节恒定）
 * - L3 动态尾部（动态池增量 + 静态值快照区 + 最近剧情 + user_input + EJS activeEntries）
 * 组合矩阵（§7）：static+stable→L1 引用；static+frozen→不注入；lowfreq+stable→L2；
 * dynamic+volatile→L3；frozen→不注入；其余按 classifyField 落点映射。
 *
 * 附：LRU 分片缓存、字段池自学习、命中率埋点（PHit）、RSI 跨轮对账（hash64）、
 * L3 绿灯缓存（G1）、最近剧情 squash（G7）。
 */
/** 字段在本轮的注入落点（classifyField × stability，§7 组合矩阵默认映射） */
function fieldSlot(field) {
    const pool = classifyField(field);
    const stability = field.stability ?? (pool === 'dynamic' ? 'volatile' : 'stable');
    if (stability === 'frozen')
        return 'none';
    if (pool === 'static' && stability === 'stable')
        return 'l1_ref';
    if (pool === 'lowfreq' && stability === 'stable')
        return 'l2_value';
    if (pool === 'dynamic' && stability === 'volatile')
        return 'l3_value';
    // 其余未列组合（§7）：按池落点映射
    if (pool === 'static')
        return 'l1_ref';
    if (pool === 'lowfreq')
        return 'l2_value';
    return 'l3_value';
}
/** 按契约声明顺序输出静态池 pathIds（进 STABLE_BATCH 引用） */
function staticBatchPaths(c) {
    return Object.values(c.updateRules)
        .filter((f) => fieldSlot(f) === 'l1_ref')
        .map((f) => f.path);
}
/** STABLE_BATCH 引用 token（§17.13-C1：只列 path_id 不携值） */
function renderStableBatch(ref) {
    return `<STABLE_BATCH schema="${ref.schemaId}" paths="${ref.pathIds.join(',')}"/>`;
}
/** L1 契约段：changeRule 汇总（确定性序列化：契约声明顺序） */
function renderContractRules(c) {
    const lines = ['# 变量更新规则（契约）'];
    for (const field of Object.values(c.updateRules)) {
        if (field.changeRule) {
            lines.push(`- ${field.path}：${field.changeRule}`);
        }
    }
    return lines.join('\n');
}
/**
 * 构建 L0-L2 前缀分片（§10.3）。确定性：同输入同输出（前缀字节恒定 = KV-Cache 命中的前提）。
 * 返回 { segments, fingerprint }；fingerprint = hash64(L0+L1+L2)。
 */
function buildPrefixSegments(c, state, due, opts = {}) {
    const segments = [];
    // L0 任务/破限模板
    if (opts.l0) {
        segments.push({
            id: 'L0', content: opts.l0, fingerprint: hash64(opts.l0), tier: 0, ttl: null,
        });
    }
    // L1 契约 + STABLE_BATCH 静态引用
    const l1Lines = [renderContractRules(c)];
    const pathIds = staticBatchPaths(c);
    if (pathIds.length) {
        l1Lines.push(renderStableBatch({ schemaId: opts.contractId ?? c.id, pathIds }));
    }
    const l1Content = l1Lines.join('\n');
    segments.push({
        id: 'L1', content: l1Content, fingerprint: hash64(l1Content), tier: 1, ttl: null,
    });
    // L2 低频池未到期沿用值（due 之外的低频 stable 字段，字节恒定；到期字段移 L3）
    const l2Lines = [];
    for (const field of Object.values(c.updateRules)) {
        if (fieldSlot(field) !== 'l2_value')
            continue;
        if (due.includes(field.path))
            continue; // 本轮到期 → L3 增量
        if (!hasAtPath(state.stat_data, field.path))
            continue;
        l2Lines.push(`${field.path}: ${JSON.stringify(getAtPath(state.stat_data, field.path))}`);
    }
    if (l2Lines.length) {
        const l2Content = `# 沿用值（低频字段）\n${l2Lines.join('\n')}`;
        segments.push({
            id: 'L2', content: l2Content, fingerprint: hash64(l2Content), tier: 2, ttl: null,
        });
    }
    const fingerprint = hash64(segments.map((s) => s.content).join('\n###\n'));
    return { segments, fingerprint };
}
/**
 * 最近剧情 squash（G7，§5.1/还原文档 §5）：取最近 N 条 → 全列表相邻同发件人消息合并 → 去重。
 * 目的：L3 尾部长度受控、前缀字节稳定。
 * （梦鲸审计修正：squash_nearby 不包裹 <observed_piece>——包裹仅 squash_into_one 的 g+y 段；
 * 此处对齐 squash_nearby 语义：纯合并。）
 */
function squashRecentStory(messages, maxMessages = 12) {
    const recent = messages.slice(-maxMessages * 3); // 取 3 倍窗口供合并
    const squashed = [];
    for (const msg of recent) {
        const last = squashed.at(-1);
        if (last && last.role === msg.role && (last.name ?? '') === (msg.name ?? '')) {
            last.content = `${last.content}\n${msg.content}`;
        }
        else {
            squashed.push({ ...msg, content: msg.content });
        }
    }
    // 去重（完全相同的连续内容）
    const deduped = squashed.filter((msg, index) => index === 0 || msg.content !== squashed[index - 1].content);
    return deduped.slice(-maxMessages);
}
/**
 * 构建 L3 动态尾部消息（§10.3 buildTail）。
 * 组成：观察层字段（动态池增量 + 静态值快照区）→ activeEntries → 最近剧情（squash）→ user_input。
 * 超预算按行截断（KV-Cache 硬约束：前缀恒定，尾部受控）。
 */
function buildTail(input) {
    const { contract, state, due, observation, activeEntries, recentStory, userInput, budget } = input;
    const lines = [];
    // 0. Full Refresh 全量快照校准（CFS 审计项 8：每 K 轮把当前全量数据塞一份做完整快照，防长会话漂移）
    if (input.fullRefresh) {
        lines.push('<!-- NLKaleido Full Refresh: 全量 stat_data 快照（周期校准） -->');
        lines.push('```json');
        lines.push(JSON.stringify(state.stat_data));
        lines.push('```');
    }
    // 1. 静态值快照区（§5.4/CFS 审计修正）：static+stable 字段的值**恒**呈现（fixed 永不到期，
    //    若只按 due 命中呈现 Agent 将永远看不到它们；CFS 同义语义 = stable 值按 schema 理解）。
    //    值未变 → 行字节恒定（前缀稳定）；值变 → 仅该行更新。
    const staticFields = Object.values(contract.updateRules).filter((f) => fieldSlot(f) === 'l1_ref');
    if (staticFields.length) {
        lines.push('# 静态字段（值在契约层维护，STABLE_BATCH 仅引用）');
        for (const field of staticFields) {
            const value = hasAtPath(state.stat_data, field.path) ? getAtPath(state.stat_data, field.path) : undefined;
            lines.push(value === undefined ? `${field.path}: (未设置)` : `${field.path}: ${JSON.stringify(value)}`);
        }
    }
    // 2. 观察层字段（动态池增量；stable 本轮变化 → 此处暴露真实新值，CFS present→delta 语义）
    const fields = observation?.fields ?? due.map((path) => ({
        path,
        value: hasAtPath(state.stat_data, path) ? getAtPath(state.stat_data, path) : undefined,
        masked: false,
    }));
    if (fields.length) {
        lines.push('# 当前状态（本轮可见）');
        for (const field of fields) {
            const def = contract.updateRules[field.path];
            if (!def)
                continue;
            if (field.masked) {
                lines.push(`${field.path}: [已脱敏]`);
            }
            else if (field.value === undefined) {
                lines.push(`${field.path}: (未设置)`);
            }
            else {
                lines.push(`${field.path}: ${JSON.stringify(field.value)}`);
            }
        }
        if (observation?.foldedSummary)
            lines.push(observation.foldedSummary);
    }
    // 3. EJS activeEntries（M11；MVP 空集合，挂 L3 尾部槽位，§17.6）
    if (activeEntries && activeEntries.size) {
        lines.push('# 已生效条目');
        for (const entry of activeEntries)
            lines.push(`- ${entry}`);
    }
    const tail = [];
    let used = 0;
    const pushLineBlock = (block) => {
        const cost = estimateTokens(block);
        if (used + cost <= budget) {
            tail.push({ role: 'system', content: block });
            used += cost;
        }
    };
    if (lines.length)
        pushLineBlock(lines.join('\n'));
    // 3a. L3「记忆段」（§20.6：top-K 计入 maxStatusTokens 预算；只进 L3，前缀恒定）
    if (input.memorySegment)
        pushLineBlock(input.memorySegment);
    // 3b. L3「世界推演段」（§22.7：事件链/风声；只进 L3，前缀恒定）
    if (input.plotSegment)
        pushLineBlock(input.plotSegment);
    // 3. 最近剧情（squash 后）
    const squashed = recentStory?.length ? squashRecentStory(recentStory) : [];
    for (const msg of squashed) {
        const cost = estimateTokens(msg.content);
        if (used + cost > budget)
            break;
        tail.push(msg);
        used += cost;
    }
    // 4. user_input
    if (userInput) {
        const cost = estimateTokens(userInput);
        if (used + cost <= budget) {
            tail.push({ role: 'user', content: userInput });
            used += cost;
        }
    }
    return tail;
}

/**
 * op 校验与状态应用（§4.7/§4.8/§10.1，KaleidoCore 纯函数模块）。
 *
 * - gateConfidence：置信度门控（§4.2 低置信不写 → pending）。
 * - validateOps：契约护栏校验（类型/fixed 拒绝/cap 频率/ttl 失效/所有权 writers 白名单/
 *   同轮同 path 冲突按 priority/merge 裁决/不变量）；含 sanitizeJsonPatch 前置（§4.8）。
 * - applyOps：幂等（turn_id+path 去重）+ changelog + revision/meta 维护（§4.3/§7）。
 * - checkInvariants + evaluateCondition：跨字段不变量（白名单谓词，禁 eval，§17.4 强类型断言）。
 *
 * 依赖：path.ts（安全寻址）、hash.ts（hash64 指纹）、types.ts。
 */
// ============================================================
// 置信度门控（§4.2 / §10.1）
// ============================================================
const CONFIDENCE_RANK = { low: 0, medium: 1, high: 2 };
function confidenceRank(c) {
    return CONFIDENCE_RANK[c] ?? 1;
}
/** 置信度门控：低于契约 minConfidence → pending；否则 apply。reject 仅用于缺失 op 形状（validateOps 处理）。 */
function gateConfidence(c, op) {
    const conf = op.confidence ?? 'medium';
    return confidenceRank(conf) >= confidenceRank(c.guardrails.minConfidence) ? 'apply' : 'pending';
}
// ============================================================
// 所有权（§4.7）
// ============================================================
/** 写者是否在白名单：'*' 表示任意；默认 [owner]（parseContract 归一化后必填） */
function isWriterAllowed(field, source) {
    const writers = field.ownership?.writers ?? [field.ownership?.owner ?? 'agent'];
    return writers.includes('*') || writers.includes(source);
}
// ============================================================
// 类型兼容（§7 FieldDef.type）
// ============================================================
function typeCompatible(field, value) {
    switch (field.type) {
        case 'number':
            return typeof value === 'number' && Number.isFinite(value);
        case 'string':
            return typeof value === 'string';
        case 'boolean':
            return typeof value === 'boolean';
        case 'list':
            return Array.isArray(value);
        case 'kv':
        case 'object':
            return value !== null && typeof value === 'object' && !Array.isArray(value);
        default:
            return false;
    }
}
/** schema.range 与 §23 类特例（魅力/幸运 1~100 等由 FieldDef 声明，MVP 只查 schema.range） */
function checkRange(field, value) {
    field.type === 'number' ? findNumberRange() : null;
    return null;
}
function findNumberRange(field) {
    // MVP：range 声明在契约 schema 树中；FieldDef 无独立 range 键。
    return null;
}
// ============================================================
// cap 频率上限（§7 FieldDef.cap，以 changelog 为事实源）
// ============================================================
function capExceeded(field, state, turnId) {
    const cap = field.cap;
    if (!cap)
        return false;
    const log = state.changelog.filter((e) => e.path === field.path);
    if (cap.perTurn != null) {
        const thisTurn = log.filter((e) => e.turnId === turnId).length;
        if (thisTurn >= cap.perTurn)
            return true;
    }
    if (cap.perNTurns != null) {
        const recent = log.filter((e) => turnId - e.turnId < cap.perNTurns).length;
        if (recent >= cap.perNTurns)
            return true;
    }
    return false;
}
/**
 * 契约护栏校验（含所有权检查 §4.7）。
 * 纯函数：不改 state，返回 applied/rejected 分列；同轮同 path 冲突按顺序应用（单源批次），
 * 跨源冲突由 commit 串行器裁决（§17.14-S1）。
 */
function validateOps(c, state, ops, turnId, opts = {}) {
    const source = opts.source ?? 'agent';
    const applied = [];
    const rejected = [];
    const working = structuredClone(state.stat_data);
    for (const op of ops) {
        try {
            if (applied.length >= c.guardrails.maxOpsPerTurn) {
                rejected.push({ op, reason: `max_ops：超过每轮上限 ${c.guardrails.maxOpsPerTurn}` });
                continue;
            }
            // 1. 路径安全（§17.4 原型链防护）
            const tokens = parsePath$1(op.path);
            if (tokens.length === 0) {
                rejected.push({ op, reason: 'bad_path：路径为空' });
                continue;
            }
            // 2. 字段必须已在契约声明（或为声明字段的合法子路径）
            const field = c.updateRules[op.path];
            if (!field) {
                rejected.push({ op, reason: `unknown_path：路径未在契约中声明：${op.path}` });
                continue;
            }
            // 3. 所有权 writers 白名单（§4.7-1）
            if (!isWriterAllowed(field, source)) {
                rejected.push({ op, reason: `not_owner：写者 '${source}' 不在字段 ${op.path} 的 writers 白名单` });
                continue;
            }
            // 4. fixed 拒绝修改（§6.1；manual 面板直写不经 op，agent 等一律拒绝）
            if (field.updateMode === 'fixed') {
                rejected.push({ op, reason: 'fixed_field：固定字段禁止修改' });
                continue;
            }
            // 5. ttl 到期失效（§4.2）
            const lastUpdated = state.meta.lastUpdated?.[op.path];
            if (field.ttl != null && lastUpdated != null && turnId - lastUpdated > field.ttl) {
                rejected.push({ op, reason: `expired：字段已过 ttl=${field.ttl}（最近更新于第 ${lastUpdated} 轮）` });
                continue;
            }
            // 6. cap 频率上限（§7）
            if (capExceeded(field, state, turnId)) {
                rejected.push({ op, reason: 'cap_exceeded：超过更新频率上限' });
                continue;
            }
            // 7. 类型与 op 语义
            const exists = hasAtPath(working, op.path);
            const oldValue = exists ? getAtPath(working, op.path) : undefined;
            if (op.op === 'replace') {
                if (!exists) {
                    rejected.push({ op, reason: `replace 路径不存在：${op.path}` });
                    continue;
                }
                if (!typeCompatible(field, op.value)) {
                    rejected.push({ op, reason: `type_mismatch：期望 ${field.type}，得到 ${typeOf(op.value)}` });
                    continue;
                }
                const rangeError = checkRange(field, op.value);
                if (rangeError) {
                    rejected.push({ op, reason: `range：${rangeError}` });
                    continue;
                }
                assertFiniteValue(op.value);
                setAtPath(working, op.path, structuredClone(op.value));
            }
            else if (op.op === 'delta') {
                if (field.type !== 'number') {
                    rejected.push({ op, reason: `delta 仅允许数值字段（${field.type}）` });
                    continue;
                }
                if (typeof op.value !== 'number' || !Number.isFinite(op.value)) {
                    rejected.push({ op, reason: 'delta 只允许有限数值' });
                    continue;
                }
                if (!exists || typeof oldValue !== 'number') {
                    rejected.push({ op, reason: 'delta 要求当前值为有限数值' });
                    continue;
                }
                // 浮点卫生（MVU 教训 update_variables.ts:144/1353：toPrecision(12) 防累积误差）
                const next = Number((oldValue + op.value).toPrecision(12));
                const rangeError = checkRange(field, next);
                if (rangeError) {
                    rejected.push({ op, reason: `range：${rangeError}` });
                    continue;
                }
                setAtPath(working, op.path, next);
            }
            else if (op.op === 'add') {
                if (exists) {
                    if (field.type === 'list' && Array.isArray(oldValue)) {
                        const next = [...oldValue, structuredClone(op.value)];
                        setAtPath(working, op.path, next);
                    }
                    else {
                        rejected.push({ op, reason: `add 路径已存在：${op.path}` });
                        continue;
                    }
                }
                else {
                    if (op.value === undefined) {
                        rejected.push({ op, reason: 'add 缺少 value' });
                        continue;
                    }
                    if (!typeCompatible(field, op.value)) {
                        rejected.push({ op, reason: `type_mismatch：期望 ${field.type}，得到 ${typeOf(op.value)}` });
                        continue;
                    }
                    assertFiniteValue(op.value);
                    setAtPath(working, op.path, structuredClone(op.value));
                }
            }
            else if (op.op === 'remove') {
                if (!exists) {
                    rejected.push({ op, reason: `remove 路径不存在：${op.path}` });
                    continue;
                }
                removeAtPath(working, op.path);
            }
            else if (op.op === 'move') {
                const fromExists = hasAtPath(working, op.from);
                if (!op.from || !fromExists) {
                    rejected.push({ op, reason: 'move 源路径不存在' });
                    continue;
                }
                const toField = c.updateRules[op.path];
                if (!toField) {
                    rejected.push({ op, reason: `unknown_path：目标路径未声明：${op.path}` });
                    continue;
                }
                const fromValue = structuredClone(getAtPath(working, op.from));
                if (fromValue === undefined || !typeCompatible(toField, fromValue)) {
                    rejected.push({ op, reason: 'move 源值与目标类型不兼容' });
                    continue;
                }
                removeAtPath(working, op.from);
                setAtPath(working, op.path, fromValue);
            }
            else {
                rejected.push({ op, reason: `未知 op：${String(op.op)}` });
                continue;
            }
            applied.push(op);
        }
        catch (error) {
            rejected.push({
                op,
                reason: error instanceof PathError ? `path：${error.message}` : (error instanceof Error ? error.message : String(error)),
            });
        }
    }
    // 8. 不变量校验（§7 Invariant）：在应用后的工作副本上检查，违规则拒绝「触及违规不变量相关路径」的 op
    //    （相关路径 = inv.paths ∪ condition 引用的路径——条件路径上的 op 正是触发违规的原因，§10.6-P3）
    const violated = checkInvariants(c, { ...state, stat_data: working });
    if (violated.length) {
        const violatingPaths = new Set(c.invariants
            .filter((inv) => violated.includes(inv.message))
            .flatMap((inv) => [...inv.paths, ...(inv.condition ? conditionPaths(inv.condition) : [])]));
        const survivor = [];
        const invariantRejected = [];
        for (const op of applied) {
            const fromPath = op.op === 'move' ? op.from : undefined;
            if (violatingPaths.has(op.path) || (fromPath && violatingPaths.has(fromPath))) {
                invariantRejected.push({ op, reason: `invariant：${violated.join('；')}` });
            }
            else {
                survivor.push(op);
            }
        }
        return { applied: survivor, rejected: [...rejected, ...invariantRejected] };
    }
    return { applied, rejected };
}
function typeOf(value) {
    if (value === null)
        return 'null';
    if (Array.isArray(value))
        return 'array';
    return typeof value;
}
/**
 * 应用已通过校验的 op（原地更新 state）。
 * - 幂等：同一 turnId+path+op 已有 changelog 记录 → 跳过（§4.3 turn_id+path 防重复累加）。
 * - changelog append（seq 递增）；revision { seq, hash, updatedAt } 更新；meta.lastUpdated/confidence 维护。
 */
function applyOps(state, applied, turnId, opts = {}) {
    const source = opts.source ?? 'agent';
    let seq = state.revision.seq;
    for (const op of applied) {
        // 幂等去重（§4.3：同一 turnId+path+op 重复应用不重复累加）。
        // rollback 源豁免：回滚 op 天然同 turnId+path+op（同字段多次回滚），按 seq 审计去重（rollbackEntry 已挡）。
        const dup = source !== 'rollback'
            && state.changelog.some((e) => e.turnId === turnId && e.path === op.path && e.op.op === op.op && e.source === source);
        if (dup)
            continue;
        const exists = hasAtPath(state.stat_data, op.path);
        const old = exists ? structuredClone(getAtPath(state.stat_data, op.path)) : undefined;
        if (op.op === 'replace') {
            setAtPath(state.stat_data, op.path, structuredClone(op.value));
        }
        else if (op.op === 'add') {
            // add 语义与 validateOps 对齐：list 追加 / 其余置值（§7 PatchOp）
            const current = exists ? getAtPath(state.stat_data, op.path) : undefined;
            if (Array.isArray(current)) {
                setAtPath(state.stat_data, op.path, [...current, structuredClone(op.value)]);
            }
            else {
                setAtPath(state.stat_data, op.path, structuredClone(op.value));
            }
        }
        else if (op.op === 'delta') {
            // 浮点卫生（MVU 教训：toPrecision(12) 防累积误差）
            setAtPath(state.stat_data, op.path, Number((old + op.value).toPrecision(12)));
        }
        else if (op.op === 'remove') {
            removeAtPath(state.stat_data, op.path);
        }
        else if (op.op === 'move') {
            const fromValue = structuredClone(getAtPath(state.stat_data, op.from));
            removeAtPath(state.stat_data, op.from);
            setAtPath(state.stat_data, op.path, fromValue);
        }
        seq += 1;
        const confidence = op.confidence ?? 'medium';
        const nextValue = op.op === 'remove' ? undefined : structuredClone(getAtPath(state.stat_data, op.path));
        state.changelog.push({
            seq,
            turnId,
            op: structuredClone(op),
            path: op.path,
            old,
            new: nextValue,
            rationale: op.rationale,
            confidence,
            source,
        });
        state.meta.lastUpdated = { ...(state.meta.lastUpdated ?? {}), [op.path]: turnId };
        state.meta.confidence = { ...state.meta.confidence, [op.path]: confidence };
        state.meta.lastTurnId = Math.max(state.meta.lastTurnId, turnId);
    }
    if (seq !== state.revision.seq) {
        state.revision = {
            seq,
            hash: hash64(`${JSON.stringify(state.stat_data)}|${state.contractVersion}|${seq}`),
            updatedAt: Date.now(),
        };
    }
}
function tokenize$1(condition) {
    const tokens = [];
    let i = 0;
    const s = condition;
    while (i < s.length) {
        const ch = s[i];
        if (/\s/u.test(ch)) {
            i += 1;
            continue;
        }
        if (ch === '!' && s[i + 1] === '=') {
            tokens.push({ kind: 'op', value: '!=' });
            i += 2;
            continue;
        }
        if (ch === '(' || ch === ')' || ch === '!') {
            tokens.push({ kind: 'op', value: ch });
            i += 1;
            continue;
        }
        if (ch === '&' && s[i + 1] === '&') {
            tokens.push({ kind: 'op', value: '&&' });
            i += 2;
            continue;
        }
        if (ch === '|' && s[i + 1] === '|') {
            tokens.push({ kind: 'op', value: '||' });
            i += 2;
            continue;
        }
        if (ch === '=' && s[i + 1] === '=') {
            tokens.push({ kind: 'op', value: '==' });
            i += 2;
            continue;
        }
        if (ch === '!' && s[i + 1] === '=') {
            tokens.push({ kind: 'op', value: '!=' });
            i += 2;
            continue;
        }
        if (ch === '>' || ch === '<') {
            const value = s[i + 1] === '=' ? `${ch}=` : ch;
            tokens.push({ kind: 'op', value });
            i += value.length;
            continue;
        }
        if (ch === '"' || ch === "'") {
            const quote = ch;
            let j = i + 1;
            let value = '';
            while (j < s.length && s[j] !== quote) {
                value += s[j];
                j += 1;
            }
            tokens.push({ kind: 'string', value });
            i = j + 1;
            continue;
        }
        if (/[0-9.-]/u.test(ch)) {
            let j = i;
            let value = '';
            while (j < s.length && /[0-9.eE+-]/u.test(s[j])) {
                value += s[j];
                j += 1;
            }
            const num = Number(value);
            if (Number.isFinite(num)) {
                tokens.push({ kind: 'number', value: num });
                i = j;
                continue;
            }
            throw new Error(`数值不合法：${value}`);
        }
        // 标识符（路径，允许中文/字母/数字/下划线/点/方括号）
        let j = i;
        let value = '';
        while (j < s.length && !/[\s()!=<>&|"']/u.test(s[j])) {
            value += s[j];
            j += 1;
        }
        if (!value)
            throw new Error(`无法解析：${s.slice(i)}`);
        tokens.push({ kind: 'ident', value: value.trim() });
        i = j;
    }
    tokens.push({ kind: 'eof', value: '' });
    return tokens;
}
class PredicateParser {
    tokens;
    state;
    pos = 0;
    depth = 0;
    static MAX_DEPTH = 5; // 嵌套深度上限（§17.14-S2：防递归膨胀）
    constructor(tokens, state) {
        this.tokens = tokens;
        this.state = state;
    }
    peek() {
        return this.tokens[Math.min(this.pos, this.tokens.length - 1)];
    }
    next() {
        const token = this.tokens[this.pos];
        this.pos += 1;
        return token;
    }
    parse() {
        const value = this.parseOr();
        if (this.peek().kind !== 'eof')
            throw new Error(`谓词存在多余内容：${this.peek().value}`);
        return value;
    }
    parseOr() {
        this.depth += 1;
        if (this.depth > PredicateParser.MAX_DEPTH)
            throw new Error(`谓词嵌套超过 ${PredicateParser.MAX_DEPTH} 层`);
        try {
            let left = this.parseAnd();
            while (this.peek().kind === 'op' && this.peek().value === '||') {
                this.next();
                const right = this.parseAnd();
                left = left || right;
            }
            return left;
        }
        finally {
            this.depth -= 1;
        }
    }
    parseAnd() {
        let left = this.parseUnary();
        while (this.peek().kind === 'op' && this.peek().value === '&&') {
            this.next();
            const right = this.parseUnary();
            left = left && right;
        }
        return left;
    }
    parseUnary() {
        if (this.peek().kind === 'op' && this.peek().value === '!') {
            this.next();
            return !this.parseUnary();
        }
        if (this.peek().kind === 'op' && this.peek().value === '(') {
            this.next();
            const value = this.parseOr();
            if (this.peek().kind !== 'op' || this.peek().value !== ')')
                throw new Error('缺少右括号');
            this.next();
            return value;
        }
        return this.parseAtom();
    }
    parseAtom() {
        const leftToken = this.next();
        if (leftToken.kind !== 'ident')
            throw new Error('谓词原子缺少路径');
        const path = leftToken.value;
        const opToken = this.next();
        if (opToken.kind === 'eof') {
            // 存在性谓词：路径存在即真
            return hasAtPath(this.state.stat_data, path);
        }
        if (opToken.kind !== 'op' || !['==', '!=', '>=', '<=', '>', '<'].includes(String(opToken.value))) {
            throw new Error(`谓词操作符不合法：${String(opToken.value)}`);
        }
        const rightToken = this.next();
        if (rightToken.kind !== 'number' && rightToken.kind !== 'string') {
            throw new Error('谓词右值必须是数值或字符串');
        }
        const left = getAtPath(this.state.stat_data, path);
        const right = rightToken.value;
        // 强类型断言（§17.4）：跨类型比较直接判 false
        if (left === undefined)
            return false;
        if (typeof left !== typeof right)
            return false;
        switch (opToken.value) {
            case '==': return left === right;
            case '!=': return left !== right;
            case '>=': return left >= right;
            case '<=': return left <= right;
            case '>': return left > right;
            case '<': return left < right;
            default: return false;
        }
    }
}
/** 从谓词文本提取涉及的路径标识符（供不变量违规 op 定位；解析失败 → 空数组） */
function conditionPaths(condition) {
    try {
        return tokenize$1(condition)
            .filter((token) => token.kind === 'ident')
            .map((token) => token.value);
    }
    catch {
        return [];
    }
}
/**
 * 白名单谓词求值（禁 eval，§7 Invariant.condition / §17.8 底层）。
 * 语法：`path op value (&&|&|and) ...`、`( )`、`!`；op ∈ == != >= <= > <；右值限数值/字符串。
 * 解析失败抛错（调用方降级处理）。
 */
function evaluateCondition(condition, state) {
    const tokens = tokenize$1(condition);
    return new PredicateParser(tokens, state).parse();
}
// ============================================================
// checkInvariants（§10.1：跨字段约束，违反则返回信息）
// ============================================================
/** 跨字段不变量：违反则返回 message 列表（空 = 通过）。 */
function checkInvariants(c, state) {
    const messages = [];
    for (const inv of c.invariants) {
        try {
            switch (inv.kind) {
                case 'range':
                    for (const path of inv.paths) {
                        const value = getAtPath(state.stat_data, path);
                        if (value !== undefined && inv.condition && !evaluateCondition(inv.condition, state)) {
                            messages.push(inv.message);
                            break;
                        }
                    }
                    break;
                case 'mutex': {
                    const present = inv.paths.filter((p) => hasAtPath(state.stat_data, p) && getAtPath(state.stat_data, p) !== null);
                    if (present.length > 1) {
                        messages.push(inv.message);
                    }
                    break;
                }
                case 'require_if': {
                    if (inv.condition && evaluateCondition(inv.condition, state)) {
                        const missing = inv.paths.filter((p) => !hasAtPath(state.stat_data, p) || getAtPath(state.stat_data, p) === null);
                        if (missing.length) {
                            messages.push(inv.message);
                        }
                    }
                    break;
                }
                default:
                    break;
            }
        }
        catch (error) {
            messages.push(`${inv.message}（求值异常：${error instanceof Error ? error.message : String(error)}）`);
        }
    }
    return messages;
}

/**
 * 状态生命周期维护（§4.4/§4.4.1/§7，KaleidoCore 纯函数模块）。
 *
 * - changelog 两段式（§17.14-S3）：近期 N 条 append-only log + 周期 full checkpoint；
 *   shouldCheckpoint 三个触发条件（50 轮 / 24h / 100KB，先到先触发）。
 * - rollback（§4.4/§9.1）：按 seq 单条回滚（面板单条回滚）+ 回滚审计。
 * - 导出/备份（P6）：{contract, stat_data, changelog} 打包 / 导入校验。
 * - pending 管理（§7 meta.pending）：addPending / resolvePending。
 * - replay：checkpoint + log 重放（恢复基底，§4.4.1 降级策略 1 的纯函数面）。
 */
const DEFAULT_CHANGELOG_CONFIG = Object.freeze({
    checkpointInterval: 50,
    checkpointIntervalHours: 24,
    checkpointLogSizeKB: 100,
    maxLogEntries: 1000,
    replayMaxEntries: 5000,
});
/** 未归档 log 的序列化大小（KB）——自最近 checkpoint 之后的条目；无未归档条目返回 0 */
function logSizeKB(state) {
    const lastCheckpointSeq = state.checkpoints.at(-1)?.seq ?? 0;
    const pending = state.changelog.filter((e) => e.seq > lastCheckpointSeq);
    if (!pending.length)
        return 0;
    return JSON.stringify(pending).length / 1024;
}
/** checkpoint 触发判定（§4.4.1 伪代码，纯函数）：满 50 轮 / 满 24h / 未归档 log ≥100KB，先到先触发 */
function shouldCheckpoint(state, now, config = DEFAULT_CHANGELOG_CONFIG) {
    const last = state.checkpoints.at(-1);
    if (!last) {
        // 无 checkpoint：以 log 量或轮数为准（首份 checkpoint 允许提前建立）
        return logSizeKB(state) >= config.checkpointLogSizeKB || state.changelog.length >= config.maxLogEntries;
    }
    const rounds = state.revision.seq - last.seq;
    const hours = (now - last.createdAt) / 3600e3;
    const sizeKB = logSizeKB(state);
    return rounds >= config.checkpointInterval || hours >= config.checkpointIntervalHours || sizeKB >= config.checkpointLogSizeKB;
}
/** 建立 full checkpoint（stat_data + meta 完整快照，§4.4.1 checkpointFull；shujuku 审计修正） */
function makeCheckpoint(state, reason, now = Date.now()) {
    state.checkpoints.push({
        seq: state.revision.seq,
        reason,
        stat_data: structuredClone(state.stat_data),
        meta: structuredClone(state.meta),
        createdAt: now,
    });
}
/** 裁剪 changelog：超 maxLogEntries 触发 checkpoint 后裁最旧（§4.4.1 maxLogEntries） */
function trimChangelog(state, config = DEFAULT_CHANGELOG_CONFIG, now = Date.now()) {
    if (state.changelog.length > config.maxLogEntries) {
        makeCheckpoint(state, 'periodic', now);
    }
    const lastCheckpointSeq = state.checkpoints.at(-1)?.seq ?? 0;
    // 只保留 checkpoint 之后的 log；再按条数上限裁剪最旧（保留最近 maxLogEntries 条）
    const afterCheckpoint = state.changelog.filter((e) => e.seq > lastCheckpointSeq);
    state.changelog = afterCheckpoint.slice(-config.maxLogEntries);
}
// ============================================================
// 单条回滚（§4.4 / §9.1 面板单条回滚）
// ============================================================
/** 构造某条 changelog 的逆 op（delta 取反、replace 回旧值、add 新建则 remove / 追加则回旧数组、remove 补回、move 反向） */
function reverseOp(entry) {
    switch (entry.op.op) {
        case 'delta':
            return { op: 'delta', path: entry.path, value: -entry.op.value, rationale: `rollback seq ${entry.seq}` };
        case 'replace':
            return { op: 'replace', path: entry.path, value: structuredClone(entry.old), rationale: `rollback seq ${entry.seq}` };
        case 'add':
            // 新建（old 为空）→ 删除；list 追加（old 是旧数组）→ 回旧数组
            if (entry.old === undefined) {
                return { op: 'remove', path: entry.path, rationale: `rollback seq ${entry.seq}` };
            }
            return { op: 'replace', path: entry.path, value: structuredClone(entry.old), rationale: `rollback seq ${entry.seq}` };
        case 'remove':
            return { op: 'add', path: entry.path, value: structuredClone(entry.old), rationale: `rollback seq ${entry.seq}` };
        case 'move':
            return { op: 'move', path: entry.op.from, from: entry.path, rationale: `rollback seq ${entry.seq}` };
        default:
            return null;
    }
}
/**
 * 按 seq 单条回滚（幂等：已回滚的 seq 再次回滚返回 error）。
 * 回滚本身写一条 source:'rollback' 的 changelog（审计可追溯，§4.7-4）。
 */
function rollbackEntry(state, seq) {
    const entry = state.changelog.find((e) => e.seq === seq);
    if (!entry)
        return { ok: false, error: `seq ${seq} 不存在` };
    // 子系统审计记录（plot 账本等）不进 stat_data，不可回滚（§22.5 账本语义）
    if (entry.source === 'plot' || entry.source === 'memory' || entry.source === 'dice') {
        return { ok: false, error: `seq ${seq} 属 ${entry.source} 子系统审计记录，不可回滚` };
    }
    // 防重复回滚：该 seq 之后已有针对它的 rollback
    const alreadyRolledBack = state.changelog.some((e) => e.seq > seq && e.source === 'rollback' && e.rationale === `rollback seq ${seq}`);
    if (alreadyRolledBack)
        return { ok: false, error: `seq ${seq} 已回滚过` };
    const reverse = reverseOp(entry);
    if (!reverse)
        return { ok: false, error: `seq ${seq} 的 op 类型不可回滚` };
    applyOps(state, [reverse], state.meta.lastTurnId, { source: 'rollback' });
    return { ok: true, entry };
}
function exportBundle(contract, state) {
    const bundle = {
        format: 'nlkaleido_bundle_v1',
        exportedAt: Date.now(),
        contract,
        state,
    };
    return JSON.stringify(bundle, null, 2);
}
// ============================================================
// pending 管理（§7 meta.pending）
// ============================================================
let pendingSeq = 0;
/** 入 pending（低置信/校验失败/熔断，§10.1）；返回创建的 PendingOp（供结果回传） */
function addPending(state, ops, turnId, reason) {
    const created = [];
    for (const op of ops) {
        pendingSeq += 1;
        const item = {
            id: `p_${Date.now().toString(36)}_${pendingSeq}`,
            op: structuredClone(op),
            createdAtTurn: turnId,
            rationale: op.rationale,
            reason,
        };
        state.meta.pending.push(item);
        created.push(item);
    }
    return created;
}
function writeValue(state, path, value) {
    // 面板直写（§4.6）：不经 op 校验（面板编辑是 manual 特权路径），但维持 revision 指纹
    setAtPath(state.stat_data, path, structuredClone(value));
    state.revision = {
        seq: state.revision.seq,
        hash: hash64(`${JSON.stringify(state.stat_data)}|${state.contractVersion}|${state.revision.seq}`),
        updatedAt: Date.now(),
    };
}

/**
 * 白名单谓词（§17.8 PredicateExpr + §17.14-S2 文本谓词；语义对齐 ACU seed-condition.ts）。
 *
 * - AST 形式（非文本 DSL）：{ var, op, value } | { source, contains } | { and } | { or } | { not }。
 * - 强类型断言（§17.4）：数值比较两端必须同类型，跨类型判 false；文本 contains 大小写不敏感
 *   子串匹配（ACU evaluateSeedExpression_ACU：lowerContent.includes，模糊匹配）。
 * - 安全：纯递归求值、无 eval、无 Function；嵌套深度 ≤5（§17.14-S2）；source 必须在渲染上下文
 *   白名单内（不在 → 抛错，调用方保守常开）。
 * - 只读 stat_data/meta；原型链污染防护由 path 层保证。
 */
class PredicateError extends Error {
    constructor(message) {
        super(message);
        this.name = 'PredicateError';
    }
}
/**
 * 文本谓词（§17.14-S2/ACU seed 语义）：大小写不敏感子串包含。
 * source 不存在于渲染上下文 → 抛 PredicateError（§17.8：调用方降级保守常开）。
 */
function evaluateTextContains(source, contains, sources) {
    if (!(source in sources))
        throw new PredicateError(`谓词引用的 source 不存在于渲染上下文：${source}`);
    const text = sources[source] ?? '';
    return text.toLowerCase().includes(contains.toLowerCase());
}
/** 强类型比较（§17.4）：两端同类型才比较，跨类型判 false；in/not_in 按数组/字符串包含 */
function compareStrict(left, op, right) {
    switch (op) {
        case '==': return typeof left === typeof right && left === right;
        case '!=': return typeof left !== typeof right || left !== right;
        case '>': return typeof left === 'number' && typeof right === 'number' && left > right;
        case '>=': return typeof left === 'number' && typeof right === 'number' && left >= right;
        case '<': return typeof left === 'number' && typeof right === 'number' && left < right;
        case '<=': return typeof left === 'number' && typeof right === 'number' && left <= right;
        case 'in': return Array.isArray(right) ? right.some((item) => item === left) : false;
        case 'not_in': return Array.isArray(right) ? !right.some((item) => item === left) : false;
        default: return false;
    }
}
/**
 * 谓词求值（§17.8 parsePredicate 运行时面）：纯函数、确定性、无 eval。
 * 求值抛错向上抛（单条规则调用方隔离，§17.4）。
 */
function evaluatePredicate(expr, ctx) {
    if ('and' in expr)
        return expr.and.every((item) => evaluatePredicate(item, ctx));
    if ('or' in expr)
        return expr.or.some((item) => evaluatePredicate(item, ctx));
    if ('not' in expr)
        return !evaluatePredicate(expr.not, ctx);
    if ('source' in expr)
        return evaluateTextContains(expr.source, expr.contains, ctx.sources);
    if ('var' in expr) {
        // 路径归一化：剥 stat_data. 前缀（§0.2 normalizeRefPath 同语义）
        const rawPath = expr.var.startsWith('stat_data.') ? expr.var.slice('stat_data.'.length) : expr.var;
        if (expr.op === 'exists')
            return hasAtPath(ctx.state.stat_data, rawPath);
        const left = hasAtPath(ctx.state.stat_data, rawPath) ? getAtPath(ctx.state.stat_data, rawPath) : undefined;
        if (left === undefined)
            return false;
        return compareStrict(left, expr.op, expr.value);
    }
    throw new PredicateError('谓词结构不合法');
}

/** 条目键（EntryRef → 稳定字符串键，§17.8） */
function entryKey(entry) {
    return `${entry.world}::${entry.name}`;
}
/**
 * 本地判定（§17.8 evaluateEjs）：逐规则求值条件 → on_match/on_not_match 决定启用集合。
 * 单条规则抛错 → 跳过 + log 记录（§17.4 错误隔离，不影响其它规则）。
 */
function evaluateEjs(c, state, sources) {
    const active = new Set();
    const log = [];
    for (const rule of c.ejs ?? []) {
        try {
            const conditionMet = evaluatePredicate(rule.condition, { state, sources });
            const shouldEnable = rule.mode === 'on_match' ? conditionMet : !conditionMet;
            log.push({ ruleId: rule.id, hit: shouldEnable });
            if (shouldEnable) {
                for (const entry of rule.entries)
                    active.add(entryKey(entry));
            }
        }
        catch (error) {
            const message = error instanceof PredicateError || error instanceof Error ? error.message : String(error);
            log.push({ ruleId: rule.id, hit: false, error: message });
            // 错误隔离：该规则跳过，条目保持上次激活状态（调用方以本轮 active 为准，§17.4）
        }
    }
    return { active, log };
}

/**
 * M13 记忆系统核心（§20，作者可选、默认关闭；纯 JS 零依赖）。
 *
 * 三源对照（详见《记忆系统_百家之长启示.md》与交接稿 §20.1）：
 * - livingmemory（astrbot_plugin_livingmemory，memory_atom.py / memory_engine.py / bm25_retriever.py）：
 *   记忆原子（五类型 + TTL + 三种衰减 + 访问强化 + 遗忘状态机）、反思写入、BM25 零向量检索、
 *   注入策略（system_prompt 注入破坏前缀缓存 → 万花筒废弃，只进 L3「记忆段」）。
 * - shujuku（ACU）：近/远两层记忆（近 = changelog 本地 append；远 = 达阈值批量归档）、
 *   纯 TS BM25（bigram 分词 + k1=1.5）、按楼层增量快照、纪要注入模板 `<记忆回溯>`。
 * - yuzuki-Memory：结构化记忆表（列定义 + 行记录）、楼层作用域。
 *
 * 本模块只做纯逻辑（可单测）；IO（StorageProvider 持久化 / Scheduler 调度 / L3 注入挂点 /
 * Agent 工具注册）由 adapter 与 §18 扩展架构接线。默认关闭时本模块代码不被执行（§21.6 零开销）。
 */
// ============================================================
// §20.2 常量：五类型基础 TTL 与衰减曲线（livingmemory 蒸馏）
// ============================================================
/** 基础 TTL（天），按类型（livingmemory memory_atom.py 蒸馏：情景 7 / 计划 2 / 事实 180 / 关系 90 / 偏好 60 / 未知 30） */
const BASE_TTL_DAYS = Object.freeze({
    episodic: 7,
    planned: 2,
    factual: 180,
    relational: 90,
    preference: 60,
    unknown: 30,
});
/** 各类型默认衰减曲线：线性 / 指数（半衰期=TTL/2）/ 阶梯（到期 1.0→0.05） */
const DEFAULT_DECAY = Object.freeze({
    episodic: 'exponential',
    planned: 'step',
    factual: 'exponential',
    relational: 'linear',
    preference: 'exponential',
    unknown: 'exponential',
});
/** 遗忘状态机时间窗（相对 expiresAt，毫秒）：active→expired(24h)→forgotten(7d)→delete(30d) */
const FORGET_WINDOWS_MS = Object.freeze({
    /** 过期 24 小时内 → expired */
    expired: 24 * 60 * 60 * 1000,
    /** 过期 7 天内 → forgotten */
    forgotten: 7 * 24 * 60 * 60 * 1000,
    /** 过期 30 天后 → 物理删除 */
    delete: 30 * 24 * 60 * 60 * 1000,
});
const DAY_MS = 24 * 60 * 60 * 1000;
/** 访问强化阈值：内容 token-Jaccard ≥ 0.6 视为同一记忆 → 合并强化而非新增 */
const REINFORCE_JACCARD_THRESHOLD = 0.6;
/** 强化 EMA：新值权重 0.3 / 旧值 0.7（"越回忆越牢"，平稳收敛） */
const REINFORCE_EMA = 0.3;
/** 每 1 次强化 TTL 增幅：×(1 + min(0.5, count×0.1)) */
const REINFORCE_TTL_STEP = 0.1;
const REINFORCE_TTL_CAP = 0.5;
/** 反思触发轮数（§20.5：每 N 轮在变量请求 jsonSchema 追加 memory_candidates） */
const REFLECTION_EVERY_N_TURNS = 10;
/** 远记忆归档：未归档 changelog 达阈值才批量归档（shujuku 归档语义） */
const ARCHIVE_THRESHOLD = 50;
/** 归档批大小：每批选最早 3 条压缩（整批成功才删原日志，失败保留、下轮重试） */
const ARCHIVE_BATCH_SIZE = 3;
/** RRF 融合常数（livingmemory reciprocal rank fusion 思路） */
const RRF_K = 60;
/** BM25 参数（shujuku summary-vector-hybrid-retrieval.ts：bigram + k1=1.5/b=0.75） */
const BM25_K1 = 1.5;
const BM25_B = 0.75;
/** 检索命中 → 衰减乘子过滤下限（importance × decay 过低不注入） */
const SEARCH_MIN_IMPORTANCE_DECAY = 0.15;
/** 原子实体数量上限（防单个原子撑爆图/上下文） */
const MAX_ENTITIES = 20;
/** 候选置信度门控（§4.2 复用）：低于此值不写入 */
const MEMORY_CONFIDENCE_GATE = 0.5;
// ============================================================
// §20.3 TTL / 衰减 / 遗忘状态机（纯函数，确定性）
// ============================================================
/** TTL 计算：base × (0.5 + importance) × (1 + min(0.5, count×0.1))，下限 1 天 */
function computeTtl(type, importance, reinforcementCount = 0, baseTtlDays) {
    const base = baseTtlDays ?? BASE_TTL_DAYS[type] ?? BASE_TTL_DAYS.unknown;
    const clampedImportance = Math.min(1, Math.max(0, importance));
    const reinforceFactor = 1 + Math.min(REINFORCE_TTL_CAP, Math.max(0, reinforcementCount) * REINFORCE_TTL_STEP);
    const ttl = base * (0.5 + clampedImportance) * reinforceFactor;
    return Math.max(1, ttl);
}
/**
 * 衰减分计算（0-1，1=完全记得）：
 * - linear：max(0, 1 - d/ttl)（匀速遗忘）；
 * - exponential：exp(-ln2 · d / max(0.5, ttl/2))（半衰期 = TTL/2）；
 * - step：d ≤ ttl → 1.0，否则 0.05（计划型"到期即忘"）。
 */
function computeDecayScore(decay, ttlDays, daysSince) {
    if (daysSince <= 0)
        return 1;
    switch (decay) {
        case 'linear':
            return Math.max(0, 1 - daysSince / Math.max(1, ttlDays));
        case 'step':
            return daysSince <= Math.max(1, ttlDays) ? 1 : 0.05;
        case 'exponential': {
            const halfLife = Math.max(0.5, Math.max(1, ttlDays) / 2);
            return Math.exp(-Math.LN2 * daysSince / halfLife);
        }
        default:
            return 1;
    }
}
/** 遗忘状态机推进：active → expired(过期+24h) → forgotten(过期+7d) → 过期+30d 应物理删除 */
function advanceAtomStatus(atom, now) {
    if (atom.status === 'dormant' || atom.status === 'superseded')
        return atom.status; // 手动置位不自动推进
    const pastExpiry = now - atom.expiresAt;
    if (pastExpiry <= 0)
        return 'active';
    if (pastExpiry <= FORGET_WINDOWS_MS.expired)
        return 'expired';
    if (pastExpiry <= FORGET_WINDOWS_MS.forgotten)
        return 'forgotten';
    return 'forgotten'; // >7d：仍为 forgotten；物理删除由 maintenance 按 delete 窗口执行
}
/** 是否到达物理删除窗口（过期 30 天） */
function isPurgeDue(atom, now) {
    return now - atom.expiresAt > FORGET_WINDOWS_MS.delete;
}
/** 记忆维护：推进状态 + 物理清理；返回统计（Scheduler 周期调用，§20.3） */
function maintainMemory(store, now) {
    let expired = 0;
    let forgotten = 0;
    const before = store.atoms.length;
    for (const atom of store.atoms) {
        const next = advanceAtomStatus(atom, now);
        if (next !== atom.status) {
            if (next === 'expired')
                expired += 1;
            if (next === 'forgotten')
                forgotten += 1;
            atom.status = next;
        }
    }
    store.atoms = store.atoms.filter((atom) => !isPurgeDue(atom, now));
    return { expired, forgotten, purged: before - store.atoms.length };
}
// ============================================================
// §20.4 分词与 BM25（纯 JS；shujuku bigram 思路）
// ============================================================
/**
 * 分词：CJK 连续段 → bigram（单字段保留 unigram，短查询可命中）；
 * 拉丁/数字连续段 → 小写整词。确定性、无依赖。
 */
function tokenize(text) {
    const input = String(text ?? '');
    const tokens = [];
    const CJK = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/;
    let run = '';
    let runKind = null;
    const flush = () => {
        if (!run)
            return;
        if (runKind === 'cjk') {
            if (run.length === 1)
                tokens.push(run);
            else
                for (let i = 0; i < run.length - 1; i += 1)
                    tokens.push(run.slice(i, i + 2));
        }
        else {
            tokens.push(run);
        }
        run = '';
    };
    for (const ch of input) {
        if (CJK.test(ch)) {
            if (runKind === 'latin')
                flush();
            runKind = 'cjk';
            run += ch;
        }
        else if (/[a-z0-9]/i.test(ch)) {
            if (runKind === 'cjk')
                flush();
            runKind = 'latin';
            run += ch.toLowerCase();
        }
        else {
            flush();
            runKind = null;
        }
    }
    flush();
    return tokens;
}
/** 纯 JS BM25 索引（bigram 中文分词 + IDF/tf 打分 + 长度归一化；k1=1.5/b=0.75） */
class Bm25Index {
    docs;
    df = new Map();
    avgdl;
    constructor(docs) {
        this.docs = docs.map((d) => tokenize(d));
        for (const tokens of this.docs) {
            for (const token of new Set(tokens))
                this.df.set(token, (this.df.get(token) ?? 0) + 1);
        }
        this.avgdl = this.docs.length ? this.docs.reduce((sum, t) => sum + t.length, 0) / this.docs.length : 0;
    }
    get docCount() {
        return this.docs.length;
    }
    idf(token) {
        const N = this.docs.length;
        const df = this.df.get(token) ?? 0;
        if (!df)
            return 0;
        return Math.log(1 + (N - df + 0.5) / (df + 0.5));
    }
    /** 检索 top-K（k=0 返回全部有分文档，按分降序） */
    search(query, k = 5) {
        if (!this.docs.length)
            return [];
        const queryTokens = tokenize(query);
        if (!queryTokens.length)
            return [];
        const hits = [];
        for (let i = 0; i < this.docs.length; i += 1) {
            const doc = this.docs[i];
            if (!doc.length)
                continue;
            let score = 0;
            for (const token of new Set(queryTokens)) {
                const idf = this.idf(token);
                if (idf === 0)
                    continue;
                let tf = 0;
                for (const t of doc)
                    if (t === token)
                        tf += 1;
                if (!tf)
                    continue;
                const dl = doc.length;
                const denom = tf + BM25_K1 * (1 - BM25_B + BM25_B * (dl / Math.max(1, this.avgdl)));
                score += idf * ((tf * (BM25_K1 + 1)) / denom);
            }
            if (score > 0)
                hits.push({ index: i, score });
        }
        hits.sort((a, b) => b.score - a.score);
        return k > 0 ? hits.slice(0, k) : hits;
    }
}
/** token 集合 Jaccard 相似度（强化判定：≥0.6 合并） */
function tokenJaccard(a, b) {
    const setA = new Set(tokenize(a));
    const setB = new Set(tokenize(b));
    if (!setA.size || !setB.size)
        return 0;
    let intersection = 0;
    for (const token of setA)
        if (setB.has(token))
            intersection += 1;
    return intersection / (setA.size + setB.size - intersection);
}
/** RRF 融合（多检索路：BM25/向量 M13f/图 M13e；rank 从 1 起，k=60） */
function rrfFusion(lists, k = RRF_K) {
    const scores = new Map();
    for (const list of lists) {
        list.forEach((hit, rank) => {
            scores.set(hit.index, (scores.get(hit.index) ?? 0) + 1 / (k + rank + 1));
        });
    }
    return [...scores.entries()].map(([index, score]) => ({ index, score })).sort((a, b) => b.score - a.score);
}
// ============================================================
// §20.5 分类与强化
// ============================================================
const CLASSIFY_PATTERNS = [
    { type: 'planned', re: /(打算|计划|准备|下次|明天|后天|下周|下个月|稍后|晚点|记得|要去|即将|待办|日程|安排)/ },
    { type: 'preference', re: /(喜欢|讨厌|最爱|不喜欢|偏好|希望|想要|怕|恐惧|爱(吃|看|听|玩)|癖好)/ },
    { type: 'relational', re: /(关系|恋人|朋友|敌人|姐妹|兄弟|师徒|夫妻|搭档|情侣|结婚|分手|告白|和好|好感)/ },
    { type: 'factual', re: /(设定|位于|名叫|叫做|拥有|属于|职业|年龄|身高|来自|住在|工作|身份|世界|背景)/ },
    { type: 'episodic', re: /(发生|当时|那天|刚才|刚刚|今天|昨天|经过|经历|事件)/ },
];
/** 本地关键词分类（LLM 未给 type 时的兜底；顺序：计划 → 偏好 → 关系 → 事实 → 情景 → 未知） */
function classifyAtom(content) {
    for (const { type, re } of CLASSIFY_PATTERNS) {
        if (re.test(content))
            return type;
    }
    return 'unknown';
}
/** 构造记忆原子（hash64 去重 id + TTL/expiresAt 计算；candidates 半成品 → 完整原子） */
function makeAtom(input) {
    const type = input.type ?? classifyAtom(input.content);
    const importance = Math.min(1, Math.max(0, input.importance ?? 0.5));
    const confidence = Math.min(1, Math.max(0, input.confidence ?? 0.5));
    const ttlDays = computeTtl(type, importance);
    const createdAt = input.createdAt ?? Date.now();
    return {
        id: hash64(input.content),
        type,
        content: input.content,
        entities: (input.entities ?? []).slice(0, MAX_ENTITIES),
        importance,
        confidence,
        createdAt,
        lastAccessedAt: createdAt,
        eventTime: input.eventTime,
        ttlDays,
        expiresAt: createdAt + ttlDays * DAY_MS,
        status: 'active',
        reinforcementCount: 0,
        decay: input.decay ?? DEFAULT_DECAY[type],
        scope: input.scope ?? 'chat',
        floorId: input.floorId,
        turnId: input.turnId ?? 0,
    };
}
/** 访问/命中强化：Jaccard ≥ 0.6 合并强化（EMA 0.7/0.3 + TTL 延长），否则视为新记忆 */
function reinforceAtom(existing, incoming, now) {
    const similar = tokenJaccard(existing.content, incoming.content) >= REINFORCE_JACCARD_THRESHOLD;
    if (!similar)
        return existing;
    const prevImportance = existing.importance;
    const prevConfidence = existing.confidence;
    existing.importance = Math.min(1, prevImportance * (1 - REINFORCE_EMA) + incoming.importance * REINFORCE_EMA);
    existing.confidence = Math.min(1, prevConfidence * (1 - REINFORCE_EMA) + incoming.confidence * REINFORCE_EMA);
    existing.reinforcementCount += 1;
    existing.lastAccessedAt = now;
    existing.lastReinforcedAt = now;
    existing.ttlDays = computeTtl(existing.type, existing.importance, existing.reinforcementCount);
    existing.expiresAt = now + existing.ttlDays * DAY_MS;
    existing.turnId = Math.max(existing.turnId, incoming.turnId);
    const merged = new Set([...existing.entities, ...incoming.entities]);
    existing.entities = [...merged].slice(0, MAX_ENTITIES);
    if (existing.status === 'expired' || existing.status === 'forgotten')
        existing.status = 'active'; // 重新想起 → 复活
    return existing;
}
/** 原子检索分：BM25 × importance × decay（§20.4 过滤口径） */
function memorySearchScore(atom, bm25Score, now) {
    const daysSince = (now - atom.lastAccessedAt) / DAY_MS;
    const decay = computeDecayScore(atom.decay, atom.ttlDays, Math.max(0, daysSince));
    return bm25Score * atom.importance * decay;
}
/**
 * 记忆检索：BM25 召回 → score × importance × decay → 过滤 inactive/scope/floor →
 * 命中强化（reinforcementCount+1、TTL 延长，"越回忆越牢"）。
 */
function searchMemory(store, query, options = {}) {
    const { scope = 'chat', floorId, activeOnly = true, topK = 5, now = Date.now() } = options;
    const candidates = store.atoms.filter((atom) => {
        if (atom.scope !== scope)
            return false;
        if (floorId !== undefined && atom.floorId !== undefined && atom.floorId !== floorId)
            return false;
        if (activeOnly && (atom.status !== 'active'))
            return false;
        return true;
    });
    if (!candidates.length)
        return [];
    const index = new Bm25Index(candidates.map((a) => a.content));
    const hits = index.search(query, 0);
    const ranked = hits
        .map(({ index: i, score }) => {
        const atom = candidates[i];
        const final = memorySearchScore(atom, score, now);
        return { atom, score: final };
    })
        .filter(({ atom, score }) => atom.importance * computeDecayScore(atom.decay, atom.ttlDays, Math.max(0, (now - atom.lastAccessedAt) / DAY_MS)) >= SEARCH_MIN_IMPORTANCE_DECAY && score > 0)
        .sort((a, b) => b.score - a.score)
        .slice(0, topK);
    for (const { atom } of ranked) {
        atom.reinforcementCount += 1;
        atom.lastAccessedAt = now;
        atom.ttlDays = computeTtl(atom.type, atom.importance, atom.reinforcementCount);
        atom.expiresAt = now + atom.ttlDays * DAY_MS;
    }
    return ranked.map(({ atom }) => atom);
}
/**
 * L3「记忆段」注入文本（shujuku `<记忆回溯>` 模板；只进 L3 尾部，绝不碰 L0-L2 前缀）。
 * 预算内按（importance × decay）排序截断；产出 null 表示无可用记忆。
 */
function renderMemorySegment(store, query, options) {
    const { budgetTokens, now = Date.now() } = options;
    if (budgetTokens <= 0)
        return null;
    const atoms = searchMemory(store, query, { activeOnly: true, topK: 10, now });
    if (!atoms.length)
        return null;
    const lines = ['<记忆回溯>'];
    let used = estimateTokens('<记忆回溯>\n</记忆回溯>');
    for (const atom of atoms) {
        const daysSince = Math.max(0, (now - atom.lastAccessedAt) / DAY_MS);
        const decay = computeDecayScore(atom.decay, atom.ttlDays, daysSince);
        const line = `- [${atom.type}·衰减${decay.toFixed(2)}] ${atom.content}`;
        const cost = estimateTokens(line);
        if (used + cost > budgetTokens)
            break;
        lines.push(line);
        used += cost;
    }
    if (lines.length === 1)
        return null;
    lines.push('</记忆回溯>');
    return lines.join('\n');
}
// ============================================================
// §20.5 反思写入（变量通道 jsonSchema 追加字段；不新增请求）
// ============================================================
const ATOM_TYPES = ['episodic', 'factual', 'relational', 'preference', 'planned', 'unknown'];
/** 反思 jsonSchema 片段（合并进 §10.2 变量请求 schema；可选字段，默认关闭） */
function buildReflectionSchema() {
    return {
        memory_candidates: {
            type: 'array',
            description: '本轮对话中值得长期记住的新事实/事件/关系/偏好/计划（没有就省略或给空数组）',
            maxItems: 8,
            items: {
                type: 'object',
                properties: {
                    content: { type: 'string', description: '一句话记忆内容（主语明确、可脱离上下文理解）' },
                    type: { type: 'string', enum: [...ATOM_TYPES] },
                    importance: { type: 'number', minimum: 0, maximum: 1, description: '重要度 0-1' },
                    confidence: { type: 'number', minimum: 0, maximum: 1, description: '置信度 0-1' },
                    entities: { type: 'array', items: { type: 'string' }, maxItems: 20, description: '涉及的角色/物品/地点' },
                },
                required: ['content'],
                additionalProperties: false,
            },
        },
    };
}
/** 从变量请求响应中收集记忆候选（容错：非对象/缺 content 跳过；LLM 未给 type → classifyAtom） */
function collectMemoryCandidates(parsed, context = {}) {
    if (!parsed || typeof parsed !== 'object')
        return [];
    const raw = parsed.memory_candidates;
    if (!Array.isArray(raw))
        return [];
    const atoms = [];
    for (const item of raw) {
        if (!item || typeof item !== 'object')
            continue;
        const candidate = item;
        const content = typeof candidate.content === 'string' ? candidate.content.trim() : '';
        if (!content)
            continue;
        const type = ATOM_TYPES.includes(candidate.type) ? candidate.type : classifyAtom(content);
        atoms.push(makeAtom({
            content,
            type,
            entities: Array.isArray(candidate.entities) ? candidate.entities.filter((e) => typeof e === 'string') : [],
            importance: typeof candidate.importance === 'number' ? candidate.importance : 0.5,
            confidence: typeof candidate.confidence === 'number' ? candidate.confidence : 0.5,
            scope: context.scope,
            floorId: context.floorId,
            turnId: context.turnId,
            createdAt: context.now,
        }));
    }
    return atoms;
}
/** 写入候选（去重 + 强化 + 置信度门控）；返回 {added, merged, dropped} */
function writeMemoryCandidates(store, candidates, now) {
    const added = [];
    const merged = [];
    const dropped = [];
    for (const incoming of candidates) {
        if (incoming.confidence < MEMORY_CONFIDENCE_GATE) {
            dropped.push(incoming);
            continue;
        }
        // 去重①：同 id（同内容）直接强化；去重②：Jaccard ≥ 0.6 的同义改写 → 合并到最相似原子
        let existing = store.atoms.find((atom) => atom.id === incoming.id && atom.scope === incoming.scope);
        if (!existing) {
            let best;
            let bestSim = REINFORCE_JACCARD_THRESHOLD;
            for (const atom of store.atoms) {
                if (atom.scope !== incoming.scope)
                    continue;
                const sim = tokenJaccard(atom.content, incoming.content);
                if (sim >= bestSim) {
                    best = atom;
                    bestSim = sim;
                }
            }
            existing = best;
        }
        if (existing) {
            const beforeCount = existing.reinforcementCount;
            const beforeTtl = existing.ttlDays;
            reinforceAtom(existing, incoming, now);
            if (existing.reinforcementCount !== beforeCount || existing.ttlDays !== beforeTtl)
                merged.push(existing);
            else
                dropped.push(incoming); // 不相似且不同 id：不会走到；防御分支
        }
        else {
            store.atoms.push(incoming);
            added.push(incoming);
        }
    }
    return { added, merged, dropped };
}
/**
 * 归档选择：未归档条目达阈值（默认 50）→ 取最早 ARCHIVE_BATCH_SIZE 条为一批。
 * 纯选择，不做删除——删除由 commitArchive（LLM 总结成功后）执行（整批成功才删，失败保留重试）。
 */
function selectArchiveBatch(entries, threshold = ARCHIVE_THRESHOLD, batchSize = ARCHIVE_BATCH_SIZE) {
    if (entries.length < threshold)
        return { triggered: false, batch: [], remaining: entries };
    const sorted = [...entries].sort((a, b) => a.turnId - b.turnId);
    const batch = sorted.slice(0, batchSize);
    return { triggered: true, batch, remaining: sorted };
}
/**
 * 归档提交：总结成功（summaryText 非空）→ 删除整批原条目 + 产出一条归档总结（进长期记忆）；
 * 失败（summaryText 空）→ 原批保留、下轮重试（shujuku 归档语义）。
 */
function commitArchive(entries, batch, summaryText) {
    if (!summaryText)
        return { entries, summary: null }; // 失败：整批保留
    const batchIds = new Set(batch.map((entry) => entry.id ?? `${entry.turnId}:${entry.path}:${String(entry.source ?? '')}`));
    const kept = entries.filter((entry) => !batchIds.has(entry.id ?? `${entry.turnId}:${entry.path}:${String(entry.source ?? '')}`));
    return { entries: kept, summary: summaryText };
}
/** 按楼层快照（shujuku ChatVectorRemoteMemoryBatch：楼层回退不被未来污染；§20.5） */
function snapshotByFloor(atoms) {
    const map = new Map();
    for (const atom of atoms) {
        const key = atom.floorId;
        const list = map.get(key) ?? [];
        list.push(atom);
        map.set(key, list);
    }
    return map;
}
// ============================================================
// §20.7 结构化记忆表（yuzuki：列定义 + 行记录；档案/物品/世界设定）
// ============================================================
/**
 * 列前缀语义（yuzuki memory-io.js）：
 * - `#` 追加列：upsert 时新值追加到旧值之后（分隔符「；」）；
 * - `*` 只填一次列：已有非空值则忽略新值；
 * - 首列为主键列。
 */
function columnSemantics(column) {
    if (column.startsWith('#'))
        return { key: column.slice(1), mode: 'append' };
    if (column.startsWith('*'))
        return { key: column.slice(1), mode: 'once' };
    return { key: column, mode: 'normal' };
}
function createMemoryTable(id, name, columns, floorScoped = false) {
    return { id, name, columns: [...columns], floorScoped, rows: [] };
}
/**
 * 表内 upsert：首列为主键（同主键合并，其余列按 `#`/`*` 语义写入）。
 * floorScoped 表按 floorId 隔离同主键行。
 */
function upsertTableRow(table, values, options = {}) {
    const [primaryColumn] = table.columns;
    if (!primaryColumn)
        throw new Error('记忆表缺少主键列');
    const primaryKey = columnSemantics(primaryColumn).key;
    const primaryValue = values[primaryKey];
    if (primaryValue === undefined)
        throw new Error(`缺少主键列值：${primaryKey}`);
    const existing = table.rows.find((row) => (row.values[primaryKey] ?? '') === primaryValue && (!table.floorScoped || row.floorId === options.floorId));
    if (existing) {
        for (const column of table.columns) {
            const { key, mode } = columnSemantics(column);
            const value = values[key];
            if (value === undefined)
                continue;
            const current = existing.values[key] ?? '';
            if (mode === 'once' && current)
                continue;
            existing.values[key] = mode === 'append' && current ? `${current}；${value}` : value;
        }
        return { row: existing, created: false };
    }
    const row = { id: `row-${hash64(`${table.id}:${primaryValue}:${options.floorId ?? ''}`).slice(0, 12)}`, hidden: false, values: {}, floorId: options.floorId };
    for (const column of table.columns) {
        const { key } = columnSemantics(column);
        if (values[key] !== undefined)
            row.values[key] = values[key];
    }
    table.rows.push(row);
    return { row, created: true };
}
/** 表查询：楼层过滤（floorScoped 表）+ 隐藏行过滤 + 主键精确定位 */
function queryTable(table, options = {}) {
    return table.rows.filter((row) => {
        if (table.floorScoped && options.floorId !== undefined && row.floorId !== options.floorId)
            return false;
        if (!options.includeHidden && row.hidden)
            return false;
        if (options.primaryKey !== undefined) {
            const [primaryColumn] = table.columns;
            const primary = columnSemantics(primaryColumn).key;
            if ((row.values[primary] ?? '') !== options.primaryKey)
                return false;
        }
        return true;
    });
}
/** 图构建：实体权重 = 相关原子 importance 和；边置信度 = 共现证据 × 时间衰减（证据消退） */
function buildEntityGraph(atoms, now = Date.now()) {
    const nodeWeight = new Map();
    const edgeEvidence = new Map();
    for (const atom of atoms) {
        if (atom.status === 'forgotten')
            continue;
        const daysSince = Math.max(0, (now - atom.createdAt) / DAY_MS);
        const decay = computeDecayScore(atom.decay, atom.ttlDays, daysSince);
        const evidence = atom.importance * decay;
        for (const entity of atom.entities) {
            nodeWeight.set(entity, (nodeWeight.get(entity) ?? 0) + evidence);
        }
        for (let i = 0; i < atom.entities.length; i += 1) {
            for (let j = i + 1; j < atom.entities.length; j += 1) {
                const [a, b] = atom.entities[i] < atom.entities[j] ? [atom.entities[i], atom.entities[j]] : [atom.entities[j], atom.entities[i]];
                const key = `${a}\u0000${b}`;
                const current = edgeEvidence.get(key) ?? { count: 0, confidence: 0 };
                current.count += 1;
                current.confidence += evidence; // 证据累积；衰减由 evidence 中的 decay 承担（消退）
                edgeEvidence.set(key, current);
            }
        }
    }
    const nodes = [...nodeWeight.entries()].map(([id, weight]) => ({ id, weight })).filter((n) => n.weight > 0);
    const edges = [...edgeEvidence.entries()].map(([key, value]) => {
        const [source, target] = key.split('\u0000');
        return { source, target, confidence: Math.min(1, value.confidence) };
    });
    return { nodes, edges };
}
/** 混合检索：各路召回 → RRF 融合（§20.4；默认只有 builtin:bm25） */
function hybridSearchMemory(store, query, retrievers, options = {}) {
    const { scope = 'chat', floorId, activeOnly = true, topK = 5, now = Date.now() } = options;
    const pool = store.atoms.filter((atom) => {
        if (atom.scope !== scope)
            return false;
        if (floorId !== undefined && atom.floorId !== undefined && atom.floorId !== floorId)
            return false;
        if (activeOnly && atom.status !== 'active')
            return false;
        return true;
    });
    if (!pool.length)
        return [];
    const lists = retrievers.map((retriever) => {
        const recalled = retriever.search(store, query, options);
        const indexMap = new Map();
        pool.forEach((atom, i) => indexMap.set(atom.id, i));
        return recalled
            .map((atom) => ({ atom, index: indexMap.get(atom.id) }))
            .filter((hit) => hit.index !== undefined)
            .map((hit) => ({ index: hit.index, score: 1 }));
    });
    const fused = rrfFusion(lists);
    return fused.slice(0, topK).map(({ index }) => pool[index]);
}
/** 内置 BM25 检索器（registry builtin:retriever.bm25 的默认实现） */
function bm25Retriever(id = 'builtin:retriever.bm25') {
    return {
        id,
        search(store, query, options) {
            const { scope = 'chat', floorId, activeOnly = true, topK = 10 } = options;
            const pool = store.atoms.filter((atom) => {
                if (atom.scope !== scope)
                    return false;
                if (floorId !== undefined && atom.floorId !== undefined && atom.floorId !== floorId)
                    return false;
                if (activeOnly && atom.status !== 'active')
                    return false;
                return true;
            });
            if (!pool.length)
                return [];
            const index = new Bm25Index(pool.map((a) => a.content));
            return index.search(query, topK).map((hit) => pool[hit.index]);
        },
    };
}

var memory = /*#__PURE__*/Object.freeze({
    __proto__: null,
    ARCHIVE_BATCH_SIZE: ARCHIVE_BATCH_SIZE,
    ARCHIVE_THRESHOLD: ARCHIVE_THRESHOLD,
    ATOM_TYPES: ATOM_TYPES,
    BASE_TTL_DAYS: BASE_TTL_DAYS,
    BM25_B: BM25_B,
    BM25_K1: BM25_K1,
    Bm25Index: Bm25Index,
    DEFAULT_DECAY: DEFAULT_DECAY,
    FORGET_WINDOWS_MS: FORGET_WINDOWS_MS,
    MAX_ENTITIES: MAX_ENTITIES,
    MEMORY_CONFIDENCE_GATE: MEMORY_CONFIDENCE_GATE,
    REFLECTION_EVERY_N_TURNS: REFLECTION_EVERY_N_TURNS,
    REINFORCE_EMA: REINFORCE_EMA,
    REINFORCE_JACCARD_THRESHOLD: REINFORCE_JACCARD_THRESHOLD,
    REINFORCE_TTL_CAP: REINFORCE_TTL_CAP,
    REINFORCE_TTL_STEP: REINFORCE_TTL_STEP,
    RRF_K: RRF_K,
    SEARCH_MIN_IMPORTANCE_DECAY: SEARCH_MIN_IMPORTANCE_DECAY,
    advanceAtomStatus: advanceAtomStatus,
    bm25Retriever: bm25Retriever,
    buildEntityGraph: buildEntityGraph,
    buildReflectionSchema: buildReflectionSchema,
    classifyAtom: classifyAtom,
    collectMemoryCandidates: collectMemoryCandidates,
    columnSemantics: columnSemantics,
    commitArchive: commitArchive,
    computeDecayScore: computeDecayScore,
    computeTtl: computeTtl,
    createMemoryTable: createMemoryTable,
    hybridSearchMemory: hybridSearchMemory,
    isPurgeDue: isPurgeDue,
    maintainMemory: maintainMemory,
    makeAtom: makeAtom,
    memorySearchScore: memorySearchScore,
    queryTable: queryTable,
    reinforceAtom: reinforceAtom,
    renderMemorySegment: renderMemorySegment,
    rrfFusion: rrfFusion,
    searchMemory: searchMemory,
    selectArchiveBatch: selectArchiveBatch,
    snapshotByFloor: snapshotByFloor,
    tokenJaccard: tokenJaccard,
    tokenize: tokenize,
    upsertTableRow: upsertTableRow,
    writeMemoryCandidates: writeMemoryCandidates
});

/**
 * Agent 更新循环（§0.1-A / §3.4 / §10.1，KaleidoCore 编排层）。
 *
 * - runSingleShotAgent：单次模式 = 一步 agent 请求（默认）：读状态 → 出 op → 校验 → 应用 → 记录；
 *   失败自纠重试（失败原因喂回，§3.4-D，默认 ≤1 次，guardrails.maxRetries）。
 * - runMultiStepAgent：多步模式 = get_state/apply_patch 工具循环（复杂卡）；
 *   maxSteps 护栏 + 死循环熔断（近 8 步同失败 op 哈希重复 ≥3 → loop_broken，§10.1）+
 *   token 预算联动（maxTokensPerStep，方向 6）。
 * - 两者共用同一契约 / 校验 / changelog（§0.1-A）。
 *
 * 纯编排：所有 IO（发请求 / 读工具结果）经注入的 transport，可单测。
 */
/** 失败反馈截断上限（shujuku 审计 SQL_ERROR_MARKER：截断-替换注入，防撑爆重试上下文） */
const FEEDBACK_MAX_CHARS = 2000;
/**
 * 单次模式：一步 agent 回合（§0.1-A 默认形态）。
 * 主链路：dueFields → observe → buildPrefixSegments/buildTail → request →
 * sanitizeJsonPatch → validateOps（含所有权）→ gateConfidence → applyOps + changelog。
 * 失败自纠：rejected 且 retries < maxRetries → 失败原因喂回重发（§3.4-D）。
 */
async function runSingleShotAgent(transport, opts) {
    const { contract, state, turnId } = opts;
    const result = {
        requested: false, applied: [], rejected: [], pending: [], retries: 0, usage: undefined,
        failureReasons: [], frozenDrift: [], demoted: [], thrashLocked: [],
    };
    // 1. 本轮到期字段（agent 决策范围）
    const due = dueFields(state.meta, contract, turnId);
    if (!due.length)
        return result;
    // 2. 依赖图（due ∪ 传递依赖，深度 ≤ maxDependencyDepth）
    const deps = computeDependencies(contract, due);
    // 3. 观察层（§3.6 状态投影 + 可见性控制）
    const pendingPaths = state.meta.pending.map((p) => ({ op: p.op, rationale: p.rationale, reason: p.reason }));
    const observation = observe(contract, state, due, deps, pendingPaths, opts.observationOpts);
    // 3a. EJS/CES 本地判定（§17.4/§17.8：变量更新 applyOps 之后、L3 构造之前——此处为本轮
    //     L3 构造前；产物 activeEntries 只进 L3 尾部，绝不进 L0-L2，KV-Cache 硬约束）
    const recentStoryText = (opts.recentStory ?? []).map((m) => m.content).join('\n');
    const ejsResult = evaluateEjs(contract, state, {
        recent_story: recentStoryText,
        user_input: opts.userInput ?? '',
        // §22.7：世界推演状态作为 CES 文本谓词数据源（{source:'plot_states', contains:'已爆发'}）
        plot_states: opts.plotStates ?? '',
    });
    // 4. 前缀 + 尾部（§5.1 L0-L3；Full Refresh 全量快照校准，CFS 审计项 8）
    const fullRefreshEveryN = opts.fullRefreshEveryN ?? 0;
    const { segments } = buildPrefixSegments(contract, state, due, { l0: opts.l0 });
    // 4a. L3「记忆段」（§20.6：检索 top-K 注入；预算与观察层共用 maxStatusTokens，前缀不受影响）
    const memorySegment = opts.memoryStore && opts.memoryQuery
        ? renderMemorySegment(opts.memoryStore, opts.memoryQuery, { budgetTokens: contract.guardrails.maxStatusTokens })
        : null;
    const tail = buildTail({
        contract,
        state,
        due,
        observation,
        activeEntries: ejsResult.active,
        recentStory: opts.recentStory,
        userInput: opts.userInput,
        budget: contract.guardrails.maxStatusTokens,
        fullRefresh: fullRefreshEveryN > 0 && turnId % fullRefreshEveryN === 0,
        memorySegment,
        plotSegment: opts.plotSegment,
    });
    const messages = [...segments.map((s) => ({ role: 'system', content: s.content })), ...tail];
    const maxRetries = contract.guardrails.maxRetries;
    let feedback = [];
    for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
        result.requested = true;
        result.retries = attempt;
        // 失败原因喂回（§3.4-D：自纠重试）；截断防撑爆上下文（shujuku 审计 SQL_ERROR_MARKER）
        const feedbackText = feedback.join('\n');
        const requestMessages = feedbackText
            ? [...messages, { role: 'system', content: `上一轮更新失败，请修正后重试：\n${feedbackText.slice(0, FEEDBACK_MAX_CHARS)}` }]
            : messages;
        const response = await transport.requestVariableUpdate(requestMessages, opts.jsonSchema ?? {});
        result.usage = response.usage;
        result.payload = response.payload ?? null;
        // 5. 解析 + 语法清洗（§4.8 ①）
        const { ops, errors } = sanitizeJsonPatchDetailed(response.jsonPatch, contract);
        if (!ops.length) {
            feedback = [...errors, ...feedback];
            result.failureReasons.push(...errors);
            continue; // 无有效 op：重试或结束
        }
        // 6. 校验（§10.1：契约护栏 + 所有权）+ 置信度门控（§4.2）
        const { applied, rejected } = validateOps(contract, state, ops, turnId, { source: 'agent' });
        const gated = applied.filter((op) => gateConfidence(contract, op) === 'apply');
        const lowConfidence = applied.filter((op) => gateConfidence(contract, op) === 'pending');
        // 7. 应用 + changelog
        applyOps(state, gated, turnId, { source: 'agent' });
        result.applied.push(...gated);
        // 8. 稳定性演化（CFS Fast Demote）+ frozen drift 上报
        const changedPaths = new Set(gated.map((op) => op.path));
        for (const path of changedPaths) {
            const field = contract.updateRules[path];
            if (field?.stability === 'frozen')
                result.frozenDrift.push(path); // frozen 变化 → drift（injection_strategy.js:619-627）
        }
        const demotion = stabilityDemotion(contract, changedPaths, state.meta.stabilityDemotions ?? (state.meta.stabilityDemotions = {}));
        result.demoted.push(...demotion.demoted);
        result.thrashLocked.push(...demotion.locked);
        // 9. changelog 两段式维护（shujuku 审计：生产路径接线；checkpoint 三触发条件）
        if (shouldCheckpoint(state, Date.now()))
            makeCheckpoint(state, 'periodic');
        trimChangelog(state);
        // 低置信 → pending（§4.2 低置信不写）
        if (lowConfidence.length) {
            const created = addPending(state, lowConfidence, turnId, '低置信');
            result.pending.push(...created.map((p) => ({ op: p.op, reason: p.reason ?? '低置信', id: p.id, createdAtTurn: p.createdAtTurn })));
        }
        if (!rejected.length) {
            result.rejected = [];
            break;
        }
        // 10. 失败原因结构化 → 重试（默认 ≤1）
        result.rejected = rejected;
        const reasons = rejected.map((r) => `- op[${r.op.op} ${r.op.path}]：${r.reason}`);
        result.failureReasons.push(...reasons);
        feedback = reasons;
        // 被拒 op 入 pending（供作者复核，§3.4 非法/低置信 → pending）；重试间去重（同 op+path 不重复入队）
        const fresh = rejected.filter((r) => !state.meta.pending.some((p) => p.op.op === r.op.op && p.op.path === r.op.path));
        const created = addPending(state, fresh.map((r) => r.op), turnId, '校验失败');
        result.pending.push(...created.map((p) => ({ op: p.op, reason: p.reason ?? '校验失败', id: p.id, createdAtTurn: p.createdAtTurn })));
    }
    return result;
}
const LOOP_WINDOW = 8;
const LOOP_THRESHOLD = 3;
/**
 * 多步 Agent 循环（§0.1-A / §10.1）：
 * get_state → 决策 → apply_patch → 校验 → 直至 done 或 maxSteps 耗尽。
 * 死循环熔断：近 N 步「失败原因 + 被拒 op + 低置信 op」哈希重复 ≥3 → loop_broken 提前熔断转 pending。
 * token 预算：Observation JSON 长度 ÷3 ≈ tokens（±20% 精度即可）；剩余不足 → max_tokens 提前终止。
 */
async function runMultiStepAgent(transport, opts) {
    const { contract, state, turnId } = opts;
    const maxSteps = opts.maxSteps ?? contract.guardrails.maxSteps ?? 0;
    const maxTokensPerStep = opts.maxTokensPerStep ?? contract.guardrails.maxTokensPerStep ?? 2048;
    const window = opts.breakerWindow ?? LOOP_WINDOW;
    const threshold = opts.breakerThreshold ?? LOOP_THRESHOLD;
    const result = {
        status: 'done', applied: [], pending: [], steps: 0,
        stepsCompleted: 0, tokensConsumed: 0, terminationReason: '',
    };
    if (maxSteps <= 0) {
        result.status = 'error';
        result.terminationReason = '多步模式未启用（maxSteps=0）';
        return result;
    }
    const totalBudget = maxTokensPerStep * maxSteps;
    const recentFailures = [];
    const { getState, applyPatch } = await transport.requestTools();
    for (let step = 0; step < maxSteps; step += 1) {
        result.steps = step + 1;
        // token 预算联动（方向 6）：不足 → 不发注定截断的请求
        const stateJson = await getState();
        const stepTokens = Math.ceil(stateJson.length / 3);
        if (result.tokensConsumed + stepTokens > totalBudget) {
            result.status = 'max_tokens';
            result.terminationReason = `token 预算耗尽：累计 ${result.tokensConsumed} + 本步 ${stepTokens} > ${totalBudget}`;
            break;
        }
        result.tokensConsumed += stepTokens;
        // 单步决策（护栏内）
        const ops = nextStepDecision(contract, state, stateJson);
        if (transport.isDone({ stateJson, ops })) {
            result.status = 'done';
            result.terminationReason = 'agent 判定完成';
            break;
        }
        // 应用 + 校验（apply_patch 工具）
        const toolResult = await applyPatch(ops);
        if (toolResult.ok) {
            result.applied.push(...ops);
            result.stepsCompleted += 1;
            continue;
        }
        // 失败：熔断检测（§10.1 近 N 步同 op 哈希重复 ≥3）
        const failureKey = hash64(`${toolResult.errors?.join('；') ?? ''}|${JSON.stringify(ops)}`);
        recentFailures.push(failureKey);
        if (recentFailures.length > window)
            recentFailures.shift();
        const repeats = recentFailures.filter((k) => k === failureKey).length;
        if (repeats >= threshold) {
            const created = addPending(state, ops, turnId, 'loop：近 N 步重复失败');
            result.pending.push(...created.map((p) => ({ op: p.op, reason: p.reason ?? 'loop 熔断', id: p.id, createdAtTurn: p.createdAtTurn })));
            result.status = 'loop_broken';
            result.terminationReason = `死循环熔断：同一失败 op 哈希近 ${window} 步重复 ${repeats} 次`;
            break;
        }
        // 失败原因喂回（下轮 getState 经 observe 含 pending 可感知）
        const created = addPending(state, ops, turnId, `校验失败：${toolResult.errors?.join('；') ?? '未知'}`);
        result.pending.push(...created.map((p) => ({ op: p.op, reason: p.reason ?? '失败', id: p.id, createdAtTurn: p.createdAtTurn })));
    }
    if (result.status === 'done' && result.steps >= maxSteps) {
        // 步数耗尽仍未见 done
        result.status = 'max_steps';
        result.terminationReason = `达到 maxSteps=${maxSteps}`;
    }
    return result;
}
/** 单步 agent 决策（§10.1 nextStepDecision，护栏内）：从 get_state 结果解析候选 ops */
function nextStepDecision(contract, state, stateView) {
    // 默认实现：stateView 为「上一轮产出的候选 ops JSON」（由 apply_patch 回填约定）；
    // 无候选时返回空数组（Agent 应输出 ops，transport 层负责解析）。此处做兜底容错。
    const { ops } = sanitizeJsonPatchDetailed(tryExtractOps(stateView), contract);
    return ops;
}
/** 从状态视图文本提取候选 ops（容错：找第一个 [ 到最后一个 ]） */
function tryExtractOps(text) {
    const first = text.search(/\[/u);
    const last = text.lastIndexOf(']');
    if (first >= 0 && last > first) {
        const slice = text.slice(first, last + 1);
        return slice;
    }
    return [];
}
/** apply_patch 工具语义（§10.1 applyPatchTool）：校验 + 应用 + 幂等 */
function applyPatchTool(contract, state, ops, turnId) {
    const { applied, rejected } = validateOps(contract, state, ops, turnId, { source: 'agent' });
    const gated = applied.filter((op) => gateConfidence(contract, op) === 'apply');
    const low = applied.filter((op) => gateConfidence(contract, op) === 'pending');
    applyOps(state, gated, turnId, { source: 'agent' });
    if (low.length)
        addPending(state, low, turnId, '低置信');
    return {
        applied: gated,
        rejected: [...rejected, ...low.map((op) => ({ op, reason: '低置信' }))],
    };
}

var agent = /*#__PURE__*/Object.freeze({
    __proto__: null,
    applyPatchTool: applyPatchTool,
    nextStepDecision: nextStepDecision,
    runMultiStepAgent: runMultiStepAgent,
    runSingleShotAgent: runSingleShotAgent
});

/**
 * 契约调和（§4.4/§10.1 reconcileData）：用新契约调和旧数据。
 *
 * - 缺失字段补默认（contract_init 语义：契约声明 → 初始化默认值）。
 * - 多余字段按 schema.strict 处理（严格模式剔除；宽松保留——§7 SchemaNode.loose/strict）。
 * - 类型漂移修复：旧值类型与 FieldDef.type 不符 → 回退默认值。
 * - 纯函数：返回新 stat_data（不修改入参）。
 */
/** 按 FieldDef.type 判定值是否兼容（宽松：可数字字符串不算兼容，交给 sanitize 层 coerce） */
function valueCompatible(field, value) {
    switch (field.type) {
        case 'number':
            return typeof value === 'number' && Number.isFinite(value);
        case 'string':
            return typeof value === 'string';
        case 'boolean':
            return typeof value === 'boolean';
        case 'list':
            return Array.isArray(value);
        case 'kv':
        case 'object':
            return value !== null && typeof value === 'object' && !Array.isArray(value);
        default:
            return false;
    }
}
/** 字段默认值（契约未声明 default 时按类型推断） */
function fieldDefault(field) {
    if (field.default !== undefined)
        return structuredClone(field.default);
    switch (field.type) {
        case 'number': return 0;
        case 'string': return '';
        case 'boolean': return false;
        case 'list': return [];
        case 'kv':
        case 'object': return {};
        default: return null;
    }
}
/**
 * 契约调和（§10.1 reconcileData）。
 * strict 剔除：仅当 schema.strict === true 时剔除契约未声明的顶层子树；默认宽松保留。
 */
function reconcileData(contract, stat) {
    const source = stat && typeof stat === 'object' && !Array.isArray(stat) ? stat : {};
    const out = {};
    // 1. 契约声明字段：缺失补默认；类型漂移回退默认
    for (const field of Object.values(contract.updateRules)) {
        if (hasAtPath(source, field.path)) {
            const value = getAtPath(source, field.path);
            if (valueCompatible(field, value)) {
                setAtPath(out, field.path, structuredClone(value));
            }
            else {
                setAtPath(out, field.path, fieldDefault(field));
            }
        }
        else {
            setAtPath(out, field.path, fieldDefault(field));
        }
    }
    // 2. 未声明顶层键：strict → 剔除；宽松 → 保留（含原值）
    if (contract.schema.strict !== true) {
        const declaredTops = new Set(Object.values(contract.updateRules).map((f) => parseTop(f.path)));
        for (const [key, value] of Object.entries(source)) {
            if (!declaredTops.has(key)) {
                try {
                    assertFiniteValue(value);
                    out[key] = structuredClone(value);
                }
                catch {
                    // 非法残留值剔除（防污染）
                }
            }
        }
    }
    return out;
}
function parseTop(path) {
    try {
        const tokens = parsePath$1(path);
        return String(tokens[0] ?? path);
    }
    catch (error) {
        if (error instanceof PathError)
            return path;
        throw error;
    }
}

/**
 * 周目与成就（§16，M10）：三级持久化作用域 + 周目边界 + 成就判定。
 *
 * 设计决策（实现记录）：
 * - stat_data 是**统一工作集**（所有声明的字段值都在其中，供 Agent/观察层/校验层直接使用）；
 *   persist 只决定**持久化路由**（chat → chat_metadata；run/global → extension_settings）。
 *   加载时三层合并回 stat_data；persistState 时按层拆分（adapter 侧）。
 * - 周目边界（runBoundary）判定是本地确定性谓词（var_cond 复用 §17.8 evaluatePredicate），
 *   不靠变量 AI（§16.1）。
 * - 成就触发是纯谓词（progress >= target && !unlocked），零模型成本（§16.2 关键设计决策）。
 * - 成就只增不减、跨周目累积、里程碑一次性触发；存 global 层独立结构，不进 stat_data。
 */
// ============================================================
// 层路由（§16.1）
// ============================================================
/** 字段持久化层（缺省 chat） */
function persistOf(field) {
    return field.persist ?? 'chat';
}
/** 按 persist 拆分 stat_data（persistState 路由用） */
function splitStatDataByPersist(contract, stat_data) {
    const chat = {};
    const run = {};
    const global = {};
    for (const field of Object.values(contract.updateRules)) {
        if (!hasAtPath(stat_data, field.path))
            continue;
        const value = getAtPath(stat_data, field.path);
        const target = persistOf(field) === 'run' ? run : persistOf(field) === 'global' ? global : chat;
        setAtPath(target, field.path, value);
    }
    return { chat, run, global };
}
/** 三层合并回统一 stat_data（loadState 用；chat 层缺省字段补默认值兜底） */
function mergeStatDataLayers(contract, chat, run, global) {
    const merged = reconcileData(contract, {}); // 契约声明字段全部补默认
    for (const [source, layer] of [[chat, 'chat'], [run, 'run'], [global, 'global']]) {
        for (const field of Object.values(contract.updateRules)) {
            if (persistOf(field) !== layer)
                continue;
            if (hasAtPath(source, field.path)) {
                setAtPath(merged, field.path, getAtPath(source, field.path));
            }
        }
    }
    return merged;
}
// ============================================================
// 周目（§16.1/§16.4）
// ============================================================
/** runBoundary 判定（本地确定性谓词；manual/story_end 由调用方触发） */
function checkRunBoundary(contract, state, sources) {
    const boundary = contract.runBoundary;
    if (!boundary)
        return { triggered: false };
    if (boundary.type === 'var_cond' && boundary.varCond) {
        try {
            if (evaluatePredicate(boundary.varCond, { state, sources })) {
                return { triggered: true, message: boundary.message };
            }
        }
        catch {
            return { triggered: false }; // 谓词异常 → 不触发（保守）
        }
    }
    return { triggered: false }; // manual/story_end 由外部动作触发
}
/**
 * 开始新周目（§16.4 beginNewRun）：chat 层字段重置为契约默认（contract_init 语义），
 * run/global 层值保留（同卡跨周目继承）；meta.runId+1；lastUpdated/confidence 中 chat 层键清除。
 */
function beginNewRun(state, contract, newRunId) {
    // 重建统一工作集：run/global 值保留，chat 值重置为默认
    const layers = splitStatDataByPersist(contract, state.stat_data);
    state.stat_data = mergeStatDataLayers(contract, {}, layers.run, layers.global);
    state.meta.runId = newRunId;
    // 清理 chat 层字段的调度痕迹（run/global 字段的 lastUpdated 保留）
    const lastUpdated = {};
    const confidence = {};
    for (const field of Object.values(contract.updateRules)) {
        const persist = persistOf(field);
        if (persist !== 'chat' && state.meta.lastUpdated?.[field.path] != null) {
            lastUpdated[field.path] = state.meta.lastUpdated[field.path];
        }
        if (persist !== 'chat' && state.meta.confidence[field.path]) {
            confidence[field.path] = state.meta.confidence[field.path];
        }
    }
    state.meta.lastUpdated = lastUpdated;
    state.meta.confidence = confidence;
}
// ============================================================
// 成就（§16.2/§16.4）
// ============================================================
/**
 * 成就判定（本地确定性谓词，零模型成本）：progressVar 达 target 且未解锁 → 解锁。
 * 返回**新解锁**的成就清单（调用方发 nlkaleido:achievement_unlocked 并落盘）。
 * 注意：progressVar 字段须声明 persist:'run'|'global'（跨周目累积，§16.2）。
 */
function checkAchievements(contract, state, achievements) {
    const newly = [];
    for (const achievement of achievements) {
        if (achievement.unlocked)
            continue;
        if (!hasAtPath(state.stat_data, achievement.progressVar))
            continue;
        const progress = Number(getAtPath(state.stat_data, achievement.progressVar));
        if (Number.isFinite(progress) && progress >= achievement.target) {
            achievement.unlocked = true;
            achievement.unlockedAtRun = state.meta.runId;
            newly.push(achievement);
        }
    }
    return newly;
}

/**
 * M14 配置便捷性核心（§20.13，玩家端一键配置；纯 JS 零依赖，防蠢优先）。
 *
 * - 三档位：极简（零配置直用）/ 标准（IndexedDB）/ 进阶（+webllm 向量可选）；
 * - 自动探测 + 降级链（向量 → BM25 → 纯规则关键词），逐级降级不崩溃不吓玩家；
 * - 边界处理：webllm 5s 超时放弃 / quota=0 隐私模式降内存+debounce / IndexedDB 不可用回落 extension_settings；
 * - 防奶人核心四项：破坏性二次确认 + 自动备份、配置快照一键回滚、恢复出厂、资源上限保护；
 * - 配置持久化：extension_settings.variables['nlkaleido:config']（F12）；configVersion+1 自动迁移
 *   （对齐 contractVersion 模式，§20.13.6）；
 * - 定位：前端封装，不改变底层存储/调度/注入体系；手动配置优先级高于档位自动值（§20.13.7）。
 */
const CONFIG_VERSION = 1;
/** 档位 → 默认配置（§20.13.4 表） */
function tierDefaults(tier, storage) {
    const base = {
        configVersion: CONFIG_VERSION,
        tier,
        storage: storage ?? (tier === 'minimal' ? 'memory' : 'indexeddb'),
        retrieval: tier === 'advanced' ? 'vector' : 'bm25',
        memory: {
            maxAtoms: tier === 'minimal' ? 300 : 500,
            injectTopK: tier === 'advanced' ? 6 : 5,
            archiveThreshold: 50,
            archiveBatchSize: 3,
        },
        resources: {
            maxVectorDims: 1024,
            maxMemoryTokens: tier === 'minimal' ? 800 : 1500,
        },
    };
    return base;
}
/** 应用手动覆盖层（§20.13.7：手动配置始终可用且优先级高于档位自动值） */
function applyOverrides(config) {
    if (!config.overrides)
        return config;
    const merged = { ...config, ...config.overrides, overrides: undefined };
    delete merged.overrides;
    return merged;
}
/** 自动探测（决策矩阵输入；探测抛错 → 全部按不可用，静默降级不弹错误框） */
function probeEnvironment(env = {}) {
    const notices = [];
    const errors = [];
    let indexedDB = env.indexedDB === 'available';
    if (env.probeThrows) {
        indexedDB = false;
        errors.push('探测抛错：按全部不可用处理（静默降级纯 JS 路径）');
    }
    const quota = env.quota ?? 0;
    const persisted = env.persisted ?? true;
    const privacyMode = quota === 0 || !persisted;
    if (privacyMode)
        notices.push('浏览器隐私模式：本地持久化受限，已用内存模式（关闭页面后记忆不保留）');
    if (env.indexedDB === 'throws') {
        notices.push('IndexedDB 不可用，已切换到扩展设置存储');
    }
    let webllm = 'unavailable';
    if (env.webllm === 'ready')
        webllm = 'ready';
    else if (env.webllm === 'timeout') {
        webllm = 'timeout';
        notices.push('webllm 加载超时（5s），已用 BM25');
    }
    return { indexedDB, privacyMode, webllm, bridges: env.bridges ?? [], errors, notices };
}
/** 探测结果 → 自动选档位/后端（§20.13.3 决策矩阵） */
function decideTier(probe, preferred = 'standard') {
    const degradations = [];
    const warnings = [];
    let tier = preferred;
    let storage;
    let retrieval = 'bm25';
    if (probe.indexedDB && !probe.privacyMode) {
        storage = 'indexeddb';
    }
    else if (probe.privacyMode) {
        storage = 'memory';
        degradations.push('隐私模式 quota=0 → 内存模式 + debounce 落盘到 extension_settings');
    }
    else {
        storage = 'extension_settings';
        degradations.push('IndexedDB 不可用 → 回落 extension_settings.variables 存储');
    }
    if (tier === 'advanced') {
        if (probe.webllm === 'ready') {
            retrieval = 'vector';
        }
        else {
            retrieval = 'bm25';
            tier = 'standard';
            degradations.push(probe.webllm === 'timeout' ? 'webllm 超时（5s）→ 降级 BM25' : 'webllm 未就绪 → 降级 BM25（纯 JS，功能不受影响）');
        }
    }
    else {
        degradations.push('标准/极简档：检索固定 BM25（纯 JS 零依赖）');
    }
    if (tier === 'advanced' && retrieval !== 'vector') {
        warnings.push('进阶模式需要向量后端；当前降级为 BM25 + 标准档');
    }
    if (probe.bridges.length) {
        warnings.push(`检测到可选桥接：${probe.bridges.join('、')}（需高级配置）`);
    }
    if (!probe.indexedDB && !probe.privacyMode) {
        // 无高级后端 → 纯 JS 默认路径，功能不缺失只降级高级特性
        degradations.push('无任何高级后端 → 纯 JS 默认路径（功能不缺失，仅降级高级特性）');
    }
    return { tier, config: tierDefaults(tier, storage), degradations, warnings };
}
/** 配置后自动自检（存储读写 / 检索 / 注入各跑一次） */
function runSelfCheck(config, env) {
    const items = [];
    items.push({
        id: 'storage',
        name: '存储读写',
        status: 'ok' ,
        message: `存储正常（${config.storage}）`
            ,
        fixAction: undefined ,
    });
    items.push({
        id: 'retrieval',
        name: '检索后端',
        status: env.retrievalOk ? 'ok' : 'warn',
        message: env.retrievalOk
            ? `检索正常（${config.retrieval}）`
            : `检索不可用，已降级 BM25（纯 JS）`,
        fixAction: 'reset-retrieval',
    });
    if (config.retrieval === 'vector') {
        items.push({
            id: 'vector',
            name: '向量后端',
            status: env.vectorReady ? 'ok' : 'warn',
            message: env.vectorReady ? 'webllm 就绪' : 'webllm 未就绪，向量检索已降级为 BM25',
            fixAction: 'retry-webllm',
        });
    }
    items.push({
        id: 'injection',
        name: 'L3 注入',
        status: 'ok' ,
        message: '注入正常（记忆只进 L3，前缀不受影响）' ,
    });
    const nearCap = env.maxAtoms > 0 && env.atomsCount >= env.maxAtoms * 0.9;
    if (nearCap) {
        items.push({
            id: 'memory-cap',
            name: '记忆容量',
            status: 'warn',
            message: `记忆条数接近上限（${env.atomsCount}/${env.maxAtoms}），建议开启归档`,
            fixAction: 'archive-now',
        });
    }
    return items;
}
/** 配置版本迁移：configVersion 落后 → 逐版本链式迁移（对齐 contractVersion 模式） */
function migrateConfig(stored, migrations, targetVersion = CONFIG_VERSION) {
    if (!stored || typeof stored !== 'object')
        return { config: null, migrated: false, errors: ['配置缺失或损坏（恢复默认）'] };
    const record = { ...stored };
    const errors = [];
    let version = typeof record.configVersion === 'number' ? record.configVersion : 1;
    let migrated = false;
    while (version < targetVersion) {
        const step = migrations[version - 1]; // migrations[0] 处理 v1→v2
        if (!step) {
            errors.push(`缺少 configVersion ${version}→${version + 1} 迁移步骤（保留当前配置）`);
            break;
        }
        try {
            const next = step(record);
            Object.assign(record, next);
            version += 1;
            migrated = true;
        }
        catch (error) {
            errors.push(`configVersion ${version} 迁移失败：${error instanceof Error ? error.message : String(error)}`);
            break;
        }
    }
    record.configVersion = version;
    const tier = ['minimal', 'standard', 'advanced'].includes(record.tier) ? record.tier : 'minimal';
    return { config: { ...tierDefaults(tier), ...record }, migrated, errors };
}
/** 配置快照（破坏性操作前自动调用） */
function takeSnapshot(config, reason, now = Date.now()) {
    return { id: hash64(`${now}:${reason}`), takenAt: now, reason, config: JSON.parse(JSON.stringify(config)) };
}

/**
 * M15 剧情编排引擎核心（§22，作者可选、默认关闭；纯 JS 零依赖）。
 *
 * 蒸馏自 World-master（F:\科研\打包\World-master，world-engine-evolution.js 逐行核对）：
 * - 事件链状态机：双类型（conflict/progress）+ 四阶段 + 每阶段 9 格 + Lv 分级 + 终局语义；
 * - 本地骰子/API 双驱：骰子先掷基线（成功/受挫/保持 + 保底强制成功），API 改写以 API 为准；
 * - 风声/舆论：四类（announcement/report/rumor/sentiment）+ 衰减参数（base/grace/linear/quadratic）；
 * - 区域突发事件骰子：加权随机 + 持续轮 + 冷却轮（REGIONAL_INCIDENT_CONFIG）；
 * - 感知边界：玩家全知 ≠ 主角全知（约束模板进 L0-L2 稳定段，只影响注入不破坏前缀）。
 *
 * 关键语义（source 行号见各函数注释）：
 * - 正面终局（已爆发/已完成）骰子可自动给出；负面终局（已消散/已失败）只能 API 判定（world-engine-evolution.js:580-581）；
 * - 每阶段 9 格，满 9 晋级下一阶段（:579）；终局阶段锁定 9/9（:741）；
 * - threshold = round(stageBase − 200·r·(1−r) + levelAdjust − modifier)（:618）；
 *   levelAdjust：progress +(level−1)·10（越大越难），conflict −(level−1)·10（越大越易，:617）；
 * - 受挫判定 dice < threshold × setbackRatio%（默认 40，:628）；
 * - 保底：连续非成功达 maxFails 强制成功（conflict 6−Lv（≥1）/ progress 2+Lv，:643-648）。
 */
// ============================================================
// §22.2 事件链状态机常量（world-engine-evolution.js:7-22）
// ============================================================
const EVENT_TYPES = ['conflict', 'progress'];
const PLOT_STAGE_ORDER = Object.freeze({
    conflict: ['萌芽', '发酵', '逼近'],
    progress: ['筹备', '执行', '关键'],
});
const PLOT_FINAL_STAGE = Object.freeze({
    conflict: '已爆发',
    progress: '已完成',
});
/** 终局阶段（含负面终局；负面只能 API 判定，骰子永不自动给） */
const PLOT_TERMINAL_STAGES = Object.freeze({
    conflict: ['已爆发', '已消散'],
    progress: ['已完成', '已失败'],
});
/** 各阶段基准阈值（world-engine-evolution.js:19-22） */
const PLOT_STAGE_BASE = Object.freeze({
    conflict: { '萌芽': 95, '发酵': 85, '逼近': 75 },
    progress: { '筹备': 75, '执行': 85, '关键': 95 },
});
/** 受挫判定比例（默认 40%，:628 localEventSetbackRatioPercent） */
const PLOT_SETBACK_RATIO = 0.4;
/** 骰子修正（默认 0，:618 localEventDiceModifier） */
const PLOT_DICE_MODIFIER_DEFAULT = 0;
/** 保底参数（:643-648）：conflict 6−Lv（≥1）；progress 2+Lv */
const PLOT_FAIL_BASE = Object.freeze({ conflict: 6, progress: 2 });
/** 正面终局保留轮数：base 2 + level×2（:66-70） */
const PLOT_TERMINAL_KEEP_BASE = 2;
const PLOT_TERMINAL_KEEP_PER_LEVEL = 2;
/** 事件链上限（localCapEvents，api.js 默认 16） */
const MAX_PLOT_EVENTS = 16;
const PLOT_INFLUENCE_KEEP_ROUNDS = 8;
function rollDice(randomFn) {
    return Math.floor(randomFn() * 100) + 1;
}
/** 保底阈值：连续非成功达此值 → 强制成功（:643-648） */
function maxFailsFor(event) {
    const level = event.level || 1;
    return event.type === 'progress'
        ? PLOT_FAIL_BASE.progress + level
        : Math.max(1, PLOT_FAIL_BASE.conflict - level);
}
/** 推进阈值（:614-618）：stageBase − 200·r·(1−r) + levelAdjust − modifier，r = min(1, stageRound/9) */
function eventThreshold(event, modifier = PLOT_DICE_MODIFIER_DEFAULT) {
    const r = Math.min(1, (event.stageRound || 1) / 9);
    const stageBase = (PLOT_STAGE_BASE[event.type] ?? PLOT_STAGE_BASE.conflict)[event.stage] ?? 85;
    const level = event.level || 1;
    const levelAdjust = event.type === 'progress' ? (level - 1) * 10 : -((level - 1) * 10);
    return Math.round(stageBase - 200 * r * (1 - r) + levelAdjust - modifier);
}
/** 阶段推进：stageRound+1；满 9 → 晋级下一阶段（重置 1）或进入正面终局（锁定 9）（:650-665） */
function advanceStageRound(event) {
    const stageOrder = PLOT_STAGE_ORDER[event.type] ?? PLOT_STAGE_ORDER.conflict;
    const finalStage = PLOT_FINAL_STAGE[event.type] ?? PLOT_FINAL_STAGE.conflict;
    event.stageRound = (event.stageRound || 0) + 1;
    if (event.stageRound >= 9) {
        const idx = stageOrder.indexOf(event.stage);
        if (idx !== -1 && idx < stageOrder.length - 1) {
            event.stage = stageOrder[idx + 1];
            event.stageRound = 1;
            return { promoted: true, terminalReached: false };
        }
        event.stage = finalStage;
        event.stageRound = 9;
        return { promoted: true, terminalReached: true };
    }
    return { promoted: false, terminalReached: false };
}
/**
 * 本地骰子推进一轮（双驱之一，:583-641）：
 * - 终局阶段跳过（负面终局骰子永不自动给，正面终局锁定）；
 * - 连续非成功 ≥ maxFails → 保底强制成功（防事件停滞）；
 * - dice > threshold → 成功推进；dice < threshold×setbackRatio → 受挫倒退；否则保持。
 */
function rollEventDice(input, options = {}) {
    const event = { ...input, influenceChain: input.influenceChain ? [...input.influenceChain] : undefined };
    const randomFn = options.randomFn ?? Math.random;
    const setbackRatio = options.setbackRatio ?? PLOT_SETBACK_RATIO;
    if (event.stageRound === undefined || event.stageRound === null)
        event.stageRound = 1;
    if (event.consecutiveFails === undefined)
        event.consecutiveFails = 0;
    if (!event.type || !EVENT_TYPES.includes(event.type))
        event.type = 'conflict';
    const terminalStages = PLOT_TERMINAL_STAGES[event.type] ?? PLOT_TERMINAL_STAGES.conflict;
    const stageOrder = PLOT_STAGE_ORDER[event.type] ?? PLOT_STAGE_ORDER.conflict;
    // 终局阶段：跳过（正面终局锁定 9/9；负面终局只在 API 判定后出现）
    if (terminalStages.includes(event.stage)) {
        return { event, result: '跳过', threshold: 0, dice: 0, promoted: false, terminalReached: false };
    }
    if (!event.stage || !stageOrder.includes(event.stage))
        event.stage = stageOrder[0];
    const threshold = eventThreshold(event, options.modifier ?? PLOT_DICE_MODIFIER_DEFAULT);
    // 保底：连续非成功达上限 → 强制成功（:602-611）
    if (event.consecutiveFails >= maxFailsFor(event)) {
        const { promoted, terminalReached } = advanceStageRound(event);
        event.consecutiveFails = 0;
        event.evolveResult = '成功';
        if (terminalReached)
            event.terminalRound = options.round;
        return { event, result: '保底成功', threshold, dice: 0, promoted, terminalReached };
    }
    const dice = options.dice ?? rollDice(randomFn);
    if (dice > threshold) {
        const { promoted, terminalReached } = advanceStageRound(event);
        event.consecutiveFails = 0;
        event.evolveResult = '成功';
        if (terminalReached)
            event.terminalRound = options.round;
        return { event, result: '成功', threshold, dice, promoted, terminalReached };
    }
    if (dice < threshold * setbackRatio) {
        event.stageRound = Math.max(1, event.stageRound - 1);
        event.consecutiveFails += 1;
        event.evolveResult = '受挫';
        return { event, result: '受挫', threshold, dice, promoted: false, terminalReached: false };
    }
    event.consecutiveFails += 1;
    event.evolveResult = '保持';
    return { event, result: '保持', threshold, dice, promoted: false, terminalReached: false };
}
/** 正面终局保留轮数：2 + Lv×2（:66-70）；负面终局下轮即删（:1274-1295） */
function terminalKeepRounds(event) {
    return PLOT_TERMINAL_KEEP_BASE + (event.level || 1) * PLOT_TERMINAL_KEEP_PER_LEVEL;
}
/**
 * 终局保留期维护（:1274-1295）：已消散/已失败 → 下一轮删除；
 * 已爆发/已完成 → 保留 2+Lv×2 轮（余波铺陈）后删除；删除前进 terminalSnapshot 供账本记录。
 */
function maintainPlotEvents(events, round) {
    const terminalSnapshot = [];
    const kept = events.filter((event) => {
        const terminalStages = PLOT_TERMINAL_STAGES[event.type] ?? PLOT_TERMINAL_STAGES.conflict;
        if (!terminalStages.includes(event.stage))
            return true; // 非终局保留
        const isPositive = event.stage === PLOT_FINAL_STAGE[event.type];
        const reached = event.terminalRound ?? round;
        if (!isPositive) {
            // 负面终局：下轮即删
            if (round - reached >= 1) {
                terminalSnapshot.push(event);
                return false;
            }
            return true;
        }
        if (round - reached >= terminalKeepRounds(event)) {
            terminalSnapshot.push(event);
            return false;
        }
        return true;
    });
    return { events: kept, terminalSnapshot };
}
/** 影响链合并（:1221-1228：同 trigger 更新不堆叠；cap 12；更新不续期） */
function mergeInfluences(existing, incoming, round) {
    const merged = [...existing];
    for (const item of incoming) {
        if (!item || !item.trigger || !item.impact)
            continue;
        const index = merged.findIndex((e) => e.trigger === item.trigger);
        const entry = {
            trigger: item.trigger.slice(0, 50),
            impact: item.impact.slice(0, 50),
            fallout: item.fallout?.slice(0, 50),
            // 更新不续期：保留原 createdRound
            createdRound: index >= 0 ? merged[index].createdRound : (round ?? item.createdRound),
        };
        if (index >= 0)
            merged[index] = entry;
        else
            merged.push(entry);
    }
    return merged.slice(-12);
}
/** 影响链过期清理（:1233-1247：createdRound 起保留 8 轮，更新不续期） */
function maintainPlotInfluences(events, round) {
    for (const event of events) {
        if (!event.influences?.length)
            continue;
        event.influences = event.influences.filter((item) => {
            if (item.createdRound === undefined)
                return true;
            return round - item.createdRound < PLOT_INFLUENCE_KEEP_ROUNDS;
        });
    }
}
/**
 * 账本行生成（ledger.js:19-99 语义）：事件链普通变化只记 Lv≥3；任何等级终局都记；
 * 风声仅「新增」Lv≥3 记 wind_new。返回人类可读行（写已有 changelog，source:'plot'）。
 */
function plotLedgerLines(before, after, windsBefore, windsAfter) {
    const lines = [];
    const beforeById = new Map(before.map((e) => [e.id, e]));
    const windIdsBefore = new Set(windsBefore.map((w) => w.id));
    for (const event of after) {
        const previous = beforeById.get(event.id);
        const terminalStages = PLOT_TERMINAL_STAGES[event.type] ?? PLOT_TERMINAL_STAGES.conflict;
        const isTerminal = terminalStages.includes(event.stage);
        const level = event.level || 1;
        if (!previous) {
            if (isTerminal || level >= 3)
                lines.push(`event_new: ${event.name}（${event.type} Lv${level} · ${event.stage}）`);
            continue;
        }
        if (isTerminal && previous.stage !== event.stage) {
            lines.push(`event_terminal: ${event.name} → ${event.stage}`);
            continue;
        }
        if (level >= 3 && previous.stage !== event.stage) {
            lines.push(`event_advance: ${event.name} → ${event.stage}`);
        }
    }
    for (const wind of windsAfter) {
        if (!windIdsBefore.has(wind.id) && (wind.level ?? 1) >= 3) {
            lines.push(`wind_new: [${wind.type}] ${wind.topic}`);
        }
    }
    return lines;
}
/** 新事件 id：hash64(type:name) 截断 12 位（id:null → 新建的本地兜底 id） */
function newEventId(name, type) {
    return `ev-${hash64(`${type}:${name}:${Date.now()}`).slice(0, 12)}`;
}
/**
 * API 更新合入（双驱之二：以 API 返回为准，:1149-1172）：
 * - id 已有 → 沿用原链更新（跨轮归并不拆链）；id:null → 新链；
 * - type 对已有事件不可变；name 可演变（改名不拆链）；
 * - API 可判定终局（含负面已消散/已失败）；stageRound ≥ 9 → 自动晋级；
 * - API 未给 stageRound → 沿用原值。
 */
function applyApiEventUpdates(events, updates, now = Date.now(), round) {
    const result = [...events];
    const created = [];
    const terminated = [];
    for (const update of updates) {
        if (!update || typeof update !== 'object')
            continue;
        const existing = update.id ? result.find((e) => e.id === update.id) : undefined;
        if (existing) {
            // 终局事件保护（evolution.js:1153-1158）：终局只允许改 desc，其余字段一律忽略
            const existingTerminal = PLOT_TERMINAL_STAGES[existing.type]?.includes(existing.stage);
            if (existingTerminal) {
                if (update.desc !== undefined)
                    existing.desc = update.desc;
                continue;
            }
            if (update.name !== undefined)
                existing.name = update.name;
            if (update.desc !== undefined)
                existing.desc = update.desc;
            if (update.level !== undefined)
                existing.level = Math.min(4, Math.max(1, Math.round(update.level)));
            if (update.stall !== undefined)
                existing.stall = Boolean(update.stall);
            if (update.influenceChain !== undefined)
                existing.influenceChain = update.influenceChain;
            if (update.influences !== undefined) {
                existing.influences = mergeInfluences(existing.influences ?? [], update.influences, round);
            }
            if (update.stage !== undefined && update.stage !== existing.stage) {
                existing.stage = update.stage;
                // 终局锁定 9/9（:741）；负面终局同样锁定
                if (PLOT_TERMINAL_STAGES[existing.type]?.includes(existing.stage)) {
                    existing.stageRound = 9;
                    existing.terminalRound = round;
                    terminated.push(existing);
                }
            }
            if (update.stageRound !== undefined && update.stageRound !== existing.stageRound) {
                existing.stageRound = update.stageRound;
                if (existing.stageRound >= 9) {
                    // API 写 9 → 本地自动晋级（:1161-1172）
                    const { promoted, terminalReached } = advanceStageRound(existing);
                    if (promoted)
                        existing.stageRound = PLOT_TERMINAL_STAGES[existing.type]?.includes(existing.stage) ? 9 : 1;
                    if (terminalReached)
                        existing.terminalRound = round;
                    if (PLOT_TERMINAL_STAGES[existing.type]?.includes(existing.stage))
                        terminated.push(existing);
                }
            }
            continue;
        }
        // 新链（id:null）：只有可独立演化的新冲突/推进才建链（归并语义由 prompt 约束 + id 匹配落地）
        if (update.name || update.desc) {
            const type = update.type && EVENT_TYPES.includes(update.type) ? update.type : 'conflict';
            const order = PLOT_STAGE_ORDER[type];
            const providedStage = typeof update.stage === 'string' && update.stage
                ? update.stage
                : order[0];
            const isTerminal = PLOT_TERMINAL_STAGES[type].includes(providedStage);
            const event = {
                id: newEventId(update.name ?? `unnamed-${now}`, type),
                name: update.name ?? '未命名事件',
                type,
                stage: isTerminal ? providedStage : (order.includes(providedStage) ? providedStage : order[0]),
                stageRound: isTerminal ? 9 : (update.stageRound ?? 1),
                level: Math.min(4, Math.max(1, Math.round(update.level ?? 1))),
                desc: update.desc ?? '',
                stall: update.stall,
                influenceChain: update.influenceChain,
                influences: update.influences ? mergeInfluences([], update.influences, round) : undefined,
                consecutiveFails: 0,
                terminalRound: isTerminal ? round : undefined,
            };
            if (isTerminal)
                terminated.push(event);
            result.push(event);
            created.push(event);
        }
    }
    // 上限保护（localCapEvents 默认 16：保留最新 16 条，evolution.js:1140-1188 unshift 语义）
    if (result.length > MAX_PLOT_EVENTS) {
        result.splice(0, result.length - MAX_PLOT_EVENTS);
    }
    return { events: result, created, terminated };
}
// ============================================================
// §22.5 风声 / 舆论系统（world-engine-evolution.js:23-28, 671-703）
// ============================================================
const WIND_TYPES = ['announcement', 'report', 'rumor', 'sentiment'];
/** 四类风声衰减参数（:23-28）：base/grace/linear/quadratic */
const WIND_DECAY = Object.freeze({
    announcement: { base: 10, grace: 4, linear: 3, quadratic: 1 },
    report: { base: 20, grace: 2, linear: 4, quadratic: 2 },
    rumor: { base: 25, grace: 1, linear: 5, quadratic: 3 },
    sentiment: { base: 8, grace: 5, linear: 2, quadratic: 1 },
});
/**
 * 风声消散轮（:674-703）：quietRounds+1；grace 内必存活；
 * 之后 chance = clamp(5, 95, base + linear·n + quadratic·n² − (level−1)·10)；dice ≤ chance → 消散。
 * API 同轮更新同 id 风声会把 quietRounds 归零（由 applyApiWindUpdates 处理）。
 */
function decayWinds(winds, options = {}) {
    const randomFn = options.randomFn ?? Math.random;
    const survivors = [];
    const decayed = [];
    for (const wind of winds) {
        const defaults = WIND_DECAY[wind.type] ?? WIND_DECAY.rumor;
        const params = { ...defaults, ...(options.params?.[wind.type] ?? {}) };
        const level = Math.min(4, Math.max(1, Math.round(wind.level ?? 1)));
        wind.quietRounds = Math.max(0, Math.round(wind.quietRounds ?? 0)) + 1;
        if (wind.quietRounds <= params.grace) {
            survivors.push(wind);
            continue;
        }
        const n = wind.quietRounds - params.grace - 1;
        const chance = Math.min(95, Math.max(5, params.base + params.linear * n + params.quadratic * n * n - (level - 1) * 10));
        const dice = Math.floor(randomFn() * 100) + 1;
        if (dice <= chance)
            decayed.push(wind);
        else
            survivors.push(wind);
    }
    return { survivors, decayed };
}
/** API 风声更新合入：同 id → quietRounds 归零（仍被提及 = 仍在传播）；id:null → 新增 */
function applyApiWindUpdates(winds, updates, now = Date.now()) {
    const result = [...winds];
    const created = [];
    for (const update of updates) {
        if (!update || typeof update !== 'object')
            continue;
        const existing = update.id ? result.find((w) => w.id === update.id) : undefined;
        if (existing) {
            existing.quietRounds = 0; // API 本轮提及 → 传播延续（:672-673）
            if (update.topic !== undefined)
                existing.topic = update.topic;
            if (update.content !== undefined)
                existing.content = update.content;
            if (update.level !== undefined)
                existing.level = Math.min(4, Math.max(1, Math.round(update.level)));
            continue;
        }
        if (update.topic || update.content) {
            const type = update.type && WIND_TYPES.includes(update.type) ? update.type : 'rumor';
            const wind = {
                id: `wind-${hash64(`${type}:${update.topic ?? ''}:${now}`).slice(0, 12)}`,
                type,
                topic: update.topic ?? '',
                content: update.content ?? '',
                level: Math.min(4, Math.max(1, Math.round(update.level ?? 1))),
                quietRounds: 0,
            };
            result.push(wind);
            created.push(wind);
        }
    }
    return { winds: result, created };
}
// ============================================================
// §22.3/§22.2 区域突发事件骰子（world-engine-evolution.js:84-102）
// ============================================================
const REGIONAL_INCIDENT_CONFIG = Object.freeze({
    chance: 0.03,
    durationRounds: 5,
    cooldownRounds: 5,
    typeWeights: [
        { type: 'banditry', label: '盗匪劫掠', weight: 18 },
        { type: 'fire', label: '大火', weight: 14 },
        { type: 'massacre', label: '恶性凶案', weight: 10 },
        { type: 'flood', label: '洪涝', weight: 10 },
        { type: 'infrastructure', label: '道路水利崩坏', weight: 10 },
        { type: 'plague', label: '疫病', weight: 9 },
        { type: 'famine', label: '饥荒粮荒', weight: 8 },
        { type: 'riot', label: '骚乱暴动', weight: 8 },
        { type: 'rebellion', label: '民变叛乱', weight: 5 },
        { type: 'military', label: '军务突变', weight: 4 },
        { type: 'earthquake', label: '地震山崩', weight: 2 },
        { type: 'storm', label: '风暴雪灾', weight: 2 },
    ],
});
/**
 * 区域突发事件轮（:82-102 语义）：进行中 → roundsLeft−1，归零进冷却；
 * 冷却中 → cooldown−1；空闲 → 按 chance 加权随机触发。
 */
function rollRegionalIncident(state, options = {}) {
    const randomFn = options.randomFn ?? Math.random;
    const chance = options.chance ?? REGIONAL_INCIDENT_CONFIG.chance;
    const durationRounds = options.durationRounds ?? REGIONAL_INCIDENT_CONFIG.durationRounds;
    const cooldownRounds = options.cooldownRounds ?? REGIONAL_INCIDENT_CONFIG.cooldownRounds;
    const weights = options.typeWeights ?? REGIONAL_INCIDENT_CONFIG.typeWeights;
    if (state.active) {
        state.active.roundsLeft -= 1;
        if (state.active.roundsLeft <= 0) {
            state.active;
            state.active = null;
            state.cooldown = cooldownRounds;
            return { state, started: false, ended: true };
        }
        return { state, started: false, ended: false };
    }
    if (state.cooldown > 0) {
        state.cooldown -= 1;
        return { state, started: false, ended: false };
    }
    const roll = randomFn();
    if (roll >= chance)
        return { state, started: false, ended: false };
    // 加权随机选取
    const total = weights.reduce((sum, w) => sum + w.weight, 0);
    let cursor = randomFn() * total;
    let picked = weights[0];
    for (const candidate of weights) {
        cursor -= candidate.weight;
        if (cursor <= 0) {
            picked = candidate;
            break;
        }
    }
    state.active = { type: picked.type, label: picked.label, roundsLeft: durationRounds };
    return { state, started: true, ended: false };
}
// ============================================================
// §22.4 世界非中心化 + 感知边界（约束模板，进 L0-L2 稳定段）
// ============================================================
/** 世界观约束模板（字节恒定 → 前缀稳定；作者可经 contract.plot.worldConstraints 覆盖） */
const WORLD_CONSTRAINT_TEMPLATE = [
    '# 世界观约束（恒定模板，勿修改）',
    '1. 世界是活的：NPC 有自己的生活、日程、社交圈与情感；事件链、风声、团体进度即使与玩家无关也会自动推进。',
    '2. 玩家全知 ≠ 主角全知：面板记录玩家可见的世界状态；角色只能依据亲眼所见、亲耳所闻、合法传播、调查或组织命令行动。',
    '3. 远处、隐秘、未传播的世界状态必须经风声、事件链、接触等合理路径才能进入角色认知；禁止把角色不该知道的状态塞进正文。',
    '4. 推演轮 ≠ 对话轮：每次推演先估计自上次以来的剧情时间；时间短 → 后台轻微反应；时间长 → 势力/经济/风声相称变化。',
    '5. 黑盒铁律：无目击的私密行为不得生成风声、不得改变声誉、不得形成/推进事件链、不得让任何不在场 NPC 据此行动。',
    '6. 痕迹不等于指向：物证只能证明发生了什么，不能自动证明是谁做的；匿名/化名/伪装身份默认身份隔离。',
    '7. 合法获知路径（必须能回答「它通过什么路径知道」）：亲历 / 知情者告知 / 公开渠道 / 风声覆盖 / 组织情报网 / 物证调查 / 世界内通讯手段；答不上来 = 不知道。',
    '8. 特权修正：受害者地位/权力高于玩家 → 事件定级跃升（顶撞权贵=重罪；冒犯皇室起步 Lv3-4）；玩家地位远高 → 可压级。',
].join('\n');
/** 感知边界注入：事件链/风声文本摘要（只进 L3 玩家可见段；由调用方决定内容） */
function renderPlotSegment(events, winds) {
    const lines = [];
    for (const event of events) {
        const level = event.level || 1;
        lines.push(`- [事件 Lv${level} ${event.type === 'conflict' ? '冲突' : '推进'}·${event.stage} ${event.stageRound ?? 1}/9] ${event.name}：${event.desc}${event.stall ? '（停滞）' : ''}${event.evolveResult ? `（${event.evolveResult}）` : ''}`);
    }
    for (const wind of winds) {
        lines.push(`- [风声 Lv${wind.level ?? 1} ${wind.type}] ${wind.topic}：${wind.content}`);
    }
    return lines.length ? `# 世界推演状态\n${lines.join('\n')}` : '';
}
// ============================================================
// 世界推演请求 jsonSchema（§22.3 复用变量通道）
// ============================================================
/** 世界推演请求 schema：{events, winds, regionalIncident}（对齐 source OUTPUT_INSTRUCTIONS :705-733） */
function buildWorldEvolutionSchema() {
    return {
        name: 'nlkaleido_world_evolution',
        description: '世界推演：返回 {events, winds}（只输出本轮有实质变化的字段）',
        value: {
            type: 'object',
            properties: {
                events: {
                    type: 'array',
                    description: '事件链创建/更新：同一事项沿用原 id；新事件 id 显式填 null',
                    items: {
                        type: 'object',
                        properties: {
                            id: { type: ['string', 'null'], description: '已有事件原样返回当前 id；新事件填 null' },
                            name: { type: 'string' },
                            type: { type: 'string', enum: ['conflict', 'progress'] },
                            level: { type: 'integer', minimum: 1, maximum: 4 },
                            stage: { type: 'string', description: 'conflict: 萌芽/发酵/逼近/已爆发/已消散；progress: 筹备/执行/关键/已完成/已失败' },
                            stageRound: { type: 'integer', minimum: 1, maximum: 9 },
                            desc: { type: 'string', description: '不超过 50 汉字' },
                            stall: { type: 'boolean' },
                            influences: {
                                type: 'array',
                                description: '影响链传导（跨系统外溢才记录）：什么触发 → 直接改变了什么 → 后续余波',
                                maxItems: 12,
                                items: {
                                    type: 'object',
                                    properties: {
                                        trigger: { type: 'string', description: '不超过 50 汉字' },
                                        impact: { type: 'string', description: '不超过 50 汉字，必须已发生' },
                                        fallout: { type: 'string', description: '不超过 50 汉字，进一步扩散趋势' },
                                    },
                                    required: ['trigger', 'impact'],
                                },
                            },
                        },
                        required: ['id', 'name', 'type'],
                    },
                },
                winds: {
                    type: 'array',
                    description: '风声创建/更新：同 id 表示仍在传播',
                    items: {
                        type: 'object',
                        properties: {
                            id: { type: ['string', 'null'] },
                            type: { type: 'string', enum: ['announcement', 'report', 'rumor', 'sentiment'] },
                            topic: { type: 'string' },
                            content: { type: 'string', description: '不超过 50 汉字' },
                            level: { type: 'integer', minimum: 1, maximum: 4 },
                        },
                        required: ['topic', 'type'],
                    },
                },
            },
        },
    };
}

const FORMULA_RE = /^(\d+)[dD](\d+)(?:(b|p)(\d+))?(?:(r|ro)(\d+))?(?:(!|!!)(?:>?=?(\d+))?)?(?:(kh|kl|dh|dl)(\d+))?(?:>?=?(\d+))?([+\-]\s*\d+)?(\*\s*\d+)?$/;
function rollOne(sides, randomFn) {
    return Math.floor(randomFn() * sides) + 1;
}
/** 解析骰子表达式（白名单正则，禁 eval；不支持括号/变量/函数） */
function parseDiceFormula(formula) {
    const input = String(formula).replace(/\s+/g, '');
    if (/^\d+$/.test(input)) {
        return {
            count: 0, sides: 1, bonusDice: 0, penaltyDice: 0,
            explodeCount: 0, add: Number(input), subtract: 0,
        };
    }
    const match = FORMULA_RE.exec(input);
    if (!match)
        throw new Error(`骰子表达式不合法：${formula}`);
    const [, countStr, sidesStr, bonusTag, bonusN, rerollTag, rerollN, explodeTag, explodeN, keepTag, keepN, successN, addPart, multPart] = match;
    const count = Number(countStr);
    const sides = Number(sidesStr);
    if (count < 1 || count > 100 || sides < 2 || sides > 10000)
        throw new Error(`骰子表达式越界：${formula}`);
    const parsed = {
        count,
        sides,
        bonusDice: bonusTag === 'b' ? Number(bonusN) : 0,
        penaltyDice: bonusTag === 'p' ? Number(bonusN) : 0,
        explodeCount: 0,
        add: addPart ? Number(addPart.replace(/\s+/g, '')) : 0,
        subtract: 0,
    };
    if (addPart && Number(addPart.replace(/\s+/g, '')) < 0) {
        parsed.add = 0;
        parsed.subtract = Math.abs(Number(addPart.replace(/\s+/g, '')));
    }
    if (multPart)
        parsed.multiply = Number(multPart.replace(/[^\d]/g, ''));
    if (rerollTag === 'r')
        parsed.rerollValue = Number(rerollN);
    if (rerollTag === 'ro')
        parsed.rerollOnceValue = Number(rerollN);
    if (explodeTag) {
        parsed.explodeCount = explodeTag === '!!' ? 2 : 1;
        parsed.explodeThreshold = explodeN ? Number(explodeN) : sides;
    }
    if (keepTag === 'kh')
        parsed.keepHighest = Number(keepN);
    if (keepTag === 'kl')
        parsed.keepLowest = Number(keepN);
    if (keepTag === 'dh')
        parsed.dropHighest = Number(keepN);
    if (keepTag === 'dl')
        parsed.dropLowest = Number(keepN);
    if (successN)
        parsed.successThreshold = Number(successN);
    if ((parsed.bonusDice > 0 || parsed.penaltyDice > 0) && !(count === 1 && sides === 100)) {
        throw new Error(`CoC 奖惩骰只支持 1d100：${formula}`);
    }
    return parsed;
}
/** 掷骰（纯函数 + 注入 randomFn 可单测；修饰符顺序固定） */
function rollFormula(formula, randomFn = Math.random) {
    const parsed = parseDiceFormula(formula);
    if (parsed.count === 0) {
        return { formula, total: parsed.add - parsed.subtract, rolls: [], kept: [], adjustment: parsed.add - parsed.subtract, multiplier: parsed.multiply ?? 1, tags: [], detail: `${parsed.add - parsed.subtract}` };
    }
    const { count, sides } = parsed;
    let rolls = [];
    for (let i = 0; i < count; i += 1)
        rolls.push(rollOne(sides, randomFn));
    // ① b/p：CoC 奖惩骰（1d100：额外掷十位骰取最好/最坏）
    if (parsed.bonusDice > 0 || parsed.penaltyDice > 0) {
        const units = rolls[0] % 10; // 个位
        let tens = Math.floor(rolls[0] / 10) % 10;
        const extraTens = [];
        for (let i = 0; i < Math.max(parsed.bonusDice, parsed.penaltyDice); i += 1) {
            extraTens.push(Math.floor(rollOne(100, randomFn) / 10) % 10);
        }
        if (parsed.bonusDice > 0)
            tens = Math.min(tens, ...extraTens); // 奖励：十位取最小（最好）
        if (parsed.penaltyDice > 0)
            tens = Math.max(tens, ...extraTens); // 惩罚：十位取最大（最坏）
        let total = tens * 10 + units;
        if (total === 0)
            total = 100; // 00 → 100
        rolls = [total];
    }
    // ② r/ro：重掷
    if (parsed.rerollValue !== undefined || parsed.rerollOnceValue !== undefined) {
        const once = parsed.rerollOnceValue !== undefined;
        const target = parsed.rerollValue ?? parsed.rerollOnceValue;
        rolls = rolls.map((value) => {
            let current = value;
            let guard = 0;
            while (current === target && guard < 100) {
                current = rollOne(sides, randomFn);
                guard += 1;
                if (once)
                    break; // ro：只重掷一次
            }
            return current;
        });
    }
    // ③ !/!!：爆炸骰
    if (parsed.explodeThreshold !== undefined) {
        const result = [];
        for (const value of rolls) {
            result.push(value);
            if (value >= parsed.explodeThreshold) {
                result.push(rollOne(sides, randomFn));
                if (parsed.explodeCount >= 2) {
                    let extra = result[result.length - 1];
                    let guard = 0;
                    while (extra >= parsed.explodeThreshold && guard < 100) {
                        extra = rollOne(sides, randomFn);
                        result.push(extra);
                        guard += 1;
                    }
                }
            }
        }
        rolls = result;
    }
    // ④ kh/kl/dh/dl
    let kept = [...rolls];
    if (parsed.keepHighest !== undefined)
        kept = [...rolls].sort((a, b) => b - a).slice(0, parsed.keepHighest);
    if (parsed.keepLowest !== undefined)
        kept = [...rolls].sort((a, b) => a - b).slice(0, parsed.keepLowest);
    if (parsed.dropHighest !== undefined)
        kept = [...rolls].sort((a, b) => b - a).slice(parsed.dropHighest);
    if (parsed.dropLowest !== undefined)
        kept = [...rolls].sort((a, b) => a - b).slice(parsed.dropLowest);
    if (kept.length === 0)
        kept = [...rolls]; // dh/dl 超界兜底
    // ⑤ 成功计数
    let total;
    if (parsed.successThreshold !== undefined) {
        total = kept.filter((value) => value >= parsed.successThreshold).length;
    }
    else {
        total = kept.reduce((sum, value) => sum + value, 0) + parsed.add - parsed.subtract;
        if (parsed.multiply !== undefined)
            total *= parsed.multiply;
    }
    const tags = [];
    if (count === 1 && sides === 20 && rolls.length === 1) {
        if (rolls[0] === 20)
            tags.push('nat20');
        if (rolls[0] === 1)
            tags.push('nat1');
    }
    const parts = [`${formula} → 掷 [${rolls.join(', ')}]`];
    if (kept.length !== rolls.length)
        parts.push(`保留 [${kept.join(', ')}]`);
    return {
        formula,
        total,
        rolls,
        kept,
        adjustment: parsed.add - parsed.subtract,
        multiplier: parsed.multiply ?? 1,
        successThreshold: parsed.successThreshold,
        tags,
        detail: `${parts.join('；')} = ${total}`,
    };
}
/**
 * 属性检定（§23.2）：
 * - COC（lte，1d100）：大成功 1-5；极难 ≤目标/5；困难 ≤目标/2；大失败 96-100；
 * - DND（gte，1d20+modifier）：nat20 大成功；nat1 大失败。
 */
function check(input, randomFn = Math.random) {
    const diceType = input.diceType ?? 100;
    const criteria = input.successCriteria ?? (diceType === 20 ? 'gte' : 'lte');
    const modifier = input.modifier ?? 0;
    const rolled = rollOne(diceType, randomFn);
    const total = rolled + (criteria === 'gte' ? modifier : 0); // COC 修正不进骰值（外部应用）；DND 修正计入
    const target = input.targetValue;
    const tags = [];
    if (diceType === 20) {
        if (rolled === 20)
            tags.push('nat20');
        if (rolled === 1)
            tags.push('nat1');
    }
    let degree;
    let success;
    if (criteria === 'lte') {
        if (rolled >= 96) {
            degree = 'fumble';
            success = false;
        }
        else if (rolled <= 5) {
            degree = 'critical';
            success = true;
        }
        else if (rolled <= target / 5) {
            degree = 'extreme';
            success = true;
        }
        else if (rolled <= target / 2) {
            degree = 'hard';
            success = true;
        }
        else if (rolled <= target) {
            degree = 'regular';
            success = true;
        }
        else {
            degree = 'failure';
            success = false;
        }
    }
    else {
        if (rolled === 1) {
            degree = 'fumble';
            success = false;
        }
        else if (rolled === 20) {
            degree = 'critical';
            success = true;
        }
        else {
            success = total >= target;
            degree = success ? 'regular' : 'failure';
        }
    }
    const rank = { fumble: -1, failure: 0, regular: 1, hard: 2, extreme: 3, critical: 4 };
    return {
        success,
        degree,
        rank: rank[degree],
        roll: rolled,
        target,
        total,
        criteria,
        tags,
        detail: `检定 ${criteria === 'lte' ? 'COC' : 'DND'}：掷 ${rolled}${criteria === 'gte' ? `+${modifier}` : ''} vs ${target} → ${degree}`,
    };
}
/** 对抗检定（§23.2）：双方各检定，按 rank 分胜负；平局按 rule */
function contest(input, randomFn = Math.random) {
    const rule = input.rule ?? 'tie';
    const left = check({ targetValue: input.left.targetValue, modifier: input.left.modifier, successCriteria: input.successCriteria, diceType: input.diceType }, randomFn);
    const right = check({ targetValue: input.right.targetValue, modifier: input.right.modifier, successCriteria: input.successCriteria, diceType: input.diceType }, randomFn);
    let winner;
    if (left.rank > right.rank)
        winner = 'left';
    else if (right.rank > left.rank)
        winner = 'right';
    else
        winner = rule === 'initiator_win' ? 'left' : rule === 'initiator_lose' ? 'right' : 'tie';
    return { winner, left, right };
}
const MAX_EXPR_DEPTH = 5;
class DiceExprParser {
    src;
    pos = 0;
    constructor(src) {
        this.src = src;
    }
    parse() {
        const node = this.parseOr();
        this.skipWs();
        if (this.pos < this.src.length)
            throw new Error(`表达式多余内容：'${this.src.slice(this.pos)}'`);
        return node;
    }
    skipWs() {
        while (this.pos < this.src.length && /\s/.test(this.src[this.pos]))
            this.pos += 1;
    }
    parseOr() {
        let left = this.parseAnd();
        for (;;) {
            this.skipWs();
            if (this.src.startsWith('||', this.pos)) {
                this.pos += 2;
                left = { kind: 'binary', op: '||', left, right: this.parseAnd() };
            }
            else
                return left;
        }
    }
    parseAnd() {
        let left = this.parseCompare();
        for (;;) {
            this.skipWs();
            if (this.src.startsWith('&&', this.pos)) {
                this.pos += 2;
                left = { kind: 'binary', op: '&&', left, right: this.parseCompare() };
            }
            else
                return left;
        }
    }
    parseCompare() {
        let left = this.parseAdd();
        for (;;) {
            this.skipWs();
            const two = this.src.slice(this.pos, this.pos + 2);
            if (two === '==' || two === '!=' || two === '>=' || two === '<=') {
                this.pos += 2;
                left = { kind: 'binary', op: two, left, right: this.parseAdd() };
            }
            else if (this.src[this.pos] === '>' || this.src[this.pos] === '<') {
                const op = this.src[this.pos];
                this.pos += 1;
                left = { kind: 'binary', op, left, right: this.parseAdd() };
            }
            else
                return left;
        }
    }
    parseAdd() {
        let left = this.parseMul();
        for (;;) {
            this.skipWs();
            if (this.src[this.pos] === '+' || this.src[this.pos] === '-') {
                const op = this.src[this.pos];
                this.pos += 1;
                left = { kind: 'binary', op, left, right: this.parseMul() };
            }
            else
                return left;
        }
    }
    parseMul() {
        let left = this.parseUnary();
        for (;;) {
            this.skipWs();
            const ch = this.src[this.pos];
            if (ch === '*' || ch === '/' || ch === '%') {
                this.pos += 1;
                left = { kind: 'binary', op: ch, left, right: this.parseUnary() };
            }
            else
                return left;
        }
    }
    parseUnary() {
        this.skipWs();
        if (this.src[this.pos] === '!') {
            this.pos += 1;
            return { kind: 'unary', op: '!', operand: this.parseUnary() };
        }
        if (this.src[this.pos] === '-') {
            this.pos += 1;
            return { kind: 'unary', op: '-', operand: this.parseUnary() };
        }
        return this.parsePrimary();
    }
    parsePrimary() {
        this.skipWs();
        const ch = this.src[this.pos];
        if (ch === '(') {
            this.pos += 1;
            const inner = this.parseOr();
            this.skipWs();
            if (this.src[this.pos] !== ')')
                throw new Error('表达式缺右括号');
            this.pos += 1;
            return inner;
        }
        if (ch === '"' || ch === "'") {
            const quote = ch;
            this.pos += 1;
            let value = '';
            while (this.pos < this.src.length && this.src[this.pos] !== quote) {
                value += this.src[this.pos];
                this.pos += 1;
            }
            if (this.src[this.pos] !== quote)
                throw new Error('字符串未闭合');
            this.pos += 1;
            return { kind: 'string', value };
        }
        if (/[0-9]/.test(ch ?? '')) {
            let num = '';
            while (this.pos < this.src.length && /[0-9.]/.test(this.src[this.pos])) {
                num += this.src[this.pos];
                this.pos += 1;
            }
            return { kind: 'number', value: Number(num) };
        }
        if (ch === '$') {
            this.pos += 1;
            const name = this.readIdentifier();
            this.skipWs();
            if (this.src[this.pos] === '(') {
                this.pos += 1;
                const args = [];
                this.skipWs();
                if (this.src[this.pos] !== ')') {
                    for (;;) {
                        args.push(this.parseOr());
                        this.skipWs();
                        if (this.src[this.pos] === ',') {
                            this.pos += 1;
                            continue;
                        }
                        break;
                    }
                }
                if (this.src[this.pos] !== ')')
                    throw new Error('函数调用缺右括号');
                this.pos += 1;
                return { kind: 'call', name, args };
            }
            return { kind: 'var', name };
        }
        const name = this.readIdentifier();
        if (!name)
            throw new Error(`表达式意外字符：'${ch ?? 'EOF'}'`);
        this.skipWs();
        if (this.src[this.pos] === '(') {
            this.pos += 1;
            const args = [];
            this.skipWs();
            if (this.src[this.pos] !== ')') {
                for (;;) {
                    args.push(this.parseOr());
                    this.skipWs();
                    if (this.src[this.pos] === ',') {
                        this.pos += 1;
                        continue;
                    }
                    break;
                }
            }
            if (this.src[this.pos] !== ')')
                throw new Error('函数调用缺右括号');
            this.pos += 1;
            return { kind: 'call', name, args };
        }
        return { kind: 'var', name };
    }
    readIdentifier() {
        let name = '';
        while (this.pos < this.src.length && /[A-Za-z0-9_.\u4e00-\u9fff]/.test(this.src[this.pos])) {
            name += this.src[this.pos];
            this.pos += 1;
        }
        // 原型链防护（§17.4）：禁止访问危险键
        if (name === '__proto__' || name === 'constructor' || name === 'prototype') {
            throw new Error(`禁止访问：${name}`);
        }
        return name;
    }
}
/** 解析白名单表达式（§23.3：禁 eval；深度 ≤ MAX_EXPR_DEPTH） */
function parseDiceExpr(src) {
    return new DiceExprParser(src).parse();
}
function exprDepth(node) {
    switch (node.kind) {
        case 'binary': return 1 + Math.max(exprDepth(node.left), exprDepth(node.right));
        case 'unary': return 1 + exprDepth(node.operand);
        case 'call': return 1 + node.args.reduce((max, arg) => Math.max(max, exprDepth(arg)), 0);
        default: return 1;
    }
}
const FUNCTIONS = {
    abs: (x) => Math.abs(x),
    floor: (x) => Math.floor(x),
    min: (...xs) => Math.min(...xs),
    max: (...xs) => Math.max(...xs),
};
/** 点路径解析（自有属性遍历，不沿原型链，§17.4）：$roll.total → ctx.roll.total */
function resolveDottedPath(ctx, dotted) {
    const parts = dotted.split('.');
    let current = ctx;
    for (const part of parts) {
        if (current === null || typeof current !== 'object')
            return undefined;
        if (!Object.prototype.hasOwnProperty.call(current, part))
            return undefined;
        current = current[part];
    }
    return current;
}
const MISSING = Symbol('nlkaleido-missing');
function resolveVar(ctx, name) {
    if (name.includes('.')) {
        const value = resolveDottedPath(ctx, name);
        return value === undefined ? MISSING : value;
    }
    if (!Object.prototype.hasOwnProperty.call(ctx, name))
        return MISSING;
    return ctx[name];
}
/** 求值（强类型断言 §17.4：跨类型比较一律 false，不隐式转换） */
function evalDiceExpr(node, ctx) {
    if (exprDepth(node) > MAX_EXPR_DEPTH)
        throw new Error(`表达式嵌套超过 ${MAX_EXPR_DEPTH} 层`);
    switch (node.kind) {
        case 'number':
        case 'string':
            return node.value;
        case 'var': {
            if (node.name === 'true')
                return true;
            if (node.name === 'false')
                return false;
            const value = resolveVar(ctx, node.name);
            if (value === MISSING)
                throw new Error(`未知变量：$${node.name}`);
            return value;
        }
        case 'call': {
            if (node.name === 'hasTag' && node.args.length === 1) {
                const tag = evalDiceExpr(node.args[0], ctx);
                return ctx.roll.hasTag(String(tag));
            }
            // $roll.hasTag(...) 点路径调用
            if (node.name.endsWith('.hasTag') && node.args.length === 1) {
                const receiver = resolveDottedPath(ctx, node.name.slice(0, -'.hasTag'.length));
                if (receiver && typeof receiver === 'object' && typeof receiver.hasTag === 'function') {
                    const tag = evalDiceExpr(node.args[0], ctx);
                    return receiver.hasTag(String(tag));
                }
            }
            const fn = FUNCTIONS[node.name];
            if (!fn)
                throw new Error(`未知函数：${node.name}`);
            const args = node.args.map((arg) => {
                const value = evalDiceExpr(arg, ctx);
                if (typeof value !== 'number')
                    throw new Error(`函数 ${node.name} 参数必须为数字`);
                return value;
            });
            return fn(...args);
        }
        case 'unary': {
            const value = evalDiceExpr(node.operand, ctx);
            if (node.op === '!')
                return !value;
            if (typeof value !== 'number')
                throw new Error('一元负号只支持数字');
            return -value;
        }
        case 'binary': {
            const left = evalDiceExpr(node.left, ctx);
            if (node.op === '&&')
                return Boolean(left) && Boolean(evalDiceExpr(node.right, ctx));
            if (node.op === '||')
                return Boolean(left) || Boolean(evalDiceExpr(node.right, ctx));
            const right = evalDiceExpr(node.right, ctx);
            switch (node.op) {
                case '==': return left === right;
                case '!=': return left !== right;
                case '>':
                case '>=':
                case '<':
                case '<=': {
                    if (typeof left !== 'number' || typeof right !== 'number')
                        return false; // 强类型：跨类型比较 false
                    if (node.op === '>')
                        return left > right;
                    if (node.op === '>=')
                        return left >= right;
                    if (node.op === '<')
                        return left < right;
                    return left <= right;
                }
                case '+':
                case '-':
                case '*':
                case '/':
                case '%': {
                    if (typeof left !== 'number' || typeof right !== 'number')
                        throw new Error('算术运算只支持数字');
                    if (node.op === '+')
                        return left + right;
                    if (node.op === '-')
                        return left - right;
                    if (node.op === '*')
                        return left * right;
                    if (node.op === '/')
                        return left / right;
                    return left % right;
                }
                default:
                    throw new Error(`未知运算符：${node.op}`);
            }
        }
    }
}
/**
 * 结果分级匹配（§23.3）：priority 升序、第一个 condition 为真者胜；必须有兜底 outcome。
 * minRank 二次裁决：命中成功类（rank≥0）但 rank < requiredRank → 替换为 unmetOutcomeId。
 */
function evaluateOutcomes(outcomes, ctx, policy) {
    const sorted = [...outcomes].sort((a, b) => (a.priority ?? 99) - (b.priority ?? 99));
    let matched;
    for (const outcome of sorted) {
        const condition = outcome.condition ?? 'true';
        let truthy = false;
        try {
            truthy = Boolean(evalDiceExpr(parseDiceExpr(condition), ctx));
        }
        catch {
            truthy = false; // 非法条件跳过（导入校验已拦；运行时防御）
        }
        if (truthy) {
            matched = outcome;
            break;
        }
    }
    if (!matched)
        throw new Error('outcomes 缺少兜底条件（必须提供 condition:true 的 outcome）');
    if (policy && policy.kind === 'minRank' && matched.rank >= 0 && matched.rank < policy.requiredRank) {
        const unmet = outcomes.find((o) => o.id === policy.unmetOutcomeId);
        if (unmet)
            return { outcome: unmet, original: matched, policyApplied: true };
    }
    return { outcome: matched, original: undefined, policyApplied: false };
}
// ============================================================
// M16c AI 预设生成协议（§23.4：format 标记 + tests 导入校验）
// ============================================================
const DICE_PRESET_FORMAT = 'nlkaleido_dice_preset_agent_v1';
const CONTRACT_PRESET_FORMAT = 'nlkaleido_contract_agent_v1';
/** 从 AI 包装文档中提取预设本体（format 识别；notes 不保存） */
function unwrapPresetDocument(raw) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw))
        throw new Error('预设文档必须为对象');
    const record = raw;
    const format = typeof record.format === 'string' ? record.format : '';
    if (!format)
        throw new Error('缺少 format 标记');
    if (record.preset && typeof record.preset === 'object') {
        const preset = { ...record.preset };
        delete preset.notes; // notes 不入库（§23.4）
        return { format, preset };
    }
    const preset = { ...record };
    delete preset.format;
    delete preset.notes;
    return { format, preset };
}
/** 校验骰子预设（§23.4：结构 + outcomes 兜底 + tests 全过；不通过返回错误列表） */
function validateDicePreset(raw) {
    const errors = [];
    let preset;
    try {
        const { format, preset: body } = unwrapPresetDocument(raw);
        if (format !== DICE_PRESET_FORMAT && format !== CONTRACT_PRESET_FORMAT) {
            errors.push(`format 不识别：${format}`);
        }
        if (!body.id || !body.name)
            errors.push('缺少 id/name');
        const outcomes = (Array.isArray(body.outcomes) ? body.outcomes : []);
        if (!outcomes.some((o) => (o.condition ?? 'true') === 'true')) {
            errors.push('outcomes 缺少兜底 outcome（condition:true, priority:99）');
        }
        preset = body;
    }
    catch (error) {
        return { ok: false, errors: [error instanceof Error ? error.message : String(error)] };
    }
    // tests 导入前校验（§23.4：不通过拒绝导入）
    const tests = (Array.isArray(preset.tests) ? preset.tests : []);
    for (const test of tests) {
        try {
            const ctx = buildPresetContext(test.context);
            const match = evaluateOutcomes(preset.outcomes, ctx, preset.outcomePolicy);
            if (match.outcome.id !== test.expectedOutcomeId) {
                errors.push(`test '${test.name}' 期望 ${test.expectedOutcomeId}，实得 ${match.outcome.id}`);
            }
        }
        catch (error) {
            errors.push(`test '${test.name}' 执行失败：${error instanceof Error ? error.message : String(error)}`);
        }
    }
    return { ok: errors.length === 0, errors, preset: errors.length ? undefined : preset };
}
/** 从 test context 构造表达式上下文（$roll/$dc/$attr…） */
function buildPresetContext(context) {
    const rollTotal = typeof context.roll === 'number' ? context.roll : (typeof context.total === 'number' ? context.total : 0);
    const tags = Array.isArray(context.tags) ? context.tags.map(String) : [];
    const base = {
        roll: {
            total: rollTotal,
            hasTag: (tag) => tags.includes(tag),
        },
    };
    for (const [key, value] of Object.entries(context)) {
        if (key === 'roll' || key === 'tags' || key === 'total')
            continue;
        base[key] = typeof value === 'number' || typeof value === 'string' || typeof value === 'boolean' ? value : String(value);
    }
    return base;
}
/** 别名映射（§23.5 checkSuggestionAliases：难度→dc、优势→1；让 AI 用自然中文生成命令） */
const CHECK_ALIASES = Object.freeze({
    '难度': 'dc',
    '修正': 'mod',
    '技能修正': 'skillMod',
    '属性修正': 'attrMod',
});
const TIE_ALIASES = Object.freeze({
    '发起方成功': 'initiator_win',
    '发起方胜': 'initiator_win',
    '发起方失败': 'initiator_lose',
    '发起方负': 'initiator_lose',
    '平局': 'tie',
});
/**
 * 解析检定建议行（§23.5 DSL）：
 * `检定 <角色> <属性> [key=value]` / `对抗 <发起者> <属性> vs <对手> <属性> [平局=...]` /
 * `必成` / `必败` / `无`。只解析不执行（点击才执行，防奶人）。
 */
function parseCheckSuggestion(line) {
    const input = String(line).trim();
    if (!input || input === '无')
        return { kind: 'none' };
    if (input === '必成')
        return { kind: 'auto_success' };
    if (input === '必败')
        return { kind: 'auto_fail' };
    const paramsOf = (tokens) => {
        const params = {};
        for (const token of tokens) {
            const eq = token.indexOf('=');
            if (eq < 0)
                continue;
            let key = token.slice(0, eq).trim();
            const value = token.slice(eq + 1).trim();
            key = CHECK_ALIASES[key] ?? key;
            params[key] = value;
        }
        return params;
    };
    const contestMatch = /^对抗\s+(.+?)\s+(.+?)\s+vs\s+(.+?)\s+(.+?)(?:\s+平局=(.+))?$/u.exec(input);
    if (contestMatch) {
        const [, initiator, initiatorAttr, opponent, opponentAttr, tieRaw] = contestMatch;
        let params = {};
        const tieRule = tieRaw ? (TIE_ALIASES[tieRaw.split(/\s+/)[0]] ?? 'tie') : 'tie';
        if (tieRaw)
            params = paramsOf(tieRaw.split(/\s+/).slice(1));
        return { kind: 'contest', initiator, initiatorAttr, opponent, opponentAttr, tieRule, params };
    }
    const checkMatch = /^检定\s+(.+?)\s+(.+?)(?:\s+(.+))?$/u.exec(input);
    if (checkMatch) {
        const [, character, attribute, restRaw] = checkMatch;
        const params = paramsOf(restRaw ? restRaw.split(/\s+/) : []);
        return { kind: 'check', character, attribute, params };
    }
    throw new Error(`检定建议语法不识别：${input}`);
}

/**
 * ST 全局面类型声明（KaleidoStAdapter 依赖注入面，§10.2/§11）。
 * 适配层只经此接口触碰 ST 全局，Core 保持零 ST 依赖；
 * 全部结论出处见《万花筒交接稿.md》§2 探明结论（2026-08-14 回填）。
 */
/** 探测 ST 核心函数签名是否如预期（§10.2）：缺什么列什么，不白屏 */
function detectVersion(globals) {
    const missing = [];
    const notes = [];
    let context = null;
    try {
        context = globals.getContext();
    }
    catch {
        missing.push('getContext');
        return { compatible: false, missing, notes: ['无法取得 ST 扩展上下文（getContext 抛错）'] };
    }
    if (typeof context.generateRawData !== 'function')
        missing.push('generateRawData');
    if (!context.eventSource || typeof context.eventSource.on !== 'function')
        missing.push('eventSource.on');
    if (!context.eventTypes || typeof context.eventTypes.GENERATION_ENDED !== 'string') {
        missing.push('eventTypes.GENERATION_ENDED');
        notes.push('U8 绝对锚点事件缺失，将退化为 MESSAGE_RECEIVED + 消息完整校验');
    }
    if (!context.eventTypes || typeof context.eventTypes.CHAT_COMPLETION_SETTINGS_READY !== 'string') {
        missing.push('eventTypes.CHAT_COMPLETION_SETTINGS_READY');
    }
    return { compatible: missing.length === 0, missing, notes };
}

/**
 * KaleidoStAdapter（§10.2）：对接 ST 的适配层。
 *
 * - detectVersion（§10.2）：版本嗅探，兼容性退路（面板优雅降级不白屏）。
 * - init：订阅事件（U8 结论：GENERATION_ENDED 为绝对锚点；GENERATION_STARTED/STOPPED 打中止标记）。
 * - onGenerationEnded：变量更新主入口（守卫：末条消息完整 + 无中止标记）。
 * - requestVariableUpdate：generateRawData({prompt: messages, api:'openai', jsonSchema})
 *   （U4：CUSTOM 透传 json_schema；DeepSeek 退化为 json_object，走 G5 兜底解析）。
 * - onSettingsReady（注入点 B，U3：SETTINGS_READY 是 stringify 前最后一站）：仅重排自己的请求
 *   （§10.2 隐藏标记隔离，正文请求零干预）。
 * - readUsage（U5：ST 无 usage 读取代码，非流式 data.usage 原样透传；DeepSeek 命中字段
 *   prompt_cache_hit_tokens / prompt_cache_miss_tokens）。
 * - persistState/loadState（U6：extension_settings 落盘服务端 settings.json；chat_metadata 需
 *   自行 saveChat 落盘——U2 补充）。
 * - 多步工具注册（§10.2：回合内注册 / 收尾清理，防残留影响正文请求）。
 *
 * 全部 ST 访问经注入的 StGlobals，Node 环境可 mock 单测。
 */
/** 变量请求隐藏标记（§10.2 事件隔离）：SETTINGS_READY 只重排含此标记的请求 */
const VREQ_MARKER = 'nlkaleido_vreq';
/** 存储键（§4.2/§5.4：chat 层存 chat_metadata；run/global 层存 extension_settings.variables.global） */
const STORE_KEY_CHAT = 'nlkaleido';
const STORE_KEY_GLOBAL_PREFIX = 'nlkaleido:';
/** @since M13 记忆持久化键（chat 层；默认关闭 → 不写盘零开销） */
const STORE_KEY_CHAT_MEMORY = 'nlkaleido.memory';
/** @since M15 剧情编排持久化键（chat 层；默认关闭 → 不写盘零开销） */
const STORE_KEY_CHAT_PLOT = 'nlkaleido.plot';
/** @since M16 检定持久化键（chat 层：预设库 + 历史；默认关闭 → 不写盘零开销） */
const STORE_KEY_CHAT_DICE = 'nlkaleido.dice';
/** @since M14 配置中心键（§20.13.6：extension_settings.variables.global 下，F12 持久化） */
const STORE_KEY_CONFIG = 'nlkaleido:config';
/** @since M14 配置快照键（防奶人：破坏性操作前自动备份） */
const STORE_KEY_CONFIG_BACKUP = 'nlkaleido:config.backup';
/**
 * commit 串行器（§17.14-S1：mutation 可并行 / commit 串行；shujuku 审计落地）。
 * 面板编辑 / AI 更新 / 导入统一经此单一写入口排队；单条失败不阻塞队列，错误上浮供面板展示。
 */
class CommitQueue {
    tail = Promise.resolve();
    _lastError = null;
    enqueue(task) {
        const run = this.tail.then(task, task);
        this.tail = run.catch(() => undefined);
        return run;
    }
    get lastError() {
        return this._lastError;
    }
    recordError(message) {
        this._lastError = message;
    }
}
class KaleidoStAdapter {
    globals;
    options;
    adapter = {
        contract: null,
        state: null,
        abortedThisGeneration: false,
        toolsRegistered: false,
        lastStoryHash: null,
        memoryStore: { version: 1, atoms: [] },
        memoryTables: [],
        archiving: false,
        plotEvents: [],
        plotWinds: [],
        regionalIncident: { active: null, cooldown: 0 },
        plotRequestInFlight: false,
        plotRound: 0,
        dicePresets: [],
        diceHistory: [],
        config: tierDefaults('minimal'),
        configSnapshot: null,
        lastConfigReport: null,
    };
    compat = null;
    /** 本轮变量请求暂存 json_schema（§10.2 方案 D：generateRawData 不传参，SETTINGS_READY 注入用） */
    pendingJsonSchema = null;
    /** commit 串行器（§17.14-S1）：persistState 统一经此排队 */
    commit = new CommitQueue();
    constructor(globals, options = {}) {
        this.globals = globals;
        this.options = options;
    }
    /** ST 全局面（面板/桥经此访问 eventSource 等，§6.2 单向数据流） */
    get stGlobals() {
        return this.globals;
    }
    // ============================================================
    // 初始化（§12 时序 A）
    // ============================================================
    init() {
        this.compat = detectVersion(this.globals);
        if (!this.compat.compatible)
            return this.compat;
        const { eventSource, eventTypes } = this.globals.getContext();
        // U8 绝对锚点：GENERATION_ENDED（覆盖成功/报错/中止/工具循环收尾）。
        // async 监听：ST 的 eventSource.emit 会等待 listener 返回的 Promise（文档要求 await emit）
        eventSource.on(eventTypes.GENERATION_ENDED, async () => {
            await this.onGenerationEnded();
        });
        // 中止标记（U8 守卫②）：STARTED 清标记，STOPPED 置标记
        eventSource.on(eventTypes.GENERATION_STARTED, () => {
            this.adapter.abortedThisGeneration = false;
        });
        eventSource.on(eventTypes.GENERATION_STOPPED, () => {
            this.adapter.abortedThisGeneration = true;
        });
        // U3 注入点 B：SETTINGS_READY 兜底重排 + json_schema 注入（只处理自己的请求，§10.2 事件隔离）
        if (typeof eventTypes.CHAT_COMPLETION_SETTINGS_READY === 'string') {
            eventSource.on(eventTypes.CHAT_COMPLETION_SETTINGS_READY, (generateData) => {
                this.onSettingsReady(generateData);
            });
        }
        return this.compat;
    }
    /** 优雅降级信息（面板用，§10.2 不白屏） */
    getCompatibility() {
        return this.compat;
    }
    // ============================================================
    // 变量更新主入口（§12 时序 B，U8 守卫）
    // ============================================================
    async onGenerationEnded() {
        if (!this.adapter.contract || !this.adapter.state)
            return;
        const contract = this.adapter.contract;
        // 守卫①：末条消息为 assistant 且 mes 非空非 '...'（过滤报错/中止的半截消息）
        const chat = this.globals.getChat();
        const last = chat.at(-1);
        if (!last || last.is_user || !last.mes || last.mes === '...' || last.mes.trim() === '')
            return;
        // 守卫②：用户中止本轮（GENERATION_STOPPED 同帧标记）
        if (this.adapter.abortedThisGeneration)
            return;
        const turnId = this.adapter.state.meta.lastTurnId + 1;
        const recentStory = this.extractRecentStory(chat);
        const userInput = this.extractUserInput(chat);
        // M13 记忆（§20：作者声明才启用；未启用 → memoryStore 不传 → 运行时零记忆路径）
        const memoryEnabled = contract.memory?.enabled === true;
        const reflectionEveryN = contract.memory?.reflectionEveryN ?? REFLECTION_EVERY_N_TURNS;
        const reflectionDue = memoryEnabled && turnId % reflectionEveryN === 0;
        const memoryQuery = memoryEnabled
            ? `${recentStory.map((m) => m.content).join('\n')}\n${userInput}`.slice(-4e3)
            : undefined;
        // M15 剧情编排（§22：作者声明才启用；未启用 → 零剧情路径）
        const plotEnabled = contract.plot?.enabled === true;
        const plotStates = plotEnabled ? renderPlotSegment(this.adapter.plotEvents, this.adapter.plotWinds) : undefined;
        // §22.4 感知边界：只注入角色可合法感知的世界状态
        // （world-engine-inject.js:97-136：事件 Lv≥3 全注入 / Lv1-2 仅终局注入；风声 Lv≥3 才注入）
        const plotSegment = plotEnabled
            ? renderPlotSegment(this.adapter.plotEvents.filter((e) => (PLOT_TERMINAL_STAGES[e.type] ?? []).includes(e.stage) || (e.level ?? 1) >= 3), this.adapter.plotWinds.filter((w) => (w.level ?? 1) >= 3)) || null
            : null;
        const l0 = plotEnabled
            ? `${this.options.l0Template ?? ''}\n\n${contract.plot?.worldConstraints ?? WORLD_CONSTRAINT_TEMPLATE}`
            : this.options.l0Template;
        const result = await runSingleShotAgent(this, {
            contract,
            state: this.adapter.state,
            turnId,
            l0,
            recentStory,
            userInput,
            jsonSchema: this.buildJsonSchema(contract, { reflection: reflectionDue }),
            memoryStore: memoryEnabled ? this.adapter.memoryStore : undefined,
            memoryQuery,
            plotSegment,
            plotStates,
        });
        if (result.requested) {
            // §20.5：反思候选写入（合并进同一请求的 memory_candidates，不新增请求；失败静默不阻塞变量链路）
            if (memoryEnabled && result.payload) {
                const written = writeMemoryCandidates(this.adapter.memoryStore, collectMemoryCandidates(result.payload, { scope: 'chat', turnId, floorId: this.currentFloorId() }), Date.now());
                if (written.added.length || written.merged.length) {
                    this.enforceMaxAtoms(contract);
                    this.onMemoryChanged?.();
                }
            }
            await this.persistState(this.adapter.state);
        }
        // §20.3 衰减调度（Scheduler 语义；每轮本地推进，零模型成本）+ §20.5 远记忆归档（异步不阻塞）
        if (memoryEnabled) {
            const maintenance = maintainMemory(this.adapter.memoryStore, Date.now());
            if (maintenance.purged || maintenance.expired || maintenance.forgotten)
                this.onMemoryChanged?.();
            void this.archiveChangelog(contract); // 达阈值才触发；失败保留重试（整批成功才删）
        }
        // §22.3 M15 本地骰子推进（每轮纯本地；双驱之一）+ 世界推演请求（每 N 轮，异步不阻塞）
        if (plotEnabled) {
            this.runPlotDice(contract);
            const plotEveryN = contract.plot?.everyN ?? 5;
            if (turnId % plotEveryN === 0)
                void this.runWorldEvolution(contract, recentStory, userInput);
            await this.persistPlotState();
            this.onPlotChanged?.();
        }
        // M10：周目边界（§16.1 本地确定性谓词）+ 成就判定（§16.2 本地谓词，零模型成本）
        const sources = {
            recent_story: recentStory.map((m) => m.content).join('\n'),
            user_input: userInput,
        };
        const boundary = checkRunBoundary(contract, this.adapter.state, sources);
        if (boundary.triggered) {
            beginNewRun(this.adapter.state, contract, this.adapter.state.meta.runId + 1);
            this.resetChatMemory(); // §16.1：chat 层记忆随周目重置，run/global 层保留
            this.resetChatPlot(); // §22.7：世界推演状态随周目重开
            await this.persistState(this.adapter.state);
            this.onRunChanged?.(this.adapter.state.meta.runId, boundary.message);
        }
        const achievements = this.readAchievements(contract.id);
        if (contract.achievements?.length) {
            // 契约声明的成就与存量解锁状态对齐（以契约为准，存量解锁保留）
            const merged = contract.achievements.map((declared) => {
                const stored = achievements.find((a) => a.id === declared.id);
                return { ...declared, ...(stored ?? {}) };
            });
            const unlocked = checkAchievements(contract, this.adapter.state, merged);
            if (unlocked.length) {
                this.writeAchievements(contract.id, merged);
                this.onAchievementUnlocked?.(unlocked);
            }
        }
    }
    /** 生命周期回调（bridge 注入：nlkaleido:run_changed / nlkaleido:achievement_unlocked） */
    onRunChanged;
    onAchievementUnlocked;
    /** @since M13 记忆变化回调（bridge 注入：nlkaleido:memory_changed，§20.10 面板刷新） */
    onMemoryChanged;
    /** @since M15 剧情变化回调（bridge 注入：nlkaleido:plot_changed，§22.6 面板刷新） */
    onPlotChanged;
    // ============================================================
    // M15 剧情编排接线（§22.2/§22.3/§22.5；全部默认关闭路径，未启用不执行）
    // ============================================================
    /** 本地骰子推进（双驱之一，§22.3：骰子防停滞；每轮纯本地零请求） */
    runPlotDice(contract) {
        const modifier = contract.plot?.diceModifier ?? PLOT_DICE_MODIFIER_DEFAULT;
        const setbackRatio = contract.plot?.setbackRatio ?? PLOT_SETBACK_RATIO;
        this.adapter.plotRound += 1;
        const round = this.adapter.plotRound;
        const eventsBefore = this.adapter.plotEvents.map((e) => ({ ...e }));
        const windsBefore = this.adapter.plotWinds.map((w) => ({ ...w }));
        const events = this.adapter.plotEvents;
        for (let i = 0; i < events.length; i += 1) {
            const outcome = rollEventDice(events[i], { modifier, setbackRatio, round });
            events[i] = outcome.event;
        }
        // 终局保留期维护（evolution.js:1274-1295：负面终局下轮即删；正面终局保留 2+Lv×2 轮）
        const maintained = maintainPlotEvents(events, round);
        this.adapter.plotEvents = maintained.events;
        // 影响链过期清理（:1233-1247 保留 8 轮不续期）
        maintainPlotInfluences(this.adapter.plotEvents, round);
        if (contract.plot?.winds !== false) {
            const { survivors, decayed } = decayWinds(this.adapter.plotWinds);
            this.adapter.plotWinds = survivors;
            if (decayed.length)
                this.onPlotChanged?.();
        }
        if (contract.plot?.regionalIncident === true) {
            const { started, ended } = rollRegionalIncident(this.adapter.regionalIncident, {
                chance: REGIONAL_INCIDENT_CONFIG.chance,
                durationRounds: REGIONAL_INCIDENT_CONFIG.durationRounds,
                cooldownRounds: REGIONAL_INCIDENT_CONFIG.cooldownRounds,
            });
            if (started || ended)
                this.onPlotChanged?.();
        }
        // 账本（ledger.js:19-99：Lv≥3 变化 / 任何终局 / 新增 Lv≥3 风声 → 写已有 changelog，source:'plot'）
        const terminalLines = maintained.terminalSnapshot.map((e) => `event_terminal_cleanup: ${e.name} → ${e.stage}`);
        const ledgerLines = [
            ...plotLedgerLines(eventsBefore, this.adapter.plotEvents, windsBefore, this.adapter.plotWinds),
            ...terminalLines,
        ];
        if (ledgerLines.length)
            this.appendPlotLedger(ledgerLines);
    }
    /** 剧情账本写入 changelog（source:'plot' 审计记录；不进 stat_data，rollbackEntry 已守卫） */
    appendPlotLedger(lines) {
        const state = this.adapter.state;
        if (!state)
            return;
        for (const line of lines) {
            state.revision = {
                seq: state.revision.seq + 1,
                hash: hash64(`${line}|${state.revision.seq}`),
                updatedAt: Date.now(),
            };
            state.changelog.push({
                seq: state.revision.seq,
                turnId: state.meta.lastTurnId,
                path: '$plot',
                op: { op: 'replace', path: '$plot', value: line, confidence: 'high', rationale: '剧情账本' },
                old: undefined,
                new: line,
                confidence: 'high',
                source: 'plot',
            });
        }
    }
    /**
     * 世界推演请求（双驱之二，§22.3：复用变量通道 + jsonSchema {events,winds}；
     * 以 API 返回为准改写 stage/stageRound；异步 fire-and-forget，失败静默不阻塞主链）。
     */
    async runWorldEvolution(contract, recentStory = [], userInput = '') {
        if (this.adapter.plotRequestInFlight || !contract.plot?.enabled)
            return;
        this.adapter.plotRequestInFlight = true;
        try {
            const context = this.globals.getContext();
            if (typeof context.generateRawData !== 'function')
                return;
            const stateText = renderPlotSegment(this.adapter.plotEvents, this.adapter.plotWinds);
            const eventsBefore = this.adapter.plotEvents.map((e) => ({ ...e }));
            const windsBefore = this.adapter.plotWinds.map((w) => ({ ...w }));
            const round = this.adapter.plotRound;
            const prompt = [
                { role: 'system', name: VREQ_MARKER, content: '' },
                {
                    role: 'system',
                    content: [
                        '你是世界推演引擎。根据最近剧情推演世界状态：事件链（events）与风声（winds）只输出本轮有实质变化的字段。',
                        '规则：同一事项（目标/矛盾/持续行动）沿用原 id 更新，不得拆成新事件；只有可独立演化的新冲突/推进才以 id:null 新建。',
                        'type 一旦确定禁止改动；终局不可逆，已终局事件只允许改 desc；负面终局（已消散/已失败）只能由你根据明确因果判定（物理阻断/能力不足/信息断裂/资源耗尽/被反制/时间过期）；仅仅连续多轮没进展不足以判定终局；正面终局（已爆发/已完成）可直接给出。',
                        '特权修正：受害者地位高于玩家 → 定级跃升；玩家地位远高 → 可压级。',
                        '因果检查：无目击的私密行为不得生成风声/声誉/事件链；物证不等于指向；NPC 必须能回答「通过什么路径知道」。',
                        '影响链（influences）只记录真实跨系统外溢：trigger 触发 → impact 已发生 → fallout 扩散趋势。',
                        `${contract.plot?.worldConstraints ?? WORLD_CONSTRAINT_TEMPLATE}`,
                        stateText ? `# 当前世界状态\n${stateText}` : '# 当前世界状态\n（无）',
                        '# 最近剧情',
                        recentStory.map((m) => m.content).join('\n').slice(-3000) || '（无）',
                        userInput ? `# 玩家输入\n${userInput}` : '',
                    ].filter(Boolean).join('\n'),
                },
            ];
            this.pendingJsonSchema = buildWorldEvolutionSchema();
            try {
                const data = (await context.generateRawData({ prompt, api: 'openai' }, undefined));
                const content = data?.choices?.[0]?.message?.content ?? '';
                const parsed = tolerantJsonParse(content);
                if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
                    const record = parsed;
                    if (Array.isArray(record.events)) {
                        const { events } = applyApiEventUpdates(this.adapter.plotEvents, record.events, Date.now(), round);
                        this.adapter.plotEvents = events;
                    }
                    if (Array.isArray(record.winds) && contract.plot?.winds !== false) {
                        const { winds } = applyApiWindUpdates(this.adapter.plotWinds, record.winds);
                        this.adapter.plotWinds = winds;
                    }
                    // 账本（Lv≥3 变化 / 任何终局 / 新增 Lv≥3 风声 → changelog，source:'plot'）
                    const ledgerLines = plotLedgerLines(eventsBefore, this.adapter.plotEvents, windsBefore, this.adapter.plotWinds);
                    if (ledgerLines.length)
                        this.appendPlotLedger(ledgerLines);
                    await this.persistPlotState();
                    this.onPlotChanged?.();
                }
            }
            finally {
                this.pendingJsonSchema = null;
            }
        }
        catch (error) {
            console.warn('[NLKaleido] 世界推演失败（下轮重试）：', error);
        }
        finally {
            this.adapter.plotRequestInFlight = false;
        }
    }
    /** 剧情状态落盘（chat 层；默认关闭 → 空态不写） */
    async persistPlotState() {
        const blob = {
            events: this.adapter.plotEvents,
            winds: this.adapter.plotWinds,
            regionalIncident: this.adapter.regionalIncident,
            plotRound: this.adapter.plotRound,
        };
        return this.commit.enqueue(async () => {
            const meta = this.globals.getChatMetadata();
            meta.variables = { ...(meta.variables ?? {}), [STORE_KEY_CHAT_PLOT]: blob };
            this.globals.setChatMetadata(meta);
            this.globals.saveChat();
        });
    }
    /** 剧情状态加载（entry 水合；缺省空态） */
    loadPlotState() {
        const meta = this.globals.getChatMetadata();
        const stored = meta.variables?.[STORE_KEY_CHAT_PLOT];
        this.adapter.plotEvents = Array.isArray(stored?.events) ? stored.events : [];
        this.adapter.plotWinds = Array.isArray(stored?.winds) ? stored.winds : [];
        this.adapter.regionalIncident = stored?.regionalIncident ?? { active: null, cooldown: 0 };
        this.adapter.plotRound = typeof stored?.plotRound === 'number' ? stored.plotRound : 0;
        return { events: this.adapter.plotEvents, winds: this.adapter.plotWinds, regionalIncident: this.adapter.regionalIncident, plotRound: this.adapter.plotRound };
    }
    /** 新周目：世界推演状态重置（§22.7 GlobalHook 语义；chat 层随周目重开） */
    resetChatPlot() {
        this.adapter.plotEvents = [];
        this.adapter.plotWinds = [];
        this.adapter.regionalIncident = { active: null, cooldown: 0 };
        this.adapter.plotRound = 0;
        this.onPlotChanged?.();
    }
    // ============================================================
    // M16 检定接线（§23.2/§23.5：纯本地执行；结果不自动改状态——防奶人）
    // ============================================================
    /** @since M16 检定完成回调（bridge 注入：nlkaleido:dice_rolled，§23.7 面板刷新） */
    onDiceRolled;
    /** 记录检定（历史 + 关键成败 → 记忆候选；不写 stat_data，不自动改状态） */
    recordDice(kind, text, result) {
        const turnId = this.adapter.state?.meta.lastTurnId ?? 0;
        this.adapter.diceHistory.unshift({ id: hash64(`${kind}:${text}:${Date.now()}`), turnId, kind, text, result });
        if (this.adapter.diceHistory.length > 50)
            this.adapter.diceHistory.length = 50;
        // §23.7 记忆联动：大成功/大失败 → 记忆候选（记忆开启时）
        if (this.adapter.contract?.memory?.enabled && typeof result.degree === 'string') {
            const degree = result.degree;
            if (degree === 'critical' || degree === 'fumble') {
                writeMemoryCandidates(this.adapter.memoryStore, [makeAtom({ content: `[检定] ${text} → ${degree}`, type: 'episodic', importance: 0.7, confidence: 0.9, scope: 'chat', turnId })], Date.now());
            }
        }
        this.onDiceRolled?.(result);
    }
    /** 掷骰（§23.2 roll：骰子表达式；面板/建议表共用执行入口） */
    executeDiceRoll(formula) {
        try {
            const result = rollFormula(formula);
            this.recordDice('roll', formula, result);
            void this.persistDiceState();
            return { ok: true, result: { total: result.total, detail: result.detail, tags: result.tags } };
        }
        catch (error) {
            return { ok: false, error: error instanceof Error ? error.message : String(error) };
        }
    }
    /** 属性检定（§23.2 check + 可选预设结果分级 §23.3） */
    executeDiceCheck(args) {
        try {
            const result = check({
                targetValue: Number(args.targetValue),
                diceType: args.diceType ?? 100,
                successCriteria: args.successCriteria,
                modifier: args.modifier,
            });
            const out = {
                degree: result.degree, rank: result.rank, roll: result.roll, target: result.target, total: result.total, success: result.success, detail: result.detail, tags: result.tags,
            };
            const preset = args.presetId ? this.adapter.dicePresets.find((p) => p.id === args.presetId) : this.adapter.dicePresets[0];
            if (preset) {
                const ctx = buildPresetContext({ roll: result.roll, tags: result.tags, dc: result.target, total: result.total, attr: preset.attributes });
                const match = evaluateOutcomes(preset.outcomes, ctx, preset.outcomePolicy);
                out.outcomeId = match.outcome.id;
                out.outcomeName = match.outcome.name;
                out.outcomeRank = match.outcome.rank;
            }
            this.recordDice('check', args.label ?? `检定 DC${result.target}`, out);
            void this.persistDiceState();
            return { ok: true, result: out };
        }
        catch (error) {
            return { ok: false, error: error instanceof Error ? error.message : String(error) };
        }
    }
    /** 对抗检定（§23.2 contest） */
    executeDiceContest(args) {
        try {
            const result = contest({ left: args.left, right: args.right, rule: args.rule, diceType: args.diceType, successCriteria: args.successCriteria });
            const out = {
                winner: result.winner,
                left: { name: args.left.name, degree: result.left.degree, rank: result.left.rank, roll: result.left.roll },
                right: { name: args.right.name, degree: result.right.degree, rank: result.right.rank, roll: result.right.roll },
            };
            this.recordDice('contest', `${args.left.name} vs ${args.right.name}`, out);
            void this.persistDiceState();
            return { ok: true, result: out };
        }
        catch (error) {
            return { ok: false, error: error instanceof Error ? error.message : String(error) };
        }
    }
    /**
     * 检定建议执行（§23.5 M16d：AI 建议行 → 用户点击才执行，不自动改状态）。
     * DSL：检定 <角色> <属性> [key=value] / 对抗 … / 必成 / 必败 / 无。
     */
    executeDiceSuggestion(line) {
        try {
            const suggestion = parseCheckSuggestion(line);
            if (suggestion.kind === 'none')
                return { ok: true, result: { kind: 'none' } };
            if (suggestion.kind === 'auto_success') {
                this.recordDice('suggestion', line, { kind: 'auto_success', success: true });
                return { ok: true, result: { kind: 'auto_success', success: true } };
            }
            if (suggestion.kind === 'auto_fail') {
                this.recordDice('suggestion', line, { kind: 'auto_fail', success: false });
                return { ok: true, result: { kind: 'auto_fail', success: false } };
            }
            if (suggestion.kind === 'check') {
                const dc = Number(suggestion.params['dc'] ?? 50);
                return this.executeDiceCheck({ targetValue: dc, modifier: Number(suggestion.params['mod'] ?? 0), label: `${suggestion.character} ${suggestion.attribute}`, diceType: 100 });
            }
            const leftTarget = Number(suggestion.params['dc'] ?? 50);
            return this.executeDiceContest({
                left: { name: suggestion.initiator, targetValue: leftTarget },
                right: { name: suggestion.opponent, targetValue: leftTarget },
                rule: suggestion.tieRule,
                diceType: 100,
            });
        }
        catch (error) {
            return { ok: false, error: error instanceof Error ? error.message : String(error) };
        }
    }
    /** AI 预设导入（§23.4 M16c：tests 导入前校验，不通过拒绝） */
    importDicePreset(raw) {
        const validation = validateDicePreset(raw);
        if (!validation.ok)
            return { ok: false, error: validation.errors.join('；') };
        const preset = validation.preset;
        const existing = this.adapter.dicePresets.findIndex((p) => p.id === preset.id);
        if (existing >= 0)
            this.adapter.dicePresets[existing] = preset; // 同名覆盖（§23.6 语义）
        else
            this.adapter.dicePresets.push(preset);
        void this.persistDiceState();
        return { ok: true, preset };
    }
    /** 检定状态落盘（chat 层：预设库 + 历史；默认关闭 → 空态不写） */
    async persistDiceState() {
        const blob = { presets: this.adapter.dicePresets, history: this.adapter.diceHistory };
        return this.commit.enqueue(async () => {
            const meta = this.globals.getChatMetadata();
            meta.variables = { ...(meta.variables ?? {}), [STORE_KEY_CHAT_DICE]: blob };
            this.globals.setChatMetadata(meta);
            this.globals.saveChat();
        });
    }
    /** 检定状态加载（entry 水合；缺省空态） */
    loadDiceState() {
        const meta = this.globals.getChatMetadata();
        const stored = meta.variables?.[STORE_KEY_CHAT_DICE];
        this.adapter.dicePresets = Array.isArray(stored?.presets) ? stored.presets : [];
        this.adapter.diceHistory = Array.isArray(stored?.history) ? stored.history : [];
        return { presets: this.adapter.dicePresets, history: this.adapter.diceHistory };
    }
    // ============================================================
    // M14 配置中心接线（§20.13：极简档零配置直用；防奶人核心四项）
    // ============================================================
    /** 配置变化回调（bridge 注入：nlkaleido:config_changed，§20.13.7 存储/检索后端重建） */
    onConfigChanged;
    globalStore() {
        const ext = this.globals.getExtensionSettings();
        const variables = (ext.variables ?? {});
        const store = (variables.global ?? {});
        variables.global = store;
        ext.variables = variables;
        return store;
    }
    /** 配置加载（§20.13.6：configVersion 落后自动迁移；损坏恢复极简默认） */
    loadConfig() {
        const stored = this.globalStore()[STORE_KEY_CONFIG];
        const { config, errors } = migrateConfig(stored, []);
        if (errors.length)
            console.warn('[NLKaleido] 配置迁移/恢复：', errors);
        this.adapter.config = config ?? tierDefaults('minimal');
        const backup = this.globalStore()[STORE_KEY_CONFIG_BACKUP];
        if (backup && typeof backup === 'object' && backup.config) {
            this.adapter.configSnapshot = backup;
        }
        return this.adapter.config;
    }
    /** 配置保存（§20.13.6：extension_settings.variables.global['nlkaleido:config']） */
    async saveConfig(config) {
        this.adapter.config = applyOverrides(config);
        this.globalStore()[STORE_KEY_CONFIG] = this.adapter.config;
        this.globals.saveSettings();
        this.onConfigChanged?.();
    }
    /**
     * 破坏性配置操作（§20.13.1：二次确认在面板；此处自动备份快照再写盘）。
     * 返回新配置；回滚用 rollbackConfig。
     */
    async applyDestructiveConfig(config, reason) {
        const snapshot = takeSnapshot(this.adapter.config, reason);
        this.adapter.configSnapshot = snapshot;
        this.globalStore()[STORE_KEY_CONFIG_BACKUP] = snapshot;
        await this.saveConfig(config);
        return { config: this.adapter.config, snapshot };
    }
    /** 一键回滚到最近快照（§20.13.1） */
    async rollbackConfig() {
        if (!this.adapter.configSnapshot)
            return { ok: false, error: '无可用配置快照' };
        await this.saveConfig(this.adapter.configSnapshot.config);
        return { ok: true };
    }
    /** 恢复出厂设置（§20.13.1：极简档零配置） */
    async factoryResetConfig() {
        await this.saveConfig(tierDefaults('minimal'));
        return this.adapter.config;
    }
    /** 一键档位切换（§20.13.4：探测 → 决策 → dry-run → 生效；失败回滚最近可用配置） */
    async applyTier(preferred, env = {}) {
        const probe = probeEnvironment(env);
        const decision = decideTier(probe, preferred);
        const snapshot = takeSnapshot(this.adapter.config, `apply-tier-${preferred}`);
        try {
            await this.saveConfig(decision.config);
            const checks = runSelfCheck(this.adapter.config, {
                storageWriteOk: true,
                retrievalOk: decision.config.retrieval === 'bm25',
                injectionOk: true,
                vectorReady: decision.config.retrieval === 'vector' && probe.webllm === 'ready',
                atomsCount: this.adapter.memoryStore.atoms.length,
                maxAtoms: this.adapter.config.memory.maxAtoms,
            });
            return { ok: true, decision, checks };
        }
        catch (error) {
            // 失败自动回滚到最近可用配置（§20.13.1 绝不把坏配置写盘）
            this.adapter.configSnapshot = snapshot;
            this.globalStore()[STORE_KEY_CONFIG_BACKUP] = snapshot;
            await this.saveConfig(snapshot.config);
            return { ok: false, error: error instanceof Error ? error.message : String(error) };
        }
    }
    /** 玩家配置 → 记忆上限兜底（作者契约声明优先，§20.13.7 作者可覆盖） */
    memoryMaxAtoms(contract) {
        return contract?.memory?.maxAtoms ?? this.adapter.config.memory.maxAtoms;
    }
    // ============================================================
    // M13 记忆接线（§20.3/§20.5/§20.6；全部默认关闭路径，未启用不执行）
    // ============================================================
    /** 当前楼层锚点（yuzuki floor scope；MVP 无世界书楼层 → undefined 不隔离） */
    currentFloorId() {
        return undefined;
    }
    /** 原子数上限保护（M14 资源保护：超限丢弃最低 importance×decay 者） */
    enforceMaxAtoms(contract) {
        const maxAtoms = this.memoryMaxAtoms(contract);
        const { memoryStore } = this.adapter;
        if (memoryStore.atoms.length <= maxAtoms)
            return;
        const now = Date.now();
        memoryStore.atoms.sort((a, b) => {
            const daysA = Math.max(0, (now - a.lastAccessedAt) / 86400000);
            const daysB = Math.max(0, (now - b.lastAccessedAt) / 86400000);
            return (b.importance * Math.exp(-daysB / 30)) - (a.importance * Math.exp(-daysA / 30));
        });
        memoryStore.atoms.length = maxAtoms;
    }
    /** 新周目：chat 层记忆原子重置（§16.1 三级作用域复用；run/global 保留） */
    resetChatMemory() {
        this.adapter.memoryStore.atoms = this.adapter.memoryStore.atoms.filter((atom) => atom.scope !== 'chat');
        this.onMemoryChanged?.();
    }
    /**
     * 远记忆归档（§20.5/M13g，shujuku 归档语义）：未归档 changelog 达阈值 → 最早一批
     * → 独立总结请求 → 成功才删除原批 + 写长期摘要原子；失败整批保留、下轮重试。
     * 异步 fire-and-forget：绝不拉长变量链路。
     */
    async archiveChangelog(contract) {
        if (this.adapter.archiving || !this.adapter.state)
            return;
        const { state } = this.adapter;
        const threshold = contract.memory?.archiveThreshold ?? ARCHIVE_THRESHOLD;
        const batchSize = contract.memory?.archiveBatchSize ?? ARCHIVE_BATCH_SIZE;
        const selection = selectArchiveBatch(state.changelog, threshold, batchSize);
        if (!selection.triggered || !selection.batch.length)
            return;
        this.adapter.archiving = true;
        try {
            const summary = await this.summarizeArchiveBatch(selection.batch);
            if (summary) {
                const committed = commitArchive(state.changelog, selection.batch, summary);
                state.changelog = committed.entries;
                const { makeAtom } = await Promise.resolve().then(function () { return memory; });
                this.adapter.memoryStore.atoms.push(makeAtom({
                    content: `[归档] ${summary}`,
                    type: 'factual',
                    importance: 0.8,
                    confidence: 0.8,
                    scope: 'run',
                    turnId: state.meta.lastTurnId,
                }));
                this.enforceMaxAtoms(contract);
                await this.persistState(state);
                this.onMemoryChanged?.();
            }
            // 失败（summary 空）→ 原批保留，下轮重试（§20.5 整批成功才删）
        }
        catch (error) {
            console.warn('[NLKaleido] 记忆归档失败（保留原日志，下轮重试）：', error);
        }
        finally {
            this.adapter.archiving = false;
        }
    }
    /** 归档总结请求（独立请求，不阻塞变量链路；失败返回 null） */
    async summarizeArchiveBatch(batch) {
        try {
            const context = this.globals.getContext();
            if (typeof context.generateRawData !== 'function')
                return null;
            const lines = batch.map((entry) => `- 第${entry.turnId}轮 ${entry.path}${entry.source ? `（${entry.source}）` : ''}`).join('\n');
            const data = (await context.generateRawData({
                prompt: [
                    { role: 'system', content: `你是长期记忆归档器。把下列变量变更事件压缩成 1-2 句长期摘要（中文，主语明确、可脱离上下文理解）。只输出摘要本身，不要 JSON、不要标签。\n${lines}` },
                ],
                api: 'openai',
            }, undefined));
            const summary = data?.choices?.[0]?.message?.content?.trim() ?? '';
            return summary || null;
        }
        catch {
            return null;
        }
    }
    /** 记忆检索（§20.9 memory_search 工具 + 面板手动 search 共用） */
    searchMemoryText(query, topK = 5) {
        const atoms = searchMemory(this.adapter.memoryStore, query, { scope: 'chat', activeOnly: true, topK });
        if (!atoms.length)
            return '（无相关长期记忆）';
        return renderMemorySegment(this.adapter.memoryStore, query, { budgetTokens: 4000 }) ?? '（无相关长期记忆）';
    }
    // ============================================================
    // 变量请求（§10.2 requestVariableUpdate / buildVariableRequest）
    // ============================================================
    /** 构造 L0-L3 messages（KaleidoCache 提供内容；此处拼 VREQ 标记，§10.2） */
    buildVariableRequest(messages) {
        return { messages, jsonSchema: this.buildJsonSchema(this.adapter.contract ?? undefined) };
    }
    /** 变量请求 json_schema（U4：字段名 json_schema；DeepSeek 来源走 G5 兜底；reflection=true 追加记忆候选字段，§20.5） */
    buildJsonSchema(_contract, options = {}) {
        const properties = {
            analysis: { type: 'string', description: '剧情理解与更新理由' },
            json_patch: {
                type: 'array',
                items: {
                    type: 'object',
                    properties: {
                        op: { type: 'string', enum: ['replace', 'delta', 'add', 'remove', 'move'] },
                        path: { type: 'string' },
                        value: {},
                        from: { type: 'string' },
                        confidence: { type: 'string', enum: ['high', 'medium', 'low'] },
                        rationale: { type: 'string' },
                    },
                    required: ['op', 'path'],
                },
            },
        };
        if (options.reflection)
            Object.assign(properties, buildReflectionSchema()); // §20.5 合并进同一请求
        return {
            name: 'nlkaleido_variable_update',
            description: '变量状态更新：返回 {analysis, json_patch:[{op,path,value,confidence,rationale}]}',
            value: {
                type: 'object',
                properties,
                required: ['analysis', 'json_patch'],
            },
        };
    }
    /** VariableTransport 实现（单次模式）：generateRawData → 非流式返回完整 data（U5） */
    async requestVariableUpdate(messages, jsonSchema) {
        const context = this.globals.getContext();
        if (typeof context.generateRawData !== 'function') {
            throw new Error('ST 缺少 generateRawData（detectVersion 应已拦截）');
        }
        // VREQ 标记（§10.2 事件隔离：SETTINGS_READY 只重排自己的请求）
        const marked = [
            { role: 'system', name: VREQ_MARKER, content: '' },
            ...messages,
        ];
        // 【探明 2026-08-14 关键】generateRawData 传 jsonSchema 时返回 JSON.stringify 后的字符串且
        // 丢失 usage；不传时返回完整 data（choices+usage 原样透传）。因此这里不传 jsonSchema——
        // 结构化约束改在 onSettingsReady（stringify 前最后一站，U3）注入 generate_data.json_schema。
        // 本轮 schema（含 §20.5 reflection 字段）暂存到适配层字段，供 SETTINGS_READY 同步取用。
        this.pendingJsonSchema = jsonSchema;
        try {
            const data = (await context.generateRawData({
                prompt: marked,
                api: 'openai',
            }, undefined));
            // 从 choices[0].message.content 提取 JSON（tolerantJsonParse + G5 包裹兜底）
            const content = data?.choices?.[0]?.message?.content ?? '';
            const parsed = parseVariableResponse(content);
            return { analysis: parsed?.analysis, jsonPatch: parsed?.jsonPatch, usage: data?.usage, payload: parsed };
        }
        finally {
            this.pendingJsonSchema = null;
        }
    }
    /** SETTINGS_READY 注入点 B（U3：stringify 前最后一站）：重排 + 给自己请求注入 json_schema */
    onSettingsReady(generateData) {
        const messages = generateData.messages;
        if (!Array.isArray(messages))
            return;
        const hasMarker = messages.some((m) => m && typeof m === 'object' && m.name === VREQ_MARKER);
        if (!hasMarker)
            return; // 正文请求零干预（§10.2 事件隔离）
        // 结构化输出注入（U4：字段名 json_schema，前端无条件塞、后端 CUSTOM 翻译 response_format）
        // 优先用本轮请求暂存 schema（含 §20.5 reflection）；缺省回退 buildJsonSchema（如旧流程/测试直呼）
        if (!generateData.json_schema) {
            generateData.json_schema = this.pendingJsonSchema ?? this.buildJsonSchema(this.adapter.contract ?? undefined);
        }
        // 重排：标记行移到最后（保证标记之后的前缀稳定），其余顺序不变
        const marked = messages.filter((m) => m.name === VREQ_MARKER);
        const rest = messages.filter((m) => m.name !== VREQ_MARKER);
        generateData.messages = [...rest, ...marked];
    }
    // ============================================================
    // usage 埋点（§10.2 readUsage，U5 字段口径）
    // ============================================================
    /**
     * 解析 usage → Metrics（U5 + worldbook-manager 审计字段链）：
     * hit 源优先级 prompt_cache_hit_tokens → cached_tokens → cachedContentTokenCount →
     * cached_content_token_count → cache_read_input_tokens（monitor.ts:2130-2136）；
     * miss 源 prompt_cache_miss_tokens → uncached_tokens → cache_creation_input_tokens，
     * 缺失时 miss = max(0, promptTokens − hitTokens)（monitor.ts:2137-2149）。
     */
    readUsage(data) {
        const usage = data?.usage;
        if (!usage || typeof usage !== 'object')
            return null;
        const promptTokens = Number(usage.prompt_tokens ?? 0);
        const hitTokens = Number(usage.prompt_cache_hit_tokens
            ?? usage.cached_tokens
            ?? usage.cachedContentTokenCount
            ?? usage.cached_content_token_count
            ?? usage.cache_read_input_tokens
            ?? 0);
        Number(usage.prompt_cache_miss_tokens
            ?? usage.uncached_tokens
            ?? usage.cache_creation_input_tokens
            ?? Math.max(0, promptTokens - hitTokens));
        const completionTokens = Number(usage.completion_tokens ?? 0);
        return {
            prefixFingerprint: '',
            phit: 0,
            ttftMs: 0,
            promptTokens,
            completionTokens,
            usage: Object.fromEntries(Object.entries(usage).map(([k, v]) => [k, Number(v)])),
            costUsd: 0,
        };
    }
    /** 提取 hit/miss token 对（MetricsStore 聚合 PHit = Σhit/(Σhit+Σmiss)，WBM 口径） */
    extractHitMiss(metrics) {
        if (!metrics)
            return { hitTokens: 0, missTokens: 0 };
        const hit = Number(metrics.usage?.['prompt_cache_hit_tokens'] ?? metrics.usage?.['cached_tokens'] ?? 0);
        const miss = Number(metrics.usage?.['prompt_cache_miss_tokens']
            ?? metrics.usage?.['uncached_tokens']
            ?? Math.max(0, metrics.promptTokens - hit));
        return { hitTokens: hit, missTokens: miss };
    }
    // ============================================================
    // G3 提示词查看器式提取（格式补全 §3.4：generate → SETTINGS_READY 截停拿真实 messages）
    // ============================================================
    /**
     * 提取当前正文请求的最终 messages（G3，§10.2 extractCurrentPrompt）：
     * generate('normal') → SETTINGS_READY 拿最终 messages → stopGeneration() 截停（默认 30s 超时）。
     * 用途：探明实验（U2/U3）、变量请求上下文的备选来源（CacheStrategy/AgentAdapter 可替换承载）。
     */
    async extractCurrentPrompt(timeoutMs = 30000) {
        const context = this.globals.getContext();
        if (typeof context.generate !== 'function' || typeof context.stopGeneration !== 'function') {
            throw new Error('extractCurrentPrompt 需要 generate/stopGeneration（detectVersion 未覆盖）');
        }
        const eventSource = context.eventSource;
        const settingsReady = context.eventTypes.CHAT_COMPLETION_SETTINGS_READY;
        return new Promise((resolve, reject) => {
            let done = false;
            const handler = (data) => {
                if (done)
                    return;
                done = true;
                cleanup();
                context.stopGeneration();
                resolve((data?.messages ?? []));
            };
            const cleanup = () => {
                eventSource.off?.(settingsReady, handler);
                clearTimeout(timer);
            };
            const timer = setTimeout(() => {
                if (done)
                    return;
                done = true;
                cleanup();
                context.stopGeneration();
                reject(new Error(`extractCurrentPrompt 超时（${timeoutMs}ms）`));
            }, timeoutMs);
            eventSource.on(settingsReady, handler);
            Promise.resolve(context.generate('normal'))
                .then(() => {
                if (!done) {
                    done = true;
                    cleanup();
                    reject(new Error('未能提取提示词（生成先于 SETTINGS_READY 完成）'));
                }
            })
                .catch((error) => {
                if (!done) {
                    done = true;
                    cleanup();
                    reject(error instanceof Error ? error : new Error(String(error)));
                }
            });
        });
    }
    // ============================================================
    // G4 intercept_anchor 注入（格式补全 §3.2：不新增消息条数，前缀更稳）
    // ============================================================
    /**
     * 锚点后拦截注入（G4，§10.2 intercept_anchor）：变量任务提示词插入末尾 user 消息锚点之后，
     * 消息条数不变 → 前缀缓存更稳。找不到锚点/末条非 user → 追加新 user 消息（保守降级）。
     */
    injectAtAnchor(messages, content, anchorRegex) {
        const last = messages.at(-1);
        if (!last || last.role !== 'user') {
            return [...messages, { role: 'user', content }];
        }
        const match = findLastMatch(last.content, anchorRegex);
        if (!match) {
            return [...messages, { role: 'user', content }];
        }
        const next = [...messages];
        next[next.length - 1] = {
            ...last,
            content: insertAt(last.content, match.index + match[0].length, content),
        };
        return next;
    }
    registerMultiStepTools() {
        const context = this.globals.getContext();
        if (!this.adapter.toolsRegistered && typeof context.registerFunctionTool === 'function') {
            context.registerFunctionTool('get_state', (async () => this.toolGetState()));
            context.registerFunctionTool('apply_patch', (async (args) => this.toolApplyPatch(args?.ops ?? [])));
            // §20.9 记忆工具（livingmemory recall_long_term_memory / memorize_long_term_memory；仅记忆开启时注册）
            if (this.adapter.contract?.memory?.enabled) {
                context.registerFunctionTool('memory_search', (async (args) => this.toolMemorySearch(String(args?.query ?? ''))));
                context.registerFunctionTool('memory_memorize', (async (args) => this.toolMemoryMemorize(args ?? {})));
            }
            this.adapter.toolsRegistered = true;
        }
    }
    unregisterMultiStepTools() {
        const context = this.globals.getContext();
        if (this.adapter.toolsRegistered && typeof context.unregisterFunctionTool === 'function') {
            context.unregisterFunctionTool('get_state');
            context.unregisterFunctionTool('apply_patch');
            context.unregisterFunctionTool('memory_search');
            context.unregisterFunctionTool('memory_memorize');
            this.adapter.toolsRegistered = false;
        }
    }
    async toolGetState() {
        const { contract, state } = this.adapter;
        if (!contract || !state)
            return '{}';
        const { renderStateTable } = await Promise.resolve().then(function () { return render; });
        return renderStateTable(contract, state, 'full');
    }
    async toolApplyPatch(ops) {
        const { contract, state } = this.adapter;
        if (!contract || !state)
            return { ok: false, errors: ['未加载状态'] };
        const { applyPatchTool } = await Promise.resolve().then(function () { return agent; });
        const result = applyPatchTool(contract, state, ops, state.meta.lastTurnId + 1);
        await this.persistState(state);
        return { ok: result.rejected.length === 0, errors: result.rejected.map((r) => `${r.op.path}：${r.reason}`) };
    }
    /** §20.9 memory_search：BM25 检索长期记忆（top-K，含强化） */
    async toolMemorySearch(query) {
        if (!query)
            return '（缺少 query）';
        return this.searchMemoryText(query, this.adapter.contract?.memory?.injectTopK ?? 5);
    }
    /** §20.9 memory_memorize：主动写入长期记忆（classifyAtom 兜底分类 + 置信度门控） */
    async toolMemoryMemorize(args) {
        const { makeAtom, writeMemoryCandidates } = await Promise.resolve().then(function () { return memory; });
        const content = String(args?.content ?? '').trim();
        if (!content)
            return { ok: false, error: '缺少 content' };
        const atom = makeAtom({
            content,
            type: typeof args?.type === 'string' ? args.type : undefined,
            importance: typeof args?.importance === 'number' ? args.importance : 0.7,
            confidence: typeof args?.confidence === 'number' ? args.confidence : 0.8,
            entities: Array.isArray(args?.entities) ? args.entities.filter((e) => typeof e === 'string') : [],
            scope: args?.scope ?? 'chat',
            turnId: this.adapter.state?.meta.lastTurnId ?? 0,
        });
        const result = writeMemoryCandidates(this.adapter.memoryStore, [atom], Date.now());
        if (this.adapter.contract)
            this.enforceMaxAtoms(this.adapter.contract);
        if (result.added.length || result.merged.length) {
            if (this.adapter.state)
                await this.persistState(this.adapter.state);
            this.onMemoryChanged?.();
            return { ok: true, id: atom.id };
        }
        return { ok: false, error: '置信度过低未写入' };
    }
    async requestMultiStepUpdate() {
        const { contract, state } = this.adapter;
        if (!contract || !state)
            return null;
        this.registerMultiStepTools();
        try {
            const result = await runMultiStepAgent({
                requestTools: async () => ({
                    getState: async () => this.toolGetState(),
                    applyPatch: async (ops) => this.toolApplyPatch(ops),
                }),
                isDone: (toolResult) => {
                    const record = toolResult;
                    return Array.isArray(record?.ops) && record.ops.length === 0;
                },
            }, { contract, state, turnId: state.meta.lastTurnId + 1 });
            await this.persistState(state);
            return result;
        }
        finally {
            this.unregisterMultiStepTools(); // 主收尾（§10.2 不残留铁律）
        }
    }
    // ============================================================
    // 存储（§10.2 persistState/loadState；U2/U6 结论）
    // ============================================================
    /** commit 串行化落盘（§17.14-S1 单写入口 + §16.1 三级作用域路由）：失败记录上浮，不炸主链 */
    persistState(state) {
        return this.commit.enqueue(async () => {
            try {
                const contract = this.adapter.contract;
                const layers = contract
                    ? splitStatDataByPersist(contract, state.stat_data)
                    : { chat: state.stat_data, run: {}, global: {} };
                // chat 层：state 主体（meta/changelog/checkpoints + chat 字段值）
                const chatState = { ...state, stat_data: layers.chat };
                const meta = this.globals.getChatMetadata();
                meta.variables = { ...(meta.variables ?? {}), [STORE_KEY_CHAT]: chatState };
                // §20.10：记忆与变量共用存储体系（chat 层持久化；默认关闭 → 空库不写）
                const memoryEnabled = contract?.memory?.enabled === true;
                if (memoryEnabled || this.adapter.memoryStore.atoms.length || this.adapter.memoryTables.length) {
                    meta.variables[STORE_KEY_CHAT_MEMORY] = { store: this.adapter.memoryStore, tables: this.adapter.memoryTables };
                }
                this.globals.setChatMetadata(meta);
                this.globals.saveChat(); // U2 补充：updateChatMetadata 只改内存，须自行落盘
                // run/global 层（§16.1）：extension_settings.variables.global（U6 服务端 settings.json）
                const ext = this.globals.getExtensionSettings();
                const variables = (ext.variables ?? {});
                const globalStore = (variables.global ?? {});
                if (contract) {
                    globalStore[`${STORE_KEY_GLOBAL_PREFIX}${contract.id}`] = layers.run; // run 层：nlkaleido:<contractId>
                    const globalFields = (globalStore[`${STORE_KEY_GLOBAL_PREFIX}global.fields`] ?? {});
                    globalFields[contract.id] = layers.global; // global 层字段：nlkaleido:global.fields.<contractId>
                    globalStore[`${STORE_KEY_GLOBAL_PREFIX}global.fields`] = globalFields;
                }
                globalStore[`${STORE_KEY_GLOBAL_PREFIX}revision`] = { seq: state.revision.seq, hash: state.revision.hash, contractVersion: state.contractVersion };
                variables.global = globalStore;
                ext.variables = variables;
                this.globals.saveSettings();
                this.commit.recordError(null);
            }
            catch (error) {
                const message = error instanceof Error ? error.message : String(error);
                this.commit.recordError(`落盘失败：${message}`);
                console.error('[NLKaleido] persistState 失败：', error);
            }
        });
    }
    loadState() {
        const meta = this.globals.getChatMetadata();
        const stored = meta.variables?.[STORE_KEY_CHAT];
        if (stored && typeof stored === 'object') {
            return stored;
        }
        return null;
    }
    /** @since M13 加载记忆持久化（chat 层 blob：{store, tables}；缺省返回空库） */
    loadMemoryStore() {
        const meta = this.globals.getChatMetadata();
        const stored = meta.variables?.[STORE_KEY_CHAT_MEMORY];
        const store = stored?.store && Array.isArray(stored.store.atoms)
            ? { version: 1, atoms: stored.store.atoms }
            : { version: 1, atoms: [] };
        const tables = Array.isArray(stored?.tables) ? stored.tables.map((t) => ({ ...t, rows: [...(t.rows ?? [])] })) : [];
        this.adapter.memoryStore = store;
        this.adapter.memoryTables = tables;
        return { store, tables };
    }
    /** @since M13 契约记忆表水合（§20.7：契约声明列结构 + 存量行合并；缺列补齐） */
    hydrateMemoryTables(contract) {
        const declared = contract.memory?.tables ?? [];
        const existing = new Map(this.adapter.memoryTables.map((t) => [t.id, t]));
        const tables = declared.map((def) => {
            const old = existing.get(def.id);
            const table = old ?? createMemoryTable(def.id, def.name, def.columns, def.floorScoped);
            // 列定义以契约为准：新列追加（存量行缺列补空串），契约列之外的存量列保留
            table.name = def.name;
            table.floorScoped = def.floorScoped ?? table.floorScoped;
            const currentColumns = new Set(table.columns);
            for (const column of def.columns) {
                if (!currentColumns.has(column)) {
                    table.columns.push(column);
                    for (const row of table.rows)
                        row.values[column.replace(/^[#*]/, '')] ??= '';
                }
            }
            return table;
        });
        this.adapter.memoryTables = tables;
        return tables;
    }
    /** 加载后水合：run/global 层字段合并回统一 stat_data（§16.1；contract 载入后调用） */
    hydratePersistLayers(state, contract) {
        const ext = this.globals.getExtensionSettings();
        const globalStore = (ext.variables ?? {}).global ?? {};
        const runLayer = (globalStore[`${STORE_KEY_GLOBAL_PREFIX}${contract.id}`] ?? {});
        const globalFields = (globalStore[`${STORE_KEY_GLOBAL_PREFIX}global.fields`] ?? {});
        const globalLayer = (globalFields[contract.id] ?? {});
        state.stat_data = mergeStatDataLayers(contract, state.stat_data ?? {}, runLayer, globalLayer);
        return state;
    }
    /** 读取本卡成就（§16.2：存 global 层独立结构，跨聊天/跨周目） */
    readAchievements(contractId) {
        const ext = this.globals.getExtensionSettings();
        const globalStore = (ext.variables ?? {}).global ?? {};
        const all = (globalStore[`${STORE_KEY_GLOBAL_PREFIX}global.achievements`] ?? {});
        return (all[contractId] ?? []);
    }
    /** 写回本卡成就（条件写回：有变化才调 saveSettings） */
    writeAchievements(contractId, achievements) {
        const ext = this.globals.getExtensionSettings();
        const variables = { ...(ext.variables ?? {}) };
        const globalStore = { ...(variables.global ?? {}) };
        const all = { ...(globalStore[`${STORE_KEY_GLOBAL_PREFIX}global.achievements`] ?? {}) };
        all[contractId] = achievements;
        globalStore[`${STORE_KEY_GLOBAL_PREFIX}global.achievements`] = all;
        variables.global = globalStore;
        ext.variables = variables;
        this.globals.saveSettings();
    }
    // ============================================================
    // 聊天内容提取（L3 尾部输入）
    // ============================================================
    extractRecentStory(chat) {
        return chat.slice(-24).map((m) => ({
            role: m.is_user ? 'user' : 'assistant',
            name: m.name,
            content: m.mes ?? '',
        }));
    }
    extractUserInput(chat) {
        for (let i = chat.length - 1; i >= 0; i -= 1) {
            if (chat[i].is_user)
                return chat[i].mes ?? '';
        }
        return '';
    }
    /** 最近剧情 hash（§21.4-a 请求节流：漂移小可跳过） */
    storyHash(chat) {
        return hash64(chat.slice(-12).map((m) => m.mes ?? '').join('\n'));
    }
}
/** 最后一个匹配（格式补全 §3.6 P：g flag + 空匹配保护） */
function findLastMatch(text, regex) {
    const flags = regex.flags.includes('g') ? regex.flags : `${regex.flags}g`;
    const global = new RegExp(regex.source, flags);
    let last = null;
    let match;
    while ((match = global.exec(text)) !== null) {
        if (match[0].length === 0)
            global.lastIndex += 1; // 空匹配保护
        last = match;
    }
    return last;
}
/** 在指定位置插入文本 */
function insertAt(text, index, content) {
    return `${text.slice(0, index)}${content}${text.slice(index)}`;
}
/**
 * 解析变量响应文本（G5 兜底）：
 * 1. `<nlkaleido_patch>…</nlkaleido_patch>` 包裹 → 提取后走 sanitize；
 * 2. 裸 JSON（含容错修复）→ 取 analysis/json_patch；
 * 3. 全部失败 → { jsonPatch: undefined }（交给 sanitize 层产出结构化失败原因喂回重试）。
 */
function parseVariableResponse(content) {
    const wrapped = /<nlkaleido_patch>([\s\S]*?)<\/nlkaleido_patch>/u.exec(content);
    const parsed = tolerantJsonParse(wrapped ? wrapped[1] : content);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        const record = parsed;
        // 扩展字段透传（§20.5 memory_candidates 等），analysis/json_patch 规范化
        return {
            ...record,
            analysis: typeof record.analysis === 'string' ? record.analysis : undefined,
            jsonPatch: record.json_patch ?? undefined,
        };
    }
    if (Array.isArray(parsed)) {
        return { jsonPatch: parsed };
    }
    return {};
}

var util;
(function (util) {
    util.assertEqual = (_) => { };
    function assertIs(_arg) { }
    util.assertIs = assertIs;
    function assertNever(_x) {
        throw new Error();
    }
    util.assertNever = assertNever;
    util.arrayToEnum = (items) => {
        const obj = {};
        for (const item of items) {
            obj[item] = item;
        }
        return obj;
    };
    util.getValidEnumValues = (obj) => {
        const validKeys = util.objectKeys(obj).filter((k) => typeof obj[obj[k]] !== "number");
        const filtered = {};
        for (const k of validKeys) {
            filtered[k] = obj[k];
        }
        return util.objectValues(filtered);
    };
    util.objectValues = (obj) => {
        return util.objectKeys(obj).map(function (e) {
            return obj[e];
        });
    };
    util.objectKeys = typeof Object.keys === "function" // eslint-disable-line ban/ban
        ? (obj) => Object.keys(obj) // eslint-disable-line ban/ban
        : (object) => {
            const keys = [];
            for (const key in object) {
                if (Object.prototype.hasOwnProperty.call(object, key)) {
                    keys.push(key);
                }
            }
            return keys;
        };
    util.find = (arr, checker) => {
        for (const item of arr) {
            if (checker(item))
                return item;
        }
        return undefined;
    };
    util.isInteger = typeof Number.isInteger === "function"
        ? (val) => Number.isInteger(val) // eslint-disable-line ban/ban
        : (val) => typeof val === "number" && Number.isFinite(val) && Math.floor(val) === val;
    function joinValues(array, separator = " | ") {
        return array.map((val) => (typeof val === "string" ? `'${val}'` : val)).join(separator);
    }
    util.joinValues = joinValues;
    util.jsonStringifyReplacer = (_, value) => {
        if (typeof value === "bigint") {
            return value.toString();
        }
        return value;
    };
})(util || (util = {}));
var objectUtil;
(function (objectUtil) {
    objectUtil.mergeShapes = (first, second) => {
        return {
            ...first,
            ...second, // second overwrites first
        };
    };
})(objectUtil || (objectUtil = {}));
const ZodParsedType = util.arrayToEnum([
    "string",
    "nan",
    "number",
    "integer",
    "float",
    "boolean",
    "date",
    "bigint",
    "symbol",
    "function",
    "undefined",
    "null",
    "array",
    "object",
    "unknown",
    "promise",
    "void",
    "never",
    "map",
    "set",
]);
const getParsedType = (data) => {
    const t = typeof data;
    switch (t) {
        case "undefined":
            return ZodParsedType.undefined;
        case "string":
            return ZodParsedType.string;
        case "number":
            return Number.isNaN(data) ? ZodParsedType.nan : ZodParsedType.number;
        case "boolean":
            return ZodParsedType.boolean;
        case "function":
            return ZodParsedType.function;
        case "bigint":
            return ZodParsedType.bigint;
        case "symbol":
            return ZodParsedType.symbol;
        case "object":
            if (Array.isArray(data)) {
                return ZodParsedType.array;
            }
            if (data === null) {
                return ZodParsedType.null;
            }
            if (data.then && typeof data.then === "function" && data.catch && typeof data.catch === "function") {
                return ZodParsedType.promise;
            }
            if (typeof Map !== "undefined" && data instanceof Map) {
                return ZodParsedType.map;
            }
            if (typeof Set !== "undefined" && data instanceof Set) {
                return ZodParsedType.set;
            }
            if (typeof Date !== "undefined" && data instanceof Date) {
                return ZodParsedType.date;
            }
            return ZodParsedType.object;
        default:
            return ZodParsedType.unknown;
    }
};

const ZodIssueCode = util.arrayToEnum([
    "invalid_type",
    "invalid_literal",
    "custom",
    "invalid_union",
    "invalid_union_discriminator",
    "invalid_enum_value",
    "unrecognized_keys",
    "invalid_arguments",
    "invalid_return_type",
    "invalid_date",
    "invalid_string",
    "too_small",
    "too_big",
    "invalid_intersection_types",
    "not_multiple_of",
    "not_finite",
]);
class ZodError extends Error {
    get errors() {
        return this.issues;
    }
    constructor(issues) {
        super();
        this.issues = [];
        this.addIssue = (sub) => {
            this.issues = [...this.issues, sub];
        };
        this.addIssues = (subs = []) => {
            this.issues = [...this.issues, ...subs];
        };
        const actualProto = new.target.prototype;
        if (Object.setPrototypeOf) {
            // eslint-disable-next-line ban/ban
            Object.setPrototypeOf(this, actualProto);
        }
        else {
            this.__proto__ = actualProto;
        }
        this.name = "ZodError";
        this.issues = issues;
    }
    format(_mapper) {
        const mapper = _mapper ||
            function (issue) {
                return issue.message;
            };
        const fieldErrors = { _errors: [] };
        const processError = (error) => {
            for (const issue of error.issues) {
                if (issue.code === "invalid_union") {
                    issue.unionErrors.map(processError);
                }
                else if (issue.code === "invalid_return_type") {
                    processError(issue.returnTypeError);
                }
                else if (issue.code === "invalid_arguments") {
                    processError(issue.argumentsError);
                }
                else if (issue.path.length === 0) {
                    fieldErrors._errors.push(mapper(issue));
                }
                else {
                    let curr = fieldErrors;
                    let i = 0;
                    while (i < issue.path.length) {
                        const el = issue.path[i];
                        const terminal = i === issue.path.length - 1;
                        if (!terminal) {
                            curr[el] = curr[el] || { _errors: [] };
                            // if (typeof el === "string") {
                            //   curr[el] = curr[el] || { _errors: [] };
                            // } else if (typeof el === "number") {
                            //   const errorArray: any = [];
                            //   errorArray._errors = [];
                            //   curr[el] = curr[el] || errorArray;
                            // }
                        }
                        else {
                            curr[el] = curr[el] || { _errors: [] };
                            curr[el]._errors.push(mapper(issue));
                        }
                        curr = curr[el];
                        i++;
                    }
                }
            }
        };
        processError(this);
        return fieldErrors;
    }
    static assert(value) {
        if (!(value instanceof ZodError)) {
            throw new Error(`Not a ZodError: ${value}`);
        }
    }
    toString() {
        return this.message;
    }
    get message() {
        return JSON.stringify(this.issues, util.jsonStringifyReplacer, 2);
    }
    get isEmpty() {
        return this.issues.length === 0;
    }
    flatten(mapper = (issue) => issue.message) {
        const fieldErrors = {};
        const formErrors = [];
        for (const sub of this.issues) {
            if (sub.path.length > 0) {
                const firstEl = sub.path[0];
                fieldErrors[firstEl] = fieldErrors[firstEl] || [];
                fieldErrors[firstEl].push(mapper(sub));
            }
            else {
                formErrors.push(mapper(sub));
            }
        }
        return { formErrors, fieldErrors };
    }
    get formErrors() {
        return this.flatten();
    }
}
ZodError.create = (issues) => {
    const error = new ZodError(issues);
    return error;
};

const errorMap = (issue, _ctx) => {
    let message;
    switch (issue.code) {
        case ZodIssueCode.invalid_type:
            if (issue.received === ZodParsedType.undefined) {
                message = "Required";
            }
            else {
                message = `Expected ${issue.expected}, received ${issue.received}`;
            }
            break;
        case ZodIssueCode.invalid_literal:
            message = `Invalid literal value, expected ${JSON.stringify(issue.expected, util.jsonStringifyReplacer)}`;
            break;
        case ZodIssueCode.unrecognized_keys:
            message = `Unrecognized key(s) in object: ${util.joinValues(issue.keys, ", ")}`;
            break;
        case ZodIssueCode.invalid_union:
            message = `Invalid input`;
            break;
        case ZodIssueCode.invalid_union_discriminator:
            message = `Invalid discriminator value. Expected ${util.joinValues(issue.options)}`;
            break;
        case ZodIssueCode.invalid_enum_value:
            message = `Invalid enum value. Expected ${util.joinValues(issue.options)}, received '${issue.received}'`;
            break;
        case ZodIssueCode.invalid_arguments:
            message = `Invalid function arguments`;
            break;
        case ZodIssueCode.invalid_return_type:
            message = `Invalid function return type`;
            break;
        case ZodIssueCode.invalid_date:
            message = `Invalid date`;
            break;
        case ZodIssueCode.invalid_string:
            if (typeof issue.validation === "object") {
                if ("includes" in issue.validation) {
                    message = `Invalid input: must include "${issue.validation.includes}"`;
                    if (typeof issue.validation.position === "number") {
                        message = `${message} at one or more positions greater than or equal to ${issue.validation.position}`;
                    }
                }
                else if ("startsWith" in issue.validation) {
                    message = `Invalid input: must start with "${issue.validation.startsWith}"`;
                }
                else if ("endsWith" in issue.validation) {
                    message = `Invalid input: must end with "${issue.validation.endsWith}"`;
                }
                else {
                    util.assertNever(issue.validation);
                }
            }
            else if (issue.validation !== "regex") {
                message = `Invalid ${issue.validation}`;
            }
            else {
                message = "Invalid";
            }
            break;
        case ZodIssueCode.too_small:
            if (issue.type === "array")
                message = `Array must contain ${issue.exact ? "exactly" : issue.inclusive ? `at least` : `more than`} ${issue.minimum} element(s)`;
            else if (issue.type === "string")
                message = `String must contain ${issue.exact ? "exactly" : issue.inclusive ? `at least` : `over`} ${issue.minimum} character(s)`;
            else if (issue.type === "number")
                message = `Number must be ${issue.exact ? `exactly equal to ` : issue.inclusive ? `greater than or equal to ` : `greater than `}${issue.minimum}`;
            else if (issue.type === "bigint")
                message = `Number must be ${issue.exact ? `exactly equal to ` : issue.inclusive ? `greater than or equal to ` : `greater than `}${issue.minimum}`;
            else if (issue.type === "date")
                message = `Date must be ${issue.exact ? `exactly equal to ` : issue.inclusive ? `greater than or equal to ` : `greater than `}${new Date(Number(issue.minimum))}`;
            else
                message = "Invalid input";
            break;
        case ZodIssueCode.too_big:
            if (issue.type === "array")
                message = `Array must contain ${issue.exact ? `exactly` : issue.inclusive ? `at most` : `less than`} ${issue.maximum} element(s)`;
            else if (issue.type === "string")
                message = `String must contain ${issue.exact ? `exactly` : issue.inclusive ? `at most` : `under`} ${issue.maximum} character(s)`;
            else if (issue.type === "number")
                message = `Number must be ${issue.exact ? `exactly` : issue.inclusive ? `less than or equal to` : `less than`} ${issue.maximum}`;
            else if (issue.type === "bigint")
                message = `BigInt must be ${issue.exact ? `exactly` : issue.inclusive ? `less than or equal to` : `less than`} ${issue.maximum}`;
            else if (issue.type === "date")
                message = `Date must be ${issue.exact ? `exactly` : issue.inclusive ? `smaller than or equal to` : `smaller than`} ${new Date(Number(issue.maximum))}`;
            else
                message = "Invalid input";
            break;
        case ZodIssueCode.custom:
            message = `Invalid input`;
            break;
        case ZodIssueCode.invalid_intersection_types:
            message = `Intersection results could not be merged`;
            break;
        case ZodIssueCode.not_multiple_of:
            message = `Number must be a multiple of ${issue.multipleOf}`;
            break;
        case ZodIssueCode.not_finite:
            message = "Number must be finite";
            break;
        default:
            message = _ctx.defaultError;
            util.assertNever(issue);
    }
    return { message };
};

let overrideErrorMap = errorMap;
function getErrorMap() {
    return overrideErrorMap;
}

const makeIssue = (params) => {
    const { data, path, errorMaps, issueData } = params;
    const fullPath = [...path, ...(issueData.path || [])];
    const fullIssue = {
        ...issueData,
        path: fullPath,
    };
    if (issueData.message !== undefined) {
        return {
            ...issueData,
            path: fullPath,
            message: issueData.message,
        };
    }
    let errorMessage = "";
    const maps = errorMaps
        .filter((m) => !!m)
        .slice()
        .reverse();
    for (const map of maps) {
        errorMessage = map(fullIssue, { data, defaultError: errorMessage }).message;
    }
    return {
        ...issueData,
        path: fullPath,
        message: errorMessage,
    };
};
function addIssueToContext(ctx, issueData) {
    const overrideMap = getErrorMap();
    const issue = makeIssue({
        issueData: issueData,
        data: ctx.data,
        path: ctx.path,
        errorMaps: [
            ctx.common.contextualErrorMap, // contextual error map is first priority
            ctx.schemaErrorMap, // then schema-bound map if available
            overrideMap, // then global override map
            overrideMap === errorMap ? undefined : errorMap, // then global default map
        ].filter((x) => !!x),
    });
    ctx.common.issues.push(issue);
}
class ParseStatus {
    constructor() {
        this.value = "valid";
    }
    dirty() {
        if (this.value === "valid")
            this.value = "dirty";
    }
    abort() {
        if (this.value !== "aborted")
            this.value = "aborted";
    }
    static mergeArray(status, results) {
        const arrayValue = [];
        for (const s of results) {
            if (s.status === "aborted")
                return INVALID;
            if (s.status === "dirty")
                status.dirty();
            arrayValue.push(s.value);
        }
        return { status: status.value, value: arrayValue };
    }
    static async mergeObjectAsync(status, pairs) {
        const syncPairs = [];
        for (const pair of pairs) {
            const key = await pair.key;
            const value = await pair.value;
            syncPairs.push({
                key,
                value,
            });
        }
        return ParseStatus.mergeObjectSync(status, syncPairs);
    }
    static mergeObjectSync(status, pairs) {
        const finalObject = {};
        for (const pair of pairs) {
            const { key, value } = pair;
            if (key.status === "aborted")
                return INVALID;
            if (value.status === "aborted")
                return INVALID;
            if (key.status === "dirty")
                status.dirty();
            if (value.status === "dirty")
                status.dirty();
            if (key.value !== "__proto__" && (typeof value.value !== "undefined" || pair.alwaysSet)) {
                finalObject[key.value] = value.value;
            }
        }
        return { status: status.value, value: finalObject };
    }
}
const INVALID = Object.freeze({
    status: "aborted",
});
const DIRTY = (value) => ({ status: "dirty", value });
const OK = (value) => ({ status: "valid", value });
const isAborted = (x) => x.status === "aborted";
const isDirty$1 = (x) => x.status === "dirty";
const isValid = (x) => x.status === "valid";
const isAsync = (x) => typeof Promise !== "undefined" && x instanceof Promise;

var errorUtil;
(function (errorUtil) {
    errorUtil.errToObj = (message) => typeof message === "string" ? { message } : message || {};
    // biome-ignore lint:
    errorUtil.toString = (message) => typeof message === "string" ? message : message?.message;
})(errorUtil || (errorUtil = {}));

class ParseInputLazyPath {
    constructor(parent, value, path, key) {
        this._cachedPath = [];
        this.parent = parent;
        this.data = value;
        this._path = path;
        this._key = key;
    }
    get path() {
        if (!this._cachedPath.length) {
            if (Array.isArray(this._key)) {
                this._cachedPath.push(...this._path, ...this._key);
            }
            else {
                this._cachedPath.push(...this._path, this._key);
            }
        }
        return this._cachedPath;
    }
}
const handleResult = (ctx, result) => {
    if (isValid(result)) {
        return { success: true, data: result.value };
    }
    else {
        if (!ctx.common.issues.length) {
            throw new Error("Validation failed but no issues detected.");
        }
        return {
            success: false,
            get error() {
                if (this._error)
                    return this._error;
                const error = new ZodError(ctx.common.issues);
                this._error = error;
                return this._error;
            },
        };
    }
};
function processCreateParams(params) {
    if (!params)
        return {};
    const { errorMap, invalid_type_error, required_error, description } = params;
    if (errorMap && (invalid_type_error || required_error)) {
        throw new Error(`Can't use "invalid_type_error" or "required_error" in conjunction with custom error map.`);
    }
    if (errorMap)
        return { errorMap: errorMap, description };
    const customMap = (iss, ctx) => {
        const { message } = params;
        if (iss.code === "invalid_enum_value") {
            return { message: message ?? ctx.defaultError };
        }
        if (typeof ctx.data === "undefined") {
            return { message: message ?? required_error ?? ctx.defaultError };
        }
        if (iss.code !== "invalid_type")
            return { message: ctx.defaultError };
        return { message: message ?? invalid_type_error ?? ctx.defaultError };
    };
    return { errorMap: customMap, description };
}
class ZodType {
    get description() {
        return this._def.description;
    }
    _getType(input) {
        return getParsedType(input.data);
    }
    _getOrReturnCtx(input, ctx) {
        return (ctx || {
            common: input.parent.common,
            data: input.data,
            parsedType: getParsedType(input.data),
            schemaErrorMap: this._def.errorMap,
            path: input.path,
            parent: input.parent,
        });
    }
    _processInputParams(input) {
        return {
            status: new ParseStatus(),
            ctx: {
                common: input.parent.common,
                data: input.data,
                parsedType: getParsedType(input.data),
                schemaErrorMap: this._def.errorMap,
                path: input.path,
                parent: input.parent,
            },
        };
    }
    _parseSync(input) {
        const result = this._parse(input);
        if (isAsync(result)) {
            throw new Error("Synchronous parse encountered promise.");
        }
        return result;
    }
    _parseAsync(input) {
        const result = this._parse(input);
        return Promise.resolve(result);
    }
    parse(data, params) {
        const result = this.safeParse(data, params);
        if (result.success)
            return result.data;
        throw result.error;
    }
    safeParse(data, params) {
        const ctx = {
            common: {
                issues: [],
                async: params?.async ?? false,
                contextualErrorMap: params?.errorMap,
            },
            path: params?.path || [],
            schemaErrorMap: this._def.errorMap,
            parent: null,
            data,
            parsedType: getParsedType(data),
        };
        const result = this._parseSync({ data, path: ctx.path, parent: ctx });
        return handleResult(ctx, result);
    }
    "~validate"(data) {
        const ctx = {
            common: {
                issues: [],
                async: !!this["~standard"].async,
            },
            path: [],
            schemaErrorMap: this._def.errorMap,
            parent: null,
            data,
            parsedType: getParsedType(data),
        };
        if (!this["~standard"].async) {
            try {
                const result = this._parseSync({ data, path: [], parent: ctx });
                return isValid(result)
                    ? {
                        value: result.value,
                    }
                    : {
                        issues: ctx.common.issues,
                    };
            }
            catch (err) {
                if (err?.message?.toLowerCase()?.includes("encountered")) {
                    this["~standard"].async = true;
                }
                ctx.common = {
                    issues: [],
                    async: true,
                };
            }
        }
        return this._parseAsync({ data, path: [], parent: ctx }).then((result) => isValid(result)
            ? {
                value: result.value,
            }
            : {
                issues: ctx.common.issues,
            });
    }
    async parseAsync(data, params) {
        const result = await this.safeParseAsync(data, params);
        if (result.success)
            return result.data;
        throw result.error;
    }
    async safeParseAsync(data, params) {
        const ctx = {
            common: {
                issues: [],
                contextualErrorMap: params?.errorMap,
                async: true,
            },
            path: params?.path || [],
            schemaErrorMap: this._def.errorMap,
            parent: null,
            data,
            parsedType: getParsedType(data),
        };
        const maybeAsyncResult = this._parse({ data, path: ctx.path, parent: ctx });
        const result = await (isAsync(maybeAsyncResult) ? maybeAsyncResult : Promise.resolve(maybeAsyncResult));
        return handleResult(ctx, result);
    }
    refine(check, message) {
        const getIssueProperties = (val) => {
            if (typeof message === "string" || typeof message === "undefined") {
                return { message };
            }
            else if (typeof message === "function") {
                return message(val);
            }
            else {
                return message;
            }
        };
        return this._refinement((val, ctx) => {
            const result = check(val);
            const setError = () => ctx.addIssue({
                code: ZodIssueCode.custom,
                ...getIssueProperties(val),
            });
            if (typeof Promise !== "undefined" && result instanceof Promise) {
                return result.then((data) => {
                    if (!data) {
                        setError();
                        return false;
                    }
                    else {
                        return true;
                    }
                });
            }
            if (!result) {
                setError();
                return false;
            }
            else {
                return true;
            }
        });
    }
    refinement(check, refinementData) {
        return this._refinement((val, ctx) => {
            if (!check(val)) {
                ctx.addIssue(typeof refinementData === "function" ? refinementData(val, ctx) : refinementData);
                return false;
            }
            else {
                return true;
            }
        });
    }
    _refinement(refinement) {
        return new ZodEffects({
            schema: this,
            typeName: ZodFirstPartyTypeKind.ZodEffects,
            effect: { type: "refinement", refinement },
        });
    }
    superRefine(refinement) {
        return this._refinement(refinement);
    }
    constructor(def) {
        /** Alias of safeParseAsync */
        this.spa = this.safeParseAsync;
        this._def = def;
        this.parse = this.parse.bind(this);
        this.safeParse = this.safeParse.bind(this);
        this.parseAsync = this.parseAsync.bind(this);
        this.safeParseAsync = this.safeParseAsync.bind(this);
        this.spa = this.spa.bind(this);
        this.refine = this.refine.bind(this);
        this.refinement = this.refinement.bind(this);
        this.superRefine = this.superRefine.bind(this);
        this.optional = this.optional.bind(this);
        this.nullable = this.nullable.bind(this);
        this.nullish = this.nullish.bind(this);
        this.array = this.array.bind(this);
        this.promise = this.promise.bind(this);
        this.or = this.or.bind(this);
        this.and = this.and.bind(this);
        this.transform = this.transform.bind(this);
        this.brand = this.brand.bind(this);
        this.default = this.default.bind(this);
        this.catch = this.catch.bind(this);
        this.describe = this.describe.bind(this);
        this.pipe = this.pipe.bind(this);
        this.readonly = this.readonly.bind(this);
        this.isNullable = this.isNullable.bind(this);
        this.isOptional = this.isOptional.bind(this);
        this["~standard"] = {
            version: 1,
            vendor: "zod",
            validate: (data) => this["~validate"](data),
        };
    }
    optional() {
        return ZodOptional.create(this, this._def);
    }
    nullable() {
        return ZodNullable.create(this, this._def);
    }
    nullish() {
        return this.nullable().optional();
    }
    array() {
        return ZodArray.create(this);
    }
    promise() {
        return ZodPromise.create(this, this._def);
    }
    or(option) {
        return ZodUnion.create([this, option], this._def);
    }
    and(incoming) {
        return ZodIntersection.create(this, incoming, this._def);
    }
    transform(transform) {
        return new ZodEffects({
            ...processCreateParams(this._def),
            schema: this,
            typeName: ZodFirstPartyTypeKind.ZodEffects,
            effect: { type: "transform", transform },
        });
    }
    default(def) {
        const defaultValueFunc = typeof def === "function" ? def : () => def;
        return new ZodDefault({
            ...processCreateParams(this._def),
            innerType: this,
            defaultValue: defaultValueFunc,
            typeName: ZodFirstPartyTypeKind.ZodDefault,
        });
    }
    brand() {
        return new ZodBranded({
            typeName: ZodFirstPartyTypeKind.ZodBranded,
            type: this,
            ...processCreateParams(this._def),
        });
    }
    catch(def) {
        const catchValueFunc = typeof def === "function" ? def : () => def;
        return new ZodCatch({
            ...processCreateParams(this._def),
            innerType: this,
            catchValue: catchValueFunc,
            typeName: ZodFirstPartyTypeKind.ZodCatch,
        });
    }
    describe(description) {
        const This = this.constructor;
        return new This({
            ...this._def,
            description,
        });
    }
    pipe(target) {
        return ZodPipeline.create(this, target);
    }
    readonly() {
        return ZodReadonly.create(this);
    }
    isOptional() {
        return this.safeParse(undefined).success;
    }
    isNullable() {
        return this.safeParse(null).success;
    }
}
const cuidRegex = /^c[^\s-]{8,}$/i;
const cuid2Regex = /^[0-9a-z]+$/;
const ulidRegex = /^[0-9A-HJKMNP-TV-Z]{26}$/i;
// const uuidRegex =
//   /^([a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[a-f0-9]{4}-[a-f0-9]{12}|00000000-0000-0000-0000-000000000000)$/i;
const uuidRegex = /^[0-9a-fA-F]{8}\b-[0-9a-fA-F]{4}\b-[0-9a-fA-F]{4}\b-[0-9a-fA-F]{4}\b-[0-9a-fA-F]{12}$/i;
const nanoidRegex = /^[a-z0-9_-]{21}$/i;
const jwtRegex = /^[A-Za-z0-9-_]+\.[A-Za-z0-9-_]+\.[A-Za-z0-9-_]*$/;
const durationRegex = /^[-+]?P(?!$)(?:(?:[-+]?\d+Y)|(?:[-+]?\d+[.,]\d+Y$))?(?:(?:[-+]?\d+M)|(?:[-+]?\d+[.,]\d+M$))?(?:(?:[-+]?\d+W)|(?:[-+]?\d+[.,]\d+W$))?(?:(?:[-+]?\d+D)|(?:[-+]?\d+[.,]\d+D$))?(?:T(?=[\d+-])(?:(?:[-+]?\d+H)|(?:[-+]?\d+[.,]\d+H$))?(?:(?:[-+]?\d+M)|(?:[-+]?\d+[.,]\d+M$))?(?:[-+]?\d+(?:[.,]\d+)?S)?)??$/;
// from https://stackoverflow.com/a/46181/1550155
// old version: too slow, didn't support unicode
// const emailRegex = /^((([a-z]|\d|[!#\$%&'\*\+\-\/=\?\^_`{\|}~]|[\u00A0-\uD7FF\uF900-\uFDCF\uFDF0-\uFFEF])+(\.([a-z]|\d|[!#\$%&'\*\+\-\/=\?\^_`{\|}~]|[\u00A0-\uD7FF\uF900-\uFDCF\uFDF0-\uFFEF])+)*)|((\x22)((((\x20|\x09)*(\x0d\x0a))?(\x20|\x09)+)?(([\x01-\x08\x0b\x0c\x0e-\x1f\x7f]|\x21|[\x23-\x5b]|[\x5d-\x7e]|[\u00A0-\uD7FF\uF900-\uFDCF\uFDF0-\uFFEF])|(\\([\x01-\x09\x0b\x0c\x0d-\x7f]|[\u00A0-\uD7FF\uF900-\uFDCF\uFDF0-\uFFEF]))))*(((\x20|\x09)*(\x0d\x0a))?(\x20|\x09)+)?(\x22)))@((([a-z]|\d|[\u00A0-\uD7FF\uF900-\uFDCF\uFDF0-\uFFEF])|(([a-z]|\d|[\u00A0-\uD7FF\uF900-\uFDCF\uFDF0-\uFFEF])([a-z]|\d|-|\.|_|~|[\u00A0-\uD7FF\uF900-\uFDCF\uFDF0-\uFFEF])*([a-z]|\d|[\u00A0-\uD7FF\uF900-\uFDCF\uFDF0-\uFFEF])))\.)+(([a-z]|[\u00A0-\uD7FF\uF900-\uFDCF\uFDF0-\uFFEF])|(([a-z]|[\u00A0-\uD7FF\uF900-\uFDCF\uFDF0-\uFFEF])([a-z]|\d|-|\.|_|~|[\u00A0-\uD7FF\uF900-\uFDCF\uFDF0-\uFFEF])*([a-z]|[\u00A0-\uD7FF\uF900-\uFDCF\uFDF0-\uFFEF])))$/i;
//old email regex
// const emailRegex = /^(([^<>()[\].,;:\s@"]+(\.[^<>()[\].,;:\s@"]+)*)|(".+"))@((?!-)([^<>()[\].,;:\s@"]+\.)+[^<>()[\].,;:\s@"]{1,})[^-<>()[\].,;:\s@"]$/i;
// eslint-disable-next-line
// const emailRegex =
//   /^(([^<>()[\]\\.,;:\s@\"]+(\.[^<>()[\]\\.,;:\s@\"]+)*)|(\".+\"))@((\[(((25[0-5])|(2[0-4][0-9])|(1[0-9]{2})|([0-9]{1,2}))\.){3}((25[0-5])|(2[0-4][0-9])|(1[0-9]{2})|([0-9]{1,2}))\])|(\[IPv6:(([a-f0-9]{1,4}:){7}|::([a-f0-9]{1,4}:){0,6}|([a-f0-9]{1,4}:){1}:([a-f0-9]{1,4}:){0,5}|([a-f0-9]{1,4}:){2}:([a-f0-9]{1,4}:){0,4}|([a-f0-9]{1,4}:){3}:([a-f0-9]{1,4}:){0,3}|([a-f0-9]{1,4}:){4}:([a-f0-9]{1,4}:){0,2}|([a-f0-9]{1,4}:){5}:([a-f0-9]{1,4}:){0,1})([a-f0-9]{1,4}|(((25[0-5])|(2[0-4][0-9])|(1[0-9]{2})|([0-9]{1,2}))\.){3}((25[0-5])|(2[0-4][0-9])|(1[0-9]{2})|([0-9]{1,2})))\])|([A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])*(\.[A-Za-z]{2,})+))$/;
// const emailRegex =
//   /^[a-zA-Z0-9\.\!\#\$\%\&\'\*\+\/\=\?\^\_\`\{\|\}\~\-]+@[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)*$/;
// const emailRegex =
//   /^(?:[a-z0-9!#$%&'*+/=?^_`{|}~-]+(?:\.[a-z0-9!#$%&'*+/=?^_`{|}~-]+)*|"(?:[\x01-\x08\x0b\x0c\x0e-\x1f\x21\x23-\x5b\x5d-\x7f]|\\[\x01-\x09\x0b\x0c\x0e-\x7f])*")@(?:(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]*[a-z0-9])?|\[(?:(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)\.){3}(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?|[a-z0-9-]*[a-z0-9]:(?:[\x01-\x08\x0b\x0c\x0e-\x1f\x21-\x5a\x53-\x7f]|\\[\x01-\x09\x0b\x0c\x0e-\x7f])+)\])$/i;
const emailRegex = /^(?!\.)(?!.*\.\.)([A-Z0-9_'+\-\.]*)[A-Z0-9_+-]@([A-Z0-9][A-Z0-9\-]*\.)+[A-Z]{2,}$/i;
// const emailRegex =
//   /^[a-z0-9.!#$%&’*+/=?^_`{|}~-]+@[a-z0-9-]+(?:\.[a-z0-9\-]+)*$/i;
// from https://thekevinscott.com/emojis-in-javascript/#writing-a-regular-expression
const _emojiRegex = `^(\\p{Extended_Pictographic}|\\p{Emoji_Component})+$`;
let emojiRegex;
// faster, simpler, safer
const ipv4Regex = /^(?:(?:25[0-5]|2[0-4][0-9]|1[0-9][0-9]|[1-9][0-9]|[0-9])\.){3}(?:25[0-5]|2[0-4][0-9]|1[0-9][0-9]|[1-9][0-9]|[0-9])$/;
const ipv4CidrRegex = /^(?:(?:25[0-5]|2[0-4][0-9]|1[0-9][0-9]|[1-9][0-9]|[0-9])\.){3}(?:25[0-5]|2[0-4][0-9]|1[0-9][0-9]|[1-9][0-9]|[0-9])\/(3[0-2]|[12]?[0-9])$/;
// const ipv6Regex =
// /^(([a-f0-9]{1,4}:){7}|::([a-f0-9]{1,4}:){0,6}|([a-f0-9]{1,4}:){1}:([a-f0-9]{1,4}:){0,5}|([a-f0-9]{1,4}:){2}:([a-f0-9]{1,4}:){0,4}|([a-f0-9]{1,4}:){3}:([a-f0-9]{1,4}:){0,3}|([a-f0-9]{1,4}:){4}:([a-f0-9]{1,4}:){0,2}|([a-f0-9]{1,4}:){5}:([a-f0-9]{1,4}:){0,1})([a-f0-9]{1,4}|(((25[0-5])|(2[0-4][0-9])|(1[0-9]{2})|([0-9]{1,2}))\.){3}((25[0-5])|(2[0-4][0-9])|(1[0-9]{2})|([0-9]{1,2})))$/;
const ipv6Regex = /^(([0-9a-fA-F]{1,4}:){7,7}[0-9a-fA-F]{1,4}|([0-9a-fA-F]{1,4}:){1,7}:|([0-9a-fA-F]{1,4}:){1,6}:[0-9a-fA-F]{1,4}|([0-9a-fA-F]{1,4}:){1,5}(:[0-9a-fA-F]{1,4}){1,2}|([0-9a-fA-F]{1,4}:){1,4}(:[0-9a-fA-F]{1,4}){1,3}|([0-9a-fA-F]{1,4}:){1,3}(:[0-9a-fA-F]{1,4}){1,4}|([0-9a-fA-F]{1,4}:){1,2}(:[0-9a-fA-F]{1,4}){1,5}|[0-9a-fA-F]{1,4}:((:[0-9a-fA-F]{1,4}){1,6})|:((:[0-9a-fA-F]{1,4}){1,7}|:)|fe80:(:[0-9a-fA-F]{0,4}){0,4}%[0-9a-zA-Z]{1,}|::(ffff(:0{1,4}){0,1}:){0,1}((25[0-5]|(2[0-4]|1{0,1}[0-9]){0,1}[0-9])\.){3,3}(25[0-5]|(2[0-4]|1{0,1}[0-9]){0,1}[0-9])|([0-9a-fA-F]{1,4}:){1,4}:((25[0-5]|(2[0-4]|1{0,1}[0-9]){0,1}[0-9])\.){3,3}(25[0-5]|(2[0-4]|1{0,1}[0-9]){0,1}[0-9]))$/;
const ipv6CidrRegex = /^(([0-9a-fA-F]{1,4}:){7,7}[0-9a-fA-F]{1,4}|([0-9a-fA-F]{1,4}:){1,7}:|([0-9a-fA-F]{1,4}:){1,6}:[0-9a-fA-F]{1,4}|([0-9a-fA-F]{1,4}:){1,5}(:[0-9a-fA-F]{1,4}){1,2}|([0-9a-fA-F]{1,4}:){1,4}(:[0-9a-fA-F]{1,4}){1,3}|([0-9a-fA-F]{1,4}:){1,3}(:[0-9a-fA-F]{1,4}){1,4}|([0-9a-fA-F]{1,4}:){1,2}(:[0-9a-fA-F]{1,4}){1,5}|[0-9a-fA-F]{1,4}:((:[0-9a-fA-F]{1,4}){1,6})|:((:[0-9a-fA-F]{1,4}){1,7}|:)|fe80:(:[0-9a-fA-F]{0,4}){0,4}%[0-9a-zA-Z]{1,}|::(ffff(:0{1,4}){0,1}:){0,1}((25[0-5]|(2[0-4]|1{0,1}[0-9]){0,1}[0-9])\.){3,3}(25[0-5]|(2[0-4]|1{0,1}[0-9]){0,1}[0-9])|([0-9a-fA-F]{1,4}:){1,4}:((25[0-5]|(2[0-4]|1{0,1}[0-9]){0,1}[0-9])\.){3,3}(25[0-5]|(2[0-4]|1{0,1}[0-9]){0,1}[0-9]))\/(12[0-8]|1[01][0-9]|[1-9]?[0-9])$/;
// https://stackoverflow.com/questions/7860392/determine-if-string-is-in-base64-using-javascript
const base64Regex = /^([0-9a-zA-Z+/]{4})*(([0-9a-zA-Z+/]{2}==)|([0-9a-zA-Z+/]{3}=))?$/;
// https://base64.guru/standards/base64url
const base64urlRegex = /^([0-9a-zA-Z-_]{4})*(([0-9a-zA-Z-_]{2}(==)?)|([0-9a-zA-Z-_]{3}(=)?))?$/;
// simple
// const dateRegexSource = `\\d{4}-\\d{2}-\\d{2}`;
// no leap year validation
// const dateRegexSource = `\\d{4}-((0[13578]|10|12)-31|(0[13-9]|1[0-2])-30|(0[1-9]|1[0-2])-(0[1-9]|1\\d|2\\d))`;
// with leap year validation
const dateRegexSource = `((\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-((0[13578]|1[02])-(0[1-9]|[12]\\d|3[01])|(0[469]|11)-(0[1-9]|[12]\\d|30)|(02)-(0[1-9]|1\\d|2[0-8])))`;
const dateRegex = new RegExp(`^${dateRegexSource}$`);
function timeRegexSource(args) {
    let secondsRegexSource = `[0-5]\\d`;
    if (args.precision) {
        secondsRegexSource = `${secondsRegexSource}\\.\\d{${args.precision}}`;
    }
    else if (args.precision == null) {
        secondsRegexSource = `${secondsRegexSource}(\\.\\d+)?`;
    }
    const secondsQuantifier = args.precision ? "+" : "?"; // require seconds if precision is nonzero
    return `([01]\\d|2[0-3]):[0-5]\\d(:${secondsRegexSource})${secondsQuantifier}`;
}
function timeRegex(args) {
    return new RegExp(`^${timeRegexSource(args)}$`);
}
// Adapted from https://stackoverflow.com/a/3143231
function datetimeRegex(args) {
    let regex = `${dateRegexSource}T${timeRegexSource(args)}`;
    const opts = [];
    opts.push(args.local ? `Z?` : `Z`);
    if (args.offset)
        opts.push(`([+-]\\d{2}:?\\d{2})`);
    regex = `${regex}(${opts.join("|")})`;
    return new RegExp(`^${regex}$`);
}
function isValidIP(ip, version) {
    if ((version === "v4" || !version) && ipv4Regex.test(ip)) {
        return true;
    }
    if ((version === "v6" || !version) && ipv6Regex.test(ip)) {
        return true;
    }
    return false;
}
function isValidJWT(jwt, alg) {
    if (!jwtRegex.test(jwt))
        return false;
    try {
        const [header] = jwt.split(".");
        if (!header)
            return false;
        // Convert base64url to base64
        const base64 = header
            .replace(/-/g, "+")
            .replace(/_/g, "/")
            .padEnd(header.length + ((4 - (header.length % 4)) % 4), "=");
        const decoded = JSON.parse(atob(base64));
        if (typeof decoded !== "object" || decoded === null)
            return false;
        if ("typ" in decoded && decoded?.typ !== "JWT")
            return false;
        if (!decoded.alg)
            return false;
        if (alg && decoded.alg !== alg)
            return false;
        return true;
    }
    catch {
        return false;
    }
}
function isValidCidr(ip, version) {
    if ((version === "v4" || !version) && ipv4CidrRegex.test(ip)) {
        return true;
    }
    if ((version === "v6" || !version) && ipv6CidrRegex.test(ip)) {
        return true;
    }
    return false;
}
class ZodString extends ZodType {
    _parse(input) {
        if (this._def.coerce) {
            input.data = String(input.data);
        }
        const parsedType = this._getType(input);
        if (parsedType !== ZodParsedType.string) {
            const ctx = this._getOrReturnCtx(input);
            addIssueToContext(ctx, {
                code: ZodIssueCode.invalid_type,
                expected: ZodParsedType.string,
                received: ctx.parsedType,
            });
            return INVALID;
        }
        const status = new ParseStatus();
        let ctx = undefined;
        for (const check of this._def.checks) {
            if (check.kind === "min") {
                if (input.data.length < check.value) {
                    ctx = this._getOrReturnCtx(input, ctx);
                    addIssueToContext(ctx, {
                        code: ZodIssueCode.too_small,
                        minimum: check.value,
                        type: "string",
                        inclusive: true,
                        exact: false,
                        message: check.message,
                    });
                    status.dirty();
                }
            }
            else if (check.kind === "max") {
                if (input.data.length > check.value) {
                    ctx = this._getOrReturnCtx(input, ctx);
                    addIssueToContext(ctx, {
                        code: ZodIssueCode.too_big,
                        maximum: check.value,
                        type: "string",
                        inclusive: true,
                        exact: false,
                        message: check.message,
                    });
                    status.dirty();
                }
            }
            else if (check.kind === "length") {
                const tooBig = input.data.length > check.value;
                const tooSmall = input.data.length < check.value;
                if (tooBig || tooSmall) {
                    ctx = this._getOrReturnCtx(input, ctx);
                    if (tooBig) {
                        addIssueToContext(ctx, {
                            code: ZodIssueCode.too_big,
                            maximum: check.value,
                            type: "string",
                            inclusive: true,
                            exact: true,
                            message: check.message,
                        });
                    }
                    else if (tooSmall) {
                        addIssueToContext(ctx, {
                            code: ZodIssueCode.too_small,
                            minimum: check.value,
                            type: "string",
                            inclusive: true,
                            exact: true,
                            message: check.message,
                        });
                    }
                    status.dirty();
                }
            }
            else if (check.kind === "email") {
                if (!emailRegex.test(input.data)) {
                    ctx = this._getOrReturnCtx(input, ctx);
                    addIssueToContext(ctx, {
                        validation: "email",
                        code: ZodIssueCode.invalid_string,
                        message: check.message,
                    });
                    status.dirty();
                }
            }
            else if (check.kind === "emoji") {
                if (!emojiRegex) {
                    emojiRegex = new RegExp(_emojiRegex, "u");
                }
                if (!emojiRegex.test(input.data)) {
                    ctx = this._getOrReturnCtx(input, ctx);
                    addIssueToContext(ctx, {
                        validation: "emoji",
                        code: ZodIssueCode.invalid_string,
                        message: check.message,
                    });
                    status.dirty();
                }
            }
            else if (check.kind === "uuid") {
                if (!uuidRegex.test(input.data)) {
                    ctx = this._getOrReturnCtx(input, ctx);
                    addIssueToContext(ctx, {
                        validation: "uuid",
                        code: ZodIssueCode.invalid_string,
                        message: check.message,
                    });
                    status.dirty();
                }
            }
            else if (check.kind === "nanoid") {
                if (!nanoidRegex.test(input.data)) {
                    ctx = this._getOrReturnCtx(input, ctx);
                    addIssueToContext(ctx, {
                        validation: "nanoid",
                        code: ZodIssueCode.invalid_string,
                        message: check.message,
                    });
                    status.dirty();
                }
            }
            else if (check.kind === "cuid") {
                if (!cuidRegex.test(input.data)) {
                    ctx = this._getOrReturnCtx(input, ctx);
                    addIssueToContext(ctx, {
                        validation: "cuid",
                        code: ZodIssueCode.invalid_string,
                        message: check.message,
                    });
                    status.dirty();
                }
            }
            else if (check.kind === "cuid2") {
                if (!cuid2Regex.test(input.data)) {
                    ctx = this._getOrReturnCtx(input, ctx);
                    addIssueToContext(ctx, {
                        validation: "cuid2",
                        code: ZodIssueCode.invalid_string,
                        message: check.message,
                    });
                    status.dirty();
                }
            }
            else if (check.kind === "ulid") {
                if (!ulidRegex.test(input.data)) {
                    ctx = this._getOrReturnCtx(input, ctx);
                    addIssueToContext(ctx, {
                        validation: "ulid",
                        code: ZodIssueCode.invalid_string,
                        message: check.message,
                    });
                    status.dirty();
                }
            }
            else if (check.kind === "url") {
                try {
                    new URL(input.data);
                }
                catch {
                    ctx = this._getOrReturnCtx(input, ctx);
                    addIssueToContext(ctx, {
                        validation: "url",
                        code: ZodIssueCode.invalid_string,
                        message: check.message,
                    });
                    status.dirty();
                }
            }
            else if (check.kind === "regex") {
                check.regex.lastIndex = 0;
                const testResult = check.regex.test(input.data);
                if (!testResult) {
                    ctx = this._getOrReturnCtx(input, ctx);
                    addIssueToContext(ctx, {
                        validation: "regex",
                        code: ZodIssueCode.invalid_string,
                        message: check.message,
                    });
                    status.dirty();
                }
            }
            else if (check.kind === "trim") {
                input.data = input.data.trim();
            }
            else if (check.kind === "includes") {
                if (!input.data.includes(check.value, check.position)) {
                    ctx = this._getOrReturnCtx(input, ctx);
                    addIssueToContext(ctx, {
                        code: ZodIssueCode.invalid_string,
                        validation: { includes: check.value, position: check.position },
                        message: check.message,
                    });
                    status.dirty();
                }
            }
            else if (check.kind === "toLowerCase") {
                input.data = input.data.toLowerCase();
            }
            else if (check.kind === "toUpperCase") {
                input.data = input.data.toUpperCase();
            }
            else if (check.kind === "startsWith") {
                if (!input.data.startsWith(check.value)) {
                    ctx = this._getOrReturnCtx(input, ctx);
                    addIssueToContext(ctx, {
                        code: ZodIssueCode.invalid_string,
                        validation: { startsWith: check.value },
                        message: check.message,
                    });
                    status.dirty();
                }
            }
            else if (check.kind === "endsWith") {
                if (!input.data.endsWith(check.value)) {
                    ctx = this._getOrReturnCtx(input, ctx);
                    addIssueToContext(ctx, {
                        code: ZodIssueCode.invalid_string,
                        validation: { endsWith: check.value },
                        message: check.message,
                    });
                    status.dirty();
                }
            }
            else if (check.kind === "datetime") {
                const regex = datetimeRegex(check);
                if (!regex.test(input.data)) {
                    ctx = this._getOrReturnCtx(input, ctx);
                    addIssueToContext(ctx, {
                        code: ZodIssueCode.invalid_string,
                        validation: "datetime",
                        message: check.message,
                    });
                    status.dirty();
                }
            }
            else if (check.kind === "date") {
                const regex = dateRegex;
                if (!regex.test(input.data)) {
                    ctx = this._getOrReturnCtx(input, ctx);
                    addIssueToContext(ctx, {
                        code: ZodIssueCode.invalid_string,
                        validation: "date",
                        message: check.message,
                    });
                    status.dirty();
                }
            }
            else if (check.kind === "time") {
                const regex = timeRegex(check);
                if (!regex.test(input.data)) {
                    ctx = this._getOrReturnCtx(input, ctx);
                    addIssueToContext(ctx, {
                        code: ZodIssueCode.invalid_string,
                        validation: "time",
                        message: check.message,
                    });
                    status.dirty();
                }
            }
            else if (check.kind === "duration") {
                if (!durationRegex.test(input.data)) {
                    ctx = this._getOrReturnCtx(input, ctx);
                    addIssueToContext(ctx, {
                        validation: "duration",
                        code: ZodIssueCode.invalid_string,
                        message: check.message,
                    });
                    status.dirty();
                }
            }
            else if (check.kind === "ip") {
                if (!isValidIP(input.data, check.version)) {
                    ctx = this._getOrReturnCtx(input, ctx);
                    addIssueToContext(ctx, {
                        validation: "ip",
                        code: ZodIssueCode.invalid_string,
                        message: check.message,
                    });
                    status.dirty();
                }
            }
            else if (check.kind === "jwt") {
                if (!isValidJWT(input.data, check.alg)) {
                    ctx = this._getOrReturnCtx(input, ctx);
                    addIssueToContext(ctx, {
                        validation: "jwt",
                        code: ZodIssueCode.invalid_string,
                        message: check.message,
                    });
                    status.dirty();
                }
            }
            else if (check.kind === "cidr") {
                if (!isValidCidr(input.data, check.version)) {
                    ctx = this._getOrReturnCtx(input, ctx);
                    addIssueToContext(ctx, {
                        validation: "cidr",
                        code: ZodIssueCode.invalid_string,
                        message: check.message,
                    });
                    status.dirty();
                }
            }
            else if (check.kind === "base64") {
                if (!base64Regex.test(input.data)) {
                    ctx = this._getOrReturnCtx(input, ctx);
                    addIssueToContext(ctx, {
                        validation: "base64",
                        code: ZodIssueCode.invalid_string,
                        message: check.message,
                    });
                    status.dirty();
                }
            }
            else if (check.kind === "base64url") {
                if (!base64urlRegex.test(input.data)) {
                    ctx = this._getOrReturnCtx(input, ctx);
                    addIssueToContext(ctx, {
                        validation: "base64url",
                        code: ZodIssueCode.invalid_string,
                        message: check.message,
                    });
                    status.dirty();
                }
            }
            else {
                util.assertNever(check);
            }
        }
        return { status: status.value, value: input.data };
    }
    _regex(regex, validation, message) {
        return this.refinement((data) => regex.test(data), {
            validation,
            code: ZodIssueCode.invalid_string,
            ...errorUtil.errToObj(message),
        });
    }
    _addCheck(check) {
        return new ZodString({
            ...this._def,
            checks: [...this._def.checks, check],
        });
    }
    email(message) {
        return this._addCheck({ kind: "email", ...errorUtil.errToObj(message) });
    }
    url(message) {
        return this._addCheck({ kind: "url", ...errorUtil.errToObj(message) });
    }
    emoji(message) {
        return this._addCheck({ kind: "emoji", ...errorUtil.errToObj(message) });
    }
    uuid(message) {
        return this._addCheck({ kind: "uuid", ...errorUtil.errToObj(message) });
    }
    nanoid(message) {
        return this._addCheck({ kind: "nanoid", ...errorUtil.errToObj(message) });
    }
    cuid(message) {
        return this._addCheck({ kind: "cuid", ...errorUtil.errToObj(message) });
    }
    cuid2(message) {
        return this._addCheck({ kind: "cuid2", ...errorUtil.errToObj(message) });
    }
    ulid(message) {
        return this._addCheck({ kind: "ulid", ...errorUtil.errToObj(message) });
    }
    base64(message) {
        return this._addCheck({ kind: "base64", ...errorUtil.errToObj(message) });
    }
    base64url(message) {
        // base64url encoding is a modification of base64 that can safely be used in URLs and filenames
        return this._addCheck({
            kind: "base64url",
            ...errorUtil.errToObj(message),
        });
    }
    jwt(options) {
        return this._addCheck({ kind: "jwt", ...errorUtil.errToObj(options) });
    }
    ip(options) {
        return this._addCheck({ kind: "ip", ...errorUtil.errToObj(options) });
    }
    cidr(options) {
        return this._addCheck({ kind: "cidr", ...errorUtil.errToObj(options) });
    }
    datetime(options) {
        if (typeof options === "string") {
            return this._addCheck({
                kind: "datetime",
                precision: null,
                offset: false,
                local: false,
                message: options,
            });
        }
        return this._addCheck({
            kind: "datetime",
            precision: typeof options?.precision === "undefined" ? null : options?.precision,
            offset: options?.offset ?? false,
            local: options?.local ?? false,
            ...errorUtil.errToObj(options?.message),
        });
    }
    date(message) {
        return this._addCheck({ kind: "date", message });
    }
    time(options) {
        if (typeof options === "string") {
            return this._addCheck({
                kind: "time",
                precision: null,
                message: options,
            });
        }
        return this._addCheck({
            kind: "time",
            precision: typeof options?.precision === "undefined" ? null : options?.precision,
            ...errorUtil.errToObj(options?.message),
        });
    }
    duration(message) {
        return this._addCheck({ kind: "duration", ...errorUtil.errToObj(message) });
    }
    regex(regex, message) {
        return this._addCheck({
            kind: "regex",
            regex: regex,
            ...errorUtil.errToObj(message),
        });
    }
    includes(value, options) {
        return this._addCheck({
            kind: "includes",
            value: value,
            position: options?.position,
            ...errorUtil.errToObj(options?.message),
        });
    }
    startsWith(value, message) {
        return this._addCheck({
            kind: "startsWith",
            value: value,
            ...errorUtil.errToObj(message),
        });
    }
    endsWith(value, message) {
        return this._addCheck({
            kind: "endsWith",
            value: value,
            ...errorUtil.errToObj(message),
        });
    }
    min(minLength, message) {
        return this._addCheck({
            kind: "min",
            value: minLength,
            ...errorUtil.errToObj(message),
        });
    }
    max(maxLength, message) {
        return this._addCheck({
            kind: "max",
            value: maxLength,
            ...errorUtil.errToObj(message),
        });
    }
    length(len, message) {
        return this._addCheck({
            kind: "length",
            value: len,
            ...errorUtil.errToObj(message),
        });
    }
    /**
     * Equivalent to `.min(1)`
     */
    nonempty(message) {
        return this.min(1, errorUtil.errToObj(message));
    }
    trim() {
        return new ZodString({
            ...this._def,
            checks: [...this._def.checks, { kind: "trim" }],
        });
    }
    toLowerCase() {
        return new ZodString({
            ...this._def,
            checks: [...this._def.checks, { kind: "toLowerCase" }],
        });
    }
    toUpperCase() {
        return new ZodString({
            ...this._def,
            checks: [...this._def.checks, { kind: "toUpperCase" }],
        });
    }
    get isDatetime() {
        return !!this._def.checks.find((ch) => ch.kind === "datetime");
    }
    get isDate() {
        return !!this._def.checks.find((ch) => ch.kind === "date");
    }
    get isTime() {
        return !!this._def.checks.find((ch) => ch.kind === "time");
    }
    get isDuration() {
        return !!this._def.checks.find((ch) => ch.kind === "duration");
    }
    get isEmail() {
        return !!this._def.checks.find((ch) => ch.kind === "email");
    }
    get isURL() {
        return !!this._def.checks.find((ch) => ch.kind === "url");
    }
    get isEmoji() {
        return !!this._def.checks.find((ch) => ch.kind === "emoji");
    }
    get isUUID() {
        return !!this._def.checks.find((ch) => ch.kind === "uuid");
    }
    get isNANOID() {
        return !!this._def.checks.find((ch) => ch.kind === "nanoid");
    }
    get isCUID() {
        return !!this._def.checks.find((ch) => ch.kind === "cuid");
    }
    get isCUID2() {
        return !!this._def.checks.find((ch) => ch.kind === "cuid2");
    }
    get isULID() {
        return !!this._def.checks.find((ch) => ch.kind === "ulid");
    }
    get isIP() {
        return !!this._def.checks.find((ch) => ch.kind === "ip");
    }
    get isCIDR() {
        return !!this._def.checks.find((ch) => ch.kind === "cidr");
    }
    get isBase64() {
        return !!this._def.checks.find((ch) => ch.kind === "base64");
    }
    get isBase64url() {
        // base64url encoding is a modification of base64 that can safely be used in URLs and filenames
        return !!this._def.checks.find((ch) => ch.kind === "base64url");
    }
    get minLength() {
        let min = null;
        for (const ch of this._def.checks) {
            if (ch.kind === "min") {
                if (min === null || ch.value > min)
                    min = ch.value;
            }
        }
        return min;
    }
    get maxLength() {
        let max = null;
        for (const ch of this._def.checks) {
            if (ch.kind === "max") {
                if (max === null || ch.value < max)
                    max = ch.value;
            }
        }
        return max;
    }
}
ZodString.create = (params) => {
    return new ZodString({
        checks: [],
        typeName: ZodFirstPartyTypeKind.ZodString,
        coerce: params?.coerce ?? false,
        ...processCreateParams(params),
    });
};
// https://stackoverflow.com/questions/3966484/why-does-modulus-operator-return-fractional-number-in-javascript/31711034#31711034
function floatSafeRemainder(val, step) {
    const valDecCount = (val.toString().split(".")[1] || "").length;
    const stepDecCount = (step.toString().split(".")[1] || "").length;
    const decCount = valDecCount > stepDecCount ? valDecCount : stepDecCount;
    const valInt = Number.parseInt(val.toFixed(decCount).replace(".", ""));
    const stepInt = Number.parseInt(step.toFixed(decCount).replace(".", ""));
    return (valInt % stepInt) / 10 ** decCount;
}
class ZodNumber extends ZodType {
    constructor() {
        super(...arguments);
        this.min = this.gte;
        this.max = this.lte;
        this.step = this.multipleOf;
    }
    _parse(input) {
        if (this._def.coerce) {
            input.data = Number(input.data);
        }
        const parsedType = this._getType(input);
        if (parsedType !== ZodParsedType.number) {
            const ctx = this._getOrReturnCtx(input);
            addIssueToContext(ctx, {
                code: ZodIssueCode.invalid_type,
                expected: ZodParsedType.number,
                received: ctx.parsedType,
            });
            return INVALID;
        }
        let ctx = undefined;
        const status = new ParseStatus();
        for (const check of this._def.checks) {
            if (check.kind === "int") {
                if (!util.isInteger(input.data)) {
                    ctx = this._getOrReturnCtx(input, ctx);
                    addIssueToContext(ctx, {
                        code: ZodIssueCode.invalid_type,
                        expected: "integer",
                        received: "float",
                        message: check.message,
                    });
                    status.dirty();
                }
            }
            else if (check.kind === "min") {
                const tooSmall = check.inclusive ? input.data < check.value : input.data <= check.value;
                if (tooSmall) {
                    ctx = this._getOrReturnCtx(input, ctx);
                    addIssueToContext(ctx, {
                        code: ZodIssueCode.too_small,
                        minimum: check.value,
                        type: "number",
                        inclusive: check.inclusive,
                        exact: false,
                        message: check.message,
                    });
                    status.dirty();
                }
            }
            else if (check.kind === "max") {
                const tooBig = check.inclusive ? input.data > check.value : input.data >= check.value;
                if (tooBig) {
                    ctx = this._getOrReturnCtx(input, ctx);
                    addIssueToContext(ctx, {
                        code: ZodIssueCode.too_big,
                        maximum: check.value,
                        type: "number",
                        inclusive: check.inclusive,
                        exact: false,
                        message: check.message,
                    });
                    status.dirty();
                }
            }
            else if (check.kind === "multipleOf") {
                if (floatSafeRemainder(input.data, check.value) !== 0) {
                    ctx = this._getOrReturnCtx(input, ctx);
                    addIssueToContext(ctx, {
                        code: ZodIssueCode.not_multiple_of,
                        multipleOf: check.value,
                        message: check.message,
                    });
                    status.dirty();
                }
            }
            else if (check.kind === "finite") {
                if (!Number.isFinite(input.data)) {
                    ctx = this._getOrReturnCtx(input, ctx);
                    addIssueToContext(ctx, {
                        code: ZodIssueCode.not_finite,
                        message: check.message,
                    });
                    status.dirty();
                }
            }
            else {
                util.assertNever(check);
            }
        }
        return { status: status.value, value: input.data };
    }
    gte(value, message) {
        return this.setLimit("min", value, true, errorUtil.toString(message));
    }
    gt(value, message) {
        return this.setLimit("min", value, false, errorUtil.toString(message));
    }
    lte(value, message) {
        return this.setLimit("max", value, true, errorUtil.toString(message));
    }
    lt(value, message) {
        return this.setLimit("max", value, false, errorUtil.toString(message));
    }
    setLimit(kind, value, inclusive, message) {
        return new ZodNumber({
            ...this._def,
            checks: [
                ...this._def.checks,
                {
                    kind,
                    value,
                    inclusive,
                    message: errorUtil.toString(message),
                },
            ],
        });
    }
    _addCheck(check) {
        return new ZodNumber({
            ...this._def,
            checks: [...this._def.checks, check],
        });
    }
    int(message) {
        return this._addCheck({
            kind: "int",
            message: errorUtil.toString(message),
        });
    }
    positive(message) {
        return this._addCheck({
            kind: "min",
            value: 0,
            inclusive: false,
            message: errorUtil.toString(message),
        });
    }
    negative(message) {
        return this._addCheck({
            kind: "max",
            value: 0,
            inclusive: false,
            message: errorUtil.toString(message),
        });
    }
    nonpositive(message) {
        return this._addCheck({
            kind: "max",
            value: 0,
            inclusive: true,
            message: errorUtil.toString(message),
        });
    }
    nonnegative(message) {
        return this._addCheck({
            kind: "min",
            value: 0,
            inclusive: true,
            message: errorUtil.toString(message),
        });
    }
    multipleOf(value, message) {
        return this._addCheck({
            kind: "multipleOf",
            value: value,
            message: errorUtil.toString(message),
        });
    }
    finite(message) {
        return this._addCheck({
            kind: "finite",
            message: errorUtil.toString(message),
        });
    }
    safe(message) {
        return this._addCheck({
            kind: "min",
            inclusive: true,
            value: Number.MIN_SAFE_INTEGER,
            message: errorUtil.toString(message),
        })._addCheck({
            kind: "max",
            inclusive: true,
            value: Number.MAX_SAFE_INTEGER,
            message: errorUtil.toString(message),
        });
    }
    get minValue() {
        let min = null;
        for (const ch of this._def.checks) {
            if (ch.kind === "min") {
                if (min === null || ch.value > min)
                    min = ch.value;
            }
        }
        return min;
    }
    get maxValue() {
        let max = null;
        for (const ch of this._def.checks) {
            if (ch.kind === "max") {
                if (max === null || ch.value < max)
                    max = ch.value;
            }
        }
        return max;
    }
    get isInt() {
        return !!this._def.checks.find((ch) => ch.kind === "int" || (ch.kind === "multipleOf" && util.isInteger(ch.value)));
    }
    get isFinite() {
        let max = null;
        let min = null;
        for (const ch of this._def.checks) {
            if (ch.kind === "finite" || ch.kind === "int" || ch.kind === "multipleOf") {
                return true;
            }
            else if (ch.kind === "min") {
                if (min === null || ch.value > min)
                    min = ch.value;
            }
            else if (ch.kind === "max") {
                if (max === null || ch.value < max)
                    max = ch.value;
            }
        }
        return Number.isFinite(min) && Number.isFinite(max);
    }
}
ZodNumber.create = (params) => {
    return new ZodNumber({
        checks: [],
        typeName: ZodFirstPartyTypeKind.ZodNumber,
        coerce: params?.coerce || false,
        ...processCreateParams(params),
    });
};
class ZodBigInt extends ZodType {
    constructor() {
        super(...arguments);
        this.min = this.gte;
        this.max = this.lte;
    }
    _parse(input) {
        if (this._def.coerce) {
            try {
                input.data = BigInt(input.data);
            }
            catch {
                return this._getInvalidInput(input);
            }
        }
        const parsedType = this._getType(input);
        if (parsedType !== ZodParsedType.bigint) {
            return this._getInvalidInput(input);
        }
        let ctx = undefined;
        const status = new ParseStatus();
        for (const check of this._def.checks) {
            if (check.kind === "min") {
                const tooSmall = check.inclusive ? input.data < check.value : input.data <= check.value;
                if (tooSmall) {
                    ctx = this._getOrReturnCtx(input, ctx);
                    addIssueToContext(ctx, {
                        code: ZodIssueCode.too_small,
                        type: "bigint",
                        minimum: check.value,
                        inclusive: check.inclusive,
                        message: check.message,
                    });
                    status.dirty();
                }
            }
            else if (check.kind === "max") {
                const tooBig = check.inclusive ? input.data > check.value : input.data >= check.value;
                if (tooBig) {
                    ctx = this._getOrReturnCtx(input, ctx);
                    addIssueToContext(ctx, {
                        code: ZodIssueCode.too_big,
                        type: "bigint",
                        maximum: check.value,
                        inclusive: check.inclusive,
                        message: check.message,
                    });
                    status.dirty();
                }
            }
            else if (check.kind === "multipleOf") {
                if (input.data % check.value !== BigInt(0)) {
                    ctx = this._getOrReturnCtx(input, ctx);
                    addIssueToContext(ctx, {
                        code: ZodIssueCode.not_multiple_of,
                        multipleOf: check.value,
                        message: check.message,
                    });
                    status.dirty();
                }
            }
            else {
                util.assertNever(check);
            }
        }
        return { status: status.value, value: input.data };
    }
    _getInvalidInput(input) {
        const ctx = this._getOrReturnCtx(input);
        addIssueToContext(ctx, {
            code: ZodIssueCode.invalid_type,
            expected: ZodParsedType.bigint,
            received: ctx.parsedType,
        });
        return INVALID;
    }
    gte(value, message) {
        return this.setLimit("min", value, true, errorUtil.toString(message));
    }
    gt(value, message) {
        return this.setLimit("min", value, false, errorUtil.toString(message));
    }
    lte(value, message) {
        return this.setLimit("max", value, true, errorUtil.toString(message));
    }
    lt(value, message) {
        return this.setLimit("max", value, false, errorUtil.toString(message));
    }
    setLimit(kind, value, inclusive, message) {
        return new ZodBigInt({
            ...this._def,
            checks: [
                ...this._def.checks,
                {
                    kind,
                    value,
                    inclusive,
                    message: errorUtil.toString(message),
                },
            ],
        });
    }
    _addCheck(check) {
        return new ZodBigInt({
            ...this._def,
            checks: [...this._def.checks, check],
        });
    }
    positive(message) {
        return this._addCheck({
            kind: "min",
            value: BigInt(0),
            inclusive: false,
            message: errorUtil.toString(message),
        });
    }
    negative(message) {
        return this._addCheck({
            kind: "max",
            value: BigInt(0),
            inclusive: false,
            message: errorUtil.toString(message),
        });
    }
    nonpositive(message) {
        return this._addCheck({
            kind: "max",
            value: BigInt(0),
            inclusive: true,
            message: errorUtil.toString(message),
        });
    }
    nonnegative(message) {
        return this._addCheck({
            kind: "min",
            value: BigInt(0),
            inclusive: true,
            message: errorUtil.toString(message),
        });
    }
    multipleOf(value, message) {
        return this._addCheck({
            kind: "multipleOf",
            value,
            message: errorUtil.toString(message),
        });
    }
    get minValue() {
        let min = null;
        for (const ch of this._def.checks) {
            if (ch.kind === "min") {
                if (min === null || ch.value > min)
                    min = ch.value;
            }
        }
        return min;
    }
    get maxValue() {
        let max = null;
        for (const ch of this._def.checks) {
            if (ch.kind === "max") {
                if (max === null || ch.value < max)
                    max = ch.value;
            }
        }
        return max;
    }
}
ZodBigInt.create = (params) => {
    return new ZodBigInt({
        checks: [],
        typeName: ZodFirstPartyTypeKind.ZodBigInt,
        coerce: params?.coerce ?? false,
        ...processCreateParams(params),
    });
};
class ZodBoolean extends ZodType {
    _parse(input) {
        if (this._def.coerce) {
            input.data = Boolean(input.data);
        }
        const parsedType = this._getType(input);
        if (parsedType !== ZodParsedType.boolean) {
            const ctx = this._getOrReturnCtx(input);
            addIssueToContext(ctx, {
                code: ZodIssueCode.invalid_type,
                expected: ZodParsedType.boolean,
                received: ctx.parsedType,
            });
            return INVALID;
        }
        return OK(input.data);
    }
}
ZodBoolean.create = (params) => {
    return new ZodBoolean({
        typeName: ZodFirstPartyTypeKind.ZodBoolean,
        coerce: params?.coerce || false,
        ...processCreateParams(params),
    });
};
class ZodDate extends ZodType {
    _parse(input) {
        if (this._def.coerce) {
            input.data = new Date(input.data);
        }
        const parsedType = this._getType(input);
        if (parsedType !== ZodParsedType.date) {
            const ctx = this._getOrReturnCtx(input);
            addIssueToContext(ctx, {
                code: ZodIssueCode.invalid_type,
                expected: ZodParsedType.date,
                received: ctx.parsedType,
            });
            return INVALID;
        }
        if (Number.isNaN(input.data.getTime())) {
            const ctx = this._getOrReturnCtx(input);
            addIssueToContext(ctx, {
                code: ZodIssueCode.invalid_date,
            });
            return INVALID;
        }
        const status = new ParseStatus();
        let ctx = undefined;
        for (const check of this._def.checks) {
            if (check.kind === "min") {
                if (input.data.getTime() < check.value) {
                    ctx = this._getOrReturnCtx(input, ctx);
                    addIssueToContext(ctx, {
                        code: ZodIssueCode.too_small,
                        message: check.message,
                        inclusive: true,
                        exact: false,
                        minimum: check.value,
                        type: "date",
                    });
                    status.dirty();
                }
            }
            else if (check.kind === "max") {
                if (input.data.getTime() > check.value) {
                    ctx = this._getOrReturnCtx(input, ctx);
                    addIssueToContext(ctx, {
                        code: ZodIssueCode.too_big,
                        message: check.message,
                        inclusive: true,
                        exact: false,
                        maximum: check.value,
                        type: "date",
                    });
                    status.dirty();
                }
            }
            else {
                util.assertNever(check);
            }
        }
        return {
            status: status.value,
            value: new Date(input.data.getTime()),
        };
    }
    _addCheck(check) {
        return new ZodDate({
            ...this._def,
            checks: [...this._def.checks, check],
        });
    }
    min(minDate, message) {
        return this._addCheck({
            kind: "min",
            value: minDate.getTime(),
            message: errorUtil.toString(message),
        });
    }
    max(maxDate, message) {
        return this._addCheck({
            kind: "max",
            value: maxDate.getTime(),
            message: errorUtil.toString(message),
        });
    }
    get minDate() {
        let min = null;
        for (const ch of this._def.checks) {
            if (ch.kind === "min") {
                if (min === null || ch.value > min)
                    min = ch.value;
            }
        }
        return min != null ? new Date(min) : null;
    }
    get maxDate() {
        let max = null;
        for (const ch of this._def.checks) {
            if (ch.kind === "max") {
                if (max === null || ch.value < max)
                    max = ch.value;
            }
        }
        return max != null ? new Date(max) : null;
    }
}
ZodDate.create = (params) => {
    return new ZodDate({
        checks: [],
        coerce: params?.coerce || false,
        typeName: ZodFirstPartyTypeKind.ZodDate,
        ...processCreateParams(params),
    });
};
class ZodSymbol extends ZodType {
    _parse(input) {
        const parsedType = this._getType(input);
        if (parsedType !== ZodParsedType.symbol) {
            const ctx = this._getOrReturnCtx(input);
            addIssueToContext(ctx, {
                code: ZodIssueCode.invalid_type,
                expected: ZodParsedType.symbol,
                received: ctx.parsedType,
            });
            return INVALID;
        }
        return OK(input.data);
    }
}
ZodSymbol.create = (params) => {
    return new ZodSymbol({
        typeName: ZodFirstPartyTypeKind.ZodSymbol,
        ...processCreateParams(params),
    });
};
class ZodUndefined extends ZodType {
    _parse(input) {
        const parsedType = this._getType(input);
        if (parsedType !== ZodParsedType.undefined) {
            const ctx = this._getOrReturnCtx(input);
            addIssueToContext(ctx, {
                code: ZodIssueCode.invalid_type,
                expected: ZodParsedType.undefined,
                received: ctx.parsedType,
            });
            return INVALID;
        }
        return OK(input.data);
    }
}
ZodUndefined.create = (params) => {
    return new ZodUndefined({
        typeName: ZodFirstPartyTypeKind.ZodUndefined,
        ...processCreateParams(params),
    });
};
class ZodNull extends ZodType {
    _parse(input) {
        const parsedType = this._getType(input);
        if (parsedType !== ZodParsedType.null) {
            const ctx = this._getOrReturnCtx(input);
            addIssueToContext(ctx, {
                code: ZodIssueCode.invalid_type,
                expected: ZodParsedType.null,
                received: ctx.parsedType,
            });
            return INVALID;
        }
        return OK(input.data);
    }
}
ZodNull.create = (params) => {
    return new ZodNull({
        typeName: ZodFirstPartyTypeKind.ZodNull,
        ...processCreateParams(params),
    });
};
class ZodAny extends ZodType {
    constructor() {
        super(...arguments);
        // to prevent instances of other classes from extending ZodAny. this causes issues with catchall in ZodObject.
        this._any = true;
    }
    _parse(input) {
        return OK(input.data);
    }
}
ZodAny.create = (params) => {
    return new ZodAny({
        typeName: ZodFirstPartyTypeKind.ZodAny,
        ...processCreateParams(params),
    });
};
class ZodUnknown extends ZodType {
    constructor() {
        super(...arguments);
        // required
        this._unknown = true;
    }
    _parse(input) {
        return OK(input.data);
    }
}
ZodUnknown.create = (params) => {
    return new ZodUnknown({
        typeName: ZodFirstPartyTypeKind.ZodUnknown,
        ...processCreateParams(params),
    });
};
class ZodNever extends ZodType {
    _parse(input) {
        const ctx = this._getOrReturnCtx(input);
        addIssueToContext(ctx, {
            code: ZodIssueCode.invalid_type,
            expected: ZodParsedType.never,
            received: ctx.parsedType,
        });
        return INVALID;
    }
}
ZodNever.create = (params) => {
    return new ZodNever({
        typeName: ZodFirstPartyTypeKind.ZodNever,
        ...processCreateParams(params),
    });
};
class ZodVoid extends ZodType {
    _parse(input) {
        const parsedType = this._getType(input);
        if (parsedType !== ZodParsedType.undefined) {
            const ctx = this._getOrReturnCtx(input);
            addIssueToContext(ctx, {
                code: ZodIssueCode.invalid_type,
                expected: ZodParsedType.void,
                received: ctx.parsedType,
            });
            return INVALID;
        }
        return OK(input.data);
    }
}
ZodVoid.create = (params) => {
    return new ZodVoid({
        typeName: ZodFirstPartyTypeKind.ZodVoid,
        ...processCreateParams(params),
    });
};
class ZodArray extends ZodType {
    _parse(input) {
        const { ctx, status } = this._processInputParams(input);
        const def = this._def;
        if (ctx.parsedType !== ZodParsedType.array) {
            addIssueToContext(ctx, {
                code: ZodIssueCode.invalid_type,
                expected: ZodParsedType.array,
                received: ctx.parsedType,
            });
            return INVALID;
        }
        if (def.exactLength !== null) {
            const tooBig = ctx.data.length > def.exactLength.value;
            const tooSmall = ctx.data.length < def.exactLength.value;
            if (tooBig || tooSmall) {
                addIssueToContext(ctx, {
                    code: tooBig ? ZodIssueCode.too_big : ZodIssueCode.too_small,
                    minimum: (tooSmall ? def.exactLength.value : undefined),
                    maximum: (tooBig ? def.exactLength.value : undefined),
                    type: "array",
                    inclusive: true,
                    exact: true,
                    message: def.exactLength.message,
                });
                status.dirty();
            }
        }
        if (def.minLength !== null) {
            if (ctx.data.length < def.minLength.value) {
                addIssueToContext(ctx, {
                    code: ZodIssueCode.too_small,
                    minimum: def.minLength.value,
                    type: "array",
                    inclusive: true,
                    exact: false,
                    message: def.minLength.message,
                });
                status.dirty();
            }
        }
        if (def.maxLength !== null) {
            if (ctx.data.length > def.maxLength.value) {
                addIssueToContext(ctx, {
                    code: ZodIssueCode.too_big,
                    maximum: def.maxLength.value,
                    type: "array",
                    inclusive: true,
                    exact: false,
                    message: def.maxLength.message,
                });
                status.dirty();
            }
        }
        if (ctx.common.async) {
            return Promise.all([...ctx.data].map((item, i) => {
                return def.type._parseAsync(new ParseInputLazyPath(ctx, item, ctx.path, i));
            })).then((result) => {
                return ParseStatus.mergeArray(status, result);
            });
        }
        const result = [...ctx.data].map((item, i) => {
            return def.type._parseSync(new ParseInputLazyPath(ctx, item, ctx.path, i));
        });
        return ParseStatus.mergeArray(status, result);
    }
    get element() {
        return this._def.type;
    }
    min(minLength, message) {
        return new ZodArray({
            ...this._def,
            minLength: { value: minLength, message: errorUtil.toString(message) },
        });
    }
    max(maxLength, message) {
        return new ZodArray({
            ...this._def,
            maxLength: { value: maxLength, message: errorUtil.toString(message) },
        });
    }
    length(len, message) {
        return new ZodArray({
            ...this._def,
            exactLength: { value: len, message: errorUtil.toString(message) },
        });
    }
    nonempty(message) {
        return this.min(1, message);
    }
}
ZodArray.create = (schema, params) => {
    return new ZodArray({
        type: schema,
        minLength: null,
        maxLength: null,
        exactLength: null,
        typeName: ZodFirstPartyTypeKind.ZodArray,
        ...processCreateParams(params),
    });
};
function deepPartialify(schema) {
    if (schema instanceof ZodObject) {
        const newShape = {};
        for (const key in schema.shape) {
            const fieldSchema = schema.shape[key];
            newShape[key] = ZodOptional.create(deepPartialify(fieldSchema));
        }
        return new ZodObject({
            ...schema._def,
            shape: () => newShape,
        });
    }
    else if (schema instanceof ZodArray) {
        return new ZodArray({
            ...schema._def,
            type: deepPartialify(schema.element),
        });
    }
    else if (schema instanceof ZodOptional) {
        return ZodOptional.create(deepPartialify(schema.unwrap()));
    }
    else if (schema instanceof ZodNullable) {
        return ZodNullable.create(deepPartialify(schema.unwrap()));
    }
    else if (schema instanceof ZodTuple) {
        return ZodTuple.create(schema.items.map((item) => deepPartialify(item)));
    }
    else {
        return schema;
    }
}
class ZodObject extends ZodType {
    constructor() {
        super(...arguments);
        this._cached = null;
        /**
         * @deprecated In most cases, this is no longer needed - unknown properties are now silently stripped.
         * If you want to pass through unknown properties, use `.passthrough()` instead.
         */
        this.nonstrict = this.passthrough;
        // extend<
        //   Augmentation extends ZodRawShape,
        //   NewOutput extends util.flatten<{
        //     [k in keyof Augmentation | keyof Output]: k extends keyof Augmentation
        //       ? Augmentation[k]["_output"]
        //       : k extends keyof Output
        //       ? Output[k]
        //       : never;
        //   }>,
        //   NewInput extends util.flatten<{
        //     [k in keyof Augmentation | keyof Input]: k extends keyof Augmentation
        //       ? Augmentation[k]["_input"]
        //       : k extends keyof Input
        //       ? Input[k]
        //       : never;
        //   }>
        // >(
        //   augmentation: Augmentation
        // ): ZodObject<
        //   extendShape<T, Augmentation>,
        //   UnknownKeys,
        //   Catchall,
        //   NewOutput,
        //   NewInput
        // > {
        //   return new ZodObject({
        //     ...this._def,
        //     shape: () => ({
        //       ...this._def.shape(),
        //       ...augmentation,
        //     }),
        //   }) as any;
        // }
        /**
         * @deprecated Use `.extend` instead
         *  */
        this.augment = this.extend;
    }
    _getCached() {
        if (this._cached !== null)
            return this._cached;
        const shape = this._def.shape();
        const keys = util.objectKeys(shape);
        this._cached = { shape, keys };
        return this._cached;
    }
    _parse(input) {
        const parsedType = this._getType(input);
        if (parsedType !== ZodParsedType.object) {
            const ctx = this._getOrReturnCtx(input);
            addIssueToContext(ctx, {
                code: ZodIssueCode.invalid_type,
                expected: ZodParsedType.object,
                received: ctx.parsedType,
            });
            return INVALID;
        }
        const { status, ctx } = this._processInputParams(input);
        const { shape, keys: shapeKeys } = this._getCached();
        const extraKeys = [];
        if (!(this._def.catchall instanceof ZodNever && this._def.unknownKeys === "strip")) {
            for (const key in ctx.data) {
                if (!shapeKeys.includes(key)) {
                    extraKeys.push(key);
                }
            }
        }
        const pairs = [];
        for (const key of shapeKeys) {
            const keyValidator = shape[key];
            const value = ctx.data[key];
            pairs.push({
                key: { status: "valid", value: key },
                value: keyValidator._parse(new ParseInputLazyPath(ctx, value, ctx.path, key)),
                alwaysSet: key in ctx.data,
            });
        }
        if (this._def.catchall instanceof ZodNever) {
            const unknownKeys = this._def.unknownKeys;
            if (unknownKeys === "passthrough") {
                for (const key of extraKeys) {
                    pairs.push({
                        key: { status: "valid", value: key },
                        value: { status: "valid", value: ctx.data[key] },
                    });
                }
            }
            else if (unknownKeys === "strict") {
                if (extraKeys.length > 0) {
                    addIssueToContext(ctx, {
                        code: ZodIssueCode.unrecognized_keys,
                        keys: extraKeys,
                    });
                    status.dirty();
                }
            }
            else if (unknownKeys === "strip") ;
            else {
                throw new Error(`Internal ZodObject error: invalid unknownKeys value.`);
            }
        }
        else {
            // run catchall validation
            const catchall = this._def.catchall;
            for (const key of extraKeys) {
                const value = ctx.data[key];
                pairs.push({
                    key: { status: "valid", value: key },
                    value: catchall._parse(new ParseInputLazyPath(ctx, value, ctx.path, key) //, ctx.child(key), value, getParsedType(value)
                    ),
                    alwaysSet: key in ctx.data,
                });
            }
        }
        if (ctx.common.async) {
            return Promise.resolve()
                .then(async () => {
                const syncPairs = [];
                for (const pair of pairs) {
                    const key = await pair.key;
                    const value = await pair.value;
                    syncPairs.push({
                        key,
                        value,
                        alwaysSet: pair.alwaysSet,
                    });
                }
                return syncPairs;
            })
                .then((syncPairs) => {
                return ParseStatus.mergeObjectSync(status, syncPairs);
            });
        }
        else {
            return ParseStatus.mergeObjectSync(status, pairs);
        }
    }
    get shape() {
        return this._def.shape();
    }
    strict(message) {
        errorUtil.errToObj;
        return new ZodObject({
            ...this._def,
            unknownKeys: "strict",
            ...(message !== undefined
                ? {
                    errorMap: (issue, ctx) => {
                        const defaultError = this._def.errorMap?.(issue, ctx).message ?? ctx.defaultError;
                        if (issue.code === "unrecognized_keys")
                            return {
                                message: errorUtil.errToObj(message).message ?? defaultError,
                            };
                        return {
                            message: defaultError,
                        };
                    },
                }
                : {}),
        });
    }
    strip() {
        return new ZodObject({
            ...this._def,
            unknownKeys: "strip",
        });
    }
    passthrough() {
        return new ZodObject({
            ...this._def,
            unknownKeys: "passthrough",
        });
    }
    // const AugmentFactory =
    //   <Def extends ZodObjectDef>(def: Def) =>
    //   <Augmentation extends ZodRawShape>(
    //     augmentation: Augmentation
    //   ): ZodObject<
    //     extendShape<ReturnType<Def["shape"]>, Augmentation>,
    //     Def["unknownKeys"],
    //     Def["catchall"]
    //   > => {
    //     return new ZodObject({
    //       ...def,
    //       shape: () => ({
    //         ...def.shape(),
    //         ...augmentation,
    //       }),
    //     }) as any;
    //   };
    extend(augmentation) {
        return new ZodObject({
            ...this._def,
            shape: () => ({
                ...this._def.shape(),
                ...augmentation,
            }),
        });
    }
    /**
     * Prior to zod@1.0.12 there was a bug in the
     * inferred type of merged objects. Please
     * upgrade if you are experiencing issues.
     */
    merge(merging) {
        const merged = new ZodObject({
            unknownKeys: merging._def.unknownKeys,
            catchall: merging._def.catchall,
            shape: () => ({
                ...this._def.shape(),
                ...merging._def.shape(),
            }),
            typeName: ZodFirstPartyTypeKind.ZodObject,
        });
        return merged;
    }
    // merge<
    //   Incoming extends AnyZodObject,
    //   Augmentation extends Incoming["shape"],
    //   NewOutput extends {
    //     [k in keyof Augmentation | keyof Output]: k extends keyof Augmentation
    //       ? Augmentation[k]["_output"]
    //       : k extends keyof Output
    //       ? Output[k]
    //       : never;
    //   },
    //   NewInput extends {
    //     [k in keyof Augmentation | keyof Input]: k extends keyof Augmentation
    //       ? Augmentation[k]["_input"]
    //       : k extends keyof Input
    //       ? Input[k]
    //       : never;
    //   }
    // >(
    //   merging: Incoming
    // ): ZodObject<
    //   extendShape<T, ReturnType<Incoming["_def"]["shape"]>>,
    //   Incoming["_def"]["unknownKeys"],
    //   Incoming["_def"]["catchall"],
    //   NewOutput,
    //   NewInput
    // > {
    //   const merged: any = new ZodObject({
    //     unknownKeys: merging._def.unknownKeys,
    //     catchall: merging._def.catchall,
    //     shape: () =>
    //       objectUtil.mergeShapes(this._def.shape(), merging._def.shape()),
    //     typeName: ZodFirstPartyTypeKind.ZodObject,
    //   }) as any;
    //   return merged;
    // }
    setKey(key, schema) {
        return this.augment({ [key]: schema });
    }
    // merge<Incoming extends AnyZodObject>(
    //   merging: Incoming
    // ): //ZodObject<T & Incoming["_shape"], UnknownKeys, Catchall> = (merging) => {
    // ZodObject<
    //   extendShape<T, ReturnType<Incoming["_def"]["shape"]>>,
    //   Incoming["_def"]["unknownKeys"],
    //   Incoming["_def"]["catchall"]
    // > {
    //   // const mergedShape = objectUtil.mergeShapes(
    //   //   this._def.shape(),
    //   //   merging._def.shape()
    //   // );
    //   const merged: any = new ZodObject({
    //     unknownKeys: merging._def.unknownKeys,
    //     catchall: merging._def.catchall,
    //     shape: () =>
    //       objectUtil.mergeShapes(this._def.shape(), merging._def.shape()),
    //     typeName: ZodFirstPartyTypeKind.ZodObject,
    //   }) as any;
    //   return merged;
    // }
    catchall(index) {
        return new ZodObject({
            ...this._def,
            catchall: index,
        });
    }
    pick(mask) {
        const shape = {};
        for (const key of util.objectKeys(mask)) {
            if (mask[key] && this.shape[key]) {
                shape[key] = this.shape[key];
            }
        }
        return new ZodObject({
            ...this._def,
            shape: () => shape,
        });
    }
    omit(mask) {
        const shape = {};
        for (const key of util.objectKeys(this.shape)) {
            if (!mask[key]) {
                shape[key] = this.shape[key];
            }
        }
        return new ZodObject({
            ...this._def,
            shape: () => shape,
        });
    }
    /**
     * @deprecated
     */
    deepPartial() {
        return deepPartialify(this);
    }
    partial(mask) {
        const newShape = {};
        for (const key of util.objectKeys(this.shape)) {
            const fieldSchema = this.shape[key];
            if (mask && !mask[key]) {
                newShape[key] = fieldSchema;
            }
            else {
                newShape[key] = fieldSchema.optional();
            }
        }
        return new ZodObject({
            ...this._def,
            shape: () => newShape,
        });
    }
    required(mask) {
        const newShape = {};
        for (const key of util.objectKeys(this.shape)) {
            if (mask && !mask[key]) {
                newShape[key] = this.shape[key];
            }
            else {
                const fieldSchema = this.shape[key];
                let newField = fieldSchema;
                while (newField instanceof ZodOptional) {
                    newField = newField._def.innerType;
                }
                newShape[key] = newField;
            }
        }
        return new ZodObject({
            ...this._def,
            shape: () => newShape,
        });
    }
    keyof() {
        return createZodEnum(util.objectKeys(this.shape));
    }
}
ZodObject.create = (shape, params) => {
    return new ZodObject({
        shape: () => shape,
        unknownKeys: "strip",
        catchall: ZodNever.create(),
        typeName: ZodFirstPartyTypeKind.ZodObject,
        ...processCreateParams(params),
    });
};
ZodObject.strictCreate = (shape, params) => {
    return new ZodObject({
        shape: () => shape,
        unknownKeys: "strict",
        catchall: ZodNever.create(),
        typeName: ZodFirstPartyTypeKind.ZodObject,
        ...processCreateParams(params),
    });
};
ZodObject.lazycreate = (shape, params) => {
    return new ZodObject({
        shape,
        unknownKeys: "strip",
        catchall: ZodNever.create(),
        typeName: ZodFirstPartyTypeKind.ZodObject,
        ...processCreateParams(params),
    });
};
class ZodUnion extends ZodType {
    _parse(input) {
        const { ctx } = this._processInputParams(input);
        const options = this._def.options;
        function handleResults(results) {
            // return first issue-free validation if it exists
            for (const result of results) {
                if (result.result.status === "valid") {
                    return result.result;
                }
            }
            for (const result of results) {
                if (result.result.status === "dirty") {
                    // add issues from dirty option
                    ctx.common.issues.push(...result.ctx.common.issues);
                    return result.result;
                }
            }
            // return invalid
            const unionErrors = results.map((result) => new ZodError(result.ctx.common.issues));
            addIssueToContext(ctx, {
                code: ZodIssueCode.invalid_union,
                unionErrors,
            });
            return INVALID;
        }
        if (ctx.common.async) {
            return Promise.all(options.map(async (option) => {
                const childCtx = {
                    ...ctx,
                    common: {
                        ...ctx.common,
                        issues: [],
                    },
                    parent: null,
                };
                return {
                    result: await option._parseAsync({
                        data: ctx.data,
                        path: ctx.path,
                        parent: childCtx,
                    }),
                    ctx: childCtx,
                };
            })).then(handleResults);
        }
        else {
            let dirty = undefined;
            const issues = [];
            for (const option of options) {
                const childCtx = {
                    ...ctx,
                    common: {
                        ...ctx.common,
                        issues: [],
                    },
                    parent: null,
                };
                const result = option._parseSync({
                    data: ctx.data,
                    path: ctx.path,
                    parent: childCtx,
                });
                if (result.status === "valid") {
                    return result;
                }
                else if (result.status === "dirty" && !dirty) {
                    dirty = { result, ctx: childCtx };
                }
                if (childCtx.common.issues.length) {
                    issues.push(childCtx.common.issues);
                }
            }
            if (dirty) {
                ctx.common.issues.push(...dirty.ctx.common.issues);
                return dirty.result;
            }
            const unionErrors = issues.map((issues) => new ZodError(issues));
            addIssueToContext(ctx, {
                code: ZodIssueCode.invalid_union,
                unionErrors,
            });
            return INVALID;
        }
    }
    get options() {
        return this._def.options;
    }
}
ZodUnion.create = (types, params) => {
    return new ZodUnion({
        options: types,
        typeName: ZodFirstPartyTypeKind.ZodUnion,
        ...processCreateParams(params),
    });
};
function mergeValues(a, b) {
    const aType = getParsedType(a);
    const bType = getParsedType(b);
    if (a === b) {
        return { valid: true, data: a };
    }
    else if (aType === ZodParsedType.object && bType === ZodParsedType.object) {
        const bKeys = util.objectKeys(b);
        const sharedKeys = util.objectKeys(a).filter((key) => bKeys.indexOf(key) !== -1);
        const newObj = { ...a, ...b };
        for (const key of sharedKeys) {
            const sharedValue = mergeValues(a[key], b[key]);
            if (!sharedValue.valid) {
                return { valid: false };
            }
            newObj[key] = sharedValue.data;
        }
        return { valid: true, data: newObj };
    }
    else if (aType === ZodParsedType.array && bType === ZodParsedType.array) {
        if (a.length !== b.length) {
            return { valid: false };
        }
        const newArray = [];
        for (let index = 0; index < a.length; index++) {
            const itemA = a[index];
            const itemB = b[index];
            const sharedValue = mergeValues(itemA, itemB);
            if (!sharedValue.valid) {
                return { valid: false };
            }
            newArray.push(sharedValue.data);
        }
        return { valid: true, data: newArray };
    }
    else if (aType === ZodParsedType.date && bType === ZodParsedType.date && +a === +b) {
        return { valid: true, data: a };
    }
    else {
        return { valid: false };
    }
}
class ZodIntersection extends ZodType {
    _parse(input) {
        const { status, ctx } = this._processInputParams(input);
        const handleParsed = (parsedLeft, parsedRight) => {
            if (isAborted(parsedLeft) || isAborted(parsedRight)) {
                return INVALID;
            }
            const merged = mergeValues(parsedLeft.value, parsedRight.value);
            if (!merged.valid) {
                addIssueToContext(ctx, {
                    code: ZodIssueCode.invalid_intersection_types,
                });
                return INVALID;
            }
            if (isDirty$1(parsedLeft) || isDirty$1(parsedRight)) {
                status.dirty();
            }
            return { status: status.value, value: merged.data };
        };
        if (ctx.common.async) {
            return Promise.all([
                this._def.left._parseAsync({
                    data: ctx.data,
                    path: ctx.path,
                    parent: ctx,
                }),
                this._def.right._parseAsync({
                    data: ctx.data,
                    path: ctx.path,
                    parent: ctx,
                }),
            ]).then(([left, right]) => handleParsed(left, right));
        }
        else {
            return handleParsed(this._def.left._parseSync({
                data: ctx.data,
                path: ctx.path,
                parent: ctx,
            }), this._def.right._parseSync({
                data: ctx.data,
                path: ctx.path,
                parent: ctx,
            }));
        }
    }
}
ZodIntersection.create = (left, right, params) => {
    return new ZodIntersection({
        left: left,
        right: right,
        typeName: ZodFirstPartyTypeKind.ZodIntersection,
        ...processCreateParams(params),
    });
};
// type ZodTupleItems = [ZodTypeAny, ...ZodTypeAny[]];
class ZodTuple extends ZodType {
    _parse(input) {
        const { status, ctx } = this._processInputParams(input);
        if (ctx.parsedType !== ZodParsedType.array) {
            addIssueToContext(ctx, {
                code: ZodIssueCode.invalid_type,
                expected: ZodParsedType.array,
                received: ctx.parsedType,
            });
            return INVALID;
        }
        if (ctx.data.length < this._def.items.length) {
            addIssueToContext(ctx, {
                code: ZodIssueCode.too_small,
                minimum: this._def.items.length,
                inclusive: true,
                exact: false,
                type: "array",
            });
            return INVALID;
        }
        const rest = this._def.rest;
        if (!rest && ctx.data.length > this._def.items.length) {
            addIssueToContext(ctx, {
                code: ZodIssueCode.too_big,
                maximum: this._def.items.length,
                inclusive: true,
                exact: false,
                type: "array",
            });
            status.dirty();
        }
        const items = [...ctx.data]
            .map((item, itemIndex) => {
            const schema = this._def.items[itemIndex] || this._def.rest;
            if (!schema)
                return null;
            return schema._parse(new ParseInputLazyPath(ctx, item, ctx.path, itemIndex));
        })
            .filter((x) => !!x); // filter nulls
        if (ctx.common.async) {
            return Promise.all(items).then((results) => {
                return ParseStatus.mergeArray(status, results);
            });
        }
        else {
            return ParseStatus.mergeArray(status, items);
        }
    }
    get items() {
        return this._def.items;
    }
    rest(rest) {
        return new ZodTuple({
            ...this._def,
            rest,
        });
    }
}
ZodTuple.create = (schemas, params) => {
    if (!Array.isArray(schemas)) {
        throw new Error("You must pass an array of schemas to z.tuple([ ... ])");
    }
    return new ZodTuple({
        items: schemas,
        typeName: ZodFirstPartyTypeKind.ZodTuple,
        rest: null,
        ...processCreateParams(params),
    });
};
class ZodRecord extends ZodType {
    get keySchema() {
        return this._def.keyType;
    }
    get valueSchema() {
        return this._def.valueType;
    }
    _parse(input) {
        const { status, ctx } = this._processInputParams(input);
        if (ctx.parsedType !== ZodParsedType.object) {
            addIssueToContext(ctx, {
                code: ZodIssueCode.invalid_type,
                expected: ZodParsedType.object,
                received: ctx.parsedType,
            });
            return INVALID;
        }
        const pairs = [];
        const keyType = this._def.keyType;
        const valueType = this._def.valueType;
        for (const key in ctx.data) {
            pairs.push({
                key: keyType._parse(new ParseInputLazyPath(ctx, key, ctx.path, key)),
                value: valueType._parse(new ParseInputLazyPath(ctx, ctx.data[key], ctx.path, key)),
                alwaysSet: key in ctx.data,
            });
        }
        if (ctx.common.async) {
            return ParseStatus.mergeObjectAsync(status, pairs);
        }
        else {
            return ParseStatus.mergeObjectSync(status, pairs);
        }
    }
    get element() {
        return this._def.valueType;
    }
    static create(first, second, third) {
        if (second instanceof ZodType) {
            return new ZodRecord({
                keyType: first,
                valueType: second,
                typeName: ZodFirstPartyTypeKind.ZodRecord,
                ...processCreateParams(third),
            });
        }
        return new ZodRecord({
            keyType: ZodString.create(),
            valueType: first,
            typeName: ZodFirstPartyTypeKind.ZodRecord,
            ...processCreateParams(second),
        });
    }
}
class ZodMap extends ZodType {
    get keySchema() {
        return this._def.keyType;
    }
    get valueSchema() {
        return this._def.valueType;
    }
    _parse(input) {
        const { status, ctx } = this._processInputParams(input);
        if (ctx.parsedType !== ZodParsedType.map) {
            addIssueToContext(ctx, {
                code: ZodIssueCode.invalid_type,
                expected: ZodParsedType.map,
                received: ctx.parsedType,
            });
            return INVALID;
        }
        const keyType = this._def.keyType;
        const valueType = this._def.valueType;
        const pairs = [...ctx.data.entries()].map(([key, value], index) => {
            return {
                key: keyType._parse(new ParseInputLazyPath(ctx, key, ctx.path, [index, "key"])),
                value: valueType._parse(new ParseInputLazyPath(ctx, value, ctx.path, [index, "value"])),
            };
        });
        if (ctx.common.async) {
            const finalMap = new Map();
            return Promise.resolve().then(async () => {
                for (const pair of pairs) {
                    const key = await pair.key;
                    const value = await pair.value;
                    if (key.status === "aborted" || value.status === "aborted") {
                        return INVALID;
                    }
                    if (key.status === "dirty" || value.status === "dirty") {
                        status.dirty();
                    }
                    finalMap.set(key.value, value.value);
                }
                return { status: status.value, value: finalMap };
            });
        }
        else {
            const finalMap = new Map();
            for (const pair of pairs) {
                const key = pair.key;
                const value = pair.value;
                if (key.status === "aborted" || value.status === "aborted") {
                    return INVALID;
                }
                if (key.status === "dirty" || value.status === "dirty") {
                    status.dirty();
                }
                finalMap.set(key.value, value.value);
            }
            return { status: status.value, value: finalMap };
        }
    }
}
ZodMap.create = (keyType, valueType, params) => {
    return new ZodMap({
        valueType,
        keyType,
        typeName: ZodFirstPartyTypeKind.ZodMap,
        ...processCreateParams(params),
    });
};
class ZodSet extends ZodType {
    _parse(input) {
        const { status, ctx } = this._processInputParams(input);
        if (ctx.parsedType !== ZodParsedType.set) {
            addIssueToContext(ctx, {
                code: ZodIssueCode.invalid_type,
                expected: ZodParsedType.set,
                received: ctx.parsedType,
            });
            return INVALID;
        }
        const def = this._def;
        if (def.minSize !== null) {
            if (ctx.data.size < def.minSize.value) {
                addIssueToContext(ctx, {
                    code: ZodIssueCode.too_small,
                    minimum: def.minSize.value,
                    type: "set",
                    inclusive: true,
                    exact: false,
                    message: def.minSize.message,
                });
                status.dirty();
            }
        }
        if (def.maxSize !== null) {
            if (ctx.data.size > def.maxSize.value) {
                addIssueToContext(ctx, {
                    code: ZodIssueCode.too_big,
                    maximum: def.maxSize.value,
                    type: "set",
                    inclusive: true,
                    exact: false,
                    message: def.maxSize.message,
                });
                status.dirty();
            }
        }
        const valueType = this._def.valueType;
        function finalizeSet(elements) {
            const parsedSet = new Set();
            for (const element of elements) {
                if (element.status === "aborted")
                    return INVALID;
                if (element.status === "dirty")
                    status.dirty();
                parsedSet.add(element.value);
            }
            return { status: status.value, value: parsedSet };
        }
        const elements = [...ctx.data.values()].map((item, i) => valueType._parse(new ParseInputLazyPath(ctx, item, ctx.path, i)));
        if (ctx.common.async) {
            return Promise.all(elements).then((elements) => finalizeSet(elements));
        }
        else {
            return finalizeSet(elements);
        }
    }
    min(minSize, message) {
        return new ZodSet({
            ...this._def,
            minSize: { value: minSize, message: errorUtil.toString(message) },
        });
    }
    max(maxSize, message) {
        return new ZodSet({
            ...this._def,
            maxSize: { value: maxSize, message: errorUtil.toString(message) },
        });
    }
    size(size, message) {
        return this.min(size, message).max(size, message);
    }
    nonempty(message) {
        return this.min(1, message);
    }
}
ZodSet.create = (valueType, params) => {
    return new ZodSet({
        valueType,
        minSize: null,
        maxSize: null,
        typeName: ZodFirstPartyTypeKind.ZodSet,
        ...processCreateParams(params),
    });
};
class ZodLazy extends ZodType {
    get schema() {
        return this._def.getter();
    }
    _parse(input) {
        const { ctx } = this._processInputParams(input);
        const lazySchema = this._def.getter();
        return lazySchema._parse({ data: ctx.data, path: ctx.path, parent: ctx });
    }
}
ZodLazy.create = (getter, params) => {
    return new ZodLazy({
        getter: getter,
        typeName: ZodFirstPartyTypeKind.ZodLazy,
        ...processCreateParams(params),
    });
};
class ZodLiteral extends ZodType {
    _parse(input) {
        if (input.data !== this._def.value) {
            const ctx = this._getOrReturnCtx(input);
            addIssueToContext(ctx, {
                received: ctx.data,
                code: ZodIssueCode.invalid_literal,
                expected: this._def.value,
            });
            return INVALID;
        }
        return { status: "valid", value: input.data };
    }
    get value() {
        return this._def.value;
    }
}
ZodLiteral.create = (value, params) => {
    return new ZodLiteral({
        value: value,
        typeName: ZodFirstPartyTypeKind.ZodLiteral,
        ...processCreateParams(params),
    });
};
function createZodEnum(values, params) {
    return new ZodEnum({
        values,
        typeName: ZodFirstPartyTypeKind.ZodEnum,
        ...processCreateParams(params),
    });
}
class ZodEnum extends ZodType {
    _parse(input) {
        if (typeof input.data !== "string") {
            const ctx = this._getOrReturnCtx(input);
            const expectedValues = this._def.values;
            addIssueToContext(ctx, {
                expected: util.joinValues(expectedValues),
                received: ctx.parsedType,
                code: ZodIssueCode.invalid_type,
            });
            return INVALID;
        }
        if (!this._cache) {
            this._cache = new Set(this._def.values);
        }
        if (!this._cache.has(input.data)) {
            const ctx = this._getOrReturnCtx(input);
            const expectedValues = this._def.values;
            addIssueToContext(ctx, {
                received: ctx.data,
                code: ZodIssueCode.invalid_enum_value,
                options: expectedValues,
            });
            return INVALID;
        }
        return OK(input.data);
    }
    get options() {
        return this._def.values;
    }
    get enum() {
        const enumValues = {};
        for (const val of this._def.values) {
            enumValues[val] = val;
        }
        return enumValues;
    }
    get Values() {
        const enumValues = {};
        for (const val of this._def.values) {
            enumValues[val] = val;
        }
        return enumValues;
    }
    get Enum() {
        const enumValues = {};
        for (const val of this._def.values) {
            enumValues[val] = val;
        }
        return enumValues;
    }
    extract(values, newDef = this._def) {
        return ZodEnum.create(values, {
            ...this._def,
            ...newDef,
        });
    }
    exclude(values, newDef = this._def) {
        return ZodEnum.create(this.options.filter((opt) => !values.includes(opt)), {
            ...this._def,
            ...newDef,
        });
    }
}
ZodEnum.create = createZodEnum;
class ZodNativeEnum extends ZodType {
    _parse(input) {
        const nativeEnumValues = util.getValidEnumValues(this._def.values);
        const ctx = this._getOrReturnCtx(input);
        if (ctx.parsedType !== ZodParsedType.string && ctx.parsedType !== ZodParsedType.number) {
            const expectedValues = util.objectValues(nativeEnumValues);
            addIssueToContext(ctx, {
                expected: util.joinValues(expectedValues),
                received: ctx.parsedType,
                code: ZodIssueCode.invalid_type,
            });
            return INVALID;
        }
        if (!this._cache) {
            this._cache = new Set(util.getValidEnumValues(this._def.values));
        }
        if (!this._cache.has(input.data)) {
            const expectedValues = util.objectValues(nativeEnumValues);
            addIssueToContext(ctx, {
                received: ctx.data,
                code: ZodIssueCode.invalid_enum_value,
                options: expectedValues,
            });
            return INVALID;
        }
        return OK(input.data);
    }
    get enum() {
        return this._def.values;
    }
}
ZodNativeEnum.create = (values, params) => {
    return new ZodNativeEnum({
        values: values,
        typeName: ZodFirstPartyTypeKind.ZodNativeEnum,
        ...processCreateParams(params),
    });
};
class ZodPromise extends ZodType {
    unwrap() {
        return this._def.type;
    }
    _parse(input) {
        const { ctx } = this._processInputParams(input);
        if (ctx.parsedType !== ZodParsedType.promise && ctx.common.async === false) {
            addIssueToContext(ctx, {
                code: ZodIssueCode.invalid_type,
                expected: ZodParsedType.promise,
                received: ctx.parsedType,
            });
            return INVALID;
        }
        const promisified = ctx.parsedType === ZodParsedType.promise ? ctx.data : Promise.resolve(ctx.data);
        return OK(promisified.then((data) => {
            return this._def.type.parseAsync(data, {
                path: ctx.path,
                errorMap: ctx.common.contextualErrorMap,
            });
        }));
    }
}
ZodPromise.create = (schema, params) => {
    return new ZodPromise({
        type: schema,
        typeName: ZodFirstPartyTypeKind.ZodPromise,
        ...processCreateParams(params),
    });
};
class ZodEffects extends ZodType {
    innerType() {
        return this._def.schema;
    }
    sourceType() {
        return this._def.schema._def.typeName === ZodFirstPartyTypeKind.ZodEffects
            ? this._def.schema.sourceType()
            : this._def.schema;
    }
    _parse(input) {
        const { status, ctx } = this._processInputParams(input);
        const effect = this._def.effect || null;
        const checkCtx = {
            addIssue: (arg) => {
                addIssueToContext(ctx, arg);
                if (arg.fatal) {
                    status.abort();
                }
                else {
                    status.dirty();
                }
            },
            get path() {
                return ctx.path;
            },
        };
        checkCtx.addIssue = checkCtx.addIssue.bind(checkCtx);
        if (effect.type === "preprocess") {
            const processed = effect.transform(ctx.data, checkCtx);
            if (ctx.common.async) {
                return Promise.resolve(processed).then(async (processed) => {
                    if (status.value === "aborted")
                        return INVALID;
                    const result = await this._def.schema._parseAsync({
                        data: processed,
                        path: ctx.path,
                        parent: ctx,
                    });
                    if (result.status === "aborted")
                        return INVALID;
                    if (result.status === "dirty")
                        return DIRTY(result.value);
                    if (status.value === "dirty")
                        return DIRTY(result.value);
                    return result;
                });
            }
            else {
                if (status.value === "aborted")
                    return INVALID;
                const result = this._def.schema._parseSync({
                    data: processed,
                    path: ctx.path,
                    parent: ctx,
                });
                if (result.status === "aborted")
                    return INVALID;
                if (result.status === "dirty")
                    return DIRTY(result.value);
                if (status.value === "dirty")
                    return DIRTY(result.value);
                return result;
            }
        }
        if (effect.type === "refinement") {
            const executeRefinement = (acc) => {
                const result = effect.refinement(acc, checkCtx);
                if (ctx.common.async) {
                    return Promise.resolve(result);
                }
                if (result instanceof Promise) {
                    throw new Error("Async refinement encountered during synchronous parse operation. Use .parseAsync instead.");
                }
                return acc;
            };
            if (ctx.common.async === false) {
                const inner = this._def.schema._parseSync({
                    data: ctx.data,
                    path: ctx.path,
                    parent: ctx,
                });
                if (inner.status === "aborted")
                    return INVALID;
                if (inner.status === "dirty")
                    status.dirty();
                // return value is ignored
                executeRefinement(inner.value);
                return { status: status.value, value: inner.value };
            }
            else {
                return this._def.schema._parseAsync({ data: ctx.data, path: ctx.path, parent: ctx }).then((inner) => {
                    if (inner.status === "aborted")
                        return INVALID;
                    if (inner.status === "dirty")
                        status.dirty();
                    return executeRefinement(inner.value).then(() => {
                        return { status: status.value, value: inner.value };
                    });
                });
            }
        }
        if (effect.type === "transform") {
            if (ctx.common.async === false) {
                const base = this._def.schema._parseSync({
                    data: ctx.data,
                    path: ctx.path,
                    parent: ctx,
                });
                if (!isValid(base))
                    return INVALID;
                const result = effect.transform(base.value, checkCtx);
                if (result instanceof Promise) {
                    throw new Error(`Asynchronous transform encountered during synchronous parse operation. Use .parseAsync instead.`);
                }
                return { status: status.value, value: result };
            }
            else {
                return this._def.schema._parseAsync({ data: ctx.data, path: ctx.path, parent: ctx }).then((base) => {
                    if (!isValid(base))
                        return INVALID;
                    return Promise.resolve(effect.transform(base.value, checkCtx)).then((result) => ({
                        status: status.value,
                        value: result,
                    }));
                });
            }
        }
        util.assertNever(effect);
    }
}
ZodEffects.create = (schema, effect, params) => {
    return new ZodEffects({
        schema,
        typeName: ZodFirstPartyTypeKind.ZodEffects,
        effect,
        ...processCreateParams(params),
    });
};
ZodEffects.createWithPreprocess = (preprocess, schema, params) => {
    return new ZodEffects({
        schema,
        effect: { type: "preprocess", transform: preprocess },
        typeName: ZodFirstPartyTypeKind.ZodEffects,
        ...processCreateParams(params),
    });
};
class ZodOptional extends ZodType {
    _parse(input) {
        const parsedType = this._getType(input);
        if (parsedType === ZodParsedType.undefined) {
            return OK(undefined);
        }
        return this._def.innerType._parse(input);
    }
    unwrap() {
        return this._def.innerType;
    }
}
ZodOptional.create = (type, params) => {
    return new ZodOptional({
        innerType: type,
        typeName: ZodFirstPartyTypeKind.ZodOptional,
        ...processCreateParams(params),
    });
};
class ZodNullable extends ZodType {
    _parse(input) {
        const parsedType = this._getType(input);
        if (parsedType === ZodParsedType.null) {
            return OK(null);
        }
        return this._def.innerType._parse(input);
    }
    unwrap() {
        return this._def.innerType;
    }
}
ZodNullable.create = (type, params) => {
    return new ZodNullable({
        innerType: type,
        typeName: ZodFirstPartyTypeKind.ZodNullable,
        ...processCreateParams(params),
    });
};
class ZodDefault extends ZodType {
    _parse(input) {
        const { ctx } = this._processInputParams(input);
        let data = ctx.data;
        if (ctx.parsedType === ZodParsedType.undefined) {
            data = this._def.defaultValue();
        }
        return this._def.innerType._parse({
            data,
            path: ctx.path,
            parent: ctx,
        });
    }
    removeDefault() {
        return this._def.innerType;
    }
}
ZodDefault.create = (type, params) => {
    return new ZodDefault({
        innerType: type,
        typeName: ZodFirstPartyTypeKind.ZodDefault,
        defaultValue: typeof params.default === "function" ? params.default : () => params.default,
        ...processCreateParams(params),
    });
};
class ZodCatch extends ZodType {
    _parse(input) {
        const { ctx } = this._processInputParams(input);
        // newCtx is used to not collect issues from inner types in ctx
        const newCtx = {
            ...ctx,
            common: {
                ...ctx.common,
                issues: [],
            },
        };
        const result = this._def.innerType._parse({
            data: newCtx.data,
            path: newCtx.path,
            parent: {
                ...newCtx,
            },
        });
        if (isAsync(result)) {
            return result.then((result) => {
                return {
                    status: "valid",
                    value: result.status === "valid"
                        ? result.value
                        : this._def.catchValue({
                            get error() {
                                return new ZodError(newCtx.common.issues);
                            },
                            input: newCtx.data,
                        }),
                };
            });
        }
        else {
            return {
                status: "valid",
                value: result.status === "valid"
                    ? result.value
                    : this._def.catchValue({
                        get error() {
                            return new ZodError(newCtx.common.issues);
                        },
                        input: newCtx.data,
                    }),
            };
        }
    }
    removeCatch() {
        return this._def.innerType;
    }
}
ZodCatch.create = (type, params) => {
    return new ZodCatch({
        innerType: type,
        typeName: ZodFirstPartyTypeKind.ZodCatch,
        catchValue: typeof params.catch === "function" ? params.catch : () => params.catch,
        ...processCreateParams(params),
    });
};
class ZodNaN extends ZodType {
    _parse(input) {
        const parsedType = this._getType(input);
        if (parsedType !== ZodParsedType.nan) {
            const ctx = this._getOrReturnCtx(input);
            addIssueToContext(ctx, {
                code: ZodIssueCode.invalid_type,
                expected: ZodParsedType.nan,
                received: ctx.parsedType,
            });
            return INVALID;
        }
        return { status: "valid", value: input.data };
    }
}
ZodNaN.create = (params) => {
    return new ZodNaN({
        typeName: ZodFirstPartyTypeKind.ZodNaN,
        ...processCreateParams(params),
    });
};
class ZodBranded extends ZodType {
    _parse(input) {
        const { ctx } = this._processInputParams(input);
        const data = ctx.data;
        return this._def.type._parse({
            data,
            path: ctx.path,
            parent: ctx,
        });
    }
    unwrap() {
        return this._def.type;
    }
}
class ZodPipeline extends ZodType {
    _parse(input) {
        const { status, ctx } = this._processInputParams(input);
        if (ctx.common.async) {
            const handleAsync = async () => {
                const inResult = await this._def.in._parseAsync({
                    data: ctx.data,
                    path: ctx.path,
                    parent: ctx,
                });
                if (inResult.status === "aborted")
                    return INVALID;
                if (inResult.status === "dirty") {
                    status.dirty();
                    return DIRTY(inResult.value);
                }
                else {
                    return this._def.out._parseAsync({
                        data: inResult.value,
                        path: ctx.path,
                        parent: ctx,
                    });
                }
            };
            return handleAsync();
        }
        else {
            const inResult = this._def.in._parseSync({
                data: ctx.data,
                path: ctx.path,
                parent: ctx,
            });
            if (inResult.status === "aborted")
                return INVALID;
            if (inResult.status === "dirty") {
                status.dirty();
                return {
                    status: "dirty",
                    value: inResult.value,
                };
            }
            else {
                return this._def.out._parseSync({
                    data: inResult.value,
                    path: ctx.path,
                    parent: ctx,
                });
            }
        }
    }
    static create(a, b) {
        return new ZodPipeline({
            in: a,
            out: b,
            typeName: ZodFirstPartyTypeKind.ZodPipeline,
        });
    }
}
class ZodReadonly extends ZodType {
    _parse(input) {
        const result = this._def.innerType._parse(input);
        const freeze = (data) => {
            if (isValid(data)) {
                data.value = Object.freeze(data.value);
            }
            return data;
        };
        return isAsync(result) ? result.then((data) => freeze(data)) : freeze(result);
    }
    unwrap() {
        return this._def.innerType;
    }
}
ZodReadonly.create = (type, params) => {
    return new ZodReadonly({
        innerType: type,
        typeName: ZodFirstPartyTypeKind.ZodReadonly,
        ...processCreateParams(params),
    });
};
var ZodFirstPartyTypeKind;
(function (ZodFirstPartyTypeKind) {
    ZodFirstPartyTypeKind["ZodString"] = "ZodString";
    ZodFirstPartyTypeKind["ZodNumber"] = "ZodNumber";
    ZodFirstPartyTypeKind["ZodNaN"] = "ZodNaN";
    ZodFirstPartyTypeKind["ZodBigInt"] = "ZodBigInt";
    ZodFirstPartyTypeKind["ZodBoolean"] = "ZodBoolean";
    ZodFirstPartyTypeKind["ZodDate"] = "ZodDate";
    ZodFirstPartyTypeKind["ZodSymbol"] = "ZodSymbol";
    ZodFirstPartyTypeKind["ZodUndefined"] = "ZodUndefined";
    ZodFirstPartyTypeKind["ZodNull"] = "ZodNull";
    ZodFirstPartyTypeKind["ZodAny"] = "ZodAny";
    ZodFirstPartyTypeKind["ZodUnknown"] = "ZodUnknown";
    ZodFirstPartyTypeKind["ZodNever"] = "ZodNever";
    ZodFirstPartyTypeKind["ZodVoid"] = "ZodVoid";
    ZodFirstPartyTypeKind["ZodArray"] = "ZodArray";
    ZodFirstPartyTypeKind["ZodObject"] = "ZodObject";
    ZodFirstPartyTypeKind["ZodUnion"] = "ZodUnion";
    ZodFirstPartyTypeKind["ZodDiscriminatedUnion"] = "ZodDiscriminatedUnion";
    ZodFirstPartyTypeKind["ZodIntersection"] = "ZodIntersection";
    ZodFirstPartyTypeKind["ZodTuple"] = "ZodTuple";
    ZodFirstPartyTypeKind["ZodRecord"] = "ZodRecord";
    ZodFirstPartyTypeKind["ZodMap"] = "ZodMap";
    ZodFirstPartyTypeKind["ZodSet"] = "ZodSet";
    ZodFirstPartyTypeKind["ZodFunction"] = "ZodFunction";
    ZodFirstPartyTypeKind["ZodLazy"] = "ZodLazy";
    ZodFirstPartyTypeKind["ZodLiteral"] = "ZodLiteral";
    ZodFirstPartyTypeKind["ZodEnum"] = "ZodEnum";
    ZodFirstPartyTypeKind["ZodEffects"] = "ZodEffects";
    ZodFirstPartyTypeKind["ZodNativeEnum"] = "ZodNativeEnum";
    ZodFirstPartyTypeKind["ZodOptional"] = "ZodOptional";
    ZodFirstPartyTypeKind["ZodNullable"] = "ZodNullable";
    ZodFirstPartyTypeKind["ZodDefault"] = "ZodDefault";
    ZodFirstPartyTypeKind["ZodCatch"] = "ZodCatch";
    ZodFirstPartyTypeKind["ZodPromise"] = "ZodPromise";
    ZodFirstPartyTypeKind["ZodBranded"] = "ZodBranded";
    ZodFirstPartyTypeKind["ZodPipeline"] = "ZodPipeline";
    ZodFirstPartyTypeKind["ZodReadonly"] = "ZodReadonly";
})(ZodFirstPartyTypeKind || (ZodFirstPartyTypeKind = {}));
const stringType = ZodString.create;
const numberType = ZodNumber.create;
const booleanType = ZodBoolean.create;
const unknownType = ZodUnknown.create;
ZodNever.create;
const arrayType = ZodArray.create;
const objectType = ZodObject.create;
const unionType = ZodUnion.create;
ZodIntersection.create;
ZodTuple.create;
const recordType = ZodRecord.create;
const lazyType = ZodLazy.create;
const literalType = ZodLiteral.create;
const enumType = ZodEnum.create;
ZodPromise.create;
ZodOptional.create;
ZodNullable.create;

/**
 * 契约 DSL 解析与校验（§7/§10.1，KaleidoCore 纯函数模块）。
 *
 * - parseContract(raw)：zod 校验 + 默认值填充 + 归一化（path-key 一致性、stability 推断）；失败抛错。
 * - validateContract(c)：返回错误列表（路径冲突 / 非法 scope / 不变量引用 / 依赖环 §0.2）。
 * - resolveContract(c, resolver)：骨架合并（extends ⊕ Σ mixins ⊕ 自身，§4.8），纯函数。
 *
 * 依赖：src/core/types.ts、src/core/path.ts、src/core/dependencies.ts（循环检测）。
 */
// ============================================================
// zod schema（§7 数据结构）
// ============================================================
const confidenceSchema = enumType(['high', 'medium', 'low']);
const updateModeSchema = enumType(['every_turn', 'fixed', 'every_n_turns', 'trigger']);
const fieldTypeSchema = enumType(['string', 'number', 'boolean', 'list', 'kv', 'object']);
const persistSchema = enumType(['chat', 'run', 'global']);
const stabilitySchema = enumType(['volatile', 'stable', 'frozen']);
const mergeRuleSchema = enumType(['last_write', 'sum', 'max', 'min', 'custom_fn_id']);
const ownershipSchema = objectType({
    owner: stringType().min(1),
    writers: arrayType(stringType().min(1)).optional(),
    priority: numberType().int().optional(),
    merge: mergeRuleSchema.optional(),
    audit: booleanType().optional(),
}).optional();
const capSchema = objectType({
    perTurn: numberType().int().nonnegative().optional(),
    perNTurns: numberType().int().positive().optional(),
}).optional();
const fieldDefSchema = objectType({
    path: stringType().min(1),
    type: fieldTypeSchema,
    default: unknownType().optional(),
    updateMode: updateModeSchema,
    everyN: numberType().int().positive().optional(),
    dynamic: booleanType().optional(),
    changeRule: stringType().max(4000).optional(),
    cap: capSchema,
    scope: arrayType(stringType().min(1)).optional(),
    ttl: numberType().int().nonnegative().optional(),
    persist: persistSchema.optional(),
    stability: stabilitySchema.optional(),
    display: booleanType(),
    dependencies: arrayType(stringType().min(1)).optional(),
    ownership: ownershipSchema,
});
const rangeSchema = objectType({ min: numberType().optional(), max: numberType().optional() }).optional();
const schemaNodeSchema = lazyType(() => objectType({
    type: fieldTypeSchema,
    enum: arrayType(unknownType()).optional(),
    range: rangeSchema,
    loose: booleanType().optional(),
    strict: booleanType().optional(),
    properties: recordType(stringType(), schemaNodeSchema).optional(),
    items: schemaNodeSchema.optional(),
}));
const guardrailsSchema = objectType({
    maxStatusTokens: numberType().int().positive().default(1500),
    maxOpsPerTurn: numberType().int().positive().default(20),
    minConfidence: confidenceSchema.default('medium'),
    maxRetries: numberType().int().nonnegative().default(1),
    maxSteps: numberType().int().nonnegative().default(0),
    maxTokensPerStep: numberType().int().positive().default(2048),
    maxDependencyDepth: numberType().int().nonnegative().default(3),
});
const invariantSchema = objectType({
    id: stringType().min(1),
    kind: enumType(['require_if', 'mutex', 'range']),
    paths: arrayType(stringType().min(1)).min(1),
    condition: stringType().optional(),
    message: stringType().min(1),
});
const displayRuleSchema = objectType({
    path: stringType().min(1),
    render: enumType(['value', 'hidden', 'summary']),
});
const skeletonRefSchema = objectType({
    ref: stringType().min(1),
    version: numberType().int().positive().optional(),
});
// ---- EJS/CES 规则（§17.8，M11）----
const predicateExprSchema = lazyType(() => unionType([
    objectType({
        var: stringType().min(1),
        op: enumType(['==', '!=', '>', '>=', '<', '<=', 'in', 'not_in', 'exists']),
        value: unknownType().optional(),
    }),
    objectType({ source: stringType().min(1), contains: stringType() }),
    objectType({ and: arrayType(predicateExprSchema).min(1) }),
    objectType({ or: arrayType(predicateExprSchema).min(1) }),
    objectType({ not: predicateExprSchema }),
]));
const ejsRuleSchema = objectType({
    id: stringType().min(1),
    condition: predicateExprSchema,
    entries: arrayType(objectType({ world: stringType().min(1), name: stringType().min(1) })).min(1),
    mode: enumType(['on_match', 'on_not_match']),
    entryPlacement: literalType('l3_tail'),
});
const achievementSchema = objectType({
    id: stringType().min(1),
    name: stringType().min(1),
    icon: stringType().optional(),
    desc: stringType().optional(),
    progressVar: stringType().min(1),
    target: numberType().positive(),
    unlocked: booleanType().default(false),
    unlockedAtRun: numberType().int().nullable().default(null),
    hidden: booleanType().optional(),
});
const runBoundarySchema = objectType({
    type: enumType(['story_end', 'manual', 'var_cond']),
    varCond: predicateExprSchema.optional(),
    message: stringType().optional(),
});
/** @since M13 记忆系统配置（§20；默认关闭） */
const memoryConfigSchema = objectType({
    enabled: booleanType(),
    reflectionEveryN: numberType().int().positive().optional(),
    maxAtoms: numberType().int().positive().optional(),
    injectTopK: numberType().int().positive().optional(),
    tables: arrayType(objectType({
        id: stringType().min(1),
        name: stringType().min(1),
        columns: arrayType(stringType().min(1)).min(1),
        floorScoped: booleanType().optional(),
    })).optional(),
    archiveThreshold: numberType().int().positive().optional(),
    archiveBatchSize: numberType().int().positive().optional(),
});
/** @since M15 剧情编排配置（§22；默认关闭） */
const plotConfigSchema = objectType({
    enabled: booleanType(),
    everyN: numberType().int().positive().optional(),
    diceModifier: numberType().min(-100).max(100).optional(),
    setbackRatio: numberType().min(0).max(1).optional(),
    winds: booleanType().optional(),
    regionalIncident: booleanType().optional(),
    worldConstraints: stringType().optional(),
});
/** @since M16 检定系统配置（§23；默认关闭） */
const diceConfigSchema = objectType({
    enabled: booleanType(),
});
const contractSchema = objectType({
    version: numberType().int().positive(),
    id: stringType().min(1),
    schema: schemaNodeSchema,
    updateRules: recordType(stringType().min(1), fieldDefSchema),
    displayRules: arrayType(displayRuleSchema).default([]),
    guardrails: guardrailsSchema.default({}),
    invariants: arrayType(invariantSchema).default([]),
    // —— 以下 @since 各里程碑，MVP 阶段可缺失、填默认空（§7 MVPContract） ——
    achievements: arrayType(achievementSchema).optional(),
    ejs: arrayType(ejsRuleSchema).optional(),
    runBoundary: runBoundarySchema.optional(),
    derived: recordType(stringType(), unknownType()).optional(),
    sideEffects: arrayType(unknownType()).optional(),
    middleware: arrayType(unknownType()).optional(),
    extends: skeletonRefSchema.optional(),
    mixins: arrayType(stringType().min(1)).optional(),
    memory: memoryConfigSchema.optional(),
    plot: plotConfigSchema.optional(),
    dice: diceConfigSchema.optional(),
});
/** parseContract 失败抛出的错误类型 */
class ContractError extends Error {
    issues;
    constructor(message, issues = []) {
        super(message);
        this.name = 'ContractError';
        this.issues = issues;
    }
}
/**
 * 解析契约原文 → 归一化 Contract。
 * 归一化动作：updateRules 键与 FieldDef.path 一致性；stability 按 classifyField 推断（§7 注）。
 */
function parseContract(raw, _opts) {
    const result = contractSchema.safeParse(raw);
    if (!result.success) {
        const issues = result.error.issues.map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`);
        throw new ContractError(`契约校验失败：${issues[0]}${issues.length > 1 ? `（另有 ${issues.length - 1} 处问题）` : ''}`, issues);
    }
    // zod 形状校验通过；可选里程碑字段在 schema 中为 unknown[]，契约语义上等价于对应类型数组
    const contract = result.data;
    // 归一化 1：updateRules 键与 FieldDef.path 一致
    for (const [key, field] of Object.entries(contract.updateRules)) {
        if (field.path !== key) {
            throw new ContractError(`updateRules 键 '${key}' 与 FieldDef.path '${field.path}' 不一致`);
        }
    }
    return normalizeContract(contract);
}
/**
 * 契约归一化（幂等）：stability 缺省按 classifyField 推断（§7 注）；
 * ownership 缺省按 §4.7 默认行为填充（owner:'agent'、writers:['agent','manual']、priority:0、
 * merge:'last_write'、audit:true）。parseContract 与 resolveContract 均调用。
 */
function normalizeContract(c) {
    for (const field of Object.values(c.updateRules)) {
        if (!field.stability) {
            field.stability = inferStability(field);
        }
        field.ownership = {
            owner: field.ownership?.owner ?? 'agent',
            writers: field.ownership?.writers ?? ['agent', 'manual'],
            priority: field.ownership?.priority ?? 0,
            merge: field.ownership?.merge ?? 'last_write',
            audit: field.ownership?.audit ?? true,
        };
    }
    return c;
}
/** stability 推断：static→stable、lowfreq→stable、dynamic→volatile（§7 组合矩阵默认落点） */
function inferStability(field) {
    if (field.updateMode === 'fixed')
        return 'stable';
    if (field.updateMode === 'every_turn' && field.dynamic !== false)
        return 'volatile';
    return 'stable';
}
/**
 * 校验契约，返回错误列表（空数组 = 合法）。
 * 覆盖：路径命名/冲突、updateMode 一致性、displayRules/invariants 引用、
 * 依赖图循环（§0.2 拓扑序拒绝）、scope/ttl 合法性。
 */
function validateContract(c, opts) {
    const errors = [];
    const paths = Object.keys(c.updateRules);
    // 1. 路径命名与冲突
    const seen = new Set();
    for (const field of Object.values(c.updateRules)) {
        if (seen.has(field.path)) {
            errors.push(`路径重复声明：${field.path}`);
            continue;
        }
        seen.add(field.path);
        const nameError = validateFieldPath(field.path);
        if (nameError)
            errors.push(`路径非法（${field.path}）：${nameError}`);
    }
    // 2. updateMode 一致性
    for (const field of Object.values(c.updateRules)) {
        if (field.updateMode === 'every_n_turns' && !field.everyN) {
            errors.push(`字段 ${field.path}：updateMode=every_n_turns 必须提供 everyN ≥ 1`);
        }
        if (field.updateMode !== 'every_n_turns' && field.everyN != null) {
            errors.push(`字段 ${field.path}：everyN 仅在 every_n_turns 模式下有效`);
        }
        if (field.updateMode === 'fixed' && field.dynamic === true) {
            errors.push(`字段 ${field.path}：fixed 字段不能声明 dynamic:true`);
        }
        if (field.ttl != null && field.ttl < 0) {
            errors.push(`字段 ${field.path}：ttl 必须 ≥ 0`);
        }
        if (field.scope && field.scope.some((s) => !s.trim())) {
            errors.push(`字段 ${field.path}：scope 数组含空字符串`);
        }
        for (const dep of field.dependencies ?? []) {
            if (!paths.includes(dep)) {
                errors.push(`字段 ${field.path}：显式依赖引用了未声明路径 '${dep}'`);
            }
        }
        // 3. ownership：custom_fn_id 需白名单注册（提供 registry 时校验）
        if (field.ownership?.merge === 'custom_fn_id' && opts?.registry) ;
    }
    // 4. displayRules 引用
    for (const rule of c.displayRules) {
        if (!paths.includes(rule.path)) {
            errors.push(`displayRules 引用了未声明路径：${rule.path}`);
        }
    }
    // 5. invariants 引用与结构
    for (const inv of c.invariants) {
        for (const path of inv.paths) {
            if (!paths.includes(path)) {
                errors.push(`invariant '${inv.id}' 引用了未声明路径：${path}`);
            }
        }
        if (inv.kind === 'mutex' && inv.paths.length < 2) {
            errors.push(`invariant '${inv.id}'：mutex 至少需要 2 个路径`);
        }
        if (inv.kind === 'require_if' && !inv.condition) {
            errors.push(`invariant '${inv.id}'：require_if 必须提供 condition`);
        }
        if (inv.kind === 'range' && inv.paths.length !== 1) {
            errors.push(`invariant '${inv.id}'：range 恰好需要 1 个路径`);
        }
    }
    // 6. 依赖图循环检测（§0.2：拓扑序拒绝，指明环路径）
    try {
        const adjacency = buildAdjacency(c);
        const cycle = topologicalCyclePath(adjacency, paths);
        if (cycle) {
            errors.push(`dependencies cycle: ${cycle.join('→')}`);
        }
    }
    catch (error) {
        if (error instanceof DependencyCycleError) {
            errors.push(error.message);
        }
        else {
            errors.push(`依赖图计算失败：${error instanceof Error ? error.message : String(error)}`);
        }
    }
    return errors;
}

const NL_EVENTS = Object.freeze({
    STATUS_CHANGED: 'nlkaleido:status_changed',
    PENDING_UPDATED: 'nlkaleido:pending_updated',
    METRICS: 'nlkaleido:metrics',
    CONTRACT_CHANGED: 'nlkaleido:contract_changed',
    COMPAT: 'nlkaleido:compat',
    EJS_CHANGED: 'nlkaleido:ejs_changed',
    RUN_CHANGED: 'nlkaleido:run_changed',
    ACHIEVEMENT_UNLOCKED: 'nlkaleido:achievement_unlocked',
    MEMORY_CHANGED: 'nlkaleido:memory_changed',
    PLOT_CHANGED: 'nlkaleido:plot_changed',
    DICE_ROLLED: 'nlkaleido:dice_rolled',
    CONFIG_CHANGED: 'nlkaleido:config_changed',
});
class KaleidoStateBridge {
    globals;
    adapter;
    constructor(globals, adapter) {
        this.globals = globals;
        this.adapter = adapter;
    }
    /** 转发引擎状态变化（面板订阅 nlkaleido:* 刷新，§6.4 事件驱动不轮询） */
    notifyStatusChanged(state) {
        this.emit(NL_EVENTS.STATUS_CHANGED, {
            stat_data: state.stat_data,
            pending: state.meta.pending,
            revision: state.revision,
            lastTurnId: state.meta.lastTurnId,
            persistError: this.adapter.commit.lastError, // §17.14-S1 落盘失败上浮（shujuku 审计）
        });
    }
    notifyPendingUpdated(state) {
        this.emit(NL_EVENTS.PENDING_UPDATED, state.meta.pending);
    }
    notifyContractChanged(contractVersion) {
        this.emit(NL_EVENTS.CONTRACT_CHANGED, { contractVersion });
    }
    notifyRunChanged(runId, message) {
        this.emit(NL_EVENTS.RUN_CHANGED, { runId, message });
    }
    notifyAchievementUnlocked(achievements) {
        this.emit(NL_EVENTS.ACHIEVEMENT_UNLOCKED, achievements);
    }
    /** @since M13 记忆变化（面板 nlkaleido:memory_changed 刷新，§20.10） */
    notifyMemoryChanged() {
        this.emit(NL_EVENTS.MEMORY_CHANGED, {
            atoms: this.adapter.adapter.memoryStore.atoms.length,
            tables: this.adapter.adapter.memoryTables.length,
        });
    }
    /** @since M15 剧情变化（面板 nlkaleido:plot_changed 刷新，§22.6） */
    notifyPlotChanged() {
        this.emit(NL_EVENTS.PLOT_CHANGED, {
            events: this.adapter.adapter.plotEvents.length,
            winds: this.adapter.adapter.plotWinds.length,
        });
    }
    /** @since M16 检定完成（面板 nlkaleido:dice_rolled 刷新，§23.7） */
    notifyDiceRolled(result) {
        this.emit(NL_EVENTS.DICE_ROLLED, result);
    }
    /** @since M14 配置变化（面板 nlkaleido:config_changed 刷新，§20.13.7） */
    notifyConfigChanged() {
        this.emit(NL_EVENTS.CONFIG_CHANGED, this.adapter.adapter.config);
    }
    notifyMetrics(metrics) {
        this.emit(NL_EVENTS.METRICS, metrics);
    }
    notifyCompat(compat) {
        this.emit(NL_EVENTS.COMPAT, compat);
    }
    /**
     * 面板 → Core 单写入口（§10.4 dispatch / §17.14-S1）。
     * - setVariable：面板编辑变量值（manual 特权路径，§4.6 只写 stat_data）。
     * - editContract：契约保存 → contractVersion+1 + 校验（§6.5 前缀失效由适配层处理）。
     * - resolvePending：accept 走 applyOps / discard 丢弃（§9.1）。
     * - rollback：按 seq 单条回滚（§4.4）。
     */
    dispatch(payload) {
        const state = this.adapter.adapter.state;
        if (!state)
            return { ok: false, error: '状态未加载' };
        switch (payload.action) {
            case 'setVariable': {
                const path = String(payload.path ?? '');
                if (!path)
                    return { ok: false, error: '缺少 path' };
                const contract = this.adapter.adapter.contract;
                if (!contract?.updateRules[path])
                    return { ok: false, error: `路径未声明：${path}` };
                writeValue(state, path, payload.value);
                void this.adapter.persistState(state).then(() => this.notifyStatusChanged(state));
                return { ok: true };
            }
            case 'editContract': {
                try {
                    const raw = payload.contract;
                    const parsed = parseContract(raw);
                    const resolved = normalizeContract(parsed);
                    const errors = validateContract(resolved);
                    if (errors.length)
                        return { ok: false, error: errors.join('；') };
                    this.adapter.adapter.contract = resolved;
                    state.contractVersion = resolved.version;
                    this.notifyContractChanged(resolved.version);
                    return { ok: true };
                }
                catch (error) {
                    return { ok: false, error: error instanceof Error ? error.message : String(error) };
                }
            }
            case 'resolvePending': {
                const { resolvePending } = this;
                return resolvePending(String(payload.id ?? ''), payload.accept === true ? 'accept' : 'discard');
            }
            case 'rollback': {
                const seq = Number(payload.seq);
                if (!Number.isFinite(seq))
                    return { ok: false, error: '缺少 seq' };
                const result = rollbackEntry(state, seq);
                if (!result.ok)
                    return result;
                void this.adapter.persistState(state).then(() => this.notifyStatusChanged(state));
                return { ok: true };
            }
            case 'beginNewRun': {
                const contract = this.adapter.adapter.contract;
                if (!contract)
                    return { ok: false, error: '契约未加载' };
                const newRunId = state.meta.runId + 1;
                beginNewRun(state, contract, newRunId);
                this.adapter.resetChatMemory(); // §16.1：chat 层记忆随周目重置
                this.adapter.resetChatPlot(); // §22.7：世界推演随周目重开
                void this.adapter.persistState(state).then(() => {
                    this.notifyStatusChanged(state);
                    this.notifyRunChanged(newRunId);
                });
                return { ok: true };
            }
            // —— @since M15 剧情面板手动干预（§22.6：手动推进 / 停滞 / 终局）——
            case 'plotAdvance':
            case 'plotStall':
            case 'plotTerminal': {
                const eventId = String(payload.eventId ?? '');
                const events = this.adapter.adapter.plotEvents;
                const event = events.find((e) => e.id === eventId);
                if (!event)
                    return { ok: false, error: `事件不存在：${eventId}` };
                if (payload.action === 'plotStall') {
                    event.stall = !event.stall; // 停滞切换（完全交给作者/AI 控制）
                }
                else if (payload.action === 'plotTerminal') {
                    const stage = String(payload.stage ?? '');
                    // 终局干预：作者显式判定（正面/负面终局都允许，§22.6）
                    event.stage = stage;
                    event.stageRound = 9;
                }
                else {
                    const contract = this.adapter.adapter.contract;
                    const outcome = rollEventDice(event, {
                        modifier: contract?.plot?.diceModifier,
                        setbackRatio: contract?.plot?.setbackRatio,
                        dice: 100, // 手动推进：直接成功
                    });
                    Object.assign(event, outcome.event);
                }
                void this.adapter.persistPlotState().then(() => this.notifyPlotChanged());
                return { ok: true };
            }
            // —— @since M13 记忆面板动作（§20.10 手动管理）——
            case 'memoryForget':
            case 'memoryRevive':
            case 'memoryDelete': {
                const id = String(payload.atomId ?? '');
                const atoms = this.adapter.adapter.memoryStore.atoms;
                const index = atoms.findIndex((atom) => atom.id === id);
                if (index < 0)
                    return { ok: false, error: `记忆原子不存在：${id}` };
                if (payload.action === 'memoryDelete') {
                    atoms.splice(index, 1);
                }
                else {
                    atoms[index].status = payload.action === 'memoryForget' ? 'forgotten' : 'active';
                    if (payload.action === 'memoryRevive') {
                        atoms[index].expiresAt = Date.now() + atoms[index].ttlDays * 86400000;
                    }
                }
                void this.adapter.persistState(state).then(() => this.notifyMemoryChanged());
                return { ok: true };
            }
            case 'memoryArchiveNow': {
                const contract = this.adapter.adapter.contract;
                if (!contract)
                    return { ok: false, error: '契约未加载' };
                void this.adapter.archiveChangelog(contract);
                return { ok: true };
            }
            case 'memorySearch': {
                const query = String(payload.query ?? '');
                if (!query)
                    return { ok: false, error: '缺少 query' };
                return { ok: true, result: this.adapter.searchMemoryText(query, Number(payload.topK ?? 5)) };
            }
            // —— @since M16 检定面板（§23.7：点击才执行，不自动改状态）——
            case 'diceRoll':
                return this.adapter.executeDiceRoll(String(payload.formula ?? ''));
            case 'diceCheck':
                return this.adapter.executeDiceCheck(payload);
            case 'diceContest':
                return this.adapter.executeDiceContest(payload);
            case 'diceSuggestion':
                return this.adapter.executeDiceSuggestion(String(payload.line ?? ''));
            case 'diceImportPreset':
                return this.adapter.importDicePreset(payload.preset);
            // —— @since M14 配置中心（§20.13：档位切换 / 回滚 / 恢复出厂；结果经 CONFIG_CHANGED 事件回面板）——
            case 'configApplyTier': {
                const tier = payload.tier;
                if (!['minimal', 'standard', 'advanced'].includes(tier))
                    return { ok: false, error: `未知档位：${String(payload.tier)}` };
                void this.adapter.applyTier(tier).then((result) => {
                    this.adapter.adapter.lastConfigReport = result.ok
                        ? { ok: true, degradations: result.decision?.degradations ?? [], warnings: result.decision?.warnings ?? [], checks: result.checks ?? [] }
                        : { ok: false, error: result.error, degradations: [], warnings: [], checks: [] };
                    this.notifyConfigChanged();
                });
                return { ok: true };
            }
            case 'configRollback':
                void this.adapter.rollbackConfig().then(() => this.notifyConfigChanged());
                return { ok: true };
            case 'configFactoryReset':
                if (payload.confirmed !== true)
                    return { ok: false, error: '恢复出厂为破坏性操作：需二次确认（confirmed:true）' };
                void this.adapter.factoryResetConfig().then(() => this.notifyConfigChanged());
                return { ok: true };
            case 'configSave':
                void this.adapter.saveConfig(payload.config).then(() => this.notifyConfigChanged());
                return { ok: true };
            default:
                return { ok: false, error: `未知 action：${String(payload.action)}` };
        }
    }
    resolvePending(id, action) {
        const state = this.adapter.adapter.state;
        if (!state)
            return { ok: false, error: '状态未加载' };
        const index = state.meta.pending.findIndex((p) => p.id === id);
        if (index < 0)
            return { ok: false, error: `pending 不存在：${id}` };
        const [item] = state.meta.pending.splice(index, 1);
        if (action === 'accept') {
            const contract = this.adapter.adapter.contract;
            if (contract) {
                const { applied, rejected } = validateOps(contract, state, [item.op], state.meta.lastTurnId, { source: 'manual' });
                if (rejected.length)
                    return { ok: false, error: `accept 被拒：${rejected[0].reason}` };
                applyOps(state, applied, state.meta.lastTurnId, { source: 'manual' });
            }
        }
        void this.adapter.persistState(state).then(() => this.notifyStatusChanged(state));
        return { ok: true };
    }
    emit(event, payload) {
        const context = this.globals.getContext();
        context.eventSource?.emit(event, payload);
    }
}

/**
* @vue/shared v3.5.41
* (c) 2018-present Yuxi (Evan) You and Vue contributors
* @license MIT
**/
// @__NO_SIDE_EFFECTS__
function makeMap(str) {
  const map = /* @__PURE__ */ Object.create(null);
  for (const key of str.split(",")) map[key] = 1;
  return (val) => val in map;
}

const EMPTY_OBJ = {};
const EMPTY_ARR = [];
const NOOP = () => {
};
const NO = () => false;
const isOn = (key) => key.charCodeAt(0) === 111 && key.charCodeAt(1) === 110 && // uppercase letter
(key.charCodeAt(2) > 122 || key.charCodeAt(2) < 97);
const isModelListener = (key) => key.startsWith("onUpdate:");
const extend = Object.assign;
const remove = (arr, el) => {
  const i = arr.indexOf(el);
  if (i > -1) {
    arr.splice(i, 1);
  }
};
const hasOwnProperty$1 = Object.prototype.hasOwnProperty;
const hasOwn = (val, key) => hasOwnProperty$1.call(val, key);
const isArray$1 = Array.isArray;
const isMap$1 = (val) => toTypeString(val) === "[object Map]";
const isSet$1 = (val) => toTypeString(val) === "[object Set]";
const isDate$1 = (val) => toTypeString(val) === "[object Date]";
const isFunction = (val) => typeof val === "function";
const isString$1 = (val) => typeof val === "string";
const isSymbol$1 = (val) => typeof val === "symbol";
const isObject = (val) => val !== null && typeof val === "object";
const isPromise = (val) => {
  return (isObject(val) || isFunction(val)) && isFunction(val.then) && isFunction(val.catch);
};
const objectToString = Object.prototype.toString;
const toTypeString = (value) => objectToString.call(value);
const toRawType = (value) => {
  return toTypeString(value).slice(8, -1);
};
const isPlainObject$1 = (val) => toTypeString(val) === "[object Object]";
const isIntegerKey = (key) => isString$1(key) && key !== "NaN" && key[0] !== "-" && "" + parseInt(key, 10) === key;
const isReservedProp = /* @__PURE__ */ makeMap(
  // the leading comma is intentional so empty string "" is also included
  ",key,ref,ref_for,ref_key,onVnodeBeforeMount,onVnodeMounted,onVnodeBeforeUpdate,onVnodeUpdated,onVnodeBeforeUnmount,onVnodeUnmounted"
);
const cacheStringFunction = (fn) => {
  const cache = /* @__PURE__ */ Object.create(null);
  return ((str) => {
    const hit = cache[str];
    return hit || (cache[str] = fn(str));
  });
};
const camelizeRE = /-\w/g;
const camelize = cacheStringFunction(
  (str) => {
    return str.replace(camelizeRE, (c) => c.slice(1).toUpperCase());
  }
);
const hyphenateRE = /\B([A-Z])/g;
const hyphenate = cacheStringFunction(
  (str) => str.replace(hyphenateRE, "-$1").toLowerCase()
);
const capitalize = cacheStringFunction((str) => {
  return str.charAt(0).toUpperCase() + str.slice(1);
});
const toHandlerKey = cacheStringFunction(
  (str) => {
    const s = str ? `on${capitalize(str)}` : ``;
    return s;
  }
);
const hasChanged = (value, oldValue) => !Object.is(value, oldValue);
const invokeArrayFns = (fns, ...arg) => {
  for (let i = 0; i < fns.length; i++) {
    fns[i](...arg);
  }
};
const def = (obj, key, value, writable = false) => {
  Object.defineProperty(obj, key, {
    configurable: true,
    enumerable: false,
    writable,
    value
  });
};
const looseToNumber = (val) => {
  const n = parseFloat(val);
  return isNaN(n) ? val : n;
};
let _globalThis;
const getGlobalThis = () => {
  return _globalThis || (_globalThis = typeof globalThis !== "undefined" ? globalThis : typeof self !== "undefined" ? self : typeof window !== "undefined" ? window : typeof global !== "undefined" ? global : {});
};

function normalizeStyle(value) {
  if (isArray$1(value)) {
    const res = {};
    for (let i = 0; i < value.length; i++) {
      const item = value[i];
      const normalized = isString$1(item) ? parseStringStyle(item) : normalizeStyle(item);
      if (normalized) {
        for (const key in normalized) {
          res[key] = normalized[key];
        }
      }
    }
    return res;
  } else if (isString$1(value) || isObject(value)) {
    return value;
  }
}
const listDelimiterRE = /;(?![^(]*\))/g;
const propertyDelimiterRE = /:([^]+)/;
const styleCommentRE = /\/\*[^]*?\*\//g;
function parseStringStyle(cssText) {
  const ret = {};
  cssText.replace(styleCommentRE, "").split(listDelimiterRE).forEach((item) => {
    if (item) {
      const tmp = item.split(propertyDelimiterRE);
      tmp.length > 1 && (ret[tmp[0].trim()] = tmp[1].trim());
    }
  });
  return ret;
}
function normalizeClass(value) {
  let res = "";
  if (isString$1(value)) {
    res = value;
  } else if (isArray$1(value)) {
    for (let i = 0; i < value.length; i++) {
      const normalized = normalizeClass(value[i]);
      if (normalized) {
        res += normalized + " ";
      }
    }
  } else if (isObject(value)) {
    for (const name in value) {
      if (value[name]) {
        res += name + " ";
      }
    }
  }
  return res.trim();
}

const specialBooleanAttrs = `itemscope,allowfullscreen,formnovalidate,ismap,nomodule,novalidate,readonly`;
const isSpecialBooleanAttr = /* @__PURE__ */ makeMap(specialBooleanAttrs);
function includeBooleanAttr(value) {
  return !!value || value === "";
}

function looseCompareArrays(a, b) {
  if (a.length !== b.length) return false;
  let equal = true;
  for (let i = 0; equal && i < a.length; i++) {
    equal = looseEqual(a[i], b[i]);
  }
  return equal;
}
function looseEqual(a, b) {
  if (a === b) return true;
  let aValidType = isDate$1(a);
  let bValidType = isDate$1(b);
  if (aValidType || bValidType) {
    return aValidType && bValidType ? a.getTime() === b.getTime() : false;
  }
  aValidType = isSymbol$1(a);
  bValidType = isSymbol$1(b);
  if (aValidType || bValidType) {
    return a === b;
  }
  aValidType = isArray$1(a);
  bValidType = isArray$1(b);
  if (aValidType || bValidType) {
    return aValidType && bValidType ? looseCompareArrays(a, b) : false;
  }
  aValidType = isObject(a);
  bValidType = isObject(b);
  if (aValidType || bValidType) {
    if (!aValidType || !bValidType) {
      return false;
    }
    const aKeysCount = Object.keys(a).length;
    const bKeysCount = Object.keys(b).length;
    if (aKeysCount !== bKeysCount) {
      return false;
    }
    for (const key in a) {
      const aHasKey = a.hasOwnProperty(key);
      const bHasKey = b.hasOwnProperty(key);
      if (aHasKey && !bHasKey || !aHasKey && bHasKey || !looseEqual(a[key], b[key])) {
        return false;
      }
    }
  }
  return String(a) === String(b);
}

/**
* @vue/reactivity v3.5.41
* (c) 2018-present Yuxi (Evan) You and Vue contributors
* @license MIT
**/

let activeEffectScope;
class EffectScope {
  // TODO isolatedDeclarations "__v_skip"
  constructor(detached = false) {
    this.detached = detached;
    /**
     * @internal
     */
    this._active = true;
    /**
     * @internal track `on` calls, allow `on` call multiple times
     */
    this._on = 0;
    /**
     * @internal
     */
    this.effects = [];
    /**
     * @internal
     */
    this.cleanups = [];
    this._isPaused = false;
    this._warnOnRun = true;
    this.__v_skip = true;
    if (!detached && activeEffectScope) {
      if (activeEffectScope.active) {
        this.parent = activeEffectScope;
        this.index = (activeEffectScope.scopes || (activeEffectScope.scopes = [])).push(
          this
        ) - 1;
      } else {
        this._active = false;
        this._warnOnRun = false;
      }
    }
  }
  get active() {
    return this._active;
  }
  pause() {
    if (this._active) {
      this._isPaused = true;
      let i, l;
      if (this.scopes) {
        const scopes = this.scopes.slice();
        for (i = 0, l = scopes.length; i < l; i++) {
          scopes[i].pause();
        }
      }
      for (i = 0, l = this.effects.length; i < l; i++) {
        this.effects[i].pause();
      }
    }
  }
  /**
   * Resumes the effect scope, including all child scopes and effects.
   */
  resume() {
    if (this._active) {
      if (this._isPaused) {
        this._isPaused = false;
        let i, l;
        if (this.scopes) {
          const scopes = this.scopes.slice();
          for (i = 0, l = scopes.length; i < l; i++) {
            scopes[i].resume();
          }
        }
        const effects = this.effects.slice();
        for (i = 0, l = effects.length; i < l; i++) {
          effects[i].resume();
        }
      }
    }
  }
  run(fn) {
    if (this._active) {
      const currentEffectScope = activeEffectScope;
      try {
        activeEffectScope = this;
        return fn();
      } finally {
        activeEffectScope = currentEffectScope;
      }
    }
  }
  /**
   * This should only be called on non-detached scopes
   * @internal
   */
  on() {
    if (++this._on === 1) {
      this.prevScope = activeEffectScope;
      activeEffectScope = this;
    }
  }
  /**
   * This should only be called on non-detached scopes
   * @internal
   */
  off() {
    if (this._on > 0 && --this._on === 0) {
      if (activeEffectScope === this) {
        activeEffectScope = this.prevScope;
      } else {
        let current = activeEffectScope;
        while (current) {
          if (current.prevScope === this) {
            current.prevScope = this.prevScope;
            break;
          }
          current = current.prevScope;
        }
      }
      this.prevScope = void 0;
    }
  }
  stop(fromParent) {
    if (this._active) {
      this._active = false;
      let i, l;
      for (i = 0, l = this.effects.length; i < l; i++) {
        this.effects[i].stop();
      }
      this.effects.length = 0;
      for (i = 0, l = this.cleanups.length; i < l; i++) {
        this.cleanups[i]();
      }
      this.cleanups.length = 0;
      if (this.scopes) {
        const scopes = this.scopes.slice();
        for (i = 0, l = scopes.length; i < l; i++) {
          scopes[i].stop(true);
        }
        this.scopes.length = 0;
      }
      if (!this.detached && this.parent && !fromParent) {
        const last = this.parent.scopes.pop();
        if (last && last !== this) {
          this.parent.scopes[this.index] = last;
          last.index = this.index;
        }
      }
      this.parent = void 0;
    }
  }
}
function effectScope(detached) {
  return new EffectScope(detached);
}
function getCurrentScope() {
  return activeEffectScope;
}
function onScopeDispose(fn, failSilently = false) {
  if (activeEffectScope) {
    activeEffectScope.cleanups.push(fn);
  }
}

let activeSub;
const pausedQueueEffects = /* @__PURE__ */ new WeakSet();
class ReactiveEffect {
  constructor(fn) {
    this.fn = fn;
    /**
     * @internal
     */
    this.deps = void 0;
    /**
     * @internal
     */
    this.depsTail = void 0;
    /**
     * @internal
     */
    this.flags = 1 | 4;
    /**
     * @internal
     */
    this.next = void 0;
    /**
     * @internal
     */
    this.cleanup = void 0;
    this.scheduler = void 0;
    if (activeEffectScope) {
      if (activeEffectScope.active) {
        activeEffectScope.effects.push(this);
      } else {
        this.flags &= -2;
      }
    }
  }
  pause() {
    this.flags |= 64;
  }
  resume() {
    if (this.flags & 64) {
      this.flags &= -65;
      if (pausedQueueEffects.has(this)) {
        pausedQueueEffects.delete(this);
        this.trigger();
      }
    }
  }
  /**
   * @internal
   */
  notify() {
    if (this.flags & 2 && !(this.flags & 32)) {
      return;
    }
    if (!(this.flags & 8)) {
      batch(this);
    }
  }
  run() {
    if (!(this.flags & 1)) {
      return this.fn();
    }
    this.flags |= 2;
    cleanupEffect(this);
    prepareDeps(this);
    const prevEffect = activeSub;
    const prevShouldTrack = shouldTrack;
    activeSub = this;
    shouldTrack = true;
    try {
      return this.fn();
    } finally {
      cleanupDeps(this);
      activeSub = prevEffect;
      shouldTrack = prevShouldTrack;
      this.flags &= -3;
    }
  }
  stop() {
    if (this.flags & 1) {
      for (let link = this.deps; link; link = link.nextDep) {
        removeSub(link);
      }
      this.deps = this.depsTail = void 0;
      cleanupEffect(this);
      this.onStop && this.onStop();
      this.flags &= -2;
    }
  }
  trigger() {
    if (this.flags & 64) {
      pausedQueueEffects.add(this);
    } else if (this.scheduler) {
      this.scheduler();
    } else {
      this.runIfDirty();
    }
  }
  /**
   * @internal
   */
  runIfDirty() {
    if (isDirty(this)) {
      this.run();
    }
  }
  get dirty() {
    return isDirty(this);
  }
}
let batchDepth = 0;
let batchedSub;
let batchedComputed;
function batch(sub, isComputed = false) {
  sub.flags |= 8;
  if (isComputed) {
    sub.next = batchedComputed;
    batchedComputed = sub;
    return;
  }
  sub.next = batchedSub;
  batchedSub = sub;
}
function startBatch() {
  batchDepth++;
}
function endBatch() {
  if (--batchDepth > 0) {
    return;
  }
  if (batchedComputed) {
    let e = batchedComputed;
    batchedComputed = void 0;
    while (e) {
      const next = e.next;
      e.next = void 0;
      e.flags &= -9;
      e = next;
    }
  }
  let error;
  while (batchedSub) {
    let e = batchedSub;
    batchedSub = void 0;
    while (e) {
      const next = e.next;
      e.next = void 0;
      e.flags &= -9;
      if (e.flags & 1) {
        try {
          ;
          e.trigger();
        } catch (err) {
          if (!error) error = err;
        }
      }
      e = next;
    }
  }
  if (error) throw error;
}
function prepareDeps(sub) {
  for (let link = sub.deps; link; link = link.nextDep) {
    link.version = -1;
    link.prevActiveLink = link.dep.activeLink;
    link.dep.activeLink = link;
  }
}
function cleanupDeps(sub) {
  let head;
  let tail = sub.depsTail;
  let link = tail;
  while (link) {
    const prev = link.prevDep;
    if (link.version === -1) {
      if (link === tail) tail = prev;
      removeSub(link);
      removeDep(link);
    } else {
      head = link;
    }
    link.dep.activeLink = link.prevActiveLink;
    link.prevActiveLink = void 0;
    link = prev;
  }
  sub.deps = head;
  sub.depsTail = tail;
}
function isDirty(sub) {
  for (let link = sub.deps; link; link = link.nextDep) {
    if (link.dep.version !== link.version || link.dep.computed && (refreshComputed(link.dep.computed) || link.dep.version !== link.version)) {
      return true;
    }
  }
  if (sub._dirty) {
    return true;
  }
  return false;
}
function refreshComputed(computed) {
  if (computed.flags & 4 && !(computed.flags & 16)) {
    return;
  }
  computed.flags &= -17;
  if (computed.globalVersion === globalVersion) {
    return;
  }
  computed.globalVersion = globalVersion;
  if (!computed.isSSR && computed.flags & 128 && (!computed.deps && !computed._dirty || !isDirty(computed))) {
    return;
  }
  computed.flags |= 2;
  const dep = computed.dep;
  const prevSub = activeSub;
  const prevShouldTrack = shouldTrack;
  activeSub = computed;
  shouldTrack = true;
  try {
    prepareDeps(computed);
    const value = computed.fn(computed._value);
    if (dep.version === 0 || hasChanged(value, computed._value)) {
      computed.flags |= 128;
      computed._value = value;
      dep.version++;
    }
  } catch (err) {
    dep.version++;
    throw err;
  } finally {
    activeSub = prevSub;
    shouldTrack = prevShouldTrack;
    cleanupDeps(computed);
    computed.flags &= -3;
  }
}
function removeSub(link, soft = false) {
  const { dep, prevSub, nextSub } = link;
  if (prevSub) {
    prevSub.nextSub = nextSub;
    link.prevSub = void 0;
  }
  if (nextSub) {
    nextSub.prevSub = prevSub;
    link.nextSub = void 0;
  }
  if (dep.subs === link) {
    dep.subs = prevSub;
    if (!prevSub && dep.computed) {
      dep.computed.flags &= -5;
      for (let l = dep.computed.deps; l; l = l.nextDep) {
        removeSub(l, true);
      }
    }
  }
  if (!soft && !--dep.sc && dep.map) {
    dep.map.delete(dep.key);
  }
}
function removeDep(link) {
  const { prevDep, nextDep } = link;
  if (prevDep) {
    prevDep.nextDep = nextDep;
    link.prevDep = void 0;
  }
  if (nextDep) {
    nextDep.prevDep = prevDep;
    link.nextDep = void 0;
  }
}
let shouldTrack = true;
const trackStack = [];
function pauseTracking() {
  trackStack.push(shouldTrack);
  shouldTrack = false;
}
function resetTracking() {
  const last = trackStack.pop();
  shouldTrack = last === void 0 ? true : last;
}
function cleanupEffect(e) {
  const { cleanup } = e;
  e.cleanup = void 0;
  if (cleanup) {
    const prevSub = activeSub;
    activeSub = void 0;
    try {
      cleanup();
    } finally {
      activeSub = prevSub;
    }
  }
}

let globalVersion = 0;
class Link {
  constructor(sub, dep) {
    this.sub = sub;
    this.dep = dep;
    this.version = dep.version;
    this.nextDep = this.prevDep = this.nextSub = this.prevSub = this.prevActiveLink = void 0;
  }
}
class Dep {
  // TODO isolatedDeclarations "__v_skip"
  constructor(computed) {
    this.computed = computed;
    this.version = 0;
    /**
     * Link between this dep and the current active effect
     */
    this.activeLink = void 0;
    /**
     * Doubly linked list representing the subscribing effects (tail)
     */
    this.subs = void 0;
    /**
     * For object property deps cleanup
     */
    this.map = void 0;
    this.key = void 0;
    /**
     * Subscriber counter
     */
    this.sc = 0;
    /**
     * @internal
     */
    this.__v_skip = true;
  }
  track(debugInfo) {
    if (!activeSub || !shouldTrack || activeSub === this.computed) {
      return;
    }
    let link = this.activeLink;
    if (link === void 0 || link.sub !== activeSub) {
      link = this.activeLink = new Link(activeSub, this);
      if (!activeSub.deps) {
        activeSub.deps = activeSub.depsTail = link;
      } else {
        link.prevDep = activeSub.depsTail;
        activeSub.depsTail.nextDep = link;
        activeSub.depsTail = link;
      }
      addSub(link);
    } else if (link.version === -1) {
      link.version = this.version;
      if (link.nextDep) {
        const next = link.nextDep;
        next.prevDep = link.prevDep;
        if (link.prevDep) {
          link.prevDep.nextDep = next;
        }
        link.prevDep = activeSub.depsTail;
        link.nextDep = void 0;
        activeSub.depsTail.nextDep = link;
        activeSub.depsTail = link;
        if (activeSub.deps === link) {
          activeSub.deps = next;
        }
      }
    }
    return link;
  }
  trigger(debugInfo) {
    this.version++;
    globalVersion++;
    this.notify(debugInfo);
  }
  notify(debugInfo) {
    startBatch();
    try {
      if (!!("production" !== "production")) ;
      for (let link = this.subs; link; link = link.prevSub) {
        if (link.sub.notify()) {
          ;
          link.sub.dep.notify();
        }
      }
    } finally {
      endBatch();
    }
  }
}
function addSub(link) {
  link.dep.sc++;
  if (link.sub.flags & 4) {
    const computed = link.dep.computed;
    if (computed && !link.dep.subs) {
      computed.flags |= 4 | 16;
      for (let l = computed.deps; l; l = l.nextDep) {
        addSub(l);
      }
    }
    const currentTail = link.dep.subs;
    if (currentTail !== link) {
      link.prevSub = currentTail;
      if (currentTail) currentTail.nextSub = link;
    }
    link.dep.subs = link;
  }
}
const targetMap = /* @__PURE__ */ new WeakMap();
const ITERATE_KEY = /* @__PURE__ */ Symbol(
  ""
);
const MAP_KEY_ITERATE_KEY = /* @__PURE__ */ Symbol(
  ""
);
const ARRAY_ITERATE_KEY = /* @__PURE__ */ Symbol(
  ""
);
function track(target, type, key) {
  if (shouldTrack && activeSub) {
    let depsMap = targetMap.get(target);
    if (!depsMap) {
      targetMap.set(target, depsMap = /* @__PURE__ */ new Map());
    }
    let dep = depsMap.get(key);
    if (!dep) {
      depsMap.set(key, dep = new Dep());
      dep.map = depsMap;
      dep.key = key;
    }
    {
      dep.track();
    }
  }
}
function trigger(target, type, key, newValue, oldValue, oldTarget) {
  const depsMap = targetMap.get(target);
  if (!depsMap) {
    globalVersion++;
    return;
  }
  const run = (dep) => {
    if (dep) {
      {
        dep.trigger();
      }
    }
  };
  startBatch();
  if (type === "clear") {
    depsMap.forEach(run);
  } else {
    const targetIsArray = isArray$1(target);
    const isArrayIndex = targetIsArray && isIntegerKey(key);
    if (targetIsArray && key === "length") {
      const newLength = Number(newValue);
      depsMap.forEach((dep, key2) => {
        if (key2 === "length" || key2 === ARRAY_ITERATE_KEY || !isSymbol$1(key2) && key2 >= newLength) {
          run(dep);
        }
      });
    } else {
      if (key !== void 0 || depsMap.has(void 0)) {
        run(depsMap.get(key));
      }
      if (isArrayIndex) {
        run(depsMap.get(ARRAY_ITERATE_KEY));
      }
      switch (type) {
        case "add":
          if (!targetIsArray) {
            run(depsMap.get(ITERATE_KEY));
            if (isMap$1(target)) {
              run(depsMap.get(MAP_KEY_ITERATE_KEY));
            }
          } else if (isArrayIndex) {
            run(depsMap.get("length"));
          }
          break;
        case "delete":
          if (!targetIsArray) {
            run(depsMap.get(ITERATE_KEY));
            if (isMap$1(target)) {
              run(depsMap.get(MAP_KEY_ITERATE_KEY));
            }
          }
          break;
        case "set":
          if (isMap$1(target)) {
            run(depsMap.get(ITERATE_KEY));
          }
          break;
      }
    }
  }
  endBatch();
}
function getDepFromReactive(object, key) {
  const depMap = targetMap.get(object);
  return depMap && depMap.get(key);
}

function reactiveReadArray(array) {
  const raw = toRaw$1(array);
  if (raw === array) return raw;
  track(raw, "iterate", ARRAY_ITERATE_KEY);
  return isShallow(array) ? raw : raw.map(toReactive);
}
function shallowReadArray(arr) {
  track(arr = toRaw$1(arr), "iterate", ARRAY_ITERATE_KEY);
  return arr;
}
function toWrapped(target, item) {
  if (isReadonly$1(target)) {
    return isReactive$1(target) ? toReadonly(toReactive(item)) : toReadonly(item);
  }
  return toReactive(item);
}
const arrayInstrumentations = {
  __proto__: null,
  [Symbol.iterator]() {
    return iterator(this, Symbol.iterator, (item) => toWrapped(this, item));
  },
  concat(...args) {
    return reactiveReadArray(this).concat(
      ...args.map((x) => isArray$1(x) ? reactiveReadArray(x) : x)
    );
  },
  entries() {
    return iterator(this, "entries", (value) => {
      value[1] = toWrapped(this, value[1]);
      return value;
    });
  },
  every(fn, thisArg) {
    return apply(this, "every", fn, thisArg, void 0, arguments);
  },
  filter(fn, thisArg) {
    return apply(
      this,
      "filter",
      fn,
      thisArg,
      (v) => v.map((item) => toWrapped(this, item)),
      arguments
    );
  },
  find(fn, thisArg) {
    return apply(
      this,
      "find",
      fn,
      thisArg,
      (item) => toWrapped(this, item),
      arguments
    );
  },
  findIndex(fn, thisArg) {
    return apply(this, "findIndex", fn, thisArg, void 0, arguments);
  },
  findLast(fn, thisArg) {
    return apply(
      this,
      "findLast",
      fn,
      thisArg,
      (item) => toWrapped(this, item),
      arguments
    );
  },
  findLastIndex(fn, thisArg) {
    return apply(this, "findLastIndex", fn, thisArg, void 0, arguments);
  },
  // flat, flatMap could benefit from ARRAY_ITERATE but are not straight-forward to implement
  forEach(fn, thisArg) {
    return apply(this, "forEach", fn, thisArg, void 0, arguments);
  },
  includes(...args) {
    return searchProxy(this, "includes", args);
  },
  indexOf(...args) {
    return searchProxy(this, "indexOf", args);
  },
  join(separator) {
    return reactiveReadArray(this).join(separator);
  },
  // keys() iterator only reads `length`, no optimization required
  lastIndexOf(...args) {
    return searchProxy(this, "lastIndexOf", args);
  },
  map(fn, thisArg) {
    return apply(this, "map", fn, thisArg, void 0, arguments);
  },
  pop() {
    return noTracking(this, "pop");
  },
  push(...args) {
    return noTracking(this, "push", args);
  },
  reduce(fn, ...args) {
    return reduce(this, "reduce", fn, args);
  },
  reduceRight(fn, ...args) {
    return reduce(this, "reduceRight", fn, args);
  },
  shift() {
    return noTracking(this, "shift");
  },
  // slice could use ARRAY_ITERATE but also seems to beg for range tracking
  some(fn, thisArg) {
    return apply(this, "some", fn, thisArg, void 0, arguments);
  },
  splice(...args) {
    return noTracking(this, "splice", args);
  },
  toReversed() {
    return reactiveReadArray(this).toReversed();
  },
  toSorted(comparer) {
    return reactiveReadArray(this).toSorted(comparer);
  },
  toSpliced(...args) {
    return reactiveReadArray(this).toSpliced(...args);
  },
  unshift(...args) {
    return noTracking(this, "unshift", args);
  },
  values() {
    return iterator(this, "values", (item) => toWrapped(this, item));
  }
};
function iterator(self, method, wrapValue) {
  const arr = shallowReadArray(self);
  const iter = arr[method]();
  if (arr !== self && !isShallow(self)) {
    iter._next = iter.next;
    iter.next = () => {
      const result = iter._next();
      if (!result.done) {
        result.value = wrapValue(result.value);
      }
      return result;
    };
  }
  return iter;
}
const arrayProto = Array.prototype;
function apply(self, method, fn, thisArg, wrappedRetFn, args) {
  const arr = shallowReadArray(self);
  const needsWrap = arr !== self && !isShallow(self);
  const methodFn = arr[method];
  if (methodFn !== arrayProto[method]) {
    const result2 = methodFn.apply(self, args);
    return needsWrap ? toReactive(result2) : result2;
  }
  let wrappedFn = fn;
  if (arr !== self) {
    if (needsWrap) {
      wrappedFn = function(item, index) {
        return fn.call(this, toWrapped(self, item), index, self);
      };
    } else if (fn.length > 2) {
      wrappedFn = function(item, index) {
        return fn.call(this, item, index, self);
      };
    }
  }
  const result = methodFn.call(arr, wrappedFn, thisArg);
  return needsWrap && wrappedRetFn ? wrappedRetFn(result) : result;
}
function reduce(self, method, fn, args) {
  const arr = shallowReadArray(self);
  const needsWrap = arr !== self && !isShallow(self);
  let wrappedFn = fn;
  let wrapInitialAccumulator = false;
  if (arr !== self) {
    if (needsWrap) {
      wrapInitialAccumulator = args.length === 0;
      wrappedFn = function(acc, item, index) {
        if (wrapInitialAccumulator) {
          wrapInitialAccumulator = false;
          acc = toWrapped(self, acc);
        }
        return fn.call(this, acc, toWrapped(self, item), index, self);
      };
    } else if (fn.length > 3) {
      wrappedFn = function(acc, item, index) {
        return fn.call(this, acc, item, index, self);
      };
    }
  }
  const result = arr[method](wrappedFn, ...args);
  return wrapInitialAccumulator ? toWrapped(self, result) : result;
}
function searchProxy(self, method, args) {
  const arr = toRaw$1(self);
  track(arr, "iterate", ARRAY_ITERATE_KEY);
  const res = arr[method](...args);
  if ((res === -1 || res === false) && isProxy(args[0])) {
    args[0] = toRaw$1(args[0]);
    return arr[method](...args);
  }
  return res;
}
function noTracking(self, method, args = []) {
  pauseTracking();
  startBatch();
  const res = toRaw$1(self)[method].apply(self, args);
  endBatch();
  resetTracking();
  return res;
}

const isNonTrackableKeys = /* @__PURE__ */ makeMap(`__proto__,__v_isRef,__isVue`);
const builtInSymbols = new Set(
  /* @__PURE__ */ Object.getOwnPropertyNames(Symbol).filter((key) => key !== "arguments" && key !== "caller").map((key) => Symbol[key]).filter(isSymbol$1)
);
function hasOwnProperty(key) {
  if (!isSymbol$1(key)) key = String(key);
  const obj = toRaw$1(this);
  track(obj, "has", key);
  return obj.hasOwnProperty(key);
}
class BaseReactiveHandler {
  constructor(_isReadonly = false, _isShallow = false) {
    this._isReadonly = _isReadonly;
    this._isShallow = _isShallow;
  }
  get(target, key, receiver) {
    if (key === "__v_skip") return target["__v_skip"];
    const isReadonly2 = this._isReadonly, isShallow2 = this._isShallow;
    if (key === "__v_isReactive") {
      return !isReadonly2;
    } else if (key === "__v_isReadonly") {
      return isReadonly2;
    } else if (key === "__v_isShallow") {
      return isShallow2;
    } else if (key === "__v_raw") {
      if (receiver === (isReadonly2 ? isShallow2 ? shallowReadonlyMap : readonlyMap : isShallow2 ? shallowReactiveMap : reactiveMap).get(target) || // receiver is not the reactive proxy, but has the same prototype
      // this means the receiver is a user proxy of the reactive proxy
      Object.getPrototypeOf(target) === Object.getPrototypeOf(receiver)) {
        return target;
      }
      return;
    }
    const targetIsArray = isArray$1(target);
    if (!isReadonly2) {
      let fn;
      if (targetIsArray && (fn = arrayInstrumentations[key])) {
        return fn;
      }
      if (key === "hasOwnProperty") {
        return hasOwnProperty;
      }
    }
    const res = Reflect.get(
      target,
      key,
      // if this is a proxy wrapping a ref, return methods using the raw ref
      // as receiver so that we don't have to call `toRaw` on the ref in all
      // its class methods
      isRef$1(target) ? target : receiver
    );
    if (isSymbol$1(key) ? builtInSymbols.has(key) : isNonTrackableKeys(key)) {
      return res;
    }
    if (!isReadonly2) {
      track(target, "get", key);
    }
    if (isShallow2) {
      return res;
    }
    if (isRef$1(res)) {
      const value = targetIsArray && isIntegerKey(key) ? res : res.value;
      return isReadonly2 && isObject(value) ? readonly(value) : value;
    }
    if (isObject(res)) {
      return isReadonly2 ? readonly(res) : reactive(res);
    }
    return res;
  }
}
class MutableReactiveHandler extends BaseReactiveHandler {
  constructor(isShallow2 = false) {
    super(false, isShallow2);
  }
  set(target, key, value, receiver) {
    let oldValue = target[key];
    const isArrayWithIntegerKey = isArray$1(target) && isIntegerKey(key);
    if (!this._isShallow) {
      const isOldValueReadonly = isReadonly$1(oldValue);
      if (!isShallow(value) && !isReadonly$1(value)) {
        oldValue = toRaw$1(oldValue);
        value = toRaw$1(value);
      }
      if (!isArrayWithIntegerKey && isRef$1(oldValue) && !isRef$1(value)) {
        if (isOldValueReadonly) {
          return true;
        } else {
          oldValue.value = value;
          return true;
        }
      }
    }
    const hadKey = isArrayWithIntegerKey ? Number(key) < target.length : hasOwn(target, key);
    const result = Reflect.set(
      target,
      key,
      value,
      isRef$1(target) ? target : receiver
    );
    if (target === toRaw$1(receiver) && result) {
      if (!hadKey) {
        trigger(target, "add", key, value);
      } else if (hasChanged(value, oldValue)) {
        trigger(target, "set", key, value);
      }
    }
    return result;
  }
  deleteProperty(target, key) {
    const hadKey = hasOwn(target, key);
    target[key];
    const result = Reflect.deleteProperty(target, key);
    if (result && hadKey) {
      trigger(target, "delete", key, void 0);
    }
    return result;
  }
  has(target, key) {
    const result = Reflect.has(target, key);
    if (!isSymbol$1(key) || !builtInSymbols.has(key)) {
      track(target, "has", key);
    }
    return result;
  }
  ownKeys(target) {
    track(
      target,
      "iterate",
      isArray$1(target) ? "length" : ITERATE_KEY
    );
    return Reflect.ownKeys(target);
  }
}
class ReadonlyReactiveHandler extends BaseReactiveHandler {
  constructor(isShallow2 = false) {
    super(true, isShallow2);
  }
  set(target, key) {
    return true;
  }
  deleteProperty(target, key) {
    return true;
  }
}
const mutableHandlers = /* @__PURE__ */ new MutableReactiveHandler();
const readonlyHandlers = /* @__PURE__ */ new ReadonlyReactiveHandler();
const shallowReactiveHandlers = /* @__PURE__ */ new MutableReactiveHandler(true);
const shallowReadonlyHandlers = /* @__PURE__ */ new ReadonlyReactiveHandler(true);

const toShallow = (value) => value;
const getProto = (v) => Reflect.getPrototypeOf(v);
function createIterableMethod(method, isReadonly2, isShallow2) {
  return function(...args) {
    const target = this["__v_raw"];
    const rawTarget = toRaw$1(target);
    const targetIsMap = isMap$1(rawTarget);
    const isPair = method === "entries" || method === Symbol.iterator && targetIsMap;
    const isKeyOnly = method === "keys" && targetIsMap;
    const innerIterator = target[method](...args);
    const wrap = isShallow2 ? toShallow : isReadonly2 ? toReadonly : toReactive;
    !isReadonly2 && track(
      rawTarget,
      "iterate",
      isKeyOnly ? MAP_KEY_ITERATE_KEY : ITERATE_KEY
    );
    return extend(
      // inheriting all iterator properties
      Object.create(innerIterator),
      {
        // iterator protocol
        next() {
          const { value, done } = innerIterator.next();
          return done ? { value, done } : {
            value: isPair ? [wrap(value[0]), wrap(value[1])] : wrap(value),
            done
          };
        }
      }
    );
  };
}
function createReadonlyMethod(type) {
  return function(...args) {
    return type === "delete" ? false : type === "clear" ? void 0 : this;
  };
}
function createInstrumentations(readonly, shallow) {
  const instrumentations = {
    get(key) {
      const target = this["__v_raw"];
      const rawTarget = toRaw$1(target);
      const rawKey = toRaw$1(key);
      if (!readonly) {
        if (hasChanged(key, rawKey)) {
          track(rawTarget, "get", key);
        }
        track(rawTarget, "get", rawKey);
      }
      const { has } = getProto(rawTarget);
      const wrap = shallow ? toShallow : readonly ? toReadonly : toReactive;
      if (has.call(rawTarget, key)) {
        return wrap(target.get(key));
      } else if (has.call(rawTarget, rawKey)) {
        return wrap(target.get(rawKey));
      } else if (target !== rawTarget) {
        target.get(key);
      }
    },
    get size() {
      const target = this["__v_raw"];
      !readonly && track(toRaw$1(target), "iterate", ITERATE_KEY);
      return target.size;
    },
    has(key) {
      const target = this["__v_raw"];
      const rawTarget = toRaw$1(target);
      const rawKey = toRaw$1(key);
      if (!readonly) {
        if (hasChanged(key, rawKey)) {
          track(rawTarget, "has", key);
        }
        track(rawTarget, "has", rawKey);
      }
      return key === rawKey ? target.has(key) : target.has(key) || target.has(rawKey);
    },
    forEach(callback, thisArg) {
      const observed = this;
      const target = observed["__v_raw"];
      const rawTarget = toRaw$1(target);
      const wrap = shallow ? toShallow : readonly ? toReadonly : toReactive;
      !readonly && track(rawTarget, "iterate", ITERATE_KEY);
      return target.forEach((value, key) => {
        return callback.call(thisArg, wrap(value), wrap(key), observed);
      });
    }
  };
  extend(
    instrumentations,
    readonly ? {
      add: createReadonlyMethod("add"),
      set: createReadonlyMethod("set"),
      delete: createReadonlyMethod("delete"),
      clear: createReadonlyMethod("clear")
    } : {
      add(value) {
        const target = toRaw$1(this);
        const proto = getProto(target);
        const rawValue = toRaw$1(value);
        const valueToAdd = !shallow && !isShallow(value) && !isReadonly$1(value) ? rawValue : value;
        const hadKey = proto.has.call(target, valueToAdd) || hasChanged(value, valueToAdd) && proto.has.call(target, value) || hasChanged(rawValue, valueToAdd) && proto.has.call(target, rawValue);
        if (!hadKey) {
          target.add(valueToAdd);
          trigger(target, "add", valueToAdd, valueToAdd);
        }
        return this;
      },
      set(key, value) {
        if (!shallow && !isShallow(value) && !isReadonly$1(value)) {
          value = toRaw$1(value);
        }
        const target = toRaw$1(this);
        const { has, get } = getProto(target);
        let hadKey = has.call(target, key);
        if (!hadKey) {
          key = toRaw$1(key);
          hadKey = has.call(target, key);
        }
        const oldValue = get.call(target, key);
        target.set(key, value);
        if (!hadKey) {
          trigger(target, "add", key, value);
        } else if (hasChanged(value, oldValue)) {
          trigger(target, "set", key, value);
        }
        return this;
      },
      delete(key) {
        const target = toRaw$1(this);
        const { has, get } = getProto(target);
        let hadKey = has.call(target, key);
        if (!hadKey) {
          key = toRaw$1(key);
          hadKey = has.call(target, key);
        }
        get ? get.call(target, key) : void 0;
        const result = target.delete(key);
        if (hadKey) {
          trigger(target, "delete", key, void 0);
        }
        return result;
      },
      clear() {
        const target = toRaw$1(this);
        const hadItems = target.size !== 0;
        const result = target.clear();
        if (hadItems) {
          trigger(
            target,
            "clear",
            void 0,
            void 0);
        }
        return result;
      }
    }
  );
  const iteratorMethods = [
    "keys",
    "values",
    "entries",
    Symbol.iterator
  ];
  iteratorMethods.forEach((method) => {
    instrumentations[method] = createIterableMethod(method, readonly, shallow);
  });
  return instrumentations;
}
function createInstrumentationGetter(isReadonly2, shallow) {
  const instrumentations = createInstrumentations(isReadonly2, shallow);
  return (target, key, receiver) => {
    if (key === "__v_isReactive") {
      return !isReadonly2;
    } else if (key === "__v_isReadonly") {
      return isReadonly2;
    } else if (key === "__v_raw") {
      return target;
    }
    return Reflect.get(
      hasOwn(instrumentations, key) && key in target ? instrumentations : target,
      key,
      receiver
    );
  };
}
const mutableCollectionHandlers = {
  get: /* @__PURE__ */ createInstrumentationGetter(false, false)
};
const shallowCollectionHandlers = {
  get: /* @__PURE__ */ createInstrumentationGetter(false, true)
};
const readonlyCollectionHandlers = {
  get: /* @__PURE__ */ createInstrumentationGetter(true, false)
};
const shallowReadonlyCollectionHandlers = {
  get: /* @__PURE__ */ createInstrumentationGetter(true, true)
};

const reactiveMap = /* @__PURE__ */ new WeakMap();
const shallowReactiveMap = /* @__PURE__ */ new WeakMap();
const readonlyMap = /* @__PURE__ */ new WeakMap();
const shallowReadonlyMap = /* @__PURE__ */ new WeakMap();
function targetTypeMap(rawType) {
  switch (rawType) {
    case "Object":
    case "Array":
      return 1 /* COMMON */;
    case "Map":
    case "Set":
    case "WeakMap":
    case "WeakSet":
      return 2 /* COLLECTION */;
    default:
      return 0 /* INVALID */;
  }
}
// @__NO_SIDE_EFFECTS__
function reactive(target) {
  if (/* @__PURE__ */ isReadonly$1(target)) {
    return target;
  }
  return createReactiveObject(
    target,
    false,
    mutableHandlers,
    mutableCollectionHandlers,
    reactiveMap
  );
}
// @__NO_SIDE_EFFECTS__
function shallowReactive(target) {
  return createReactiveObject(
    target,
    false,
    shallowReactiveHandlers,
    shallowCollectionHandlers,
    shallowReactiveMap
  );
}
// @__NO_SIDE_EFFECTS__
function readonly(target) {
  return createReactiveObject(
    target,
    true,
    readonlyHandlers,
    readonlyCollectionHandlers,
    readonlyMap
  );
}
// @__NO_SIDE_EFFECTS__
function shallowReadonly(target) {
  return createReactiveObject(
    target,
    true,
    shallowReadonlyHandlers,
    shallowReadonlyCollectionHandlers,
    shallowReadonlyMap
  );
}
function createReactiveObject(target, isReadonly2, baseHandlers, collectionHandlers, proxyMap) {
  if (!isObject(target)) {
    return target;
  }
  if (target["__v_raw"] && !(isReadonly2 && target["__v_isReactive"])) {
    return target;
  }
  if (target["__v_skip"] || !Object.isExtensible(target)) {
    return target;
  }
  const existingProxy = proxyMap.get(target);
  if (existingProxy) {
    return existingProxy;
  }
  const targetType = targetTypeMap(toRawType(target));
  if (targetType === 0 /* INVALID */) {
    return target;
  }
  const proxy = new Proxy(
    target,
    targetType === 2 /* COLLECTION */ ? collectionHandlers : baseHandlers
  );
  proxyMap.set(target, proxy);
  return proxy;
}
// @__NO_SIDE_EFFECTS__
function isReactive$1(value) {
  if (/* @__PURE__ */ isReadonly$1(value)) {
    return /* @__PURE__ */ isReactive$1(value["__v_raw"]);
  }
  return !!(value && value["__v_isReactive"]);
}
// @__NO_SIDE_EFFECTS__
function isReadonly$1(value) {
  return !!(value && value["__v_isReadonly"]);
}
// @__NO_SIDE_EFFECTS__
function isShallow(value) {
  return !!(value && value["__v_isShallow"]);
}
// @__NO_SIDE_EFFECTS__
function isProxy(value) {
  return value ? !!value["__v_raw"] : false;
}
// @__NO_SIDE_EFFECTS__
function toRaw$1(observed) {
  const raw = observed && observed["__v_raw"];
  return raw ? /* @__PURE__ */ toRaw$1(raw) : observed;
}
function markRaw(value) {
  if (!hasOwn(value, "__v_skip") && Object.isExtensible(value)) {
    def(value, "__v_skip", true);
  }
  return value;
}
const toReactive = (value) => isObject(value) ? /* @__PURE__ */ reactive(value) : value;
const toReadonly = (value) => isObject(value) ? /* @__PURE__ */ readonly(value) : value;

// @__NO_SIDE_EFFECTS__
function isRef$1(r) {
  return r ? r["__v_isRef"] === true : false;
}
// @__NO_SIDE_EFFECTS__
function ref(value) {
  return createRef(value, false);
}
// @__NO_SIDE_EFFECTS__
function shallowRef(value) {
  return createRef(value, true);
}
function createRef(rawValue, shallow) {
  if (/* @__PURE__ */ isRef$1(rawValue)) {
    return rawValue;
  }
  return new RefImpl(rawValue, shallow);
}
class RefImpl {
  constructor(value, isShallow2) {
    this.dep = new Dep();
    this["__v_isRef"] = true;
    this["__v_isShallow"] = false;
    this._rawValue = isShallow2 ? value : toRaw$1(value);
    this._value = isShallow2 ? value : toReactive(value);
    this["__v_isShallow"] = isShallow2;
  }
  get value() {
    {
      this.dep.track();
    }
    return this._value;
  }
  set value(newValue) {
    const oldValue = this._rawValue;
    const useDirectValue = this["__v_isShallow"] || isShallow(newValue) || isReadonly$1(newValue);
    newValue = useDirectValue ? newValue : toRaw$1(newValue);
    if (hasChanged(newValue, oldValue)) {
      this._rawValue = newValue;
      this._value = useDirectValue ? newValue : toReactive(newValue);
      {
        this.dep.trigger();
      }
    }
  }
}
function unref(ref2) {
  return /* @__PURE__ */ isRef$1(ref2) ? ref2.value : ref2;
}
const shallowUnwrapHandlers = {
  get: (target, key, receiver) => key === "__v_raw" ? target : unref(Reflect.get(target, key, receiver)),
  set: (target, key, value, receiver) => {
    const oldValue = target[key];
    if (/* @__PURE__ */ isRef$1(oldValue) && !/* @__PURE__ */ isRef$1(value)) {
      oldValue.value = value;
      return true;
    } else {
      return Reflect.set(target, key, value, receiver);
    }
  }
};
function proxyRefs(objectWithRefs) {
  return isReactive$1(objectWithRefs) ? objectWithRefs : new Proxy(objectWithRefs, shallowUnwrapHandlers);
}
// @__NO_SIDE_EFFECTS__
function toRefs(object) {
  const ret = isArray$1(object) ? new Array(object.length) : {};
  for (const key in object) {
    ret[key] = propertyToRef(object, key);
  }
  return ret;
}
class ObjectRefImpl {
  constructor(_object, key, _defaultValue) {
    this._object = _object;
    this._defaultValue = _defaultValue;
    this["__v_isRef"] = true;
    this._value = void 0;
    this._key = isSymbol$1(key) ? key : String(key);
    this._raw = toRaw$1(_object);
    let shallow = true;
    let obj = _object;
    if (!isArray$1(_object) || isSymbol$1(this._key) || !isIntegerKey(this._key)) {
      do {
        shallow = !isProxy(obj) || isShallow(obj);
      } while (shallow && (obj = obj["__v_raw"]));
    }
    this._shallow = shallow;
  }
  get value() {
    let val = this._object[this._key];
    if (this._shallow) {
      val = unref(val);
    }
    return this._value = val === void 0 ? this._defaultValue : val;
  }
  set value(newVal) {
    if (this._shallow && /* @__PURE__ */ isRef$1(this._raw[this._key])) {
      const nestedRef = this._object[this._key];
      if (/* @__PURE__ */ isRef$1(nestedRef)) {
        nestedRef.value = newVal;
        return;
      }
    }
    this._object[this._key] = newVal;
  }
  get dep() {
    return getDepFromReactive(this._raw, this._key);
  }
}
function propertyToRef(source, key, defaultValue) {
  return new ObjectRefImpl(source, key, defaultValue);
}

class ComputedRefImpl {
  constructor(fn, setter, isSSR) {
    this.fn = fn;
    this.setter = setter;
    /**
     * @internal
     */
    this._value = void 0;
    /**
     * @internal
     */
    this.dep = new Dep(this);
    /**
     * @internal
     */
    this.__v_isRef = true;
    // TODO isolatedDeclarations "__v_isReadonly"
    // A computed is also a subscriber that tracks other deps
    /**
     * @internal
     */
    this.deps = void 0;
    /**
     * @internal
     */
    this.depsTail = void 0;
    /**
     * @internal
     */
    this.flags = 16;
    /**
     * @internal
     */
    this.globalVersion = globalVersion - 1;
    /**
     * @internal
     */
    this.next = void 0;
    // for backwards compat
    this.effect = this;
    this["__v_isReadonly"] = !setter;
    this.isSSR = isSSR;
  }
  /**
   * @internal
   */
  notify() {
    this.flags |= 16;
    if (!(this.flags & 8) && // avoid infinite self recursion
    activeSub !== this) {
      batch(this, true);
      return true;
    }
  }
  get value() {
    const link = this.dep.track();
    refreshComputed(this);
    if (link) {
      link.version = this.dep.version;
    }
    return this._value;
  }
  set value(newValue) {
    if (this.setter) {
      this.setter(newValue);
    }
  }
}
// @__NO_SIDE_EFFECTS__
function computed$1(getterOrOptions, debugOptions, isSSR = false) {
  let getter;
  let setter;
  if (isFunction(getterOrOptions)) {
    getter = getterOrOptions;
  } else {
    getter = getterOrOptions.get;
    setter = getterOrOptions.set;
  }
  const cRef = new ComputedRefImpl(getter, setter, isSSR);
  return cRef;
}
const INITIAL_WATCHER_VALUE = {};
const cleanupMap = /* @__PURE__ */ new WeakMap();
let activeWatcher = void 0;
function onWatcherCleanup(cleanupFn, failSilently = false, owner = activeWatcher) {
  if (owner) {
    let cleanups = cleanupMap.get(owner);
    if (!cleanups) cleanupMap.set(owner, cleanups = []);
    cleanups.push(cleanupFn);
  }
}
function watch$1(source, cb, options = EMPTY_OBJ) {
  const { immediate, deep, once, scheduler, augmentJob, call } = options;
  const reactiveGetter = (source2) => {
    if (deep) return source2;
    if (isShallow(source2) || deep === false || deep === 0)
      return traverse$1(source2, 1);
    return traverse$1(source2);
  };
  let effect;
  let getter;
  let cleanup;
  let boundCleanup;
  let forceTrigger = false;
  let isMultiSource = false;
  if (isRef$1(source)) {
    getter = () => source.value;
    forceTrigger = isShallow(source);
  } else if (isReactive$1(source)) {
    getter = () => reactiveGetter(source);
    forceTrigger = true;
  } else if (isArray$1(source)) {
    isMultiSource = true;
    forceTrigger = source.some((s) => isReactive$1(s) || isShallow(s));
    getter = () => source.map((s) => {
      if (isRef$1(s)) {
        return s.value;
      } else if (isReactive$1(s)) {
        return reactiveGetter(s);
      } else if (isFunction(s)) {
        return call ? call(s, 2) : s();
      } else ;
    });
  } else if (isFunction(source)) {
    if (cb) {
      getter = call ? () => call(source, 2) : source;
    } else {
      getter = () => {
        if (cleanup) {
          pauseTracking();
          try {
            cleanup();
          } finally {
            resetTracking();
          }
        }
        const currentEffect = activeWatcher;
        activeWatcher = effect;
        try {
          return call ? call(source, 3, [boundCleanup]) : source(boundCleanup);
        } finally {
          activeWatcher = currentEffect;
        }
      };
    }
  } else {
    getter = NOOP;
  }
  if (cb && deep) {
    const baseGetter = getter;
    const depth = deep === true ? Infinity : deep;
    getter = () => traverse$1(baseGetter(), depth);
  }
  const scope = getCurrentScope();
  const watchHandle = () => {
    effect.stop();
    if (scope && scope.active) {
      remove(scope.effects, effect);
    }
  };
  if (once && cb) {
    const _cb = cb;
    cb = (...args) => {
      const res = _cb(...args);
      watchHandle();
      return res;
    };
  }
  let oldValue = isMultiSource ? new Array(source.length).fill(INITIAL_WATCHER_VALUE) : INITIAL_WATCHER_VALUE;
  const job = (immediateFirstRun) => {
    if (!(effect.flags & 1) || !effect.dirty && !immediateFirstRun) {
      return;
    }
    if (cb) {
      const newValue = effect.run();
      if (immediateFirstRun || deep || forceTrigger || (isMultiSource ? newValue.some((v, i) => hasChanged(v, oldValue[i])) : hasChanged(newValue, oldValue))) {
        if (cleanup) {
          cleanup();
        }
        const currentWatcher = activeWatcher;
        activeWatcher = effect;
        try {
          const args = [
            newValue,
            // pass undefined as the old value when it's changed for the first time
            oldValue === INITIAL_WATCHER_VALUE ? void 0 : isMultiSource && oldValue[0] === INITIAL_WATCHER_VALUE ? [] : oldValue,
            boundCleanup
          ];
          oldValue = newValue;
          call ? call(cb, 3, args) : (
            // @ts-expect-error
            cb(...args)
          );
        } finally {
          activeWatcher = currentWatcher;
        }
      }
    } else {
      effect.run();
    }
  };
  if (augmentJob) {
    augmentJob(job);
  }
  effect = new ReactiveEffect(getter);
  effect.scheduler = scheduler ? () => scheduler(job, false) : job;
  boundCleanup = (fn) => onWatcherCleanup(fn, false, effect);
  cleanup = effect.onStop = () => {
    const cleanups = cleanupMap.get(effect);
    if (cleanups) {
      if (call) {
        call(cleanups, 4);
      } else {
        for (const cleanup2 of cleanups) cleanup2();
      }
      cleanupMap.delete(effect);
    }
  };
  if (cb) {
    if (immediate) {
      job(true);
    } else {
      oldValue = effect.run();
    }
  } else if (scheduler) {
    scheduler(job.bind(null, true), true);
  } else {
    effect.run();
  }
  watchHandle.pause = effect.pause.bind(effect);
  watchHandle.resume = effect.resume.bind(effect);
  watchHandle.stop = watchHandle;
  return watchHandle;
}
function traverse$1(value, depth = Infinity, seen) {
  if (depth <= 0 || !isObject(value) || value["__v_skip"]) {
    return value;
  }
  seen = seen || /* @__PURE__ */ new Map();
  if ((seen.get(value) || 0) >= depth) {
    return value;
  }
  seen.set(value, depth);
  depth--;
  if (isRef$1(value)) {
    traverse$1(value.value, depth, seen);
  } else if (isArray$1(value)) {
    for (let i = 0; i < value.length; i++) {
      traverse$1(value[i], depth, seen);
    }
  } else if (isSet$1(value) || isMap$1(value)) {
    value.forEach((v) => {
      traverse$1(v, depth, seen);
    });
  } else if (isPlainObject$1(value)) {
    for (const key in value) {
      traverse$1(value[key], depth, seen);
    }
    for (const key of Object.getOwnPropertySymbols(value)) {
      if (Object.prototype.propertyIsEnumerable.call(value, key)) {
        traverse$1(value[key], depth, seen);
      }
    }
  }
  return value;
}

/**
* @vue/runtime-core v3.5.41
* (c) 2018-present Yuxi (Evan) You and Vue contributors
* @license MIT
**/

const stack = [];
let isWarning = false;
function warn$1(msg, ...args) {
  if (isWarning) return;
  isWarning = true;
  pauseTracking();
  const instance = stack.length ? stack[stack.length - 1].component : null;
  const appWarnHandler = instance && instance.appContext.config.warnHandler;
  const trace = getComponentTrace();
  if (appWarnHandler) {
    callWithErrorHandling(
      appWarnHandler,
      instance,
      11,
      [
        // eslint-disable-next-line no-restricted-syntax
        msg + args.map((a) => {
          var _a, _b;
          return (_b = (_a = a.toString) == null ? void 0 : _a.call(a)) != null ? _b : JSON.stringify(a);
        }).join(""),
        instance && instance.proxy,
        trace.map(
          ({ vnode }) => `at <${formatComponentName(instance, vnode.type)}>`
        ).join("\n"),
        trace
      ]
    );
  } else {
    const warnArgs = [`[Vue warn]: ${msg}`, ...args];
    if (trace.length && // avoid spamming console during tests
    true) {
      warnArgs.push(`
`, ...formatTrace(trace));
    }
    console.warn(...warnArgs);
  }
  resetTracking();
  isWarning = false;
}
function getComponentTrace() {
  let currentVNode = stack[stack.length - 1];
  if (!currentVNode) {
    return [];
  }
  const normalizedStack = [];
  while (currentVNode) {
    const last = normalizedStack[0];
    if (last && last.vnode === currentVNode) {
      last.recurseCount++;
    } else {
      normalizedStack.push({
        vnode: currentVNode,
        recurseCount: 0
      });
    }
    const parentInstance = currentVNode.component && currentVNode.component.parent;
    currentVNode = parentInstance && parentInstance.vnode;
  }
  return normalizedStack;
}
function formatTrace(trace) {
  const logs = [];
  trace.forEach((entry, i) => {
    logs.push(...i === 0 ? [] : [`
`], ...formatTraceEntry(entry));
  });
  return logs;
}
function formatTraceEntry({ vnode, recurseCount }) {
  const postfix = recurseCount > 0 ? `... (${recurseCount} recursive calls)` : ``;
  const isRoot = vnode.component ? vnode.component.parent == null : false;
  const open = ` at <${formatComponentName(
    vnode.component,
    vnode.type,
    isRoot
  )}`;
  const close = `>` + postfix;
  return vnode.props ? [open, ...formatProps(vnode.props), close] : [open + close];
}
function formatProps(props) {
  const res = [];
  const keys = Object.keys(props);
  keys.slice(0, 3).forEach((key) => {
    res.push(...formatProp(key, props[key]));
  });
  if (keys.length > 3) {
    res.push(` ...`);
  }
  return res;
}
function formatProp(key, value, raw) {
  if (isString$1(value)) {
    value = JSON.stringify(value);
    return raw ? value : [`${key}=${value}`];
  } else if (typeof value === "number" || typeof value === "boolean" || value == null) {
    return raw ? value : [`${key}=${value}`];
  } else if (isRef$1(value)) {
    value = formatProp(key, toRaw$1(value.value), true);
    return raw ? value : [`${key}=Ref<`, value, `>`];
  } else if (isFunction(value)) {
    return [`${key}=fn${value.name ? `<${value.name}>` : ``}`];
  } else {
    value = toRaw$1(value);
    return raw ? value : [`${key}=`, value];
  }
}
function callWithErrorHandling(fn, instance, type, args) {
  try {
    return args ? fn(...args) : fn();
  } catch (err) {
    handleError(err, instance, type);
  }
}
function callWithAsyncErrorHandling(fn, instance, type, args) {
  if (isFunction(fn)) {
    const res = callWithErrorHandling(fn, instance, type, args);
    if (res && isPromise(res)) {
      res.catch((err) => {
        handleError(err, instance, type);
      });
    }
    return res;
  }
  if (isArray$1(fn)) {
    const values = [];
    for (let i = 0; i < fn.length; i++) {
      values.push(callWithAsyncErrorHandling(fn[i], instance, type, args));
    }
    return values;
  }
}
function handleError(err, instance, type, throwInDev = true) {
  const contextVNode = instance ? instance.vnode : null;
  const { errorHandler, throwUnhandledErrorInProduction } = instance && instance.appContext.config || EMPTY_OBJ;
  if (instance) {
    let cur = instance.parent;
    const exposedInstance = instance.proxy;
    const errorInfo = `https://vuejs.org/error-reference/#runtime-${type}`;
    while (cur) {
      const errorCapturedHooks = cur.ec;
      if (errorCapturedHooks) {
        for (let i = 0; i < errorCapturedHooks.length; i++) {
          if (errorCapturedHooks[i](err, exposedInstance, errorInfo) === false) {
            return;
          }
        }
      }
      cur = cur.parent;
    }
    if (errorHandler) {
      pauseTracking();
      callWithErrorHandling(errorHandler, null, 10, [
        err,
        exposedInstance,
        errorInfo
      ]);
      resetTracking();
      return;
    }
  }
  logError(err, type, contextVNode, throwInDev, throwUnhandledErrorInProduction);
}
function logError(err, type, contextVNode, throwInDev = true, throwInProd = false) {
  if (throwInProd) {
    throw err;
  } else {
    console.error(err);
  }
}

const queue = [];
let flushIndex = -1;
const pendingPostFlushCbs = [];
let activePostFlushCbs = null;
let postFlushIndex = 0;
const resolvedPromise = /* @__PURE__ */ Promise.resolve();
let currentFlushPromise = null;
function nextTick(fn) {
  const p = currentFlushPromise || resolvedPromise;
  return fn ? p.then(this ? fn.bind(this) : fn) : p;
}
function findInsertionIndex(id) {
  let start = flushIndex + 1;
  let end = queue.length;
  while (start < end) {
    const middle = start + end >>> 1;
    const middleJob = queue[middle];
    const middleJobId = getId(middleJob);
    if (middleJobId < id || middleJobId === id && middleJob.flags & 2) {
      start = middle + 1;
    } else {
      end = middle;
    }
  }
  return start;
}
function queueJob(job) {
  if (!(job.flags & 1)) {
    const jobId = getId(job);
    const lastJob = queue[queue.length - 1];
    if (!lastJob || // fast path when the job id is larger than the tail
    !(job.flags & 2) && jobId >= getId(lastJob)) {
      queue.push(job);
    } else {
      queue.splice(findInsertionIndex(jobId), 0, job);
    }
    job.flags |= 1;
    queueFlush();
  }
}
function queueFlush() {
  if (!currentFlushPromise) {
    currentFlushPromise = resolvedPromise.then(flushJobs);
  }
}
function queuePostFlushCb(cb) {
  if (!isArray$1(cb)) {
    if (activePostFlushCbs && cb.id === -1) {
      activePostFlushCbs.splice(postFlushIndex + 1, 0, cb);
    } else if (!(cb.flags & 1)) {
      pendingPostFlushCbs.push(cb);
      cb.flags |= 1;
    }
  } else {
    for (let i = 0; i < cb.length; i++) {
      pendingPostFlushCbs.push(cb[i]);
    }
  }
  queueFlush();
}
function flushPreFlushCbs(instance, seen, i = flushIndex + 1) {
  for (; i < queue.length; i++) {
    const cb = queue[i];
    if (cb && cb.flags & 2) {
      if (instance && cb.id !== instance.uid) {
        continue;
      }
      queue.splice(i, 1);
      i--;
      if (cb.flags & 4) {
        cb.flags &= -2;
      }
      cb();
      if (!(cb.flags & 4)) {
        cb.flags &= -2;
      }
    }
  }
}
function flushPostFlushCbs(seen) {
  if (pendingPostFlushCbs.length) {
    const deduped = [...new Set(pendingPostFlushCbs)].sort(
      (a, b) => getId(a) - getId(b)
    );
    pendingPostFlushCbs.length = 0;
    if (activePostFlushCbs) {
      for (let i = 0; i < deduped.length; i++) {
        activePostFlushCbs.push(deduped[i]);
      }
      return;
    }
    activePostFlushCbs = deduped;
    for (postFlushIndex = 0; postFlushIndex < activePostFlushCbs.length; postFlushIndex++) {
      const cb = activePostFlushCbs[postFlushIndex];
      if (cb.flags & 4) {
        cb.flags &= -2;
      }
      if (!(cb.flags & 8)) cb();
      cb.flags &= -2;
    }
    activePostFlushCbs = null;
    postFlushIndex = 0;
  }
}
const getId = (job) => job.id == null ? job.flags & 2 ? -1 : Infinity : job.id;
function flushJobs(seen) {
  const check = NOOP;
  try {
    for (flushIndex = 0; flushIndex < queue.length; flushIndex++) {
      const job = queue[flushIndex];
      if (job && !(job.flags & 8)) {
        if (!!("production" !== "production") && check(job)) ;
        if (job.flags & 4) {
          job.flags &= ~1;
        }
        callWithErrorHandling(
          job,
          job.i,
          job.i ? 15 : 14
        );
        if (!(job.flags & 4)) {
          job.flags &= ~1;
        }
      }
    }
  } finally {
    for (; flushIndex < queue.length; flushIndex++) {
      const job = queue[flushIndex];
      if (job) {
        job.flags &= -2;
      }
    }
    flushIndex = -1;
    queue.length = 0;
    flushPostFlushCbs();
    currentFlushPromise = null;
    if (queue.length || pendingPostFlushCbs.length) {
      flushJobs();
    }
  }
}

let devtools$1;
let buffer = [];
let devtoolsNotInstalled = false;
function emit$1(event, ...args) {
  if (devtools$1) {
    devtools$1.emit(event, ...args);
  } else if (!devtoolsNotInstalled) {
    buffer.push({ event, args });
  }
}
function setDevtoolsHook$1(hook, target) {
  var _a, _b;
  devtools$1 = hook;
  if (devtools$1) {
    devtools$1.enabled = true;
    buffer.forEach(({ event, args }) => devtools$1.emit(event, ...args));
    buffer = [];
  } else if (
    // handle late devtools injection - only do this if we are in an actual
    // browser environment to avoid the timer handle stalling test runner exit
    // (#4815)
    typeof window !== "undefined" && // some envs mock window but not fully
    window.HTMLElement && // also exclude jsdom
    // eslint-disable-next-line no-restricted-syntax
    !((_b = (_a = window.navigator) == null ? void 0 : _a.userAgent) == null ? void 0 : _b.includes("jsdom"))
  ) {
    const replay = target.__VUE_DEVTOOLS_HOOK_REPLAY__ = target.__VUE_DEVTOOLS_HOOK_REPLAY__ || [];
    replay.push((newHook) => {
      setDevtoolsHook$1(newHook, target);
    });
    setTimeout(() => {
      if (!devtools$1) {
        target.__VUE_DEVTOOLS_HOOK_REPLAY__ = null;
        devtoolsNotInstalled = true;
        buffer = [];
      }
    }, 3e3);
  } else {
    devtoolsNotInstalled = true;
    buffer = [];
  }
}
function devtoolsInitApp(app, version) {
  emit$1("app:init" /* APP_INIT */, app, version, {
    Fragment,
    Text,
    Comment,
    Static
  });
}
function devtoolsUnmountApp(app) {
  emit$1("app:unmount" /* APP_UNMOUNT */, app);
}
const devtoolsComponentAdded = /* @__PURE__ */ createDevtoolsComponentHook("component:added" /* COMPONENT_ADDED */);
const devtoolsComponentUpdated = /* @__PURE__ */ createDevtoolsComponentHook("component:updated" /* COMPONENT_UPDATED */);
const _devtoolsComponentRemoved = /* @__PURE__ */ createDevtoolsComponentHook(
  "component:removed" /* COMPONENT_REMOVED */
);
const devtoolsComponentRemoved = (component) => {
  if (devtools$1 && typeof devtools$1.cleanupBuffer === "function" && // remove the component if it wasn't buffered
  !devtools$1.cleanupBuffer(component)) {
    _devtoolsComponentRemoved(component);
  }
};
// @__NO_SIDE_EFFECTS__
function createDevtoolsComponentHook(hook) {
  return (component) => {
    emit$1(
      hook,
      component.appContext.app,
      component.uid,
      component.parent ? component.parent.uid : void 0,
      component
    );
  };
}
function devtoolsComponentEmit(component, event, params) {
  emit$1(
    "component:emit" /* COMPONENT_EMIT */,
    component.appContext.app,
    component,
    event,
    params
  );
}

let currentRenderingInstance = null;
let currentScopeId = null;
function setCurrentRenderingInstance(instance) {
  const prev = currentRenderingInstance;
  currentRenderingInstance = instance;
  currentScopeId = instance && instance.type.__scopeId || null;
  return prev;
}
function withCtx(fn, ctx = currentRenderingInstance, isNonScopedSlot) {
  if (!ctx) return fn;
  if (fn._n) {
    return fn;
  }
  const renderFnWithContext = (...args) => {
    if (renderFnWithContext._d) {
      setBlockTracking(-1);
    }
    const prevInstance = setCurrentRenderingInstance(ctx);
    const prevStackSize = blockStack.length;
    let res;
    try {
      res = fn(...args);
    } finally {
      for (let i = blockStack.length; i > prevStackSize; i--) closeBlock();
      setCurrentRenderingInstance(prevInstance);
      if (renderFnWithContext._d) {
        setBlockTracking(1);
      }
    }
    if (__VUE_PROD_DEVTOOLS__) {
      devtoolsComponentUpdated(ctx);
    }
    return res;
  };
  renderFnWithContext._n = true;
  renderFnWithContext._c = true;
  renderFnWithContext._d = true;
  return renderFnWithContext;
}
function invokeDirectiveHook(vnode, prevVNode, instance, name) {
  const bindings = vnode.dirs;
  const oldBindings = prevVNode && prevVNode.dirs;
  for (let i = 0; i < bindings.length; i++) {
    const binding = bindings[i];
    if (oldBindings) {
      binding.oldValue = oldBindings[i].value;
    }
    let hook = binding.dir[name];
    if (hook) {
      pauseTracking();
      callWithAsyncErrorHandling(hook, instance, 8, [
        vnode.el,
        binding,
        vnode,
        prevVNode
      ]);
      resetTracking();
    }
  }
}

function provide(key, value) {
  if (currentInstance) {
    let provides = currentInstance.provides;
    const parentProvides = currentInstance.parent && currentInstance.parent.provides;
    if (parentProvides === provides) {
      provides = currentInstance.provides = Object.create(parentProvides);
    }
    provides[key] = value;
  }
}
function inject(key, defaultValue, treatDefaultAsFactory = false) {
  const instance = getCurrentInstance();
  if (instance || currentApp) {
    let provides = currentApp ? currentApp._context.provides : instance ? instance.parent == null || instance.ce ? instance.vnode.appContext && instance.vnode.appContext.provides : instance.parent.provides : void 0;
    if (provides && key in provides) {
      return provides[key];
    } else if (arguments.length > 1) {
      return treatDefaultAsFactory && isFunction(defaultValue) ? defaultValue.call(instance && instance.proxy) : defaultValue;
    } else ;
  }
}
function hasInjectionContext() {
  return !!(getCurrentInstance() || currentApp);
}

const ssrContextKey = /* @__PURE__ */ Symbol.for("v-scx");
const useSSRContext = () => {
  {
    const ctx = inject(ssrContextKey);
    return ctx;
  }
};
function watch(source, cb, options) {
  return doWatch(source, cb, options);
}
function doWatch(source, cb, options = EMPTY_OBJ) {
  const { immediate, deep, flush, once } = options;
  const baseWatchOptions = extend({}, options);
  const runsImmediately = cb && immediate || !cb && flush !== "post";
  let ssrCleanup;
  if (isInSSRComponentSetup) {
    if (flush === "sync") {
      const ctx = useSSRContext();
      ssrCleanup = ctx.__watcherHandles || (ctx.__watcherHandles = []);
    } else if (!runsImmediately) {
      const watchStopHandle = () => {
      };
      watchStopHandle.stop = NOOP;
      watchStopHandle.resume = NOOP;
      watchStopHandle.pause = NOOP;
      return watchStopHandle;
    }
  }
  const instance = currentInstance;
  baseWatchOptions.call = (fn, type, args) => callWithAsyncErrorHandling(fn, instance, type, args);
  let isPre = false;
  if (flush === "post") {
    baseWatchOptions.scheduler = (job) => {
      queuePostRenderEffect(job, instance && instance.suspense);
    };
  } else if (flush !== "sync") {
    isPre = true;
    baseWatchOptions.scheduler = (job, isFirstRun) => {
      if (isFirstRun) {
        job();
      } else {
        queueJob(job);
      }
    };
  }
  baseWatchOptions.augmentJob = (job) => {
    if (cb) {
      job.flags |= 4;
    }
    if (isPre) {
      job.flags |= 2;
      if (instance) {
        job.id = instance.uid;
        job.i = instance;
      }
    }
  };
  const watchHandle = watch$1(source, cb, baseWatchOptions);
  if (isInSSRComponentSetup) {
    if (ssrCleanup) {
      ssrCleanup.push(watchHandle);
    } else if (runsImmediately) {
      watchHandle();
    }
  }
  return watchHandle;
}
function instanceWatch(source, value, options) {
  const publicThis = this.proxy;
  const getter = isString$1(source) ? source.includes(".") ? createPathGetter(publicThis, source) : () => publicThis[source] : source.bind(publicThis, publicThis);
  let cb;
  if (isFunction(value)) {
    cb = value;
  } else {
    cb = value.handler;
    options = value;
  }
  const reset = setCurrentInstance(this);
  const res = doWatch(getter, cb.bind(publicThis), options);
  reset();
  return res;
}
function createPathGetter(ctx, path) {
  const segments = path.split(".");
  return () => {
    let cur = ctx;
    for (let i = 0; i < segments.length && cur; i++) {
      cur = cur[segments[i]];
    }
    return cur;
  };
}
const TeleportEndKey = /* @__PURE__ */ Symbol("_vte");
const isTeleport = (type) => type.__isTeleport;

const leaveCbKey = /* @__PURE__ */ Symbol("_leaveCb");
function findNonCommentChild(children) {
  let child = children[0];
  if (children.length > 1) {
    for (const c of children) {
      if (c.type !== Comment) {
        child = c;
        break;
      }
    }
  }
  return child;
}
function getInnerChild$1(vnode) {
  if (!isKeepAlive(vnode)) {
    if (isTeleport(vnode.type) && vnode.children) {
      return findNonCommentChild(vnode.children);
    }
    return vnode;
  }
  if (vnode.component) {
    return vnode.component.subTree;
  }
  const { shapeFlag, children } = vnode;
  if (children) {
    if (shapeFlag & 16) {
      return children[0];
    }
    if (shapeFlag & 32 && isFunction(children.default)) {
      return children.default();
    }
  }
}
function setTransitionHooks(vnode, hooks) {
  if (vnode.shapeFlag & 6 && vnode.component) {
    vnode.transition = hooks;
    const subTree = vnode.component.subTree;
    setTransitionHooks(
      isTeleport(subTree.type) ? getInnerChild$1(subTree) || subTree : subTree,
      hooks
    );
  } else if (vnode.shapeFlag & 128) {
    vnode.ssContent.transition = hooks.clone(vnode.ssContent);
    vnode.ssFallback.transition = hooks.clone(vnode.ssFallback);
  } else {
    vnode.transition = hooks;
  }
}

// @__NO_SIDE_EFFECTS__
function defineComponent(options, extraOptions) {
  return isFunction(options) ? (
    // #8236: extend call and options.name access are considered side-effects
    // by Rollup, so we have to wrap it in a pure-annotated IIFE.
    /* @__PURE__ */ (() => extend({ name: options.name }, extraOptions, { setup: options }))()
  ) : options;
}
function markAsyncBoundary(instance) {
  instance.ids = [instance.ids[0] + instance.ids[2]++ + "-", 0, 0];
}
function isTemplateRefKey(refs, key) {
  let desc;
  return !!((desc = Object.getOwnPropertyDescriptor(refs, key)) && !desc.configurable);
}

const pendingSetRefMap = /* @__PURE__ */ new WeakMap();
function setRef(rawRef, oldRawRef, parentSuspense, vnode, isUnmount = false) {
  if (isArray$1(rawRef)) {
    rawRef.forEach(
      (r, i) => setRef(
        r,
        oldRawRef && (isArray$1(oldRawRef) ? oldRawRef[i] : oldRawRef),
        parentSuspense,
        vnode,
        isUnmount
      )
    );
    return;
  }
  if (isAsyncWrapper(vnode) && !isUnmount) {
    if (vnode.shapeFlag & 512 && vnode.type.__asyncResolved && vnode.component.subTree.component) {
      setRef(rawRef, oldRawRef, parentSuspense, vnode.component.subTree);
    }
    return;
  }
  const refValue = vnode.shapeFlag & 4 ? getComponentPublicInstance(vnode.component) : vnode.el;
  const value = isUnmount ? null : refValue;
  const { i: owner, r: ref } = rawRef;
  const oldRef = oldRawRef && oldRawRef.r;
  const refs = owner.refs === EMPTY_OBJ ? owner.refs = {} : owner.refs;
  const setupState = owner.setupState;
  const rawSetupState = toRaw$1(setupState);
  const canSetSetupRef = setupState === EMPTY_OBJ ? NO : (key) => {
    if (isTemplateRefKey(refs, key)) {
      return false;
    }
    return hasOwn(rawSetupState, key);
  };
  const canSetRef = (ref2, key) => {
    if (key && isTemplateRefKey(refs, key)) {
      return false;
    }
    return true;
  };
  if (oldRef != null && oldRef !== ref) {
    invalidatePendingSetRef(oldRawRef);
    if (isString$1(oldRef)) {
      refs[oldRef] = null;
      if (canSetSetupRef(oldRef)) {
        setupState[oldRef] = null;
      }
    } else if (isRef$1(oldRef)) {
      const oldRawRefAtom = oldRawRef;
      if (canSetRef(oldRef, oldRawRefAtom.k)) {
        oldRef.value = null;
      }
      if (oldRawRefAtom.k) refs[oldRawRefAtom.k] = null;
    }
  }
  if (isFunction(ref)) {
    callWithErrorHandling(ref, owner, 12, [value, refs]);
  } else {
    const _isString = isString$1(ref);
    const _isRef = isRef$1(ref);
    if (_isString || _isRef) {
      const doSet = () => {
        if (rawRef.f) {
          const existing = _isString ? canSetSetupRef(ref) ? setupState[ref] : refs[ref] : canSetRef() || !rawRef.k ? ref.value : refs[rawRef.k];
          if (isUnmount) {
            isArray$1(existing) && remove(existing, refValue);
          } else {
            if (!isArray$1(existing)) {
              if (_isString) {
                refs[ref] = [refValue];
                if (canSetSetupRef(ref)) {
                  setupState[ref] = refs[ref];
                }
              } else {
                const newVal = [refValue];
                if (canSetRef(ref, rawRef.k)) {
                  ref.value = newVal;
                }
                if (rawRef.k) refs[rawRef.k] = newVal;
              }
            } else if (!existing.includes(refValue)) {
              existing.push(refValue);
            }
          }
        } else if (_isString) {
          refs[ref] = value;
          if (canSetSetupRef(ref)) {
            setupState[ref] = value;
          }
        } else if (_isRef) {
          if (canSetRef(ref, rawRef.k)) {
            ref.value = value;
          }
          if (rawRef.k) refs[rawRef.k] = value;
        } else ;
      };
      if (value) {
        const job = () => {
          doSet();
          pendingSetRefMap.delete(rawRef);
        };
        job.id = -1;
        pendingSetRefMap.set(rawRef, job);
        queuePostRenderEffect(job, parentSuspense);
      } else {
        invalidatePendingSetRef(rawRef);
        doSet();
      }
    }
  }
}
function invalidatePendingSetRef(rawRef) {
  const pendingSetRef = pendingSetRefMap.get(rawRef);
  if (pendingSetRef) {
    pendingSetRef.flags |= 8;
    pendingSetRefMap.delete(rawRef);
  }
}

getGlobalThis().requestIdleCallback || ((cb) => setTimeout(cb, 1));
getGlobalThis().cancelIdleCallback || ((id) => clearTimeout(id));

const isAsyncWrapper = (i) => !!i.type.__asyncLoader;

const isKeepAlive = (vnode) => vnode.type.__isKeepAlive;
function onActivated(hook, target) {
  registerKeepAliveHook(hook, "a", target);
}
function onDeactivated(hook, target) {
  registerKeepAliveHook(hook, "da", target);
}
function registerKeepAliveHook(hook, type, target = currentInstance) {
  const wrappedHook = hook.__wdc || (hook.__wdc = () => {
    let current = target;
    while (current) {
      if (current.isDeactivated) {
        return;
      }
      current = current.parent;
    }
    return hook();
  });
  injectHook(type, wrappedHook, target);
  if (target) {
    let current = target.parent;
    while (current && current.parent) {
      if (isKeepAlive(current.parent.vnode)) {
        injectToKeepAliveRoot(wrappedHook, type, target, current);
      }
      current = current.parent;
    }
  }
}
function injectToKeepAliveRoot(hook, type, target, keepAliveRoot) {
  const injected = injectHook(
    type,
    hook,
    keepAliveRoot,
    true
    /* prepend */
  );
  onUnmounted(() => {
    remove(keepAliveRoot[type], injected);
  }, target);
}

function injectHook(type, hook, target = currentInstance, prepend = false) {
  if (target) {
    const hooks = target[type] || (target[type] = []);
    const wrappedHook = hook.__weh || (hook.__weh = (...args) => {
      pauseTracking();
      const reset = setCurrentInstance(target);
      const res = callWithAsyncErrorHandling(hook, target, type, args);
      reset();
      resetTracking();
      return res;
    });
    if (prepend) {
      hooks.unshift(wrappedHook);
    } else {
      hooks.push(wrappedHook);
    }
    return wrappedHook;
  }
}
const createHook = (lifecycle) => (hook, target = currentInstance) => {
  if (!isInSSRComponentSetup || lifecycle === "sp") {
    injectHook(lifecycle, (...args) => hook(...args), target);
  }
};
const onBeforeMount = createHook("bm");
const onMounted = createHook("m");
const onBeforeUpdate = createHook(
  "bu"
);
const onUpdated = createHook("u");
const onBeforeUnmount = createHook(
  "bum"
);
const onUnmounted = createHook("um");
const onServerPrefetch = createHook(
  "sp"
);
const onRenderTriggered = createHook("rtg");
const onRenderTracked = createHook("rtc");
function onErrorCaptured(hook, target = currentInstance) {
  injectHook("ec", hook, target);
}
const NULL_DYNAMIC_COMPONENT = /* @__PURE__ */ Symbol.for("v-ndc");

const getPublicInstance = (i) => {
  if (!i) return null;
  if (isStatefulComponent(i)) return getComponentPublicInstance(i);
  return getPublicInstance(i.parent);
};
const publicPropertiesMap = (
  // Move PURE marker to new line to workaround compiler discarding it
  // due to type annotation
  /* @__PURE__ */ extend(/* @__PURE__ */ Object.create(null), {
    $: (i) => i,
    $el: (i) => i.vnode.el,
    $data: (i) => i.data,
    $props: (i) => i.props,
    $attrs: (i) => i.attrs,
    $slots: (i) => i.slots,
    $refs: (i) => i.refs,
    $parent: (i) => getPublicInstance(i.parent),
    $root: (i) => getPublicInstance(i.root),
    $host: (i) => i.ce,
    $emit: (i) => i.emit,
    $options: (i) => __VUE_OPTIONS_API__ ? resolveMergedOptions(i) : i.type,
    $forceUpdate: (i) => i.f || (i.f = () => {
      queueJob(i.update);
    }),
    $nextTick: (i) => i.n || (i.n = nextTick.bind(i.proxy)),
    $watch: (i) => __VUE_OPTIONS_API__ ? instanceWatch.bind(i) : NOOP
  })
);
const hasSetupBinding = (state, key) => state !== EMPTY_OBJ && !state.__isScriptSetup && hasOwn(state, key);
const PublicInstanceProxyHandlers = {
  get({ _: instance }, key) {
    if (key === "__v_skip") {
      return true;
    }
    const { ctx, setupState, data, props, accessCache, type, appContext } = instance;
    if (key[0] !== "$") {
      const n = accessCache[key];
      if (n !== void 0) {
        switch (n) {
          case 1 /* SETUP */:
            return setupState[key];
          case 2 /* DATA */:
            return data[key];
          case 4 /* CONTEXT */:
            return ctx[key];
          case 3 /* PROPS */:
            return props[key];
        }
      } else if (hasSetupBinding(setupState, key)) {
        accessCache[key] = 1 /* SETUP */;
        return setupState[key];
      } else if (__VUE_OPTIONS_API__ && data !== EMPTY_OBJ && hasOwn(data, key)) {
        accessCache[key] = 2 /* DATA */;
        return data[key];
      } else if (hasOwn(props, key)) {
        accessCache[key] = 3 /* PROPS */;
        return props[key];
      } else if (ctx !== EMPTY_OBJ && hasOwn(ctx, key)) {
        accessCache[key] = 4 /* CONTEXT */;
        return ctx[key];
      } else if (!__VUE_OPTIONS_API__ || shouldCacheAccess) {
        accessCache[key] = 0 /* OTHER */;
      }
    }
    const publicGetter = publicPropertiesMap[key];
    let cssModule, globalProperties;
    if (publicGetter) {
      if (key === "$attrs") {
        track(instance.attrs, "get", "");
      }
      return publicGetter(instance);
    } else if (
      // css module (injected by vue-loader)
      (cssModule = type.__cssModules) && (cssModule = cssModule[key])
    ) {
      return cssModule;
    } else if (ctx !== EMPTY_OBJ && hasOwn(ctx, key)) {
      accessCache[key] = 4 /* CONTEXT */;
      return ctx[key];
    } else if (
      // global properties
      globalProperties = appContext.config.globalProperties, hasOwn(globalProperties, key)
    ) {
      {
        return globalProperties[key];
      }
    } else ;
  },
  set({ _: instance }, key, value) {
    const { data, setupState, ctx } = instance;
    if (hasSetupBinding(setupState, key)) {
      setupState[key] = value;
      return true;
    } else if (__VUE_OPTIONS_API__ && data !== EMPTY_OBJ && hasOwn(data, key)) {
      data[key] = value;
      return true;
    } else if (hasOwn(instance.props, key)) {
      return false;
    }
    if (key[0] === "$" && key.slice(1) in instance) {
      return false;
    } else {
      {
        ctx[key] = value;
      }
    }
    return true;
  },
  has({
    _: { data, setupState, accessCache, ctx, appContext, props, type }
  }, key) {
    let cssModules;
    return !!(accessCache[key] || __VUE_OPTIONS_API__ && data !== EMPTY_OBJ && key[0] !== "$" && hasOwn(data, key) || hasSetupBinding(setupState, key) || hasOwn(props, key) || hasOwn(ctx, key) || hasOwn(publicPropertiesMap, key) || hasOwn(appContext.config.globalProperties, key) || (cssModules = type.__cssModules) && cssModules[key]);
  },
  defineProperty(target, key, descriptor) {
    if (descriptor.get != null) {
      target._.accessCache[key] = 0;
    } else if (hasOwn(descriptor, "value")) {
      this.set(target, key, descriptor.value, null);
    }
    return Reflect.defineProperty(target, key, descriptor);
  }
};
function normalizePropsOrEmits(props) {
  return isArray$1(props) ? props.reduce(
    (normalized, p) => (normalized[p] = null, normalized),
    {}
  ) : props;
}
let shouldCacheAccess = true;
function applyOptions(instance) {
  const options = resolveMergedOptions(instance);
  const publicThis = instance.proxy;
  const ctx = instance.ctx;
  shouldCacheAccess = false;
  if (options.beforeCreate) {
    callHook(options.beforeCreate, instance, "bc");
  }
  const {
    // state
    data: dataOptions,
    computed: computedOptions,
    methods,
    watch: watchOptions,
    provide: provideOptions,
    inject: injectOptions,
    // lifecycle
    created,
    beforeMount,
    mounted,
    beforeUpdate,
    updated,
    activated,
    deactivated,
    beforeDestroy,
    beforeUnmount,
    destroyed,
    unmounted,
    render,
    renderTracked,
    renderTriggered,
    errorCaptured,
    serverPrefetch,
    // public API
    expose,
    inheritAttrs,
    // assets
    components,
    directives,
    filters
  } = options;
  const checkDuplicateProperties = null;
  if (injectOptions) {
    resolveInjections(injectOptions, ctx, checkDuplicateProperties);
  }
  if (methods) {
    for (const key in methods) {
      const methodHandler = methods[key];
      if (isFunction(methodHandler)) {
        {
          ctx[key] = methodHandler.bind(publicThis);
        }
      }
    }
  }
  if (dataOptions) {
    const data = dataOptions.call(publicThis, publicThis);
    if (!isObject(data)) ; else {
      instance.data = reactive(data);
    }
  }
  shouldCacheAccess = true;
  if (computedOptions) {
    for (const key in computedOptions) {
      const opt = computedOptions[key];
      const get = isFunction(opt) ? opt.bind(publicThis, publicThis) : isFunction(opt.get) ? opt.get.bind(publicThis, publicThis) : NOOP;
      const set = !isFunction(opt) && isFunction(opt.set) ? opt.set.bind(publicThis) : NOOP;
      const c = computed({
        get,
        set
      });
      Object.defineProperty(ctx, key, {
        enumerable: true,
        configurable: true,
        get: () => c.value,
        set: (v) => c.value = v
      });
    }
  }
  if (watchOptions) {
    for (const key in watchOptions) {
      createWatcher(watchOptions[key], ctx, publicThis, key);
    }
  }
  if (provideOptions) {
    const provides = isFunction(provideOptions) ? provideOptions.call(publicThis) : provideOptions;
    Reflect.ownKeys(provides).forEach((key) => {
      provide(key, provides[key]);
    });
  }
  if (created) {
    callHook(created, instance, "c");
  }
  function registerLifecycleHook(register, hook) {
    if (isArray$1(hook)) {
      hook.forEach((_hook) => register(_hook.bind(publicThis)));
    } else if (hook) {
      register(hook.bind(publicThis));
    }
  }
  registerLifecycleHook(onBeforeMount, beforeMount);
  registerLifecycleHook(onMounted, mounted);
  registerLifecycleHook(onBeforeUpdate, beforeUpdate);
  registerLifecycleHook(onUpdated, updated);
  registerLifecycleHook(onActivated, activated);
  registerLifecycleHook(onDeactivated, deactivated);
  registerLifecycleHook(onErrorCaptured, errorCaptured);
  registerLifecycleHook(onRenderTracked, renderTracked);
  registerLifecycleHook(onRenderTriggered, renderTriggered);
  registerLifecycleHook(onBeforeUnmount, beforeUnmount);
  registerLifecycleHook(onUnmounted, unmounted);
  registerLifecycleHook(onServerPrefetch, serverPrefetch);
  if (isArray$1(expose)) {
    if (expose.length) {
      const exposed = instance.exposed || (instance.exposed = {});
      expose.forEach((key) => {
        Object.defineProperty(exposed, key, {
          get: () => publicThis[key],
          set: (val) => publicThis[key] = val,
          enumerable: true
        });
      });
    } else if (!instance.exposed) {
      instance.exposed = {};
    }
  }
  if (render && instance.render === NOOP) {
    instance.render = render;
  }
  if (inheritAttrs != null) {
    instance.inheritAttrs = inheritAttrs;
  }
  if (components) instance.components = components;
  if (directives) instance.directives = directives;
  if (serverPrefetch) {
    markAsyncBoundary(instance);
  }
}
function resolveInjections(injectOptions, ctx, checkDuplicateProperties = NOOP) {
  if (isArray$1(injectOptions)) {
    injectOptions = normalizeInject(injectOptions);
  }
  for (const key in injectOptions) {
    const opt = injectOptions[key];
    let injected;
    if (isObject(opt)) {
      if ("default" in opt) {
        injected = inject(
          opt.from || key,
          opt.default,
          true
        );
      } else {
        injected = inject(opt.from || key);
      }
    } else {
      injected = inject(opt);
    }
    if (isRef$1(injected)) {
      Object.defineProperty(ctx, key, {
        enumerable: true,
        configurable: true,
        get: () => injected.value,
        set: (v) => injected.value = v
      });
    } else {
      ctx[key] = injected;
    }
  }
}
function callHook(hook, instance, type) {
  callWithAsyncErrorHandling(
    isArray$1(hook) ? hook.map((h) => h.bind(instance.proxy)) : hook.bind(instance.proxy),
    instance,
    type
  );
}
function createWatcher(raw, ctx, publicThis, key) {
  let getter = key.includes(".") ? createPathGetter(publicThis, key) : () => publicThis[key];
  if (isString$1(raw)) {
    const handler = ctx[raw];
    if (isFunction(handler)) {
      {
        watch(getter, handler);
      }
    }
  } else if (isFunction(raw)) {
    {
      watch(getter, raw.bind(publicThis));
    }
  } else if (isObject(raw)) {
    if (isArray$1(raw)) {
      raw.forEach((r) => createWatcher(r, ctx, publicThis, key));
    } else {
      const handler = isFunction(raw.handler) ? raw.handler.bind(publicThis) : ctx[raw.handler];
      if (isFunction(handler)) {
        watch(getter, handler, raw);
      }
    }
  } else ;
}
function resolveMergedOptions(instance) {
  const base = instance.type;
  const { mixins, extends: extendsOptions } = base;
  const {
    mixins: globalMixins,
    optionsCache: cache,
    config: { optionMergeStrategies }
  } = instance.appContext;
  const cached = cache.get(base);
  let resolved;
  if (cached) {
    resolved = cached;
  } else if (!globalMixins.length && !mixins && !extendsOptions) {
    {
      resolved = base;
    }
  } else {
    resolved = {};
    if (globalMixins.length) {
      globalMixins.forEach(
        (m) => mergeOptions(resolved, m, optionMergeStrategies, true)
      );
    }
    mergeOptions(resolved, base, optionMergeStrategies);
  }
  if (isObject(base)) {
    cache.set(base, resolved);
  }
  return resolved;
}
function mergeOptions(to, from, strats, asMixin = false) {
  const { mixins, extends: extendsOptions } = from;
  if (extendsOptions) {
    mergeOptions(to, extendsOptions, strats, true);
  }
  if (mixins) {
    mixins.forEach(
      (m) => mergeOptions(to, m, strats, true)
    );
  }
  for (const key in from) {
    if (asMixin && key === "expose") ; else {
      const strat = internalOptionMergeStrats[key] || strats && strats[key];
      to[key] = strat ? strat(to[key], from[key]) : from[key];
    }
  }
  return to;
}
const internalOptionMergeStrats = {
  data: mergeDataFn,
  props: mergeEmitsOrPropsOptions,
  emits: mergeEmitsOrPropsOptions,
  // objects
  methods: mergeObjectOptions,
  computed: mergeObjectOptions,
  // lifecycle
  beforeCreate: mergeAsArray,
  created: mergeAsArray,
  beforeMount: mergeAsArray,
  mounted: mergeAsArray,
  beforeUpdate: mergeAsArray,
  updated: mergeAsArray,
  beforeDestroy: mergeAsArray,
  beforeUnmount: mergeAsArray,
  destroyed: mergeAsArray,
  unmounted: mergeAsArray,
  activated: mergeAsArray,
  deactivated: mergeAsArray,
  errorCaptured: mergeAsArray,
  serverPrefetch: mergeAsArray,
  // assets
  components: mergeObjectOptions,
  directives: mergeObjectOptions,
  // watch
  watch: mergeWatchOptions,
  // provide / inject
  provide: mergeDataFn,
  inject: mergeInject
};
function mergeDataFn(to, from) {
  if (!from) {
    return to;
  }
  if (!to) {
    return from;
  }
  return function mergedDataFn() {
    return (extend)(
      isFunction(to) ? to.call(this, this) : to,
      isFunction(from) ? from.call(this, this) : from
    );
  };
}
function mergeInject(to, from) {
  return mergeObjectOptions(normalizeInject(to), normalizeInject(from));
}
function normalizeInject(raw) {
  if (isArray$1(raw)) {
    const res = {};
    for (let i = 0; i < raw.length; i++) {
      res[raw[i]] = raw[i];
    }
    return res;
  }
  return raw;
}
function mergeAsArray(to, from) {
  return to ? [...new Set([].concat(to, from))] : from;
}
function mergeObjectOptions(to, from) {
  return to ? extend(/* @__PURE__ */ Object.create(null), to, from) : from;
}
function mergeEmitsOrPropsOptions(to, from) {
  if (to) {
    if (isArray$1(to) && isArray$1(from)) {
      return [.../* @__PURE__ */ new Set([...to, ...from])];
    }
    return extend(
      /* @__PURE__ */ Object.create(null),
      normalizePropsOrEmits(to),
      normalizePropsOrEmits(from != null ? from : {})
    );
  } else {
    return from;
  }
}
function mergeWatchOptions(to, from) {
  if (!to) return from;
  if (!from) return to;
  const merged = extend(/* @__PURE__ */ Object.create(null), to);
  for (const key in from) {
    merged[key] = mergeAsArray(to[key], from[key]);
  }
  return merged;
}

function createAppContext() {
  return {
    app: null,
    config: {
      isNativeTag: NO,
      performance: false,
      globalProperties: {},
      optionMergeStrategies: {},
      errorHandler: void 0,
      warnHandler: void 0,
      compilerOptions: {}
    },
    mixins: [],
    components: {},
    directives: {},
    provides: /* @__PURE__ */ Object.create(null),
    optionsCache: /* @__PURE__ */ new WeakMap(),
    propsCache: /* @__PURE__ */ new WeakMap(),
    emitsCache: /* @__PURE__ */ new WeakMap()
  };
}
let uid$1 = 0;
function createAppAPI(render, hydrate) {
  return function createApp(rootComponent, rootProps = null) {
    if (!isFunction(rootComponent)) {
      rootComponent = extend({}, rootComponent);
    }
    if (rootProps != null && !isObject(rootProps)) {
      rootProps = null;
    }
    const context = createAppContext();
    const installedPlugins = /* @__PURE__ */ new WeakSet();
    const pluginCleanupFns = [];
    let isMounted = false;
    const app = context.app = {
      _uid: uid$1++,
      _component: rootComponent,
      _props: rootProps,
      _container: null,
      _context: context,
      _instance: null,
      version,
      get config() {
        return context.config;
      },
      set config(v) {
      },
      use(plugin, ...options) {
        if (installedPlugins.has(plugin)) ; else if (plugin && isFunction(plugin.install)) {
          installedPlugins.add(plugin);
          plugin.install(app, ...options);
        } else if (isFunction(plugin)) {
          installedPlugins.add(plugin);
          plugin(app, ...options);
        } else ;
        return app;
      },
      mixin(mixin) {
        if (__VUE_OPTIONS_API__) {
          if (!context.mixins.includes(mixin)) {
            context.mixins.push(mixin);
          }
        }
        return app;
      },
      component(name, component) {
        if (!component) {
          return context.components[name];
        }
        context.components[name] = component;
        return app;
      },
      directive(name, directive) {
        if (!directive) {
          return context.directives[name];
        }
        context.directives[name] = directive;
        return app;
      },
      mount(rootContainer, isHydrate, namespace) {
        if (!isMounted) {
          const vnode = app._ceVNode || createVNode(rootComponent, rootProps);
          vnode.appContext = context;
          if (namespace === true) {
            namespace = "svg";
          } else if (namespace === false) {
            namespace = void 0;
          }
          {
            render(vnode, rootContainer, namespace);
          }
          isMounted = true;
          app._container = rootContainer;
          rootContainer.__vue_app__ = app;
          if (__VUE_PROD_DEVTOOLS__) {
            app._instance = vnode.component;
            devtoolsInitApp(app, version);
          }
          return getComponentPublicInstance(vnode.component);
        }
      },
      onUnmount(cleanupFn) {
        pluginCleanupFns.push(cleanupFn);
      },
      unmount() {
        if (isMounted) {
          callWithAsyncErrorHandling(
            pluginCleanupFns,
            app._instance,
            16
          );
          render(null, app._container);
          if (__VUE_PROD_DEVTOOLS__) {
            app._instance = null;
            devtoolsUnmountApp(app);
          }
          delete app._container.__vue_app__;
        }
      },
      provide(key, value) {
        context.provides[key] = value;
        return app;
      },
      runWithContext(fn) {
        const lastApp = currentApp;
        currentApp = app;
        try {
          return fn();
        } finally {
          currentApp = lastApp;
        }
      }
    };
    return app;
  };
}
let currentApp = null;
const getModelModifiers = (props, modelName) => {
  return modelName === "modelValue" || modelName === "model-value" ? props.modelModifiers : props[`${modelName}Modifiers`] || props[`${camelize(modelName)}Modifiers`] || props[`${hyphenate(modelName)}Modifiers`];
};

function emit(instance, event, ...rawArgs) {
  if (instance.isUnmounted) return;
  const props = instance.vnode.props || EMPTY_OBJ;
  let args = rawArgs;
  const isModelListener = event.startsWith("update:");
  const modifiers = isModelListener && getModelModifiers(props, event.slice(7));
  if (modifiers) {
    if (modifiers.trim) {
      args = rawArgs.map((a) => isString$1(a) ? a.trim() : a);
    }
    if (modifiers.number) {
      args = rawArgs.map(looseToNumber);
    }
  }
  if (__VUE_PROD_DEVTOOLS__) {
    devtoolsComponentEmit(instance, event, args);
  }
  let handlerName;
  let handler = props[handlerName = toHandlerKey(event)] || // also try camelCase event handler (#2249)
  props[handlerName = toHandlerKey(camelize(event))];
  if (!handler && isModelListener) {
    handler = props[handlerName = toHandlerKey(hyphenate(event))];
  }
  if (handler) {
    callWithAsyncErrorHandling(
      handler,
      instance,
      6,
      args
    );
  }
  const onceHandler = props[handlerName + `Once`];
  if (onceHandler) {
    if (!instance.emitted) {
      instance.emitted = {};
    } else if (instance.emitted[handlerName]) {
      return;
    }
    instance.emitted[handlerName] = true;
    callWithAsyncErrorHandling(
      onceHandler,
      instance,
      6,
      args
    );
  }
}
const mixinEmitsCache = /* @__PURE__ */ new WeakMap();
function normalizeEmitsOptions(comp, appContext, asMixin = false) {
  const cache = __VUE_OPTIONS_API__ && asMixin ? mixinEmitsCache : appContext.emitsCache;
  const cached = cache.get(comp);
  if (cached !== void 0) {
    return cached;
  }
  const raw = comp.emits;
  let normalized = {};
  let hasExtends = false;
  if (__VUE_OPTIONS_API__ && !isFunction(comp)) {
    const extendEmits = (raw2) => {
      const normalizedFromExtend = normalizeEmitsOptions(raw2, appContext, true);
      if (normalizedFromExtend) {
        hasExtends = true;
        extend(normalized, normalizedFromExtend);
      }
    };
    if (!asMixin && appContext.mixins.length) {
      appContext.mixins.forEach(extendEmits);
    }
    if (comp.extends) {
      extendEmits(comp.extends);
    }
    if (comp.mixins) {
      comp.mixins.forEach(extendEmits);
    }
  }
  if (!raw && !hasExtends) {
    if (isObject(comp)) {
      cache.set(comp, null);
    }
    return null;
  }
  if (isArray$1(raw)) {
    raw.forEach((key) => normalized[key] = null);
  } else {
    extend(normalized, raw);
  }
  if (isObject(comp)) {
    cache.set(comp, normalized);
  }
  return normalized;
}
function isEmitListener(options, key) {
  if (!options || !isOn(key)) {
    return false;
  }
  key = key.slice(2);
  key = key === "Once" ? key : key.replace(/Once$/, "");
  return hasOwn(options, key[0].toLowerCase() + key.slice(1)) || hasOwn(options, hyphenate(key)) || hasOwn(options, key);
}
function markAttrsAccessed() {
}
function renderComponentRoot(instance) {
  const {
    type: Component,
    vnode,
    proxy,
    withProxy,
    propsOptions: [propsOptions],
    slots,
    attrs,
    emit,
    render,
    renderCache,
    props,
    data,
    setupState,
    ctx,
    inheritAttrs
  } = instance;
  const prev = setCurrentRenderingInstance(instance);
  let result;
  let fallthroughAttrs;
  try {
    if (vnode.shapeFlag & 4) {
      const proxyToUse = withProxy || proxy;
      const thisProxy = !!("production" !== "production") && setupState.__isScriptSetup ? new Proxy(proxyToUse, {
        get(target, key, receiver) {
          warn$1(
            `Property '${String(
              key
            )}' was accessed via 'this'. Avoid using 'this' in templates.`
          );
          return Reflect.get(target, key, receiver);
        }
      }) : proxyToUse;
      result = normalizeVNode(
        render.call(
          thisProxy,
          proxyToUse,
          renderCache,
          !!("production" !== "production") ? shallowReadonly(props) : props,
          setupState,
          data,
          ctx
        )
      );
      fallthroughAttrs = attrs;
    } else {
      const render2 = Component;
      if (!!("production" !== "production") && attrs === props) ;
      result = normalizeVNode(
        render2.length > 1 ? render2(
          !!("production" !== "production") ? shallowReadonly(props) : props,
          !!("production" !== "production") ? {
            get attrs() {
              markAttrsAccessed();
              return shallowReadonly(attrs);
            },
            slots,
            emit
          } : { attrs, slots, emit }
        ) : render2(
          !!("production" !== "production") ? shallowReadonly(props) : props,
          null
        )
      );
      fallthroughAttrs = Component.props ? attrs : getFunctionalFallthrough(attrs);
    }
  } catch (err) {
    blockStack.length = 0;
    handleError(err, instance, 1);
    result = createVNode(Comment);
  }
  let root = result;
  if (fallthroughAttrs && inheritAttrs !== false) {
    const keys = Object.keys(fallthroughAttrs);
    const { shapeFlag } = root;
    if (keys.length) {
      if (shapeFlag & (1 | 6)) {
        if (propsOptions && keys.some(isModelListener)) {
          fallthroughAttrs = filterModelListeners(
            fallthroughAttrs,
            propsOptions
          );
        }
        root = cloneVNode(root, fallthroughAttrs, false, true);
      }
    }
  }
  if (vnode.dirs) {
    root = cloneVNode(root, null, false, true);
    root.dirs = root.dirs ? root.dirs.concat(vnode.dirs) : vnode.dirs;
  }
  if (vnode.transition) {
    const child = isTeleport(root.type) ? getInnerChild$1(root) || root : root;
    setTransitionHooks(child, vnode.transition);
  }
  {
    result = root;
  }
  setCurrentRenderingInstance(prev);
  return result;
}
const getFunctionalFallthrough = (attrs) => {
  let res;
  for (const key in attrs) {
    if (key === "class" || key === "style" || isOn(key)) {
      (res || (res = {}))[key] = attrs[key];
    }
  }
  return res;
};
const filterModelListeners = (attrs, props) => {
  const res = {};
  for (const key in attrs) {
    if (!isModelListener(key) || !(key.slice(9) in props)) {
      res[key] = attrs[key];
    }
  }
  return res;
};
function shouldUpdateComponent(prevVNode, nextVNode, optimized) {
  const { props: prevProps, children: prevChildren, component } = prevVNode;
  const { props: nextProps, children: nextChildren, patchFlag } = nextVNode;
  const emits = component.emitsOptions;
  if (nextVNode.dirs || nextVNode.transition) {
    return true;
  }
  if (optimized && patchFlag >= 0) {
    if (patchFlag & 1024) {
      return true;
    }
    if (patchFlag & 16) {
      if (!prevProps) {
        return !!nextProps;
      }
      return hasPropsChanged(prevProps, nextProps, emits);
    } else if (patchFlag & 8) {
      const dynamicProps = nextVNode.dynamicProps;
      for (let i = 0; i < dynamicProps.length; i++) {
        const key = dynamicProps[i];
        if (hasPropValueChanged(nextProps, prevProps, key) && !isEmitListener(emits, key)) {
          return true;
        }
      }
    }
  } else {
    if (prevChildren || nextChildren) {
      if (!nextChildren || !nextChildren.$stable) {
        return true;
      }
    }
    if (prevProps === nextProps) {
      return false;
    }
    if (!prevProps) {
      return !!nextProps;
    }
    if (!nextProps) {
      return true;
    }
    return hasPropsChanged(prevProps, nextProps, emits);
  }
  return false;
}
function hasPropsChanged(prevProps, nextProps, emitsOptions) {
  const nextKeys = Object.keys(nextProps);
  if (nextKeys.length !== Object.keys(prevProps).length) {
    return true;
  }
  for (let i = 0; i < nextKeys.length; i++) {
    const key = nextKeys[i];
    if (hasPropValueChanged(nextProps, prevProps, key) && !isEmitListener(emitsOptions, key)) {
      return true;
    }
  }
  return false;
}
function hasPropValueChanged(nextProps, prevProps, key) {
  const nextProp = nextProps[key];
  const prevProp = prevProps[key];
  if (key === "style" && isObject(nextProp) && isObject(prevProp)) {
    return !looseEqual(nextProp, prevProp);
  }
  return nextProp !== prevProp;
}
function updateHOCHostEl({ vnode, parent, suspense }, el) {
  while (parent) {
    const root = parent.subTree;
    if (root.suspense && root.suspense.activeBranch === vnode) {
      root.suspense.vnode.el = root.el = el;
      vnode = root;
    }
    if (root === vnode) {
      (vnode = parent.vnode).el = el;
      parent = parent.parent;
    } else {
      break;
    }
  }
  if (suspense && suspense.activeBranch === vnode) {
    suspense.vnode.el = el;
  }
}

const internalObjectProto = {};
const createInternalObject = () => Object.create(internalObjectProto);
const isInternalObject = (obj) => Object.getPrototypeOf(obj) === internalObjectProto;

function initProps(instance, rawProps, isStateful, isSSR = false) {
  const props = {};
  const attrs = createInternalObject();
  instance.propsDefaults = /* @__PURE__ */ Object.create(null);
  setFullProps(instance, rawProps, props, attrs);
  for (const key in instance.propsOptions[0]) {
    if (!(key in props)) {
      props[key] = void 0;
    }
  }
  if (isStateful) {
    instance.props = isSSR ? props : shallowReactive(props);
  } else {
    if (!instance.type.props) {
      instance.props = attrs;
    } else {
      instance.props = props;
    }
  }
  instance.attrs = attrs;
}
function updateProps(instance, rawProps, rawPrevProps, optimized) {
  const {
    props,
    attrs,
    vnode: { patchFlag }
  } = instance;
  const rawCurrentProps = toRaw$1(props);
  const [options] = instance.propsOptions;
  let hasAttrsChanged = false;
  if (
    // always force full diff in dev
    // - #1942 if hmr is enabled with sfc component
    // - vite#872 non-sfc component used by sfc component
    (optimized || patchFlag > 0) && !(patchFlag & 16)
  ) {
    if (patchFlag & 8) {
      const propsToUpdate = instance.vnode.dynamicProps;
      for (let i = 0; i < propsToUpdate.length; i++) {
        let key = propsToUpdate[i];
        if (isEmitListener(instance.emitsOptions, key)) {
          continue;
        }
        const value = rawProps[key];
        if (options) {
          if (hasOwn(attrs, key)) {
            if (value !== attrs[key]) {
              attrs[key] = value;
              hasAttrsChanged = true;
            }
          } else {
            const camelizedKey = camelize(key);
            props[camelizedKey] = resolvePropValue(
              options,
              rawCurrentProps,
              camelizedKey,
              value,
              instance,
              false
            );
          }
        } else {
          if (value !== attrs[key]) {
            attrs[key] = value;
            hasAttrsChanged = true;
          }
        }
      }
    }
  } else {
    if (setFullProps(instance, rawProps, props, attrs)) {
      hasAttrsChanged = true;
    }
    let kebabKey;
    for (const key in rawCurrentProps) {
      if (!rawProps || // for camelCase
      !hasOwn(rawProps, key) && // it's possible the original props was passed in as kebab-case
      // and converted to camelCase (#955)
      ((kebabKey = hyphenate(key)) === key || !hasOwn(rawProps, kebabKey))) {
        if (options) {
          if (rawPrevProps && // for camelCase
          (rawPrevProps[key] !== void 0 || // for kebab-case
          rawPrevProps[kebabKey] !== void 0)) {
            props[key] = resolvePropValue(
              options,
              rawCurrentProps,
              key,
              void 0,
              instance,
              true
            );
          }
        } else {
          delete props[key];
        }
      }
    }
    if (attrs !== rawCurrentProps) {
      for (const key in attrs) {
        if (!rawProps || !hasOwn(rawProps, key) && true) {
          delete attrs[key];
          hasAttrsChanged = true;
        }
      }
    }
  }
  if (hasAttrsChanged) {
    trigger(instance.attrs, "set", "");
  }
}
function setFullProps(instance, rawProps, props, attrs) {
  const [options, needCastKeys] = instance.propsOptions;
  let hasAttrsChanged = false;
  let rawCastValues;
  if (rawProps) {
    for (let key in rawProps) {
      if (isReservedProp(key)) {
        continue;
      }
      const value = rawProps[key];
      let camelKey;
      if (options && hasOwn(options, camelKey = camelize(key))) {
        if (!needCastKeys || !needCastKeys.includes(camelKey)) {
          props[camelKey] = value;
        } else {
          (rawCastValues || (rawCastValues = {}))[camelKey] = value;
        }
      } else if (!isEmitListener(instance.emitsOptions, key)) {
        if (!(key in attrs) || value !== attrs[key]) {
          attrs[key] = value;
          hasAttrsChanged = true;
        }
      }
    }
  }
  if (needCastKeys) {
    const rawCurrentProps = toRaw$1(props);
    const castValues = rawCastValues || EMPTY_OBJ;
    for (let i = 0; i < needCastKeys.length; i++) {
      const key = needCastKeys[i];
      props[key] = resolvePropValue(
        options,
        rawCurrentProps,
        key,
        castValues[key],
        instance,
        !hasOwn(castValues, key)
      );
    }
  }
  return hasAttrsChanged;
}
function resolvePropValue(options, props, key, value, instance, isAbsent) {
  const opt = options[key];
  if (opt != null) {
    const hasDefault = hasOwn(opt, "default");
    if (hasDefault && value === void 0) {
      const defaultValue = opt.default;
      if (opt.type !== Function && !opt.skipFactory && isFunction(defaultValue)) {
        const { propsDefaults } = instance;
        if (key in propsDefaults) {
          value = propsDefaults[key];
        } else {
          const reset = setCurrentInstance(instance);
          value = propsDefaults[key] = defaultValue.call(
            null,
            props
          );
          reset();
        }
      } else {
        value = defaultValue;
      }
      if (instance.ce) {
        instance.ce._setProp(key, value);
      }
    }
    if (opt[0 /* shouldCast */]) {
      if (isAbsent && !hasDefault) {
        value = false;
      } else if (opt[1 /* shouldCastTrue */] && (value === "" || value === hyphenate(key))) {
        value = true;
      }
    }
  }
  return value;
}
const mixinPropsCache = /* @__PURE__ */ new WeakMap();
function normalizePropsOptions(comp, appContext, asMixin = false) {
  const cache = __VUE_OPTIONS_API__ && asMixin ? mixinPropsCache : appContext.propsCache;
  const cached = cache.get(comp);
  if (cached) {
    return cached;
  }
  const raw = comp.props;
  const normalized = {};
  const needCastKeys = [];
  let hasExtends = false;
  if (__VUE_OPTIONS_API__ && !isFunction(comp)) {
    const extendProps = (raw2) => {
      hasExtends = true;
      const [props, keys] = normalizePropsOptions(raw2, appContext, true);
      extend(normalized, props);
      if (keys) needCastKeys.push(...keys);
    };
    if (!asMixin && appContext.mixins.length) {
      appContext.mixins.forEach(extendProps);
    }
    if (comp.extends) {
      extendProps(comp.extends);
    }
    if (comp.mixins) {
      comp.mixins.forEach(extendProps);
    }
  }
  if (!raw && !hasExtends) {
    if (isObject(comp)) {
      cache.set(comp, EMPTY_ARR);
    }
    return EMPTY_ARR;
  }
  if (isArray$1(raw)) {
    for (let i = 0; i < raw.length; i++) {
      const normalizedKey = camelize(raw[i]);
      if (validatePropName(normalizedKey)) {
        normalized[normalizedKey] = EMPTY_OBJ;
      }
    }
  } else if (raw) {
    for (const key in raw) {
      const normalizedKey = camelize(key);
      if (validatePropName(normalizedKey)) {
        const opt = raw[key];
        const prop = normalized[normalizedKey] = isArray$1(opt) || isFunction(opt) ? { type: opt } : extend({}, opt);
        const propType = prop.type;
        let shouldCast = false;
        let shouldCastTrue = true;
        if (isArray$1(propType)) {
          for (let index = 0; index < propType.length; ++index) {
            const type = propType[index];
            const typeName = isFunction(type) && type.name;
            if (typeName === "Boolean") {
              shouldCast = true;
              break;
            } else if (typeName === "String") {
              shouldCastTrue = false;
            }
          }
        } else {
          shouldCast = isFunction(propType) && propType.name === "Boolean";
        }
        prop[0 /* shouldCast */] = shouldCast;
        prop[1 /* shouldCastTrue */] = shouldCastTrue;
        if (shouldCast || hasOwn(prop, "default")) {
          needCastKeys.push(normalizedKey);
        }
      }
    }
  }
  const res = [normalized, needCastKeys];
  if (isObject(comp)) {
    cache.set(comp, res);
  }
  return res;
}
function validatePropName(key) {
  if (key[0] !== "$" && !isReservedProp(key)) {
    return true;
  }
  return false;
}

const isInternalKey = (key) => key === "_" || key === "_ctx" || key === "$stable";
const normalizeSlotValue = (value) => isArray$1(value) ? value.map(normalizeVNode) : [normalizeVNode(value)];
const normalizeSlot = (key, rawSlot, ctx) => {
  if (rawSlot._n) {
    return rawSlot;
  }
  const normalized = withCtx((...args) => {
    if (!!("production" !== "production") && currentInstance && !(ctx === null && currentRenderingInstance) && !(ctx && ctx.root !== currentInstance.root)) ;
    return normalizeSlotValue(rawSlot(...args));
  }, ctx);
  normalized._c = false;
  return normalized;
};
const normalizeObjectSlots = (rawSlots, slots, instance) => {
  const ctx = rawSlots._ctx;
  for (const key in rawSlots) {
    if (isInternalKey(key)) continue;
    const value = rawSlots[key];
    if (isFunction(value)) {
      slots[key] = normalizeSlot(key, value, ctx);
    } else if (value != null) {
      const normalized = normalizeSlotValue(value);
      slots[key] = () => normalized;
    }
  }
};
const normalizeVNodeSlots = (instance, children) => {
  const normalized = normalizeSlotValue(children);
  instance.slots.default = () => normalized;
};
const assignSlots = (slots, children, optimized) => {
  for (const key in children) {
    if (optimized || !isInternalKey(key)) {
      slots[key] = children[key];
    }
  }
};
const initSlots = (instance, children, optimized) => {
  const slots = instance.slots = createInternalObject();
  if (instance.vnode.shapeFlag & 32) {
    const type = children._;
    if (type) {
      assignSlots(slots, children, optimized);
      if (optimized) {
        def(slots, "_", type, true);
      }
    } else {
      normalizeObjectSlots(children, slots);
    }
  } else if (children) {
    normalizeVNodeSlots(instance, children);
  }
};
const updateSlots = (instance, children, optimized) => {
  const { vnode, slots } = instance;
  let needDeletionCheck = true;
  let deletionComparisonTarget = EMPTY_OBJ;
  if (vnode.shapeFlag & 32) {
    const type = children._;
    if (type) {
      if (optimized && type === 1) {
        needDeletionCheck = false;
      } else {
        assignSlots(slots, children, optimized);
      }
    } else {
      needDeletionCheck = !children.$stable;
      normalizeObjectSlots(children, slots);
    }
    deletionComparisonTarget = children;
  } else if (children) {
    normalizeVNodeSlots(instance, children);
    deletionComparisonTarget = { default: 1 };
  }
  if (needDeletionCheck) {
    for (const key in slots) {
      if (!isInternalKey(key) && deletionComparisonTarget[key] == null) {
        delete slots[key];
      }
    }
  }
};

function initFeatureFlags() {
  if (typeof __VUE_OPTIONS_API__ !== "boolean") {
    getGlobalThis().__VUE_OPTIONS_API__ = true;
  }
  if (typeof __VUE_PROD_DEVTOOLS__ !== "boolean") {
    getGlobalThis().__VUE_PROD_DEVTOOLS__ = false;
  }
  if (typeof __VUE_PROD_HYDRATION_MISMATCH_DETAILS__ !== "boolean") {
    getGlobalThis().__VUE_PROD_HYDRATION_MISMATCH_DETAILS__ = false;
  }
}

const queuePostRenderEffect = queueEffectWithSuspense ;
function createRenderer(options) {
  return baseCreateRenderer(options);
}
function baseCreateRenderer(options, createHydrationFns) {
  {
    initFeatureFlags();
  }
  const target = getGlobalThis();
  target.__VUE__ = true;
  if (__VUE_PROD_DEVTOOLS__) {
    setDevtoolsHook$1(target.__VUE_DEVTOOLS_GLOBAL_HOOK__, target);
  }
  const {
    insert: hostInsert,
    remove: hostRemove,
    patchProp: hostPatchProp,
    createElement: hostCreateElement,
    createText: hostCreateText,
    createComment: hostCreateComment,
    setText: hostSetText,
    setElementText: hostSetElementText,
    parentNode: hostParentNode,
    nextSibling: hostNextSibling,
    setScopeId: hostSetScopeId = NOOP,
    insertStaticContent: hostInsertStaticContent
  } = options;
  const patch = (n1, n2, container, anchor = null, parentComponent = null, parentSuspense = null, namespace = void 0, slotScopeIds = null, optimized = !!n2.dynamicChildren) => {
    if (n1 === n2) {
      return;
    }
    if (n1 && !isSameVNodeType(n1, n2)) {
      anchor = getNextHostNode(n1);
      unmount(n1, parentComponent, parentSuspense, true);
      n1 = null;
    }
    if (n2.patchFlag === -2) {
      optimized = false;
      n2.dynamicChildren = null;
    }
    const { type, ref, shapeFlag } = n2;
    switch (type) {
      case Text:
        processText(n1, n2, container, anchor);
        break;
      case Comment:
        processCommentNode(n1, n2, container, anchor);
        break;
      case Static:
        if (n1 == null) {
          mountStaticNode(n2, container, anchor, namespace);
        }
        break;
      case Fragment:
        processFragment(
          n1,
          n2,
          container,
          anchor,
          parentComponent,
          parentSuspense,
          namespace,
          slotScopeIds,
          optimized
        );
        break;
      default:
        if (shapeFlag & 1) {
          processElement(
            n1,
            n2,
            container,
            anchor,
            parentComponent,
            parentSuspense,
            namespace,
            slotScopeIds,
            optimized
          );
        } else if (shapeFlag & 6) {
          processComponent(
            n1,
            n2,
            container,
            anchor,
            parentComponent,
            parentSuspense,
            namespace,
            slotScopeIds,
            optimized
          );
        } else if (shapeFlag & 64) {
          type.process(
            n1,
            n2,
            container,
            anchor,
            parentComponent,
            parentSuspense,
            namespace,
            slotScopeIds,
            optimized,
            internals
          );
        } else if (shapeFlag & 128) {
          type.process(
            n1,
            n2,
            container,
            anchor,
            parentComponent,
            parentSuspense,
            namespace,
            slotScopeIds,
            optimized,
            internals
          );
        } else ;
    }
    if (ref != null && parentComponent) {
      setRef(ref, n1 && n1.ref, parentSuspense, n2 || n1, !n2);
    } else if (ref == null && n1 && n1.ref != null) {
      setRef(n1.ref, null, parentSuspense, n1, true);
    }
  };
  const processText = (n1, n2, container, anchor) => {
    if (n1 == null) {
      hostInsert(
        n2.el = hostCreateText(n2.children),
        container,
        anchor
      );
    } else {
      const el = n2.el = n1.el;
      if (n2.children !== n1.children) {
        hostSetText(el, n2.children);
      }
    }
  };
  const processCommentNode = (n1, n2, container, anchor) => {
    if (n1 == null) {
      hostInsert(
        n2.el = hostCreateComment(n2.children || ""),
        container,
        anchor
      );
    } else {
      n2.el = n1.el;
    }
  };
  const mountStaticNode = (n2, container, anchor, namespace) => {
    [n2.el, n2.anchor] = hostInsertStaticContent(
      n2.children,
      container,
      anchor,
      namespace,
      n2.el,
      n2.anchor
    );
  };
  const moveStaticNode = ({ el, anchor }, container, nextSibling) => {
    let next;
    while (el && el !== anchor) {
      next = hostNextSibling(el);
      hostInsert(el, container, nextSibling);
      el = next;
    }
    hostInsert(anchor, container, nextSibling);
  };
  const removeStaticNode = ({ el, anchor }) => {
    let next;
    while (el && el !== anchor) {
      next = hostNextSibling(el);
      hostRemove(el);
      el = next;
    }
    hostRemove(anchor);
  };
  const processElement = (n1, n2, container, anchor, parentComponent, parentSuspense, namespace, slotScopeIds, optimized) => {
    if (n2.type === "svg") {
      namespace = "svg";
    } else if (n2.type === "math") {
      namespace = "mathml";
    }
    if (n1 == null) {
      mountElement(
        n2,
        container,
        anchor,
        parentComponent,
        parentSuspense,
        namespace,
        slotScopeIds,
        optimized
      );
    } else {
      const customElement = n1.el && n1.el._isVueCE ? n1.el : null;
      try {
        if (customElement) {
          customElement._beginPatch();
        }
        patchElement(
          n1,
          n2,
          parentComponent,
          parentSuspense,
          namespace,
          slotScopeIds,
          optimized
        );
      } finally {
        if (customElement) {
          customElement._endPatch();
        }
      }
    }
  };
  const mountElement = (vnode, container, anchor, parentComponent, parentSuspense, namespace, slotScopeIds, optimized) => {
    let el;
    let vnodeHook;
    const { props, shapeFlag, transition, dirs } = vnode;
    el = vnode.el = hostCreateElement(
      vnode.type,
      namespace,
      props && props.is,
      props
    );
    if (shapeFlag & 8) {
      hostSetElementText(el, vnode.children);
    } else if (shapeFlag & 16) {
      mountChildren(
        vnode.children,
        el,
        null,
        parentComponent,
        parentSuspense,
        resolveChildrenNamespace(vnode, namespace),
        slotScopeIds,
        optimized
      );
    }
    if (dirs) {
      invokeDirectiveHook(vnode, null, parentComponent, "created");
    }
    setScopeId(el, vnode, vnode.scopeId, slotScopeIds, parentComponent);
    if (props) {
      for (const key in props) {
        if (key !== "value" && !isReservedProp(key)) {
          hostPatchProp(el, key, null, props[key], namespace, parentComponent);
        }
      }
      if ("value" in props) {
        hostPatchProp(el, "value", null, props.value, namespace);
      }
      if (vnodeHook = props.onVnodeBeforeMount) {
        invokeVNodeHook(vnodeHook, parentComponent, vnode);
      }
    }
    if (__VUE_PROD_DEVTOOLS__) {
      def(el, "__vnode", vnode, true);
      def(el, "__vueParentComponent", parentComponent, true);
    }
    if (dirs) {
      invokeDirectiveHook(vnode, null, parentComponent, "beforeMount");
    }
    const needCallTransitionHooks = needTransition(parentSuspense, transition);
    if (needCallTransitionHooks) {
      transition.beforeEnter(el);
    }
    hostInsert(el, container, anchor);
    if ((vnodeHook = props && props.onVnodeMounted) || needCallTransitionHooks || dirs) {
      queuePostRenderEffect(() => {
        try {
          vnodeHook && invokeVNodeHook(vnodeHook, parentComponent, vnode);
          needCallTransitionHooks && transition.enter(el);
          dirs && invokeDirectiveHook(vnode, null, parentComponent, "mounted");
        } finally {
        }
      }, parentSuspense);
    }
  };
  const setScopeId = (el, vnode, scopeId, slotScopeIds, parentComponent) => {
    if (scopeId) {
      hostSetScopeId(el, scopeId);
    }
    if (slotScopeIds) {
      for (let i = 0; i < slotScopeIds.length; i++) {
        hostSetScopeId(el, slotScopeIds[i]);
      }
    }
    if (parentComponent) {
      let subTree = parentComponent.subTree;
      if (vnode === subTree || isSuspense(subTree.type) && (subTree.ssContent === vnode || subTree.ssFallback === vnode)) {
        const parentVNode = parentComponent.vnode;
        setScopeId(
          el,
          parentVNode,
          parentVNode.scopeId,
          parentVNode.slotScopeIds,
          parentComponent.parent
        );
      }
    }
  };
  const mountChildren = (children, container, anchor, parentComponent, parentSuspense, namespace, slotScopeIds, optimized, start = 0) => {
    for (let i = start; i < children.length; i++) {
      const child = children[i] = optimized ? cloneIfMounted(children[i]) : normalizeVNode(children[i]);
      patch(
        null,
        child,
        container,
        anchor,
        parentComponent,
        parentSuspense,
        namespace,
        slotScopeIds,
        optimized
      );
    }
  };
  const patchElement = (n1, n2, parentComponent, parentSuspense, namespace, slotScopeIds, optimized) => {
    const el = n2.el = n1.el;
    if (__VUE_PROD_DEVTOOLS__) {
      el.__vnode = n2;
    }
    let { patchFlag, dynamicChildren, dirs } = n2;
    patchFlag |= n1.patchFlag & 16;
    const oldProps = n1.props || EMPTY_OBJ;
    const newProps = n2.props || EMPTY_OBJ;
    let vnodeHook;
    parentComponent && toggleRecurse(parentComponent, false);
    if (vnodeHook = newProps.onVnodeBeforeUpdate) {
      invokeVNodeHook(vnodeHook, parentComponent, n2, n1);
    }
    if (dirs) {
      invokeDirectiveHook(n2, n1, parentComponent, "beforeUpdate");
    }
    parentComponent && toggleRecurse(parentComponent, true);
    if (
      // HMR updated, force full diff
      // #6385 the old vnode may be a user-wrapped non-isomorphic block
      // Force full diff when block metadata is unstable.
      dynamicChildren && (!n1.dynamicChildren || n1.dynamicChildren.length !== dynamicChildren.length)
    ) {
      patchFlag = 0;
      optimized = false;
      dynamicChildren = null;
    }
    if (oldProps.innerHTML && newProps.innerHTML == null || oldProps.textContent && newProps.textContent == null) {
      hostSetElementText(el, "");
    }
    if (dynamicChildren) {
      patchBlockChildren(
        n1.dynamicChildren,
        dynamicChildren,
        el,
        parentComponent,
        parentSuspense,
        resolveChildrenNamespace(n2, namespace),
        slotScopeIds
      );
    } else if (!optimized) {
      patchChildren(
        n1,
        n2,
        el,
        null,
        parentComponent,
        parentSuspense,
        resolveChildrenNamespace(n2, namespace),
        slotScopeIds,
        false
      );
    }
    if (patchFlag > 0) {
      if (patchFlag & 16) {
        patchProps(el, oldProps, newProps, parentComponent, namespace);
      } else {
        if (patchFlag & 2) {
          if (oldProps.class !== newProps.class) {
            hostPatchProp(el, "class", null, newProps.class, namespace);
          }
        }
        if (patchFlag & 4) {
          hostPatchProp(el, "style", oldProps.style, newProps.style, namespace);
        }
        if (patchFlag & 8) {
          const propsToUpdate = n2.dynamicProps;
          for (let i = 0; i < propsToUpdate.length; i++) {
            const key = propsToUpdate[i];
            const prev = oldProps[key];
            const next = newProps[key];
            if (next !== prev || key === "value") {
              hostPatchProp(el, key, prev, next, namespace, parentComponent);
            }
          }
        }
      }
      if (patchFlag & 1) {
        if (n1.children !== n2.children) {
          hostSetElementText(el, n2.children);
        }
      }
    } else if (!optimized && dynamicChildren == null) {
      patchProps(el, oldProps, newProps, parentComponent, namespace);
    }
    if ((vnodeHook = newProps.onVnodeUpdated) || dirs) {
      queuePostRenderEffect(() => {
        vnodeHook && invokeVNodeHook(vnodeHook, parentComponent, n2, n1);
        dirs && invokeDirectiveHook(n2, n1, parentComponent, "updated");
      }, parentSuspense);
    }
  };
  const patchBlockChildren = (oldChildren, newChildren, fallbackContainer, parentComponent, parentSuspense, namespace, slotScopeIds) => {
    for (let i = 0; i < newChildren.length; i++) {
      const oldVNode = oldChildren[i];
      const newVNode = newChildren[i];
      const container = (
        // oldVNode may be an errored async setup() component inside Suspense
        // which will not have a mounted element
        oldVNode.el && // - In the case of a Fragment, we need to provide the actual parent
        // of the Fragment itself so it can move its children.
        (oldVNode.type === Fragment || // - In the case of different nodes, there is going to be a replacement
        // which also requires the correct parent container
        !isSameVNodeType(oldVNode, newVNode) || // - In the case of a component, it could contain anything.
        oldVNode.shapeFlag & (6 | 64 | 128)) ? hostParentNode(oldVNode.el) : (
          // In other cases, the parent container is not actually used so we
          // just pass the block element here to avoid a DOM parentNode call.
          fallbackContainer
        )
      );
      patch(
        oldVNode,
        newVNode,
        container,
        null,
        parentComponent,
        parentSuspense,
        namespace,
        slotScopeIds,
        true
      );
    }
  };
  const patchProps = (el, oldProps, newProps, parentComponent, namespace) => {
    if (oldProps !== newProps) {
      if (oldProps !== EMPTY_OBJ) {
        for (const key in oldProps) {
          if (!isReservedProp(key) && !(key in newProps)) {
            hostPatchProp(
              el,
              key,
              oldProps[key],
              null,
              namespace,
              parentComponent
            );
          }
        }
      }
      for (const key in newProps) {
        if (isReservedProp(key)) continue;
        const next = newProps[key];
        const prev = oldProps[key];
        if (next !== prev && key !== "value") {
          hostPatchProp(el, key, prev, next, namespace, parentComponent);
        }
      }
      if ("value" in newProps) {
        hostPatchProp(el, "value", oldProps.value, newProps.value, namespace);
      }
    }
  };
  const processFragment = (n1, n2, container, anchor, parentComponent, parentSuspense, namespace, slotScopeIds, optimized) => {
    const fragmentStartAnchor = n2.el = n1 ? n1.el : hostCreateText("");
    const fragmentEndAnchor = n2.anchor = n1 ? n1.anchor : hostCreateText("");
    let { patchFlag, dynamicChildren, slotScopeIds: fragmentSlotScopeIds } = n2;
    if (fragmentSlotScopeIds) {
      slotScopeIds = slotScopeIds ? slotScopeIds.concat(fragmentSlotScopeIds) : fragmentSlotScopeIds;
    }
    if (n1 == null) {
      hostInsert(fragmentStartAnchor, container, anchor);
      hostInsert(fragmentEndAnchor, container, anchor);
      mountChildren(
        // #10007
        // such fragment like `<></>` will be compiled into
        // a fragment which doesn't have a children.
        // In this case fallback to an empty array
        n2.children || [],
        container,
        fragmentEndAnchor,
        parentComponent,
        parentSuspense,
        namespace,
        slotScopeIds,
        optimized
      );
    } else {
      if (patchFlag > 0 && patchFlag & 64 && dynamicChildren && // #2715 the previous fragment could've been a BAILed one as a result
      // of renderSlot() with no valid children
      n1.dynamicChildren && n1.dynamicChildren.length === dynamicChildren.length) {
        patchBlockChildren(
          n1.dynamicChildren,
          dynamicChildren,
          container,
          parentComponent,
          parentSuspense,
          namespace,
          slotScopeIds
        );
        if (
          // #2080 if the stable fragment has a key, it's a <template v-for> that may
          //  get moved around. Make sure all root level vnodes inherit el.
          // #2134 or if it's a component root, it may also get moved around
          // as the component is being moved.
          n2.key != null || parentComponent && n2 === parentComponent.subTree
        ) {
          traverseStaticChildren(
            n1,
            n2,
            true
            /* shallow */
          );
        }
      } else {
        patchChildren(
          n1,
          n2,
          container,
          fragmentEndAnchor,
          parentComponent,
          parentSuspense,
          namespace,
          slotScopeIds,
          optimized
        );
      }
    }
  };
  const processComponent = (n1, n2, container, anchor, parentComponent, parentSuspense, namespace, slotScopeIds, optimized) => {
    n2.slotScopeIds = slotScopeIds;
    if (n1 == null) {
      if (n2.shapeFlag & 512) {
        parentComponent.ctx.activate(
          n2,
          container,
          anchor,
          namespace,
          optimized
        );
      } else {
        mountComponent(
          n2,
          container,
          anchor,
          parentComponent,
          parentSuspense,
          namespace,
          optimized
        );
      }
    } else {
      updateComponent(n1, n2, optimized);
    }
  };
  const mountComponent = (initialVNode, container, anchor, parentComponent, parentSuspense, namespace, optimized) => {
    const instance = (initialVNode.component = createComponentInstance(
      initialVNode,
      parentComponent,
      parentSuspense
    ));
    if (isKeepAlive(initialVNode)) {
      instance.ctx.renderer = internals;
    }
    {
      setupComponent(instance, false, optimized);
    }
    if (instance.asyncDep) {
      parentSuspense && parentSuspense.registerDep(instance, setupRenderEffect, optimized);
      if (!initialVNode.el) {
        const placeholder = instance.subTree = createVNode(Comment);
        processCommentNode(null, placeholder, container, anchor);
        initialVNode.placeholder = placeholder.el;
      }
    } else {
      setupRenderEffect(
        instance,
        initialVNode,
        container,
        anchor,
        parentSuspense,
        namespace,
        optimized
      );
    }
  };
  const updateComponent = (n1, n2, optimized) => {
    const instance = n2.component = n1.component;
    if (shouldUpdateComponent(n1, n2, optimized)) {
      if (instance.asyncDep && !instance.asyncResolved) {
        updateComponentPreRender(instance, n2, optimized);
        return;
      } else {
        instance.next = n2;
        instance.update();
      }
    } else {
      n2.el = n1.el;
      instance.vnode = n2;
    }
  };
  const setupRenderEffect = (instance, initialVNode, container, anchor, parentSuspense, namespace, optimized) => {
    const componentUpdateFn = () => {
      if (!instance.isMounted) {
        let vnodeHook;
        const { el, props } = initialVNode;
        const { bm, m, parent, root, type } = instance;
        const isAsyncWrapperVNode = isAsyncWrapper(initialVNode);
        toggleRecurse(instance, false);
        if (bm) {
          invokeArrayFns(bm);
        }
        if (!isAsyncWrapperVNode && (vnodeHook = props && props.onVnodeBeforeMount)) {
          invokeVNodeHook(vnodeHook, parent, initialVNode);
        }
        toggleRecurse(instance, true);
        {
          if (root.ce && root.ce._hasShadowRoot()) {
            root.ce._injectChildStyle(
              type,
              instance.parent ? instance.parent.type : void 0
            );
          }
          const subTree = instance.subTree = renderComponentRoot(instance);
          patch(
            null,
            subTree,
            container,
            anchor,
            instance,
            parentSuspense,
            namespace
          );
          initialVNode.el = subTree.el;
        }
        if (m) {
          queuePostRenderEffect(m, parentSuspense);
        }
        if (!isAsyncWrapperVNode && (vnodeHook = props && props.onVnodeMounted)) {
          const scopedInitialVNode = initialVNode;
          queuePostRenderEffect(
            () => invokeVNodeHook(vnodeHook, parent, scopedInitialVNode),
            parentSuspense
          );
        }
        if (initialVNode.shapeFlag & 256 || parent && isAsyncWrapper(parent.vnode) && parent.vnode.shapeFlag & 256) {
          instance.a && queuePostRenderEffect(instance.a, parentSuspense);
        }
        instance.isMounted = true;
        if (__VUE_PROD_DEVTOOLS__) {
          devtoolsComponentAdded(instance);
        }
        initialVNode = container = anchor = null;
      } else {
        let { next, bu, u, parent, vnode } = instance;
        {
          const nonHydratedAsyncRoot = locateNonHydratedAsyncRoot(instance);
          if (nonHydratedAsyncRoot) {
            if (next) {
              next.el = vnode.el;
              updateComponentPreRender(instance, next, optimized);
            }
            nonHydratedAsyncRoot.asyncDep.then(() => {
              queuePostRenderEffect(() => {
                if (!instance.isUnmounted) update();
              }, parentSuspense);
            });
            return;
          }
        }
        let originNext = next;
        let vnodeHook;
        toggleRecurse(instance, false);
        if (next) {
          next.el = vnode.el;
          updateComponentPreRender(instance, next, optimized);
        } else {
          next = vnode;
        }
        if (bu) {
          invokeArrayFns(bu);
        }
        if (vnodeHook = next.props && next.props.onVnodeBeforeUpdate) {
          invokeVNodeHook(vnodeHook, parent, next, vnode);
        }
        toggleRecurse(instance, true);
        const nextTree = renderComponentRoot(instance);
        const prevTree = instance.subTree;
        instance.subTree = nextTree;
        patch(
          prevTree,
          nextTree,
          // parent may have changed if it's in a teleport
          hostParentNode(prevTree.el),
          // anchor may have changed if it's in a fragment
          getNextHostNode(prevTree),
          instance,
          parentSuspense,
          namespace
        );
        next.el = nextTree.el;
        if (originNext === null) {
          updateHOCHostEl(instance, nextTree.el);
        }
        if (u) {
          queuePostRenderEffect(u, parentSuspense);
        }
        if (vnodeHook = next.props && next.props.onVnodeUpdated) {
          queuePostRenderEffect(
            () => invokeVNodeHook(vnodeHook, parent, next, vnode),
            parentSuspense
          );
        }
        if (__VUE_PROD_DEVTOOLS__) {
          devtoolsComponentUpdated(instance);
        }
      }
    };
    instance.scope.on();
    const effect = instance.effect = new ReactiveEffect(componentUpdateFn);
    instance.scope.off();
    const update = instance.update = effect.run.bind(effect);
    const job = instance.job = effect.runIfDirty.bind(effect);
    job.i = instance;
    job.id = instance.uid;
    effect.scheduler = () => queueJob(job);
    toggleRecurse(instance, true);
    update();
  };
  const updateComponentPreRender = (instance, nextVNode, optimized) => {
    nextVNode.component = instance;
    const prevProps = instance.vnode.props;
    instance.vnode = nextVNode;
    instance.next = null;
    updateProps(instance, nextVNode.props, prevProps, optimized);
    updateSlots(instance, nextVNode.children, optimized);
    pauseTracking();
    flushPreFlushCbs(instance);
    resetTracking();
  };
  const patchChildren = (n1, n2, container, anchor, parentComponent, parentSuspense, namespace, slotScopeIds, optimized = false) => {
    const c1 = n1 && n1.children;
    const prevShapeFlag = n1 ? n1.shapeFlag : 0;
    const c2 = n2.children;
    const { patchFlag, shapeFlag } = n2;
    if (patchFlag > 0) {
      if (patchFlag & 128) {
        patchKeyedChildren(
          c1,
          c2,
          container,
          anchor,
          parentComponent,
          parentSuspense,
          namespace,
          slotScopeIds,
          optimized
        );
        return;
      } else if (patchFlag & 256) {
        patchUnkeyedChildren(
          c1,
          c2,
          container,
          anchor,
          parentComponent,
          parentSuspense,
          namespace,
          slotScopeIds,
          optimized
        );
        return;
      }
    }
    if (shapeFlag & 8) {
      if (prevShapeFlag & 16) {
        unmountChildren(c1, parentComponent, parentSuspense);
      }
      if (c2 !== c1) {
        hostSetElementText(container, c2);
      }
    } else {
      if (prevShapeFlag & 16) {
        if (shapeFlag & 16) {
          patchKeyedChildren(
            c1,
            c2,
            container,
            anchor,
            parentComponent,
            parentSuspense,
            namespace,
            slotScopeIds,
            optimized
          );
        } else {
          unmountChildren(c1, parentComponent, parentSuspense, true);
        }
      } else {
        if (prevShapeFlag & 8) {
          hostSetElementText(container, "");
        }
        if (shapeFlag & 16) {
          mountChildren(
            c2,
            container,
            anchor,
            parentComponent,
            parentSuspense,
            namespace,
            slotScopeIds,
            optimized
          );
        }
      }
    }
  };
  const patchUnkeyedChildren = (c1, c2, container, anchor, parentComponent, parentSuspense, namespace, slotScopeIds, optimized) => {
    c1 = c1 || EMPTY_ARR;
    c2 = c2 || EMPTY_ARR;
    const oldLength = c1.length;
    const newLength = c2.length;
    const commonLength = Math.min(oldLength, newLength);
    let i;
    for (i = 0; i < commonLength; i++) {
      const nextChild = c2[i] = optimized ? cloneIfMounted(c2[i]) : normalizeVNode(c2[i]);
      patch(
        c1[i],
        nextChild,
        container,
        null,
        parentComponent,
        parentSuspense,
        namespace,
        slotScopeIds,
        optimized
      );
    }
    if (oldLength > newLength) {
      unmountChildren(
        c1,
        parentComponent,
        parentSuspense,
        true,
        false,
        commonLength
      );
    } else {
      mountChildren(
        c2,
        container,
        anchor,
        parentComponent,
        parentSuspense,
        namespace,
        slotScopeIds,
        optimized,
        commonLength
      );
    }
  };
  const patchKeyedChildren = (c1, c2, container, parentAnchor, parentComponent, parentSuspense, namespace, slotScopeIds, optimized) => {
    let i = 0;
    const l2 = c2.length;
    let e1 = c1.length - 1;
    let e2 = l2 - 1;
    while (i <= e1 && i <= e2) {
      const n1 = c1[i];
      const n2 = c2[i] = optimized ? cloneIfMounted(c2[i]) : normalizeVNode(c2[i]);
      if (isSameVNodeType(n1, n2)) {
        patch(
          n1,
          n2,
          container,
          null,
          parentComponent,
          parentSuspense,
          namespace,
          slotScopeIds,
          optimized
        );
      } else {
        break;
      }
      i++;
    }
    while (i <= e1 && i <= e2) {
      const n1 = c1[e1];
      const n2 = c2[e2] = optimized ? cloneIfMounted(c2[e2]) : normalizeVNode(c2[e2]);
      if (isSameVNodeType(n1, n2)) {
        patch(
          n1,
          n2,
          container,
          null,
          parentComponent,
          parentSuspense,
          namespace,
          slotScopeIds,
          optimized
        );
      } else {
        break;
      }
      e1--;
      e2--;
    }
    if (i > e1) {
      if (i <= e2) {
        const nextPos = e2 + 1;
        const anchor = nextPos < l2 ? c2[nextPos].el : parentAnchor;
        while (i <= e2) {
          patch(
            null,
            c2[i] = optimized ? cloneIfMounted(c2[i]) : normalizeVNode(c2[i]),
            container,
            anchor,
            parentComponent,
            parentSuspense,
            namespace,
            slotScopeIds,
            optimized
          );
          i++;
        }
      }
    } else if (i > e2) {
      while (i <= e1) {
        unmount(c1[i], parentComponent, parentSuspense, true);
        i++;
      }
    } else {
      const s1 = i;
      const s2 = i;
      const keyToNewIndexMap = /* @__PURE__ */ new Map();
      for (i = s2; i <= e2; i++) {
        const nextChild = c2[i] = optimized ? cloneIfMounted(c2[i]) : normalizeVNode(c2[i]);
        if (nextChild.key != null) {
          keyToNewIndexMap.set(nextChild.key, i);
        }
      }
      let j;
      let patched = 0;
      const toBePatched = e2 - s2 + 1;
      let moved = false;
      let maxNewIndexSoFar = 0;
      const newIndexToOldIndexMap = new Array(toBePatched);
      for (i = 0; i < toBePatched; i++) newIndexToOldIndexMap[i] = 0;
      for (i = s1; i <= e1; i++) {
        const prevChild = c1[i];
        if (patched >= toBePatched) {
          unmount(prevChild, parentComponent, parentSuspense, true);
          continue;
        }
        let newIndex;
        if (prevChild.key != null) {
          newIndex = keyToNewIndexMap.get(prevChild.key);
        } else {
          for (j = s2; j <= e2; j++) {
            if (newIndexToOldIndexMap[j - s2] === 0 && isSameVNodeType(prevChild, c2[j])) {
              newIndex = j;
              break;
            }
          }
        }
        if (newIndex === void 0) {
          unmount(prevChild, parentComponent, parentSuspense, true);
        } else {
          newIndexToOldIndexMap[newIndex - s2] = i + 1;
          if (newIndex >= maxNewIndexSoFar) {
            maxNewIndexSoFar = newIndex;
          } else {
            moved = true;
          }
          patch(
            prevChild,
            c2[newIndex],
            container,
            null,
            parentComponent,
            parentSuspense,
            namespace,
            slotScopeIds,
            optimized
          );
          patched++;
        }
      }
      const increasingNewIndexSequence = moved ? getSequence(newIndexToOldIndexMap) : EMPTY_ARR;
      j = increasingNewIndexSequence.length - 1;
      for (i = toBePatched - 1; i >= 0; i--) {
        const nextIndex = s2 + i;
        const nextChild = c2[nextIndex];
        const anchorVNode = c2[nextIndex + 1];
        const anchor = nextIndex + 1 < l2 ? (
          // #13559, #14173 fallback to el placeholder for unresolved async component
          anchorVNode.el || resolveAsyncComponentPlaceholder(anchorVNode)
        ) : parentAnchor;
        if (newIndexToOldIndexMap[i] === 0) {
          patch(
            null,
            nextChild,
            container,
            anchor,
            parentComponent,
            parentSuspense,
            namespace,
            slotScopeIds,
            optimized
          );
        } else if (moved) {
          if (j < 0 || i !== increasingNewIndexSequence[j]) {
            move(nextChild, container, anchor, 2);
          } else {
            j--;
          }
        }
      }
    }
  };
  const move = (vnode, container, anchor, moveType, parentSuspense = null) => {
    const { el, type, transition, children, shapeFlag } = vnode;
    if (shapeFlag & 6) {
      move(vnode.component.subTree, container, anchor, moveType);
      return;
    }
    if (shapeFlag & 128) {
      vnode.suspense.move(container, anchor, moveType);
      return;
    }
    if (shapeFlag & 64) {
      type.move(vnode, container, anchor, internals);
      return;
    }
    if (type === Fragment) {
      hostInsert(el, container, anchor);
      for (let i = 0; i < children.length; i++) {
        move(children[i], container, anchor, moveType);
      }
      hostInsert(vnode.anchor, container, anchor);
      return;
    }
    if (type === Static) {
      moveStaticNode(vnode, container, anchor);
      return;
    }
    const needTransition2 = moveType !== 2 && shapeFlag & 1 && transition;
    if (needTransition2) {
      if (moveType === 0) {
        if (transition.persisted && !el[leaveCbKey]) {
          hostInsert(el, container, anchor);
        } else {
          transition.beforeEnter(el);
          hostInsert(el, container, anchor);
          queuePostRenderEffect(() => transition.enter(el), parentSuspense);
        }
      } else {
        const { leave, delayLeave, afterLeave } = transition;
        const remove2 = () => {
          if (vnode.ctx.isUnmounted) {
            hostRemove(el);
          } else {
            hostInsert(el, container, anchor);
          }
        };
        const performLeave = () => {
          const wasLeaving = el._isLeaving || !!el[leaveCbKey];
          if (el._isLeaving) {
            el[leaveCbKey](
              true
              /* cancelled */
            );
          }
          if (transition.persisted && !wasLeaving) {
            remove2();
          } else {
            leave(el, () => {
              remove2();
              afterLeave && afterLeave();
            });
          }
        };
        if (delayLeave) {
          delayLeave(el, remove2, performLeave);
        } else {
          performLeave();
        }
      }
    } else {
      hostInsert(el, container, anchor);
    }
  };
  const unmount = (vnode, parentComponent, parentSuspense, doRemove = false, optimized = false) => {
    const {
      type,
      props,
      ref,
      children,
      dynamicChildren,
      shapeFlag,
      patchFlag,
      dirs,
      cacheIndex,
      memo
    } = vnode;
    if (patchFlag === -2) {
      optimized = false;
    }
    if (ref != null) {
      pauseTracking();
      setRef(ref, null, parentSuspense, vnode, true);
      resetTracking();
    }
    if (cacheIndex != null) {
      parentComponent.renderCache[cacheIndex] = void 0;
    }
    if (shapeFlag & 256) {
      parentComponent.ctx.deactivate(vnode);
      return;
    }
    const shouldInvokeDirs = shapeFlag & 1 && dirs;
    const shouldInvokeVnodeHook = !isAsyncWrapper(vnode);
    let vnodeHook;
    if (shouldInvokeVnodeHook && (vnodeHook = props && props.onVnodeBeforeUnmount)) {
      invokeVNodeHook(vnodeHook, parentComponent, vnode);
    }
    if (shapeFlag & 6) {
      unmountComponent(vnode.component, parentSuspense, doRemove);
    } else {
      if (shapeFlag & 128) {
        vnode.suspense.unmount(parentSuspense, doRemove);
        return;
      }
      if (shouldInvokeDirs) {
        invokeDirectiveHook(vnode, null, parentComponent, "beforeUnmount");
      }
      if (shapeFlag & 64) {
        vnode.type.remove(
          vnode,
          parentComponent,
          parentSuspense,
          internals,
          doRemove
        );
      } else if (dynamicChildren && // #5154
      // when v-once is used inside a block, setBlockTracking(-1) marks the
      // parent block with hasOnce: true
      // so that it doesn't take the fast path during unmount - otherwise
      // components nested in v-once are never unmounted.
      !dynamicChildren.hasOnce && // #1153: fast path should not be taken for non-stable (v-for) fragments
      (type !== Fragment || patchFlag > 0 && patchFlag & 64)) {
        unmountChildren(
          dynamicChildren,
          parentComponent,
          parentSuspense,
          false,
          true
        );
      } else if (type === Fragment && patchFlag & (128 | 256) || !optimized && shapeFlag & 16) {
        unmountChildren(children, parentComponent, parentSuspense);
      }
      if (doRemove) {
        remove(vnode);
      }
    }
    const shouldInvalidateMemo = memo != null && cacheIndex == null;
    if (shouldInvokeVnodeHook && (vnodeHook = props && props.onVnodeUnmounted) || shouldInvokeDirs || shouldInvalidateMemo) {
      queuePostRenderEffect(() => {
        vnodeHook && invokeVNodeHook(vnodeHook, parentComponent, vnode);
        shouldInvokeDirs && invokeDirectiveHook(vnode, null, parentComponent, "unmounted");
        if (shouldInvalidateMemo) {
          vnode.el = null;
        }
      }, parentSuspense);
    }
  };
  const remove = (vnode) => {
    const { type, el, anchor, transition } = vnode;
    if (type === Fragment) {
      {
        removeFragment(el, anchor);
      }
      return;
    }
    if (type === Static) {
      removeStaticNode(vnode);
      return;
    }
    const performRemove = () => {
      hostRemove(el);
      if (transition && !transition.persisted && transition.afterLeave) {
        transition.afterLeave();
      }
    };
    if (vnode.shapeFlag & 1 && transition && !transition.persisted) {
      const { leave, delayLeave } = transition;
      const performLeave = () => leave(el, performRemove);
      if (delayLeave) {
        delayLeave(vnode.el, performRemove, performLeave);
      } else {
        performLeave();
      }
    } else {
      performRemove();
    }
  };
  const removeFragment = (cur, end) => {
    let next;
    while (cur !== end) {
      next = hostNextSibling(cur);
      hostRemove(cur);
      cur = next;
    }
    hostRemove(end);
  };
  const unmountComponent = (instance, parentSuspense, doRemove) => {
    const { bum, scope, job, subTree, um, m, a } = instance;
    invalidateMount(m);
    invalidateMount(a);
    if (bum) {
      invokeArrayFns(bum);
    }
    scope.stop();
    if (job) {
      job.flags |= 8;
      unmount(subTree, instance, parentSuspense, doRemove);
    }
    if (um) {
      queuePostRenderEffect(um, parentSuspense);
    }
    queuePostRenderEffect(() => {
      instance.isUnmounted = true;
    }, parentSuspense);
    if (__VUE_PROD_DEVTOOLS__) {
      devtoolsComponentRemoved(instance);
    }
  };
  const unmountChildren = (children, parentComponent, parentSuspense, doRemove = false, optimized = false, start = 0) => {
    for (let i = start; i < children.length; i++) {
      unmount(children[i], parentComponent, parentSuspense, doRemove, optimized);
    }
  };
  const getNextHostNode = (vnode) => {
    if (vnode.shapeFlag & 6) {
      return getNextHostNode(vnode.component.subTree);
    }
    if (vnode.shapeFlag & 128) {
      return vnode.suspense.next();
    }
    const el = hostNextSibling(vnode.anchor || vnode.el);
    const teleportEnd = el && el[TeleportEndKey];
    return teleportEnd ? hostNextSibling(teleportEnd) : el;
  };
  let isFlushing = false;
  const render = (vnode, container, namespace) => {
    let instance;
    if (vnode == null) {
      if (container._vnode) {
        unmount(container._vnode, null, null, true);
        instance = container._vnode.component;
      }
    } else {
      patch(
        container._vnode || null,
        vnode,
        container,
        null,
        null,
        null,
        namespace
      );
    }
    container._vnode = vnode;
    if (!isFlushing) {
      isFlushing = true;
      flushPreFlushCbs(instance);
      flushPostFlushCbs();
      isFlushing = false;
    }
  };
  const internals = {
    p: patch,
    um: unmount,
    m: move,
    r: remove,
    mt: mountComponent,
    mc: mountChildren,
    pc: patchChildren,
    pbc: patchBlockChildren,
    n: getNextHostNode,
    o: options
  };
  let hydrate;
  return {
    render,
    hydrate,
    createApp: createAppAPI(render)
  };
}
function resolveChildrenNamespace({ type, props }, currentNamespace) {
  return currentNamespace === "svg" && type === "foreignObject" || currentNamespace === "mathml" && type === "annotation-xml" && props && props.encoding && props.encoding.includes("html") ? void 0 : currentNamespace;
}
function toggleRecurse({ effect, job }, allowed) {
  if (allowed) {
    effect.flags |= 32;
    job.flags |= 4;
  } else {
    effect.flags &= -33;
    job.flags &= -5;
  }
}
function needTransition(parentSuspense, transition) {
  return (!parentSuspense || parentSuspense && !parentSuspense.pendingBranch) && transition && !transition.persisted;
}
function traverseStaticChildren(n1, n2, shallow = false) {
  const ch1 = n1.children;
  const ch2 = n2.children;
  if (isArray$1(ch1) && isArray$1(ch2)) {
    for (let i = 0; i < ch1.length; i++) {
      const c1 = ch1[i];
      let c2 = ch2[i];
      if (c2.shapeFlag & 1 && !c2.dynamicChildren) {
        if (c2.patchFlag <= 0 || c2.patchFlag === 32) {
          c2 = ch2[i] = cloneIfMounted(ch2[i]);
          c2.el = c1.el;
        }
        if (!shallow && c2.patchFlag !== -2)
          traverseStaticChildren(c1, c2);
      }
      if (c2.type === Text) {
        if (c2.patchFlag === -1) {
          c2 = ch2[i] = cloneIfMounted(c2);
        }
        c2.el = c1.el;
      }
      if (c2.type === Comment && !c2.el) {
        c2.el = c1.el;
      }
    }
  }
}
function getSequence(arr) {
  const p = arr.slice();
  const result = [0];
  let i, j, u, v, c;
  const len = arr.length;
  for (i = 0; i < len; i++) {
    const arrI = arr[i];
    if (arrI !== 0) {
      j = result[result.length - 1];
      if (arr[j] < arrI) {
        p[i] = j;
        result.push(i);
        continue;
      }
      u = 0;
      v = result.length - 1;
      while (u < v) {
        c = u + v >> 1;
        if (arr[result[c]] < arrI) {
          u = c + 1;
        } else {
          v = c;
        }
      }
      if (arrI < arr[result[u]]) {
        if (u > 0) {
          p[i] = result[u - 1];
        }
        result[u] = i;
      }
    }
  }
  u = result.length;
  v = result[u - 1];
  while (u-- > 0) {
    result[u] = v;
    v = p[v];
  }
  return result;
}
function locateNonHydratedAsyncRoot(instance) {
  const subComponent = instance.subTree.component;
  if (subComponent) {
    if (subComponent.asyncDep && !subComponent.asyncResolved) {
      return subComponent;
    } else {
      return locateNonHydratedAsyncRoot(subComponent);
    }
  }
}
function invalidateMount(hooks) {
  if (hooks) {
    for (let i = 0; i < hooks.length; i++)
      hooks[i].flags |= 8;
  }
}
function resolveAsyncComponentPlaceholder(anchorVnode) {
  if (anchorVnode.placeholder) {
    return anchorVnode.placeholder;
  }
  const instance = anchorVnode.component;
  if (instance) {
    return resolveAsyncComponentPlaceholder(instance.subTree);
  }
  return null;
}

const isSuspense = (type) => type.__isSuspense;
function queueEffectWithSuspense(fn, suspense) {
  if (suspense && suspense.pendingBranch) {
    if (isArray$1(fn)) {
      suspense.effects.push(...fn);
    } else {
      suspense.effects.push(fn);
    }
  } else {
    queuePostFlushCb(fn);
  }
}

const Fragment = /* @__PURE__ */ Symbol.for("v-fgt");
const Text = /* @__PURE__ */ Symbol.for("v-txt");
const Comment = /* @__PURE__ */ Symbol.for("v-cmt");
const Static = /* @__PURE__ */ Symbol.for("v-stc");
const blockStack = [];
let currentBlock = null;
function closeBlock() {
  blockStack.pop();
  currentBlock = blockStack[blockStack.length - 1] || null;
}
let isBlockTreeEnabled = 1;
function setBlockTracking(value, inVOnce = false) {
  isBlockTreeEnabled += value;
  if (value < 0 && currentBlock && inVOnce) {
    currentBlock.hasOnce = true;
  }
}
function isVNode(value) {
  return value ? value.__v_isVNode === true : false;
}
function isSameVNodeType(n1, n2) {
  return n1.type === n2.type && n1.key === n2.key;
}
const normalizeKey = ({ key }) => key != null ? key : null;
const normalizeRef = ({
  ref,
  ref_key,
  ref_for
}) => {
  if (typeof ref === "number") {
    ref = "" + ref;
  }
  return ref != null ? isString$1(ref) || isRef$1(ref) || isFunction(ref) ? { i: currentRenderingInstance, r: ref, k: ref_key, f: !!ref_for } : ref : null;
};
function createBaseVNode(type, props = null, children = null, patchFlag = 0, dynamicProps = null, shapeFlag = type === Fragment ? 0 : 1, isBlockNode = false, needFullChildrenNormalization = false) {
  const vnode = {
    __v_isVNode: true,
    __v_skip: true,
    type,
    props,
    key: props && normalizeKey(props),
    ref: props && normalizeRef(props),
    scopeId: currentScopeId,
    slotScopeIds: null,
    children,
    component: null,
    suspense: null,
    ssContent: null,
    ssFallback: null,
    dirs: null,
    transition: null,
    el: null,
    anchor: null,
    target: null,
    targetStart: null,
    targetAnchor: null,
    staticCount: 0,
    shapeFlag,
    patchFlag,
    dynamicProps,
    dynamicChildren: null,
    appContext: null,
    ctx: currentRenderingInstance
  };
  if (needFullChildrenNormalization) {
    normalizeChildren(vnode, children);
    if (shapeFlag & 128) {
      type.normalize(vnode);
    }
  } else if (children) {
    vnode.shapeFlag |= isString$1(children) ? 8 : 16;
  }
  if (isBlockTreeEnabled > 0 && // avoid a block node from tracking itself
  !isBlockNode && // has current parent block
  currentBlock && // presence of a patch flag indicates this node needs patching on updates.
  // component nodes also should always be patched, because even if the
  // component doesn't need to update, it needs to persist the instance on to
  // the next vnode so that it can be properly unmounted later.
  (vnode.patchFlag > 0 || shapeFlag & 6) && // the EVENTS flag is only for hydration and if it is the only flag, the
  // vnode should not be considered dynamic due to handler caching.
  vnode.patchFlag !== 32) {
    currentBlock.push(vnode);
  }
  return vnode;
}
const createVNode = _createVNode;
function _createVNode(type, props = null, children = null, patchFlag = 0, dynamicProps = null, isBlockNode = false) {
  if (!type || type === NULL_DYNAMIC_COMPONENT) {
    type = Comment;
  }
  if (isVNode(type)) {
    const cloned = cloneVNode(
      type,
      props,
      true
      /* mergeRef: true */
    );
    if (children) {
      normalizeChildren(cloned, children);
    }
    if (isBlockTreeEnabled > 0 && !isBlockNode && currentBlock) {
      if (cloned.shapeFlag & 6) {
        currentBlock[currentBlock.indexOf(type)] = cloned;
      } else {
        currentBlock.push(cloned);
      }
    }
    cloned.patchFlag = -2;
    return cloned;
  }
  if (isClassComponent(type)) {
    type = type.__vccOpts;
  }
  if (props) {
    props = guardReactiveProps(props);
    let { class: klass, style } = props;
    if (klass && !isString$1(klass)) {
      props.class = normalizeClass(klass);
    }
    if (isObject(style)) {
      if (isProxy(style) && !isArray$1(style)) {
        style = extend({}, style);
      }
      props.style = normalizeStyle(style);
    }
  }
  const shapeFlag = isString$1(type) ? 1 : isSuspense(type) ? 128 : isTeleport(type) ? 64 : isObject(type) ? 4 : isFunction(type) ? 2 : 0;
  return createBaseVNode(
    type,
    props,
    children,
    patchFlag,
    dynamicProps,
    shapeFlag,
    isBlockNode,
    true
  );
}
function guardReactiveProps(props) {
  if (!props) return null;
  return isProxy(props) || isInternalObject(props) ? extend({}, props) : props;
}
function cloneVNode(vnode, extraProps, mergeRef = false, cloneTransition = false) {
  const { props, ref, patchFlag, children, transition } = vnode;
  const mergedProps = extraProps ? mergeProps(props || {}, extraProps) : props;
  const cloned = {
    __v_isVNode: true,
    __v_skip: true,
    type: vnode.type,
    props: mergedProps,
    key: mergedProps && normalizeKey(mergedProps),
    ref: extraProps && extraProps.ref ? (
      // #2078 in the case of <component :is="vnode" ref="extra"/>
      // if the vnode itself already has a ref, cloneVNode will need to merge
      // the refs so the single vnode can be set on multiple refs
      mergeRef && ref ? isArray$1(ref) ? ref.concat(normalizeRef(extraProps)) : [ref, normalizeRef(extraProps)] : normalizeRef(extraProps)
    ) : ref,
    scopeId: vnode.scopeId,
    slotScopeIds: vnode.slotScopeIds,
    children: children,
    target: vnode.target,
    targetStart: vnode.targetStart,
    targetAnchor: vnode.targetAnchor,
    staticCount: vnode.staticCount,
    shapeFlag: vnode.shapeFlag,
    // if the vnode is cloned with extra props, we can no longer assume its
    // existing patch flag to be reliable and need to add the FULL_PROPS flag.
    // note: preserve flag for fragments since they use the flag for children
    // fast paths only.
    patchFlag: extraProps && vnode.type !== Fragment ? patchFlag === -1 ? 16 : patchFlag | 16 : patchFlag,
    dynamicProps: vnode.dynamicProps,
    dynamicChildren: vnode.dynamicChildren,
    appContext: vnode.appContext,
    dirs: vnode.dirs,
    transition,
    // These should technically only be non-null on mounted VNodes. However,
    // they *should* be copied for kept-alive vnodes. So we just always copy
    // them since them being non-null during a mount doesn't affect the logic as
    // they will simply be overwritten.
    component: vnode.component,
    suspense: vnode.suspense,
    ssContent: vnode.ssContent && cloneVNode(vnode.ssContent),
    ssFallback: vnode.ssFallback && cloneVNode(vnode.ssFallback),
    placeholder: vnode.placeholder,
    el: vnode.el,
    anchor: vnode.anchor,
    ctx: vnode.ctx,
    ce: vnode.ce
  };
  if (transition && cloneTransition) {
    setTransitionHooks(
      cloned,
      transition.clone(cloned)
    );
  }
  return cloned;
}
function createTextVNode(text = " ", flag = 0) {
  return createVNode(Text, null, text, flag);
}
function normalizeVNode(child) {
  if (child == null || typeof child === "boolean") {
    return createVNode(Comment);
  } else if (isArray$1(child)) {
    return createVNode(
      Fragment,
      null,
      // #3666, avoid reference pollution when reusing vnode
      child.slice()
    );
  } else if (isVNode(child)) {
    return cloneIfMounted(child);
  } else {
    return createVNode(Text, null, String(child));
  }
}
function cloneIfMounted(child) {
  return child.el === null && child.patchFlag !== -1 || child.memo ? child : cloneVNode(child);
}
function normalizeChildren(vnode, children) {
  let type = 0;
  const { shapeFlag } = vnode;
  if (children == null) {
    children = null;
  } else if (isArray$1(children)) {
    type = 16;
  } else if (typeof children === "object") {
    if (shapeFlag & (1 | 64)) {
      const slot = children.default;
      if (slot) {
        slot._c && (slot._d = false);
        normalizeChildren(vnode, slot());
        slot._c && (slot._d = true);
      }
      return;
    } else {
      type = 32;
      const slotFlag = children._;
      if (!slotFlag && !isInternalObject(children)) {
        children._ctx = currentRenderingInstance;
      } else if (slotFlag === 3 && currentRenderingInstance) {
        if (currentRenderingInstance.slots._ === 1) {
          children._ = 1;
        } else {
          children._ = 2;
          vnode.patchFlag |= 1024;
        }
      }
    }
  } else if (isFunction(children)) {
    if (shapeFlag & (1 | 64)) {
      normalizeChildren(vnode, { default: children });
      return;
    }
    children = { default: children, _ctx: currentRenderingInstance };
    type = 32;
  } else {
    children = String(children);
    if (shapeFlag & 64) {
      type = 16;
      children = [createTextVNode(children)];
    } else {
      type = 8;
    }
  }
  vnode.children = children;
  vnode.shapeFlag |= type;
}
function mergeProps(...args) {
  const ret = {};
  for (let i = 0; i < args.length; i++) {
    const toMerge = args[i];
    for (const key in toMerge) {
      if (key === "class") {
        if (ret.class !== toMerge.class) {
          ret.class = normalizeClass([ret.class, toMerge.class]);
        }
      } else if (key === "style") {
        ret.style = normalizeStyle([ret.style, toMerge.style]);
      } else if (isOn(key)) {
        const existing = ret[key];
        const incoming = toMerge[key];
        if (incoming && existing !== incoming && !(isArray$1(existing) && existing.includes(incoming))) {
          ret[key] = existing ? [].concat(existing, incoming) : incoming;
        } else if (incoming == null && existing == null && // mergeProps({ 'onUpdate:modelValue': undefined }) should not retain
        // the model listener.
        !isModelListener(key)) {
          ret[key] = incoming;
        }
      } else if (key !== "") {
        ret[key] = toMerge[key];
      }
    }
  }
  return ret;
}
function invokeVNodeHook(hook, instance, vnode, prevVNode = null) {
  callWithAsyncErrorHandling(hook, instance, 7, [
    vnode,
    prevVNode
  ]);
}

const emptyAppContext = createAppContext();
let uid = 0;
function createComponentInstance(vnode, parent, suspense) {
  const type = vnode.type;
  const appContext = (parent ? parent.appContext : vnode.appContext) || emptyAppContext;
  const instance = {
    uid: uid++,
    vnode,
    type,
    parent,
    appContext,
    root: null,
    // to be immediately set
    next: null,
    subTree: null,
    // will be set synchronously right after creation
    effect: null,
    update: null,
    // will be set synchronously right after creation
    job: null,
    scope: new EffectScope(
      true
      /* detached */
    ),
    render: null,
    proxy: null,
    exposed: null,
    exposeProxy: null,
    withProxy: null,
    provides: parent ? parent.provides : Object.create(appContext.provides),
    ids: parent ? parent.ids : ["", 0, 0],
    accessCache: null,
    renderCache: [],
    // local resolved assets
    components: null,
    directives: null,
    // resolved props and emits options
    propsOptions: normalizePropsOptions(type, appContext),
    emitsOptions: normalizeEmitsOptions(type, appContext),
    // emit
    emit: null,
    // to be set immediately
    emitted: null,
    // props default value
    propsDefaults: EMPTY_OBJ,
    // inheritAttrs
    inheritAttrs: type.inheritAttrs,
    // state
    ctx: EMPTY_OBJ,
    data: EMPTY_OBJ,
    props: EMPTY_OBJ,
    attrs: EMPTY_OBJ,
    slots: EMPTY_OBJ,
    refs: EMPTY_OBJ,
    setupState: EMPTY_OBJ,
    setupContext: null,
    // suspense related
    suspense,
    suspenseId: suspense ? suspense.pendingId : 0,
    asyncDep: null,
    asyncResolved: false,
    // lifecycle hooks
    // not using enums here because it results in computed properties
    isMounted: false,
    isUnmounted: false,
    isDeactivated: false,
    bc: null,
    c: null,
    bm: null,
    m: null,
    bu: null,
    u: null,
    um: null,
    bum: null,
    da: null,
    a: null,
    rtg: null,
    rtc: null,
    ec: null,
    sp: null
  };
  {
    instance.ctx = { _: instance };
  }
  instance.root = parent ? parent.root : instance;
  instance.emit = emit.bind(null, instance);
  if (vnode.ce) {
    vnode.ce(instance);
  }
  return instance;
}
let currentInstance = null;
const getCurrentInstance = () => currentInstance || currentRenderingInstance;
let internalSetCurrentInstance;
let setInSSRSetupState;
{
  const g = getGlobalThis();
  const registerGlobalSetter = (key, setter) => {
    let setters;
    if (!(setters = g[key])) setters = g[key] = [];
    setters.push(setter);
    return (v) => {
      if (setters.length > 1) setters.forEach((set) => set(v));
      else setters[0](v);
    };
  };
  internalSetCurrentInstance = registerGlobalSetter(
    `__VUE_INSTANCE_SETTERS__`,
    (v) => currentInstance = v
  );
  setInSSRSetupState = registerGlobalSetter(
    `__VUE_SSR_SETTERS__`,
    (v) => isInSSRComponentSetup = v
  );
}
const setCurrentInstance = (instance) => {
  const prev = currentInstance;
  internalSetCurrentInstance(instance);
  instance.scope.on();
  return () => {
    instance.scope.off();
    internalSetCurrentInstance(prev);
  };
};
const unsetCurrentInstance = () => {
  currentInstance && currentInstance.scope.off();
  internalSetCurrentInstance(null);
};
function isStatefulComponent(instance) {
  return instance.vnode.shapeFlag & 4;
}
let isInSSRComponentSetup = false;
function setupComponent(instance, isSSR = false, optimized = false) {
  isSSR && setInSSRSetupState(isSSR);
  const { props, children } = instance.vnode;
  const isStateful = isStatefulComponent(instance);
  initProps(instance, props, isStateful, isSSR);
  initSlots(instance, children, optimized || isSSR);
  const setupResult = isStateful ? setupStatefulComponent(instance, isSSR) : void 0;
  isSSR && setInSSRSetupState(false);
  return setupResult;
}
function setupStatefulComponent(instance, isSSR) {
  const Component = instance.type;
  instance.accessCache = /* @__PURE__ */ Object.create(null);
  instance.proxy = new Proxy(instance.ctx, PublicInstanceProxyHandlers);
  const { setup } = Component;
  if (setup) {
    pauseTracking();
    const setupContext = instance.setupContext = setup.length > 1 ? createSetupContext(instance) : null;
    const reset = setCurrentInstance(instance);
    const setupResult = callWithErrorHandling(
      setup,
      instance,
      0,
      [
        instance.props,
        setupContext
      ]
    );
    const isAsyncSetup = isPromise(setupResult);
    resetTracking();
    reset();
    if ((isAsyncSetup || instance.sp) && !isAsyncWrapper(instance)) {
      markAsyncBoundary(instance);
    }
    if (isAsyncSetup) {
      setupResult.then(unsetCurrentInstance, unsetCurrentInstance);
      if (isSSR) {
        return setupResult.then((resolvedResult) => {
          setInSSRSetupState(true);
          try {
            handleSetupResult(instance, resolvedResult, isSSR);
          } finally {
            setInSSRSetupState(false);
          }
        }).catch((e) => {
          handleError(e, instance, 0);
        });
      } else {
        instance.asyncDep = setupResult;
      }
    } else {
      handleSetupResult(instance, setupResult);
    }
  } else {
    finishComponentSetup(instance);
  }
}
function handleSetupResult(instance, setupResult, isSSR) {
  if (isFunction(setupResult)) {
    if (instance.type.__ssrInlineRender) {
      instance.ssrRender = setupResult;
    } else {
      instance.render = setupResult;
    }
  } else if (isObject(setupResult)) {
    if (__VUE_PROD_DEVTOOLS__) {
      instance.devtoolsRawSetupState = setupResult;
    }
    instance.setupState = proxyRefs(setupResult);
  } else ;
  finishComponentSetup(instance);
}
function finishComponentSetup(instance, isSSR, skipOptions) {
  const Component = instance.type;
  if (!instance.render) {
    instance.render = Component.render || NOOP;
  }
  if (__VUE_OPTIONS_API__ && true) {
    const reset = setCurrentInstance(instance);
    pauseTracking();
    try {
      applyOptions(instance);
    } finally {
      resetTracking();
      reset();
    }
  }
}
const attrsProxyHandlers = {
  get(target, key) {
    track(target, "get", "");
    return target[key];
  }
};
function createSetupContext(instance) {
  const expose = (exposed) => {
    instance.exposed = exposed || {};
  };
  {
    return {
      attrs: new Proxy(instance.attrs, attrsProxyHandlers),
      slots: instance.slots,
      emit: instance.emit,
      expose
    };
  }
}
function getComponentPublicInstance(instance) {
  if (instance.exposed) {
    return instance.exposeProxy || (instance.exposeProxy = new Proxy(proxyRefs(markRaw(instance.exposed)), {
      get(target, key) {
        if (key in target) {
          return target[key];
        } else if (key in publicPropertiesMap) {
          return publicPropertiesMap[key](instance);
        }
      },
      has(target, key) {
        return key in target || key in publicPropertiesMap;
      }
    }));
  } else {
    return instance.proxy;
  }
}
const classifyRE$1 = /(?:^|[-_])\w/g;
const classify$1 = (str) => str.replace(classifyRE$1, (c) => c.toUpperCase()).replace(/[-_]/g, "");
function getComponentName(Component, includeInferred = true) {
  return isFunction(Component) ? Component.displayName || Component.name : Component.name || includeInferred && Component.__name;
}
function formatComponentName(instance, Component, isRoot = false) {
  let name = getComponentName(Component);
  if (!name && Component.__file) {
    const match = Component.__file.match(/([^/\\]+)\.\w+$/);
    if (match) {
      name = match[1];
    }
  }
  if (!name && instance) {
    const inferFromRegistry = (registry) => {
      for (const key in registry) {
        if (registry[key] === Component) {
          return key;
        }
      }
    };
    name = inferFromRegistry(instance.components) || instance.parent && inferFromRegistry(
      instance.parent.type.components
    ) || inferFromRegistry(instance.appContext.components);
  }
  return name ? classify$1(name) : isRoot ? `App` : `Anonymous`;
}
function isClassComponent(value) {
  return isFunction(value) && "__vccOpts" in value;
}

const computed = (getterOrOptions, debugOptions) => {
  const c = computed$1(getterOrOptions, debugOptions, isInSSRComponentSetup);
  return c;
};

function h(type, propsOrChildren, children) {
  try {
    setBlockTracking(-1);
    const l = arguments.length;
    if (l === 2) {
      if (isObject(propsOrChildren) && !isArray$1(propsOrChildren)) {
        if (isVNode(propsOrChildren)) {
          return createVNode(type, null, [propsOrChildren]);
        }
        return createVNode(type, propsOrChildren);
      } else {
        return createVNode(type, null, propsOrChildren);
      }
    } else {
      if (l > 3) {
        children = Array.prototype.slice.call(arguments, 2);
      } else if (l === 3 && isVNode(children)) {
        children = [children];
      }
      return createVNode(type, propsOrChildren, children);
    }
  } finally {
    setBlockTracking(1);
  }
}

const version = "3.5.41";

/**
* @vue/runtime-dom v3.5.41
* (c) 2018-present Yuxi (Evan) You and Vue contributors
* @license MIT
**/

let policy = void 0;
const tt = typeof window !== "undefined" && window.trustedTypes;
if (tt) {
  try {
    policy = /* @__PURE__ */ tt.createPolicy("vue", {
      createHTML: (val) => val
    });
  } catch (e) {
  }
}
const unsafeToTrustedHTML = policy ? (val) => policy.createHTML(val) : (val) => val;
const svgNS = "http://www.w3.org/2000/svg";
const mathmlNS = "http://www.w3.org/1998/Math/MathML";
const doc = typeof document !== "undefined" ? document : null;
const templateContainer = doc && /* @__PURE__ */ doc.createElement("template");
const nodeOps = {
  insert: (child, parent, anchor) => {
    parent.insertBefore(child, anchor || null);
  },
  remove: (child) => {
    const parent = child.parentNode;
    if (parent) {
      parent.removeChild(child);
    }
  },
  createElement: (tag, namespace, is, props) => {
    const el = namespace === "svg" ? doc.createElementNS(svgNS, tag) : namespace === "mathml" ? doc.createElementNS(mathmlNS, tag) : is ? doc.createElement(tag, { is }) : doc.createElement(tag);
    if (tag === "select" && props && props.multiple != null) {
      el.setAttribute("multiple", props.multiple);
    }
    return el;
  },
  createText: (text) => doc.createTextNode(text),
  createComment: (text) => doc.createComment(text),
  setText: (node, text) => {
    node.nodeValue = text;
  },
  setElementText: (el, text) => {
    el.textContent = text;
  },
  parentNode: (node) => node.parentNode,
  nextSibling: (node) => node.nextSibling,
  querySelector: (selector) => doc.querySelector(selector),
  setScopeId(el, id) {
    el.setAttribute(id, "");
  },
  // __UNSAFE__
  // Reason: innerHTML.
  // Static content here can only come from compiled templates.
  // As long as the user only uses trusted templates, this is safe.
  insertStaticContent(content, parent, anchor, namespace, start, end) {
    const before = anchor ? anchor.previousSibling : parent.lastChild;
    if (start && (start === end || start.nextSibling)) {
      while (true) {
        parent.insertBefore(start.cloneNode(true), anchor);
        if (start === end || !(start = start.nextSibling)) break;
      }
    } else {
      templateContainer.innerHTML = unsafeToTrustedHTML(
        namespace === "svg" ? `<svg>${content}</svg>` : namespace === "mathml" ? `<math>${content}</math>` : content
      );
      const template = templateContainer.content;
      if (namespace === "svg" || namespace === "mathml") {
        const wrapper = template.firstChild;
        while (wrapper.firstChild) {
          template.appendChild(wrapper.firstChild);
        }
        template.removeChild(wrapper);
      }
      parent.insertBefore(template, anchor);
    }
    return [
      // first
      before ? before.nextSibling : parent.firstChild,
      // last
      anchor ? anchor.previousSibling : parent.lastChild
    ];
  }
};
const vtcKey = /* @__PURE__ */ Symbol("_vtc");

function patchClass(el, value, isSVG) {
  const transitionClasses = el[vtcKey];
  if (transitionClasses) {
    value = (value ? [value, ...transitionClasses] : [...transitionClasses]).join(" ");
  }
  if (value == null) {
    el.removeAttribute("class");
  } else if (isSVG) {
    el.setAttribute("class", value);
  } else {
    el.className = value;
  }
}

const vShowOriginalDisplay = /* @__PURE__ */ Symbol("_vod");
const vShowHidden = /* @__PURE__ */ Symbol("_vsh");

const CSS_VAR_TEXT = /* @__PURE__ */ Symbol("");

const displayRE = /(?:^|;)\s*display\s*:/;
function patchStyle(el, prev, next) {
  const style = el.style;
  const isCssString = isString$1(next);
  let hasControlledDisplay = false;
  if (next && !isCssString) {
    if (prev) {
      if (!isString$1(prev)) {
        for (const key in prev) {
          if (next[key] == null) {
            setStyle(style, key, "");
          }
        }
      } else {
        for (const prevStyle of prev.split(";")) {
          const key = prevStyle.slice(0, prevStyle.indexOf(":")).trim();
          if (next[key] == null) {
            setStyle(style, key, "");
          }
        }
      }
    }
    for (const key in next) {
      if (key === "display") {
        hasControlledDisplay = true;
      }
      const value = next[key];
      if (value != null) {
        if (!shouldPreserveTextareaResizeStyle(
          el,
          key,
          !isString$1(prev) && prev ? prev[key] : void 0,
          value
        )) {
          setStyle(style, key, value);
        }
      } else {
        setStyle(style, key, "");
      }
    }
  } else {
    if (isCssString) {
      if (prev !== next) {
        const cssVarText = style[CSS_VAR_TEXT];
        if (cssVarText) {
          next += ";" + cssVarText;
        }
        style.cssText = next;
        hasControlledDisplay = displayRE.test(next);
      }
    } else if (prev) {
      el.removeAttribute("style");
    }
  }
  if (vShowOriginalDisplay in el) {
    el[vShowOriginalDisplay] = hasControlledDisplay ? style.display : "";
    if (el[vShowHidden]) {
      style.display = "none";
    }
  }
}
const importantRE = /\s*!important$/;
function setStyle(style, name, val) {
  if (isArray$1(val)) {
    val.forEach((v) => setStyle(style, name, v));
  } else {
    if (val == null) val = "";
    if (name.startsWith("--")) {
      style.setProperty(name, val);
    } else {
      const prefixed = autoPrefix(style, name);
      if (importantRE.test(val)) {
        style.setProperty(
          hyphenate(prefixed),
          val.replace(importantRE, ""),
          "important"
        );
      } else {
        style[prefixed] = val;
      }
    }
  }
}
const prefixes = ["Webkit", "Moz", "ms"];
const prefixCache = {};
function autoPrefix(style, rawName) {
  const cached = prefixCache[rawName];
  if (cached) {
    return cached;
  }
  let name = camelize(rawName);
  if (name !== "filter" && name in style) {
    return prefixCache[rawName] = name;
  }
  name = capitalize(name);
  for (let i = 0; i < prefixes.length; i++) {
    const prefixed = prefixes[i] + name;
    if (prefixed in style) {
      return prefixCache[rawName] = prefixed;
    }
  }
  return rawName;
}
function shouldPreserveTextareaResizeStyle(el, key, prev, next) {
  return el.tagName === "TEXTAREA" && (key === "width" || key === "height") && isString$1(next) && prev === next;
}

const xlinkNS = "http://www.w3.org/1999/xlink";
function patchAttr(el, key, value, isSVG, instance, isBoolean = isSpecialBooleanAttr(key)) {
  if (isSVG && key.startsWith("xlink:")) {
    if (value == null) {
      el.removeAttributeNS(xlinkNS, key.slice(6, key.length));
    } else {
      el.setAttributeNS(xlinkNS, key, value);
    }
  } else {
    if (value == null || isBoolean && !includeBooleanAttr(value)) {
      el.removeAttribute(key);
    } else {
      el.setAttribute(
        key,
        isBoolean ? "" : isSymbol$1(value) ? String(value) : value
      );
    }
  }
}

function patchDOMProp(el, key, value, parentComponent, attrName) {
  if (key === "innerHTML" || key === "textContent") {
    if (value != null) {
      el[key] = key === "innerHTML" ? unsafeToTrustedHTML(value) : value;
    }
    return;
  }
  const tag = el.tagName;
  if (key === "value" && tag !== "PROGRESS" && // custom elements may use _value internally
  !tag.includes("-")) {
    const oldValue = tag === "OPTION" ? el.getAttribute("value") || "" : el.value;
    const newValue = value == null ? (
      // #11647: value should be set as empty string for null and undefined,
      // but <input type="checkbox"> should be set as 'on'.
      el.type === "checkbox" ? "on" : ""
    ) : String(value);
    if (oldValue !== newValue || !("_value" in el)) {
      el.value = newValue;
    }
    if (value == null) {
      el.removeAttribute(key);
    }
    el._value = value;
    return;
  }
  let needRemove = false;
  if (value === "" || value == null) {
    const type = typeof el[key];
    if (type === "boolean") {
      value = includeBooleanAttr(value);
    } else if (value == null && type === "string") {
      value = "";
      needRemove = true;
    } else if (type === "number") {
      value = 0;
      needRemove = true;
    }
  }
  try {
    el[key] = value;
  } catch (e) {
  }
  needRemove && el.removeAttribute(attrName || key);
}

function addEventListener(el, event, handler, options) {
  el.addEventListener(event, handler, options);
}
function removeEventListener(el, event, handler, options) {
  el.removeEventListener(event, handler, options);
}
const veiKey = /* @__PURE__ */ Symbol("_vei");
function patchEvent(el, rawName, prevValue, nextValue, instance = null) {
  const invokers = el[veiKey] || (el[veiKey] = {});
  const existingInvoker = invokers[rawName];
  if (nextValue && existingInvoker) {
    existingInvoker.value = nextValue;
  } else {
    const [name, options] = parseName(rawName);
    if (nextValue) {
      const invoker = invokers[rawName] = createInvoker(
        nextValue,
        instance
      );
      addEventListener(el, name, invoker, options);
    } else if (existingInvoker) {
      removeEventListener(el, name, existingInvoker, options);
      invokers[rawName] = void 0;
    }
  }
}
const optionsModifierRE = /(Once|Passive|Capture)$/;
const optionsModifierEventRE = /^on:?(?:Once|Passive|Capture)$/;
function parseName(name) {
  let options;
  let m;
  while ((m = name.match(optionsModifierRE)) && !optionsModifierEventRE.test(name)) {
    if (!options) options = {};
    name = name.slice(0, name.length - m[1].length);
    options[m[1].toLowerCase()] = true;
  }
  const event = name[2] === ":" ? name.slice(3) : hyphenate(name.slice(2));
  return [event, options];
}
let cachedNow = 0;
const p = /* @__PURE__ */ Promise.resolve();
const getNow = () => cachedNow || (p.then(() => cachedNow = 0), cachedNow = Date.now());
function createInvoker(initialValue, instance) {
  const invoker = (e) => {
    if (!e._vts) {
      e._vts = Date.now();
    } else if (e._vts <= invoker.attached) {
      return;
    }
    const value = invoker.value;
    if (isArray$1(value)) {
      const originalStop = e.stopImmediatePropagation;
      e.stopImmediatePropagation = () => {
        originalStop.call(e);
        e._stopped = true;
      };
      const handlers = value.slice();
      const args = [e];
      for (let i = 0; i < handlers.length; i++) {
        if (e._stopped) {
          break;
        }
        const handler = handlers[i];
        if (handler) {
          callWithAsyncErrorHandling(
            handler,
            instance,
            5,
            args
          );
        }
      }
    } else {
      callWithAsyncErrorHandling(
        value,
        instance,
        5,
        [e]
      );
    }
  };
  invoker.value = initialValue;
  invoker.attached = getNow();
  return invoker;
}

const isNativeOn = (key) => key.charCodeAt(0) === 111 && key.charCodeAt(1) === 110 && // lowercase letter
key.charCodeAt(2) > 96 && key.charCodeAt(2) < 123;
const patchProp = (el, key, prevValue, nextValue, namespace, parentComponent) => {
  const isSVG = namespace === "svg";
  if (key === "class") {
    patchClass(el, nextValue, isSVG);
  } else if (key === "style") {
    patchStyle(el, prevValue, nextValue);
  } else if (isOn(key)) {
    if (!isModelListener(key)) {
      patchEvent(el, key, prevValue, nextValue, parentComponent);
    }
  } else if (key[0] === "." ? (key = key.slice(1), true) : key[0] === "^" ? (key = key.slice(1), false) : shouldSetAsProp(el, key, nextValue, isSVG)) {
    patchDOMProp(el, key, nextValue);
    if (!el.tagName.includes("-") && (key === "value" || key === "checked" || key === "selected")) {
      patchAttr(el, key, nextValue, isSVG, parentComponent, key !== "value");
    }
  } else if (
    // #11081 force set props for possible async custom element
    el._isVueCE && // #12408 check if it's declared prop or it's async custom element
    (shouldSetAsPropForVueCE(el, key) || // @ts-expect-error _def is private
    el._def.__asyncLoader && (/[A-Z]/.test(key) || !isString$1(nextValue)))
  ) {
    patchDOMProp(el, camelize(key), nextValue, parentComponent, key);
  } else {
    if (key === "true-value") {
      el._trueValue = nextValue;
    } else if (key === "false-value") {
      el._falseValue = nextValue;
    }
    patchAttr(el, key, nextValue, isSVG);
  }
};
function shouldSetAsProp(el, key, value, isSVG) {
  if (isSVG) {
    if (key === "innerHTML" || key === "textContent") {
      return true;
    }
    if (key in el && isNativeOn(key) && isFunction(value)) {
      return true;
    }
    return false;
  }
  if (key === "spellcheck" || key === "draggable" || key === "translate" || key === "autocorrect") {
    return false;
  }
  if (key === "sandbox" && el.tagName === "IFRAME") {
    return false;
  }
  if (key === "form") {
    return false;
  }
  if (key === "list" && el.tagName === "INPUT") {
    return false;
  }
  if (key === "type" && el.tagName === "TEXTAREA") {
    return false;
  }
  if (key === "width" || key === "height") {
    const tag = el.tagName;
    if (tag === "IMG" || tag === "VIDEO" || tag === "CANVAS" || tag === "SOURCE") {
      return false;
    }
  }
  if (isNativeOn(key) && isString$1(value)) {
    return false;
  }
  return key in el;
}
function shouldSetAsPropForVueCE(el, key) {
  const props = (
    // @ts-expect-error _def is private
    el._def.props
  );
  if (!props) {
    return false;
  }
  const camelKey = camelize(key);
  return Array.isArray(props) ? props.some((prop) => camelize(prop) === camelKey) : Object.keys(props).some((prop) => camelize(prop) === camelKey);
}

const rendererOptions = /* @__PURE__ */ extend({ patchProp }, nodeOps);
let renderer;
function ensureRenderer() {
  return renderer || (renderer = createRenderer(rendererOptions));
}
const createApp = ((...args) => {
  const app = ensureRenderer().createApp(...args);
  const { mount } = app;
  app.mount = (containerOrSelector) => {
    const container = normalizeContainer(containerOrSelector);
    if (!container) return;
    const component = app._component;
    if (!isFunction(component) && !component.render && !component.template) {
      component.template = container.innerHTML;
    }
    if (container.nodeType === 1) {
      container.textContent = "";
    }
    const proxy = mount(container, false, resolveRootNamespace(container));
    if (container instanceof Element) {
      container.removeAttribute("v-cloak");
      container.setAttribute("data-v-app", "");
    }
    return proxy;
  };
  return app;
});
function resolveRootNamespace(container) {
  if (container instanceof SVGElement) {
    return "svg";
  }
  if (typeof MathMLElement === "function" && container instanceof MathMLElement) {
    return "mathml";
  }
}
function normalizeContainer(container) {
  if (isString$1(container)) {
    const res = document.querySelector(container);
    return res;
  }
  return container;
}

var __create$1 = Object.create;
var __defProp$1 = Object.defineProperty;
var __getOwnPropDesc$1 = Object.getOwnPropertyDescriptor;
var __getOwnPropNames$1 = Object.getOwnPropertyNames;
var __getProtoOf$1 = Object.getPrototypeOf;
var __hasOwnProp$1 = Object.prototype.hasOwnProperty;
var __esm$1 = (fn, res) => function __init() {
  return fn && (res = (0, fn[__getOwnPropNames$1(fn)[0]])(fn = 0)), res;
};
var __commonJS$1 = (cb, mod) => function __require() {
  return mod || (0, cb[__getOwnPropNames$1(cb)[0]])((mod = { exports: {} }).exports, mod), mod.exports;
};
var __copyProps$1 = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames$1(from))
      if (!__hasOwnProp$1.call(to, key) && key !== except)
        __defProp$1(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc$1(from, key)) || desc.enumerable });
  }
  return to;
};
var __toESM$1 = (mod, isNodeMode, target2) => (target2 = mod != null ? __create$1(__getProtoOf$1(mod)) : {}, __copyProps$1(
  // If the importer is in node compatibility mode or this is not an ESM
  // file that has been converted to a CommonJS file using a Babel-
  // compatible transform (i.e. "__esModule" has not been set), then set
  // "default" to the CommonJS "module.exports" for node compatibility.
  __defProp$1(target2, "default", { value: mod, enumerable: true }) ,
  mod
));

// ../../node_modules/.pnpm/tsup@8.4.0_@microsoft+api-extractor@7.51.1_@types+node@22.13.14__jiti@2.4.2_postcss@8.5_96eb05a9d65343021e53791dd83f3773/node_modules/tsup/assets/esm_shims.js
var init_esm_shims$1 = __esm$1({
  "../../node_modules/.pnpm/tsup@8.4.0_@microsoft+api-extractor@7.51.1_@types+node@22.13.14__jiti@2.4.2_postcss@8.5_96eb05a9d65343021e53791dd83f3773/node_modules/tsup/assets/esm_shims.js"() {
  }
});

// ../../node_modules/.pnpm/rfdc@1.4.1/node_modules/rfdc/index.js
var require_rfdc = __commonJS$1({
  "../../node_modules/.pnpm/rfdc@1.4.1/node_modules/rfdc/index.js"(exports, module) {
    init_esm_shims$1();
    module.exports = rfdc2;
    function copyBuffer(cur) {
      if (cur instanceof Buffer) {
        return Buffer.from(cur);
      }
      return new cur.constructor(cur.buffer.slice(), cur.byteOffset, cur.length);
    }
    function rfdc2(opts) {
      opts = opts || {};
      if (opts.circles) return rfdcCircles(opts);
      const constructorHandlers = /* @__PURE__ */ new Map();
      constructorHandlers.set(Date, (o) => new Date(o));
      constructorHandlers.set(Map, (o, fn) => new Map(cloneArray(Array.from(o), fn)));
      constructorHandlers.set(Set, (o, fn) => new Set(cloneArray(Array.from(o), fn)));
      if (opts.constructorHandlers) {
        for (const handler2 of opts.constructorHandlers) {
          constructorHandlers.set(handler2[0], handler2[1]);
        }
      }
      let handler = null;
      return opts.proto ? cloneProto : clone;
      function cloneArray(a, fn) {
        const keys = Object.keys(a);
        const a2 = new Array(keys.length);
        for (let i = 0; i < keys.length; i++) {
          const k = keys[i];
          const cur = a[k];
          if (typeof cur !== "object" || cur === null) {
            a2[k] = cur;
          } else if (cur.constructor !== Object && (handler = constructorHandlers.get(cur.constructor))) {
            a2[k] = handler(cur, fn);
          } else if (ArrayBuffer.isView(cur)) {
            a2[k] = copyBuffer(cur);
          } else {
            a2[k] = fn(cur);
          }
        }
        return a2;
      }
      function clone(o) {
        if (typeof o !== "object" || o === null) return o;
        if (Array.isArray(o)) return cloneArray(o, clone);
        if (o.constructor !== Object && (handler = constructorHandlers.get(o.constructor))) {
          return handler(o, clone);
        }
        const o2 = {};
        for (const k in o) {
          if (Object.hasOwnProperty.call(o, k) === false) continue;
          const cur = o[k];
          if (typeof cur !== "object" || cur === null) {
            o2[k] = cur;
          } else if (cur.constructor !== Object && (handler = constructorHandlers.get(cur.constructor))) {
            o2[k] = handler(cur, clone);
          } else if (ArrayBuffer.isView(cur)) {
            o2[k] = copyBuffer(cur);
          } else {
            o2[k] = clone(cur);
          }
        }
        return o2;
      }
      function cloneProto(o) {
        if (typeof o !== "object" || o === null) return o;
        if (Array.isArray(o)) return cloneArray(o, cloneProto);
        if (o.constructor !== Object && (handler = constructorHandlers.get(o.constructor))) {
          return handler(o, cloneProto);
        }
        const o2 = {};
        for (const k in o) {
          const cur = o[k];
          if (typeof cur !== "object" || cur === null) {
            o2[k] = cur;
          } else if (cur.constructor !== Object && (handler = constructorHandlers.get(cur.constructor))) {
            o2[k] = handler(cur, cloneProto);
          } else if (ArrayBuffer.isView(cur)) {
            o2[k] = copyBuffer(cur);
          } else {
            o2[k] = cloneProto(cur);
          }
        }
        return o2;
      }
    }
    function rfdcCircles(opts) {
      const refs = [];
      const refsNew = [];
      const constructorHandlers = /* @__PURE__ */ new Map();
      constructorHandlers.set(Date, (o) => new Date(o));
      constructorHandlers.set(Map, (o, fn) => new Map(cloneArray(Array.from(o), fn)));
      constructorHandlers.set(Set, (o, fn) => new Set(cloneArray(Array.from(o), fn)));
      if (opts.constructorHandlers) {
        for (const handler2 of opts.constructorHandlers) {
          constructorHandlers.set(handler2[0], handler2[1]);
        }
      }
      let handler = null;
      return opts.proto ? cloneProto : clone;
      function cloneArray(a, fn) {
        const keys = Object.keys(a);
        const a2 = new Array(keys.length);
        for (let i = 0; i < keys.length; i++) {
          const k = keys[i];
          const cur = a[k];
          if (typeof cur !== "object" || cur === null) {
            a2[k] = cur;
          } else if (cur.constructor !== Object && (handler = constructorHandlers.get(cur.constructor))) {
            a2[k] = handler(cur, fn);
          } else if (ArrayBuffer.isView(cur)) {
            a2[k] = copyBuffer(cur);
          } else {
            const index = refs.indexOf(cur);
            if (index !== -1) {
              a2[k] = refsNew[index];
            } else {
              a2[k] = fn(cur);
            }
          }
        }
        return a2;
      }
      function clone(o) {
        if (typeof o !== "object" || o === null) return o;
        if (Array.isArray(o)) return cloneArray(o, clone);
        if (o.constructor !== Object && (handler = constructorHandlers.get(o.constructor))) {
          return handler(o, clone);
        }
        const o2 = {};
        refs.push(o);
        refsNew.push(o2);
        for (const k in o) {
          if (Object.hasOwnProperty.call(o, k) === false) continue;
          const cur = o[k];
          if (typeof cur !== "object" || cur === null) {
            o2[k] = cur;
          } else if (cur.constructor !== Object && (handler = constructorHandlers.get(cur.constructor))) {
            o2[k] = handler(cur, clone);
          } else if (ArrayBuffer.isView(cur)) {
            o2[k] = copyBuffer(cur);
          } else {
            const i = refs.indexOf(cur);
            if (i !== -1) {
              o2[k] = refsNew[i];
            } else {
              o2[k] = clone(cur);
            }
          }
        }
        refs.pop();
        refsNew.pop();
        return o2;
      }
      function cloneProto(o) {
        if (typeof o !== "object" || o === null) return o;
        if (Array.isArray(o)) return cloneArray(o, cloneProto);
        if (o.constructor !== Object && (handler = constructorHandlers.get(o.constructor))) {
          return handler(o, cloneProto);
        }
        const o2 = {};
        refs.push(o);
        refsNew.push(o2);
        for (const k in o) {
          const cur = o[k];
          if (typeof cur !== "object" || cur === null) {
            o2[k] = cur;
          } else if (cur.constructor !== Object && (handler = constructorHandlers.get(cur.constructor))) {
            o2[k] = handler(cur, cloneProto);
          } else if (ArrayBuffer.isView(cur)) {
            o2[k] = copyBuffer(cur);
          } else {
            const i = refs.indexOf(cur);
            if (i !== -1) {
              o2[k] = refsNew[i];
            } else {
              o2[k] = cloneProto(cur);
            }
          }
        }
        refs.pop();
        refsNew.pop();
        return o2;
      }
    }
  }
});

// src/index.ts
init_esm_shims$1();

// src/constants.ts
init_esm_shims$1();

// src/env.ts
init_esm_shims$1();
var isBrowser = typeof navigator !== "undefined";
var target = typeof window !== "undefined" ? window : typeof globalThis !== "undefined" ? globalThis : typeof global !== "undefined" ? global : {};
typeof target.chrome !== "undefined" && !!target.chrome.devtools;
isBrowser && target.self !== target.top;
var _a$1;
typeof navigator !== "undefined" && ((_a$1 = navigator.userAgent) == null ? void 0 : _a$1.toLowerCase().includes("electron"));

// src/general.ts
init_esm_shims$1();
var import_rfdc = __toESM$1(require_rfdc());
var classifyRE = /(?:^|[-_/])(\w)/g;
function toUpper(_, c) {
  return c ? c.toUpperCase() : "";
}
function classify(str) {
  return str && `${str}`.replace(classifyRE, toUpper);
}
function basename(filename, ext) {
  let normalizedFilename = filename.replace(/^[a-z]:/i, "").replace(/\\/g, "/");
  if (normalizedFilename.endsWith(`index${ext}`)) {
    normalizedFilename = normalizedFilename.replace(`/index${ext}`, ext);
  }
  const lastSlashIndex = normalizedFilename.lastIndexOf("/");
  const baseNameWithExt = normalizedFilename.substring(lastSlashIndex + 1);
  {
    const extIndex = baseNameWithExt.lastIndexOf(ext);
    return baseNameWithExt.substring(0, extIndex);
  }
}
var deepClone = (0, import_rfdc.default)({ circles: true });

const DEBOUNCE_DEFAULTS = {
  trailing: true
};
function debounce(fn, wait = 25, options = {}) {
  options = { ...DEBOUNCE_DEFAULTS, ...options };
  if (!Number.isFinite(wait)) {
    throw new TypeError("Expected `wait` to be a finite number");
  }
  let leadingValue;
  let timeout;
  let resolveList = [];
  let currentPromise;
  let trailingArgs;
  const applyFn = (_this, args) => {
    currentPromise = _applyPromised(fn, _this, args);
    currentPromise.finally(() => {
      currentPromise = null;
      if (options.trailing && trailingArgs && !timeout) {
        const promise = applyFn(_this, trailingArgs);
        trailingArgs = null;
        return promise;
      }
    });
    return currentPromise;
  };
  return function(...args) {
    if (currentPromise) {
      if (options.trailing) {
        trailingArgs = args;
      }
      return currentPromise;
    }
    return new Promise((resolve) => {
      const shouldCallNow = !timeout && options.leading;
      clearTimeout(timeout);
      timeout = setTimeout(() => {
        timeout = null;
        const promise = options.leading ? leadingValue : applyFn(this, args);
        for (const _resolve of resolveList) {
          _resolve(promise);
        }
        resolveList = [];
      }, wait);
      if (shouldCallNow) {
        leadingValue = applyFn(this, args);
        resolve(leadingValue);
      } else {
        resolveList.push(resolve);
      }
    });
  };
}
async function _applyPromised(fn, _this, args) {
  return await fn.apply(_this, args);
}

function flatHooks(configHooks, hooks = {}, parentName) {
  for (const key in configHooks) {
    const subHook = configHooks[key];
    const name = parentName ? `${parentName}:${key}` : key;
    if (typeof subHook === "object" && subHook !== null) {
      flatHooks(subHook, hooks, name);
    } else if (typeof subHook === "function") {
      hooks[name] = subHook;
    }
  }
  return hooks;
}
const defaultTask = { run: (function_) => function_() };
const _createTask = () => defaultTask;
const createTask = typeof console.createTask !== "undefined" ? console.createTask : _createTask;
function serialTaskCaller(hooks, args) {
  const name = args.shift();
  const task = createTask(name);
  return hooks.reduce(
    (promise, hookFunction) => promise.then(() => task.run(() => hookFunction(...args))),
    Promise.resolve()
  );
}
function parallelTaskCaller(hooks, args) {
  const name = args.shift();
  const task = createTask(name);
  return Promise.all(hooks.map((hook) => task.run(() => hook(...args))));
}
function callEachWith(callbacks, arg0) {
  for (const callback of [...callbacks]) {
    callback(arg0);
  }
}

class Hookable {
  constructor() {
    this._hooks = {};
    this._before = void 0;
    this._after = void 0;
    this._deprecatedMessages = void 0;
    this._deprecatedHooks = {};
    this.hook = this.hook.bind(this);
    this.callHook = this.callHook.bind(this);
    this.callHookWith = this.callHookWith.bind(this);
  }
  hook(name, function_, options = {}) {
    if (!name || typeof function_ !== "function") {
      return () => {
      };
    }
    const originalName = name;
    let dep;
    while (this._deprecatedHooks[name]) {
      dep = this._deprecatedHooks[name];
      name = dep.to;
    }
    if (dep && !options.allowDeprecated) {
      let message = dep.message;
      if (!message) {
        message = `${originalName} hook has been deprecated` + (dep.to ? `, please use ${dep.to}` : "");
      }
      if (!this._deprecatedMessages) {
        this._deprecatedMessages = /* @__PURE__ */ new Set();
      }
      if (!this._deprecatedMessages.has(message)) {
        console.warn(message);
        this._deprecatedMessages.add(message);
      }
    }
    if (!function_.name) {
      try {
        Object.defineProperty(function_, "name", {
          get: () => "_" + name.replace(/\W+/g, "_") + "_hook_cb",
          configurable: true
        });
      } catch {
      }
    }
    this._hooks[name] = this._hooks[name] || [];
    this._hooks[name].push(function_);
    return () => {
      if (function_) {
        this.removeHook(name, function_);
        function_ = void 0;
      }
    };
  }
  hookOnce(name, function_) {
    let _unreg;
    let _function = (...arguments_) => {
      if (typeof _unreg === "function") {
        _unreg();
      }
      _unreg = void 0;
      _function = void 0;
      return function_(...arguments_);
    };
    _unreg = this.hook(name, _function);
    return _unreg;
  }
  removeHook(name, function_) {
    if (this._hooks[name]) {
      const index = this._hooks[name].indexOf(function_);
      if (index !== -1) {
        this._hooks[name].splice(index, 1);
      }
      if (this._hooks[name].length === 0) {
        delete this._hooks[name];
      }
    }
  }
  deprecateHook(name, deprecated) {
    this._deprecatedHooks[name] = typeof deprecated === "string" ? { to: deprecated } : deprecated;
    const _hooks = this._hooks[name] || [];
    delete this._hooks[name];
    for (const hook of _hooks) {
      this.hook(name, hook);
    }
  }
  deprecateHooks(deprecatedHooks) {
    Object.assign(this._deprecatedHooks, deprecatedHooks);
    for (const name in deprecatedHooks) {
      this.deprecateHook(name, deprecatedHooks[name]);
    }
  }
  addHooks(configHooks) {
    const hooks = flatHooks(configHooks);
    const removeFns = Object.keys(hooks).map(
      (key) => this.hook(key, hooks[key])
    );
    return () => {
      for (const unreg of removeFns.splice(0, removeFns.length)) {
        unreg();
      }
    };
  }
  removeHooks(configHooks) {
    const hooks = flatHooks(configHooks);
    for (const key in hooks) {
      this.removeHook(key, hooks[key]);
    }
  }
  removeAllHooks() {
    for (const key in this._hooks) {
      delete this._hooks[key];
    }
  }
  callHook(name, ...arguments_) {
    arguments_.unshift(name);
    return this.callHookWith(serialTaskCaller, name, ...arguments_);
  }
  callHookParallel(name, ...arguments_) {
    arguments_.unshift(name);
    return this.callHookWith(parallelTaskCaller, name, ...arguments_);
  }
  callHookWith(caller, name, ...arguments_) {
    const event = this._before || this._after ? { name, args: arguments_, context: {} } : void 0;
    if (this._before) {
      callEachWith(this._before, event);
    }
    const result = caller(
      name in this._hooks ? [...this._hooks[name]] : [],
      arguments_
    );
    if (result instanceof Promise) {
      return result.finally(() => {
        if (this._after && event) {
          callEachWith(this._after, event);
        }
      });
    }
    if (this._after && event) {
      callEachWith(this._after, event);
    }
    return result;
  }
  beforeEach(function_) {
    this._before = this._before || [];
    this._before.push(function_);
    return () => {
      if (this._before !== void 0) {
        const index = this._before.indexOf(function_);
        if (index !== -1) {
          this._before.splice(index, 1);
        }
      }
    };
  }
  afterEach(function_) {
    this._after = this._after || [];
    this._after.push(function_);
    return () => {
      if (this._after !== void 0) {
        const index = this._after.indexOf(function_);
        if (index !== -1) {
          this._after.splice(index, 1);
        }
      }
    };
  }
}
function createHooks() {
  return new Hookable();
}

var __create = Object.create;
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __getProtoOf = Object.getPrototypeOf;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __esm = (fn, res) => function __init() {
  return fn && (res = (0, fn[__getOwnPropNames(fn)[0]])(fn = 0)), res;
};
var __commonJS = (cb, mod) => function __require() {
  return mod || (0, cb[__getOwnPropNames(cb)[0]])((mod = { exports: {} }).exports, mod), mod.exports;
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toESM = (mod, isNodeMode, target21) => (target21 = mod != null ? __create(__getProtoOf(mod)) : {}, __copyProps(
  // If the importer is in node compatibility mode or this is not an ESM
  // file that has been converted to a CommonJS file using a Babel-
  // compatible transform (i.e. "__esModule" has not been set), then set
  // "default" to the CommonJS "module.exports" for node compatibility.
  __defProp(target21, "default", { value: mod, enumerable: true }) ,
  mod
));

// ../../node_modules/.pnpm/tsup@8.4.0_@microsoft+api-extractor@7.51.1_@types+node@22.13.14__jiti@2.4.2_postcss@8.5_96eb05a9d65343021e53791dd83f3773/node_modules/tsup/assets/esm_shims.js
var init_esm_shims = __esm({
  "../../node_modules/.pnpm/tsup@8.4.0_@microsoft+api-extractor@7.51.1_@types+node@22.13.14__jiti@2.4.2_postcss@8.5_96eb05a9d65343021e53791dd83f3773/node_modules/tsup/assets/esm_shims.js"() {
  }
});

// ../../node_modules/.pnpm/speakingurl@14.0.1/node_modules/speakingurl/lib/speakingurl.js
var require_speakingurl = __commonJS({
  "../../node_modules/.pnpm/speakingurl@14.0.1/node_modules/speakingurl/lib/speakingurl.js"(exports, module) {
    init_esm_shims();
    (function(root) {
      var charMap = {
        // latin
        "\xC0": "A",
        "\xC1": "A",
        "\xC2": "A",
        "\xC3": "A",
        "\xC4": "Ae",
        "\xC5": "A",
        "\xC6": "AE",
        "\xC7": "C",
        "\xC8": "E",
        "\xC9": "E",
        "\xCA": "E",
        "\xCB": "E",
        "\xCC": "I",
        "\xCD": "I",
        "\xCE": "I",
        "\xCF": "I",
        "\xD0": "D",
        "\xD1": "N",
        "\xD2": "O",
        "\xD3": "O",
        "\xD4": "O",
        "\xD5": "O",
        "\xD6": "Oe",
        "\u0150": "O",
        "\xD8": "O",
        "\xD9": "U",
        "\xDA": "U",
        "\xDB": "U",
        "\xDC": "Ue",
        "\u0170": "U",
        "\xDD": "Y",
        "\xDE": "TH",
        "\xDF": "ss",
        "\xE0": "a",
        "\xE1": "a",
        "\xE2": "a",
        "\xE3": "a",
        "\xE4": "ae",
        "\xE5": "a",
        "\xE6": "ae",
        "\xE7": "c",
        "\xE8": "e",
        "\xE9": "e",
        "\xEA": "e",
        "\xEB": "e",
        "\xEC": "i",
        "\xED": "i",
        "\xEE": "i",
        "\xEF": "i",
        "\xF0": "d",
        "\xF1": "n",
        "\xF2": "o",
        "\xF3": "o",
        "\xF4": "o",
        "\xF5": "o",
        "\xF6": "oe",
        "\u0151": "o",
        "\xF8": "o",
        "\xF9": "u",
        "\xFA": "u",
        "\xFB": "u",
        "\xFC": "ue",
        "\u0171": "u",
        "\xFD": "y",
        "\xFE": "th",
        "\xFF": "y",
        "\u1E9E": "SS",
        // language specific
        // Arabic
        "\u0627": "a",
        "\u0623": "a",
        "\u0625": "i",
        "\u0622": "aa",
        "\u0624": "u",
        "\u0626": "e",
        "\u0621": "a",
        "\u0628": "b",
        "\u062A": "t",
        "\u062B": "th",
        "\u062C": "j",
        "\u062D": "h",
        "\u062E": "kh",
        "\u062F": "d",
        "\u0630": "th",
        "\u0631": "r",
        "\u0632": "z",
        "\u0633": "s",
        "\u0634": "sh",
        "\u0635": "s",
        "\u0636": "dh",
        "\u0637": "t",
        "\u0638": "z",
        "\u0639": "a",
        "\u063A": "gh",
        "\u0641": "f",
        "\u0642": "q",
        "\u0643": "k",
        "\u0644": "l",
        "\u0645": "m",
        "\u0646": "n",
        "\u0647": "h",
        "\u0648": "w",
        "\u064A": "y",
        "\u0649": "a",
        "\u0629": "h",
        "\uFEFB": "la",
        "\uFEF7": "laa",
        "\uFEF9": "lai",
        "\uFEF5": "laa",
        // Persian additional characters than Arabic
        "\u06AF": "g",
        "\u0686": "ch",
        "\u067E": "p",
        "\u0698": "zh",
        "\u06A9": "k",
        "\u06CC": "y",
        // Arabic diactrics
        "\u064E": "a",
        "\u064B": "an",
        "\u0650": "e",
        "\u064D": "en",
        "\u064F": "u",
        "\u064C": "on",
        "\u0652": "",
        // Arabic numbers
        "\u0660": "0",
        "\u0661": "1",
        "\u0662": "2",
        "\u0663": "3",
        "\u0664": "4",
        "\u0665": "5",
        "\u0666": "6",
        "\u0667": "7",
        "\u0668": "8",
        "\u0669": "9",
        // Persian numbers
        "\u06F0": "0",
        "\u06F1": "1",
        "\u06F2": "2",
        "\u06F3": "3",
        "\u06F4": "4",
        "\u06F5": "5",
        "\u06F6": "6",
        "\u06F7": "7",
        "\u06F8": "8",
        "\u06F9": "9",
        // Burmese consonants
        "\u1000": "k",
        "\u1001": "kh",
        "\u1002": "g",
        "\u1003": "ga",
        "\u1004": "ng",
        "\u1005": "s",
        "\u1006": "sa",
        "\u1007": "z",
        "\u1005\u103B": "za",
        "\u100A": "ny",
        "\u100B": "t",
        "\u100C": "ta",
        "\u100D": "d",
        "\u100E": "da",
        "\u100F": "na",
        "\u1010": "t",
        "\u1011": "ta",
        "\u1012": "d",
        "\u1013": "da",
        "\u1014": "n",
        "\u1015": "p",
        "\u1016": "pa",
        "\u1017": "b",
        "\u1018": "ba",
        "\u1019": "m",
        "\u101A": "y",
        "\u101B": "ya",
        "\u101C": "l",
        "\u101D": "w",
        "\u101E": "th",
        "\u101F": "h",
        "\u1020": "la",
        "\u1021": "a",
        // consonant character combos
        "\u103C": "y",
        "\u103B": "ya",
        "\u103D": "w",
        "\u103C\u103D": "yw",
        "\u103B\u103D": "ywa",
        "\u103E": "h",
        // independent vowels
        "\u1027": "e",
        "\u104F": "-e",
        "\u1023": "i",
        "\u1024": "-i",
        "\u1009": "u",
        "\u1026": "-u",
        "\u1029": "aw",
        "\u101E\u103C\u1031\u102C": "aw",
        "\u102A": "aw",
        // numbers
        "\u1040": "0",
        "\u1041": "1",
        "\u1042": "2",
        "\u1043": "3",
        "\u1044": "4",
        "\u1045": "5",
        "\u1046": "6",
        "\u1047": "7",
        "\u1048": "8",
        "\u1049": "9",
        // virama and tone marks which are silent in transliteration
        "\u1039": "",
        "\u1037": "",
        "\u1038": "",
        // Czech
        "\u010D": "c",
        "\u010F": "d",
        "\u011B": "e",
        "\u0148": "n",
        "\u0159": "r",
        "\u0161": "s",
        "\u0165": "t",
        "\u016F": "u",
        "\u017E": "z",
        "\u010C": "C",
        "\u010E": "D",
        "\u011A": "E",
        "\u0147": "N",
        "\u0158": "R",
        "\u0160": "S",
        "\u0164": "T",
        "\u016E": "U",
        "\u017D": "Z",
        // Dhivehi
        "\u0780": "h",
        "\u0781": "sh",
        "\u0782": "n",
        "\u0783": "r",
        "\u0784": "b",
        "\u0785": "lh",
        "\u0786": "k",
        "\u0787": "a",
        "\u0788": "v",
        "\u0789": "m",
        "\u078A": "f",
        "\u078B": "dh",
        "\u078C": "th",
        "\u078D": "l",
        "\u078E": "g",
        "\u078F": "gn",
        "\u0790": "s",
        "\u0791": "d",
        "\u0792": "z",
        "\u0793": "t",
        "\u0794": "y",
        "\u0795": "p",
        "\u0796": "j",
        "\u0797": "ch",
        "\u0798": "tt",
        "\u0799": "hh",
        "\u079A": "kh",
        "\u079B": "th",
        "\u079C": "z",
        "\u079D": "sh",
        "\u079E": "s",
        "\u079F": "d",
        "\u07A0": "t",
        "\u07A1": "z",
        "\u07A2": "a",
        "\u07A3": "gh",
        "\u07A4": "q",
        "\u07A5": "w",
        "\u07A6": "a",
        "\u07A7": "aa",
        "\u07A8": "i",
        "\u07A9": "ee",
        "\u07AA": "u",
        "\u07AB": "oo",
        "\u07AC": "e",
        "\u07AD": "ey",
        "\u07AE": "o",
        "\u07AF": "oa",
        "\u07B0": "",
        // Georgian https://en.wikipedia.org/wiki/Romanization_of_Georgian
        // National system (2002)
        "\u10D0": "a",
        "\u10D1": "b",
        "\u10D2": "g",
        "\u10D3": "d",
        "\u10D4": "e",
        "\u10D5": "v",
        "\u10D6": "z",
        "\u10D7": "t",
        "\u10D8": "i",
        "\u10D9": "k",
        "\u10DA": "l",
        "\u10DB": "m",
        "\u10DC": "n",
        "\u10DD": "o",
        "\u10DE": "p",
        "\u10DF": "zh",
        "\u10E0": "r",
        "\u10E1": "s",
        "\u10E2": "t",
        "\u10E3": "u",
        "\u10E4": "p",
        "\u10E5": "k",
        "\u10E6": "gh",
        "\u10E7": "q",
        "\u10E8": "sh",
        "\u10E9": "ch",
        "\u10EA": "ts",
        "\u10EB": "dz",
        "\u10EC": "ts",
        "\u10ED": "ch",
        "\u10EE": "kh",
        "\u10EF": "j",
        "\u10F0": "h",
        // Greek
        "\u03B1": "a",
        "\u03B2": "v",
        "\u03B3": "g",
        "\u03B4": "d",
        "\u03B5": "e",
        "\u03B6": "z",
        "\u03B7": "i",
        "\u03B8": "th",
        "\u03B9": "i",
        "\u03BA": "k",
        "\u03BB": "l",
        "\u03BC": "m",
        "\u03BD": "n",
        "\u03BE": "ks",
        "\u03BF": "o",
        "\u03C0": "p",
        "\u03C1": "r",
        "\u03C3": "s",
        "\u03C4": "t",
        "\u03C5": "y",
        "\u03C6": "f",
        "\u03C7": "x",
        "\u03C8": "ps",
        "\u03C9": "o",
        "\u03AC": "a",
        "\u03AD": "e",
        "\u03AF": "i",
        "\u03CC": "o",
        "\u03CD": "y",
        "\u03AE": "i",
        "\u03CE": "o",
        "\u03C2": "s",
        "\u03CA": "i",
        "\u03B0": "y",
        "\u03CB": "y",
        "\u0390": "i",
        "\u0391": "A",
        "\u0392": "B",
        "\u0393": "G",
        "\u0394": "D",
        "\u0395": "E",
        "\u0396": "Z",
        "\u0397": "I",
        "\u0398": "TH",
        "\u0399": "I",
        "\u039A": "K",
        "\u039B": "L",
        "\u039C": "M",
        "\u039D": "N",
        "\u039E": "KS",
        "\u039F": "O",
        "\u03A0": "P",
        "\u03A1": "R",
        "\u03A3": "S",
        "\u03A4": "T",
        "\u03A5": "Y",
        "\u03A6": "F",
        "\u03A7": "X",
        "\u03A8": "PS",
        "\u03A9": "O",
        "\u0386": "A",
        "\u0388": "E",
        "\u038A": "I",
        "\u038C": "O",
        "\u038E": "Y",
        "\u0389": "I",
        "\u038F": "O",
        "\u03AA": "I",
        "\u03AB": "Y",
        // Latvian
        "\u0101": "a",
        // 'č': 'c', // duplicate
        "\u0113": "e",
        "\u0123": "g",
        "\u012B": "i",
        "\u0137": "k",
        "\u013C": "l",
        "\u0146": "n",
        // 'š': 's', // duplicate
        "\u016B": "u",
        // 'ž': 'z', // duplicate
        "\u0100": "A",
        // 'Č': 'C', // duplicate
        "\u0112": "E",
        "\u0122": "G",
        "\u012A": "I",
        "\u0136": "k",
        "\u013B": "L",
        "\u0145": "N",
        // 'Š': 'S', // duplicate
        "\u016A": "U",
        // 'Ž': 'Z', // duplicate
        // Macedonian
        "\u040C": "Kj",
        "\u045C": "kj",
        "\u0409": "Lj",
        "\u0459": "lj",
        "\u040A": "Nj",
        "\u045A": "nj",
        "\u0422\u0441": "Ts",
        "\u0442\u0441": "ts",
        // Polish
        "\u0105": "a",
        "\u0107": "c",
        "\u0119": "e",
        "\u0142": "l",
        "\u0144": "n",
        // 'ó': 'o', // duplicate
        "\u015B": "s",
        "\u017A": "z",
        "\u017C": "z",
        "\u0104": "A",
        "\u0106": "C",
        "\u0118": "E",
        "\u0141": "L",
        "\u0143": "N",
        "\u015A": "S",
        "\u0179": "Z",
        "\u017B": "Z",
        // Ukranian
        "\u0404": "Ye",
        "\u0406": "I",
        "\u0407": "Yi",
        "\u0490": "G",
        "\u0454": "ye",
        "\u0456": "i",
        "\u0457": "yi",
        "\u0491": "g",
        // Romanian
        "\u0103": "a",
        "\u0102": "A",
        "\u0219": "s",
        "\u0218": "S",
        // 'ş': 's', // duplicate
        // 'Ş': 'S', // duplicate
        "\u021B": "t",
        "\u021A": "T",
        "\u0163": "t",
        "\u0162": "T",
        // Russian https://en.wikipedia.org/wiki/Romanization_of_Russian
        // ICAO
        "\u0430": "a",
        "\u0431": "b",
        "\u0432": "v",
        "\u0433": "g",
        "\u0434": "d",
        "\u0435": "e",
        "\u0451": "yo",
        "\u0436": "zh",
        "\u0437": "z",
        "\u0438": "i",
        "\u0439": "i",
        "\u043A": "k",
        "\u043B": "l",
        "\u043C": "m",
        "\u043D": "n",
        "\u043E": "o",
        "\u043F": "p",
        "\u0440": "r",
        "\u0441": "s",
        "\u0442": "t",
        "\u0443": "u",
        "\u0444": "f",
        "\u0445": "kh",
        "\u0446": "c",
        "\u0447": "ch",
        "\u0448": "sh",
        "\u0449": "sh",
        "\u044A": "",
        "\u044B": "y",
        "\u044C": "",
        "\u044D": "e",
        "\u044E": "yu",
        "\u044F": "ya",
        "\u0410": "A",
        "\u0411": "B",
        "\u0412": "V",
        "\u0413": "G",
        "\u0414": "D",
        "\u0415": "E",
        "\u0401": "Yo",
        "\u0416": "Zh",
        "\u0417": "Z",
        "\u0418": "I",
        "\u0419": "I",
        "\u041A": "K",
        "\u041B": "L",
        "\u041C": "M",
        "\u041D": "N",
        "\u041E": "O",
        "\u041F": "P",
        "\u0420": "R",
        "\u0421": "S",
        "\u0422": "T",
        "\u0423": "U",
        "\u0424": "F",
        "\u0425": "Kh",
        "\u0426": "C",
        "\u0427": "Ch",
        "\u0428": "Sh",
        "\u0429": "Sh",
        "\u042A": "",
        "\u042B": "Y",
        "\u042C": "",
        "\u042D": "E",
        "\u042E": "Yu",
        "\u042F": "Ya",
        // Serbian
        "\u0452": "dj",
        "\u0458": "j",
        // 'љ': 'lj',  // duplicate
        // 'њ': 'nj', // duplicate
        "\u045B": "c",
        "\u045F": "dz",
        "\u0402": "Dj",
        "\u0408": "j",
        // 'Љ': 'Lj', // duplicate
        // 'Њ': 'Nj', // duplicate
        "\u040B": "C",
        "\u040F": "Dz",
        // Slovak
        "\u013E": "l",
        "\u013A": "l",
        "\u0155": "r",
        "\u013D": "L",
        "\u0139": "L",
        "\u0154": "R",
        // Turkish
        "\u015F": "s",
        "\u015E": "S",
        "\u0131": "i",
        "\u0130": "I",
        // 'ç': 'c', // duplicate
        // 'Ç': 'C', // duplicate
        // 'ü': 'u', // duplicate, see langCharMap
        // 'Ü': 'U', // duplicate, see langCharMap
        // 'ö': 'o', // duplicate, see langCharMap
        // 'Ö': 'O', // duplicate, see langCharMap
        "\u011F": "g",
        "\u011E": "G",
        // Vietnamese
        "\u1EA3": "a",
        "\u1EA2": "A",
        "\u1EB3": "a",
        "\u1EB2": "A",
        "\u1EA9": "a",
        "\u1EA8": "A",
        "\u0111": "d",
        "\u0110": "D",
        "\u1EB9": "e",
        "\u1EB8": "E",
        "\u1EBD": "e",
        "\u1EBC": "E",
        "\u1EBB": "e",
        "\u1EBA": "E",
        "\u1EBF": "e",
        "\u1EBE": "E",
        "\u1EC1": "e",
        "\u1EC0": "E",
        "\u1EC7": "e",
        "\u1EC6": "E",
        "\u1EC5": "e",
        "\u1EC4": "E",
        "\u1EC3": "e",
        "\u1EC2": "E",
        "\u1ECF": "o",
        "\u1ECD": "o",
        "\u1ECC": "o",
        "\u1ED1": "o",
        "\u1ED0": "O",
        "\u1ED3": "o",
        "\u1ED2": "O",
        "\u1ED5": "o",
        "\u1ED4": "O",
        "\u1ED9": "o",
        "\u1ED8": "O",
        "\u1ED7": "o",
        "\u1ED6": "O",
        "\u01A1": "o",
        "\u01A0": "O",
        "\u1EDB": "o",
        "\u1EDA": "O",
        "\u1EDD": "o",
        "\u1EDC": "O",
        "\u1EE3": "o",
        "\u1EE2": "O",
        "\u1EE1": "o",
        "\u1EE0": "O",
        "\u1EDE": "o",
        "\u1EDF": "o",
        "\u1ECB": "i",
        "\u1ECA": "I",
        "\u0129": "i",
        "\u0128": "I",
        "\u1EC9": "i",
        "\u1EC8": "i",
        "\u1EE7": "u",
        "\u1EE6": "U",
        "\u1EE5": "u",
        "\u1EE4": "U",
        "\u0169": "u",
        "\u0168": "U",
        "\u01B0": "u",
        "\u01AF": "U",
        "\u1EE9": "u",
        "\u1EE8": "U",
        "\u1EEB": "u",
        "\u1EEA": "U",
        "\u1EF1": "u",
        "\u1EF0": "U",
        "\u1EEF": "u",
        "\u1EEE": "U",
        "\u1EED": "u",
        "\u1EEC": "\u01B0",
        "\u1EF7": "y",
        "\u1EF6": "y",
        "\u1EF3": "y",
        "\u1EF2": "Y",
        "\u1EF5": "y",
        "\u1EF4": "Y",
        "\u1EF9": "y",
        "\u1EF8": "Y",
        "\u1EA1": "a",
        "\u1EA0": "A",
        "\u1EA5": "a",
        "\u1EA4": "A",
        "\u1EA7": "a",
        "\u1EA6": "A",
        "\u1EAD": "a",
        "\u1EAC": "A",
        "\u1EAB": "a",
        "\u1EAA": "A",
        // 'ă': 'a', // duplicate
        // 'Ă': 'A', // duplicate
        "\u1EAF": "a",
        "\u1EAE": "A",
        "\u1EB1": "a",
        "\u1EB0": "A",
        "\u1EB7": "a",
        "\u1EB6": "A",
        "\u1EB5": "a",
        "\u1EB4": "A",
        "\u24EA": "0",
        "\u2460": "1",
        "\u2461": "2",
        "\u2462": "3",
        "\u2463": "4",
        "\u2464": "5",
        "\u2465": "6",
        "\u2466": "7",
        "\u2467": "8",
        "\u2468": "9",
        "\u2469": "10",
        "\u246A": "11",
        "\u246B": "12",
        "\u246C": "13",
        "\u246D": "14",
        "\u246E": "15",
        "\u246F": "16",
        "\u2470": "17",
        "\u2471": "18",
        "\u2472": "18",
        "\u2473": "18",
        "\u24F5": "1",
        "\u24F6": "2",
        "\u24F7": "3",
        "\u24F8": "4",
        "\u24F9": "5",
        "\u24FA": "6",
        "\u24FB": "7",
        "\u24FC": "8",
        "\u24FD": "9",
        "\u24FE": "10",
        "\u24FF": "0",
        "\u24EB": "11",
        "\u24EC": "12",
        "\u24ED": "13",
        "\u24EE": "14",
        "\u24EF": "15",
        "\u24F0": "16",
        "\u24F1": "17",
        "\u24F2": "18",
        "\u24F3": "19",
        "\u24F4": "20",
        "\u24B6": "A",
        "\u24B7": "B",
        "\u24B8": "C",
        "\u24B9": "D",
        "\u24BA": "E",
        "\u24BB": "F",
        "\u24BC": "G",
        "\u24BD": "H",
        "\u24BE": "I",
        "\u24BF": "J",
        "\u24C0": "K",
        "\u24C1": "L",
        "\u24C2": "M",
        "\u24C3": "N",
        "\u24C4": "O",
        "\u24C5": "P",
        "\u24C6": "Q",
        "\u24C7": "R",
        "\u24C8": "S",
        "\u24C9": "T",
        "\u24CA": "U",
        "\u24CB": "V",
        "\u24CC": "W",
        "\u24CD": "X",
        "\u24CE": "Y",
        "\u24CF": "Z",
        "\u24D0": "a",
        "\u24D1": "b",
        "\u24D2": "c",
        "\u24D3": "d",
        "\u24D4": "e",
        "\u24D5": "f",
        "\u24D6": "g",
        "\u24D7": "h",
        "\u24D8": "i",
        "\u24D9": "j",
        "\u24DA": "k",
        "\u24DB": "l",
        "\u24DC": "m",
        "\u24DD": "n",
        "\u24DE": "o",
        "\u24DF": "p",
        "\u24E0": "q",
        "\u24E1": "r",
        "\u24E2": "s",
        "\u24E3": "t",
        "\u24E4": "u",
        "\u24E6": "v",
        "\u24E5": "w",
        "\u24E7": "x",
        "\u24E8": "y",
        "\u24E9": "z",
        // symbols
        "\u201C": '"',
        "\u201D": '"',
        "\u2018": "'",
        "\u2019": "'",
        "\u2202": "d",
        "\u0192": "f",
        "\u2122": "(TM)",
        "\xA9": "(C)",
        "\u0153": "oe",
        "\u0152": "OE",
        "\xAE": "(R)",
        "\u2020": "+",
        "\u2120": "(SM)",
        "\u2026": "...",
        "\u02DA": "o",
        "\xBA": "o",
        "\xAA": "a",
        "\u2022": "*",
        "\u104A": ",",
        "\u104B": ".",
        // currency
        "$": "USD",
        "\u20AC": "EUR",
        "\u20A2": "BRN",
        "\u20A3": "FRF",
        "\xA3": "GBP",
        "\u20A4": "ITL",
        "\u20A6": "NGN",
        "\u20A7": "ESP",
        "\u20A9": "KRW",
        "\u20AA": "ILS",
        "\u20AB": "VND",
        "\u20AD": "LAK",
        "\u20AE": "MNT",
        "\u20AF": "GRD",
        "\u20B1": "ARS",
        "\u20B2": "PYG",
        "\u20B3": "ARA",
        "\u20B4": "UAH",
        "\u20B5": "GHS",
        "\xA2": "cent",
        "\xA5": "CNY",
        "\u5143": "CNY",
        "\u5186": "YEN",
        "\uFDFC": "IRR",
        "\u20A0": "EWE",
        "\u0E3F": "THB",
        "\u20A8": "INR",
        "\u20B9": "INR",
        "\u20B0": "PF",
        "\u20BA": "TRY",
        "\u060B": "AFN",
        "\u20BC": "AZN",
        "\u043B\u0432": "BGN",
        "\u17DB": "KHR",
        "\u20A1": "CRC",
        "\u20B8": "KZT",
        "\u0434\u0435\u043D": "MKD",
        "z\u0142": "PLN",
        "\u20BD": "RUB",
        "\u20BE": "GEL"
      };
      var lookAheadCharArray = [
        // burmese
        "\u103A",
        // Dhivehi
        "\u07B0"
      ];
      var diatricMap = {
        // Burmese
        // dependent vowels
        "\u102C": "a",
        "\u102B": "a",
        "\u1031": "e",
        "\u1032": "e",
        "\u102D": "i",
        "\u102E": "i",
        "\u102D\u102F": "o",
        "\u102F": "u",
        "\u1030": "u",
        "\u1031\u102B\u1004\u103A": "aung",
        "\u1031\u102C": "aw",
        "\u1031\u102C\u103A": "aw",
        "\u1031\u102B": "aw",
        "\u1031\u102B\u103A": "aw",
        "\u103A": "\u103A",
        // this is special case but the character will be converted to latin in the code
        "\u1000\u103A": "et",
        "\u102D\u102F\u1000\u103A": "aik",
        "\u1031\u102C\u1000\u103A": "auk",
        "\u1004\u103A": "in",
        "\u102D\u102F\u1004\u103A": "aing",
        "\u1031\u102C\u1004\u103A": "aung",
        "\u1005\u103A": "it",
        "\u100A\u103A": "i",
        "\u1010\u103A": "at",
        "\u102D\u1010\u103A": "eik",
        "\u102F\u1010\u103A": "ok",
        "\u103D\u1010\u103A": "ut",
        "\u1031\u1010\u103A": "it",
        "\u1012\u103A": "d",
        "\u102D\u102F\u1012\u103A": "ok",
        "\u102F\u1012\u103A": "ait",
        "\u1014\u103A": "an",
        "\u102C\u1014\u103A": "an",
        "\u102D\u1014\u103A": "ein",
        "\u102F\u1014\u103A": "on",
        "\u103D\u1014\u103A": "un",
        "\u1015\u103A": "at",
        "\u102D\u1015\u103A": "eik",
        "\u102F\u1015\u103A": "ok",
        "\u103D\u1015\u103A": "ut",
        "\u1014\u103A\u102F\u1015\u103A": "nub",
        "\u1019\u103A": "an",
        "\u102D\u1019\u103A": "ein",
        "\u102F\u1019\u103A": "on",
        "\u103D\u1019\u103A": "un",
        "\u101A\u103A": "e",
        "\u102D\u102F\u101C\u103A": "ol",
        "\u1009\u103A": "in",
        "\u1036": "an",
        "\u102D\u1036": "ein",
        "\u102F\u1036": "on",
        // Dhivehi
        "\u07A6\u0787\u07B0": "ah",
        "\u07A6\u0781\u07B0": "ah"
      };
      var langCharMap = {
        "en": {},
        // default language
        "az": {
          // Azerbaijani
          "\xE7": "c",
          "\u0259": "e",
          "\u011F": "g",
          "\u0131": "i",
          "\xF6": "o",
          "\u015F": "s",
          "\xFC": "u",
          "\xC7": "C",
          "\u018F": "E",
          "\u011E": "G",
          "\u0130": "I",
          "\xD6": "O",
          "\u015E": "S",
          "\xDC": "U"
        },
        "cs": {
          // Czech
          "\u010D": "c",
          "\u010F": "d",
          "\u011B": "e",
          "\u0148": "n",
          "\u0159": "r",
          "\u0161": "s",
          "\u0165": "t",
          "\u016F": "u",
          "\u017E": "z",
          "\u010C": "C",
          "\u010E": "D",
          "\u011A": "E",
          "\u0147": "N",
          "\u0158": "R",
          "\u0160": "S",
          "\u0164": "T",
          "\u016E": "U",
          "\u017D": "Z"
        },
        "fi": {
          // Finnish
          // 'å': 'a', duplicate see charMap/latin
          // 'Å': 'A', duplicate see charMap/latin
          "\xE4": "a",
          // ok
          "\xC4": "A",
          // ok
          "\xF6": "o",
          // ok
          "\xD6": "O"
          // ok
        },
        "hu": {
          // Hungarian
          "\xE4": "a",
          // ok
          "\xC4": "A",
          // ok
          // 'á': 'a', duplicate see charMap/latin
          // 'Á': 'A', duplicate see charMap/latin
          "\xF6": "o",
          // ok
          "\xD6": "O",
          // ok
          // 'ő': 'o', duplicate see charMap/latin
          // 'Ő': 'O', duplicate see charMap/latin
          "\xFC": "u",
          "\xDC": "U",
          "\u0171": "u",
          "\u0170": "U"
        },
        "lt": {
          // Lithuanian
          "\u0105": "a",
          "\u010D": "c",
          "\u0119": "e",
          "\u0117": "e",
          "\u012F": "i",
          "\u0161": "s",
          "\u0173": "u",
          "\u016B": "u",
          "\u017E": "z",
          "\u0104": "A",
          "\u010C": "C",
          "\u0118": "E",
          "\u0116": "E",
          "\u012E": "I",
          "\u0160": "S",
          "\u0172": "U",
          "\u016A": "U"
        },
        "lv": {
          // Latvian
          "\u0101": "a",
          "\u010D": "c",
          "\u0113": "e",
          "\u0123": "g",
          "\u012B": "i",
          "\u0137": "k",
          "\u013C": "l",
          "\u0146": "n",
          "\u0161": "s",
          "\u016B": "u",
          "\u017E": "z",
          "\u0100": "A",
          "\u010C": "C",
          "\u0112": "E",
          "\u0122": "G",
          "\u012A": "i",
          "\u0136": "k",
          "\u013B": "L",
          "\u0145": "N",
          "\u0160": "S",
          "\u016A": "u",
          "\u017D": "Z"
        },
        "pl": {
          // Polish
          "\u0105": "a",
          "\u0107": "c",
          "\u0119": "e",
          "\u0142": "l",
          "\u0144": "n",
          "\xF3": "o",
          "\u015B": "s",
          "\u017A": "z",
          "\u017C": "z",
          "\u0104": "A",
          "\u0106": "C",
          "\u0118": "e",
          "\u0141": "L",
          "\u0143": "N",
          "\xD3": "O",
          "\u015A": "S",
          "\u0179": "Z",
          "\u017B": "Z"
        },
        "sv": {
          // Swedish
          // 'å': 'a', duplicate see charMap/latin
          // 'Å': 'A', duplicate see charMap/latin
          "\xE4": "a",
          // ok
          "\xC4": "A",
          // ok
          "\xF6": "o",
          // ok
          "\xD6": "O"
          // ok
        },
        "sk": {
          // Slovak
          "\xE4": "a",
          "\xC4": "A"
        },
        "sr": {
          // Serbian
          "\u0459": "lj",
          "\u045A": "nj",
          "\u0409": "Lj",
          "\u040A": "Nj",
          "\u0111": "dj",
          "\u0110": "Dj"
        },
        "tr": {
          // Turkish
          "\xDC": "U",
          "\xD6": "O",
          "\xFC": "u",
          "\xF6": "o"
        }
      };
      var symbolMap = {
        "ar": {
          "\u2206": "delta",
          "\u221E": "la-nihaya",
          "\u2665": "hob",
          "&": "wa",
          "|": "aw",
          "<": "aqal-men",
          ">": "akbar-men",
          "\u2211": "majmou",
          "\xA4": "omla"
        },
        "az": {},
        "ca": {
          "\u2206": "delta",
          "\u221E": "infinit",
          "\u2665": "amor",
          "&": "i",
          "|": "o",
          "<": "menys que",
          ">": "mes que",
          "\u2211": "suma dels",
          "\xA4": "moneda"
        },
        "cs": {
          "\u2206": "delta",
          "\u221E": "nekonecno",
          "\u2665": "laska",
          "&": "a",
          "|": "nebo",
          "<": "mensi nez",
          ">": "vetsi nez",
          "\u2211": "soucet",
          "\xA4": "mena"
        },
        "de": {
          "\u2206": "delta",
          "\u221E": "unendlich",
          "\u2665": "Liebe",
          "&": "und",
          "|": "oder",
          "<": "kleiner als",
          ">": "groesser als",
          "\u2211": "Summe von",
          "\xA4": "Waehrung"
        },
        "dv": {
          "\u2206": "delta",
          "\u221E": "kolunulaa",
          "\u2665": "loabi",
          "&": "aai",
          "|": "noonee",
          "<": "ah vure kuda",
          ">": "ah vure bodu",
          "\u2211": "jumula",
          "\xA4": "faisaa"
        },
        "en": {
          "\u2206": "delta",
          "\u221E": "infinity",
          "\u2665": "love",
          "&": "and",
          "|": "or",
          "<": "less than",
          ">": "greater than",
          "\u2211": "sum",
          "\xA4": "currency"
        },
        "es": {
          "\u2206": "delta",
          "\u221E": "infinito",
          "\u2665": "amor",
          "&": "y",
          "|": "u",
          "<": "menos que",
          ">": "mas que",
          "\u2211": "suma de los",
          "\xA4": "moneda"
        },
        "fa": {
          "\u2206": "delta",
          "\u221E": "bi-nahayat",
          "\u2665": "eshgh",
          "&": "va",
          "|": "ya",
          "<": "kamtar-az",
          ">": "bishtar-az",
          "\u2211": "majmooe",
          "\xA4": "vahed"
        },
        "fi": {
          "\u2206": "delta",
          "\u221E": "aarettomyys",
          "\u2665": "rakkaus",
          "&": "ja",
          "|": "tai",
          "<": "pienempi kuin",
          ">": "suurempi kuin",
          "\u2211": "summa",
          "\xA4": "valuutta"
        },
        "fr": {
          "\u2206": "delta",
          "\u221E": "infiniment",
          "\u2665": "Amour",
          "&": "et",
          "|": "ou",
          "<": "moins que",
          ">": "superieure a",
          "\u2211": "somme des",
          "\xA4": "monnaie"
        },
        "ge": {
          "\u2206": "delta",
          "\u221E": "usasruloba",
          "\u2665": "siqvaruli",
          "&": "da",
          "|": "an",
          "<": "naklebi",
          ">": "meti",
          "\u2211": "jami",
          "\xA4": "valuta"
        },
        "gr": {},
        "hu": {
          "\u2206": "delta",
          "\u221E": "vegtelen",
          "\u2665": "szerelem",
          "&": "es",
          "|": "vagy",
          "<": "kisebb mint",
          ">": "nagyobb mint",
          "\u2211": "szumma",
          "\xA4": "penznem"
        },
        "it": {
          "\u2206": "delta",
          "\u221E": "infinito",
          "\u2665": "amore",
          "&": "e",
          "|": "o",
          "<": "minore di",
          ">": "maggiore di",
          "\u2211": "somma",
          "\xA4": "moneta"
        },
        "lt": {
          "\u2206": "delta",
          "\u221E": "begalybe",
          "\u2665": "meile",
          "&": "ir",
          "|": "ar",
          "<": "maziau nei",
          ">": "daugiau nei",
          "\u2211": "suma",
          "\xA4": "valiuta"
        },
        "lv": {
          "\u2206": "delta",
          "\u221E": "bezgaliba",
          "\u2665": "milestiba",
          "&": "un",
          "|": "vai",
          "<": "mazak neka",
          ">": "lielaks neka",
          "\u2211": "summa",
          "\xA4": "valuta"
        },
        "my": {
          "\u2206": "kwahkhyaet",
          "\u221E": "asaonasme",
          "\u2665": "akhyait",
          "&": "nhin",
          "|": "tho",
          "<": "ngethaw",
          ">": "kyithaw",
          "\u2211": "paungld",
          "\xA4": "ngwekye"
        },
        "mk": {},
        "nl": {
          "\u2206": "delta",
          "\u221E": "oneindig",
          "\u2665": "liefde",
          "&": "en",
          "|": "of",
          "<": "kleiner dan",
          ">": "groter dan",
          "\u2211": "som",
          "\xA4": "valuta"
        },
        "pl": {
          "\u2206": "delta",
          "\u221E": "nieskonczonosc",
          "\u2665": "milosc",
          "&": "i",
          "|": "lub",
          "<": "mniejsze niz",
          ">": "wieksze niz",
          "\u2211": "suma",
          "\xA4": "waluta"
        },
        "pt": {
          "\u2206": "delta",
          "\u221E": "infinito",
          "\u2665": "amor",
          "&": "e",
          "|": "ou",
          "<": "menor que",
          ">": "maior que",
          "\u2211": "soma",
          "\xA4": "moeda"
        },
        "ro": {
          "\u2206": "delta",
          "\u221E": "infinit",
          "\u2665": "dragoste",
          "&": "si",
          "|": "sau",
          "<": "mai mic ca",
          ">": "mai mare ca",
          "\u2211": "suma",
          "\xA4": "valuta"
        },
        "ru": {
          "\u2206": "delta",
          "\u221E": "beskonechno",
          "\u2665": "lubov",
          "&": "i",
          "|": "ili",
          "<": "menshe",
          ">": "bolshe",
          "\u2211": "summa",
          "\xA4": "valjuta"
        },
        "sk": {
          "\u2206": "delta",
          "\u221E": "nekonecno",
          "\u2665": "laska",
          "&": "a",
          "|": "alebo",
          "<": "menej ako",
          ">": "viac ako",
          "\u2211": "sucet",
          "\xA4": "mena"
        },
        "sr": {},
        "tr": {
          "\u2206": "delta",
          "\u221E": "sonsuzluk",
          "\u2665": "ask",
          "&": "ve",
          "|": "veya",
          "<": "kucuktur",
          ">": "buyuktur",
          "\u2211": "toplam",
          "\xA4": "para birimi"
        },
        "uk": {
          "\u2206": "delta",
          "\u221E": "bezkinechnist",
          "\u2665": "lubov",
          "&": "i",
          "|": "abo",
          "<": "menshe",
          ">": "bilshe",
          "\u2211": "suma",
          "\xA4": "valjuta"
        },
        "vn": {
          "\u2206": "delta",
          "\u221E": "vo cuc",
          "\u2665": "yeu",
          "&": "va",
          "|": "hoac",
          "<": "nho hon",
          ">": "lon hon",
          "\u2211": "tong",
          "\xA4": "tien te"
        }
      };
      var uricChars = [";", "?", ":", "@", "&", "=", "+", "$", ",", "/"].join("");
      var uricNoSlashChars = [";", "?", ":", "@", "&", "=", "+", "$", ","].join("");
      var markChars = [".", "!", "~", "*", "'", "(", ")"].join("");
      var getSlug = function getSlug2(input, opts) {
        var separator = "-";
        var result = "";
        var diatricString = "";
        var convertSymbols = true;
        var customReplacements = {};
        var maintainCase;
        var titleCase;
        var truncate;
        var uricFlag;
        var uricNoSlashFlag;
        var markFlag;
        var symbol;
        var langChar;
        var lucky;
        var i;
        var ch;
        var l;
        var lastCharWasSymbol;
        var lastCharWasDiatric;
        var allowedChars = "";
        if (typeof input !== "string") {
          return "";
        }
        if (typeof opts === "string") {
          separator = opts;
        }
        symbol = symbolMap.en;
        langChar = langCharMap.en;
        if (typeof opts === "object") {
          maintainCase = opts.maintainCase || false;
          customReplacements = opts.custom && typeof opts.custom === "object" ? opts.custom : customReplacements;
          truncate = +opts.truncate > 1 && opts.truncate || false;
          uricFlag = opts.uric || false;
          uricNoSlashFlag = opts.uricNoSlash || false;
          markFlag = opts.mark || false;
          convertSymbols = opts.symbols === false || opts.lang === false ? false : true;
          separator = opts.separator || separator;
          if (uricFlag) {
            allowedChars += uricChars;
          }
          if (uricNoSlashFlag) {
            allowedChars += uricNoSlashChars;
          }
          if (markFlag) {
            allowedChars += markChars;
          }
          symbol = opts.lang && symbolMap[opts.lang] && convertSymbols ? symbolMap[opts.lang] : convertSymbols ? symbolMap.en : {};
          langChar = opts.lang && langCharMap[opts.lang] ? langCharMap[opts.lang] : opts.lang === false || opts.lang === true ? {} : langCharMap.en;
          if (opts.titleCase && typeof opts.titleCase.length === "number" && Array.prototype.toString.call(opts.titleCase)) {
            opts.titleCase.forEach(function(v) {
              customReplacements[v + ""] = v + "";
            });
            titleCase = true;
          } else {
            titleCase = !!opts.titleCase;
          }
          if (opts.custom && typeof opts.custom.length === "number" && Array.prototype.toString.call(opts.custom)) {
            opts.custom.forEach(function(v) {
              customReplacements[v + ""] = v + "";
            });
          }
          Object.keys(customReplacements).forEach(function(v) {
            var r;
            if (v.length > 1) {
              r = new RegExp("\\b" + escapeChars(v) + "\\b", "gi");
            } else {
              r = new RegExp(escapeChars(v), "gi");
            }
            input = input.replace(r, customReplacements[v]);
          });
          for (ch in customReplacements) {
            allowedChars += ch;
          }
        }
        allowedChars += separator;
        allowedChars = escapeChars(allowedChars);
        input = input.replace(/(^\s+|\s+$)/g, "");
        lastCharWasSymbol = false;
        lastCharWasDiatric = false;
        for (i = 0, l = input.length; i < l; i++) {
          ch = input[i];
          if (isReplacedCustomChar(ch, customReplacements)) {
            lastCharWasSymbol = false;
          } else if (langChar[ch]) {
            ch = lastCharWasSymbol && langChar[ch].match(/[A-Za-z0-9]/) ? " " + langChar[ch] : langChar[ch];
            lastCharWasSymbol = false;
          } else if (ch in charMap) {
            if (i + 1 < l && lookAheadCharArray.indexOf(input[i + 1]) >= 0) {
              diatricString += ch;
              ch = "";
            } else if (lastCharWasDiatric === true) {
              ch = diatricMap[diatricString] + charMap[ch];
              diatricString = "";
            } else {
              ch = lastCharWasSymbol && charMap[ch].match(/[A-Za-z0-9]/) ? " " + charMap[ch] : charMap[ch];
            }
            lastCharWasSymbol = false;
            lastCharWasDiatric = false;
          } else if (ch in diatricMap) {
            diatricString += ch;
            ch = "";
            if (i === l - 1) {
              ch = diatricMap[diatricString];
            }
            lastCharWasDiatric = true;
          } else if (
            // process symbol chars
            symbol[ch] && !(uricFlag && uricChars.indexOf(ch) !== -1) && !(uricNoSlashFlag && uricNoSlashChars.indexOf(ch) !== -1)
          ) {
            ch = lastCharWasSymbol || result.substr(-1).match(/[A-Za-z0-9]/) ? separator + symbol[ch] : symbol[ch];
            ch += input[i + 1] !== void 0 && input[i + 1].match(/[A-Za-z0-9]/) ? separator : "";
            lastCharWasSymbol = true;
          } else {
            if (lastCharWasDiatric === true) {
              ch = diatricMap[diatricString] + ch;
              diatricString = "";
              lastCharWasDiatric = false;
            } else if (lastCharWasSymbol && (/[A-Za-z0-9]/.test(ch) || result.substr(-1).match(/A-Za-z0-9]/))) {
              ch = " " + ch;
            }
            lastCharWasSymbol = false;
          }
          result += ch.replace(new RegExp("[^\\w\\s" + allowedChars + "_-]", "g"), separator);
        }
        if (titleCase) {
          result = result.replace(/(\w)(\S*)/g, function(_, i2, r) {
            var j = i2.toUpperCase() + (r !== null ? r : "");
            return Object.keys(customReplacements).indexOf(j.toLowerCase()) < 0 ? j : j.toLowerCase();
          });
        }
        result = result.replace(/\s+/g, separator).replace(new RegExp("\\" + separator + "+", "g"), separator).replace(new RegExp("(^\\" + separator + "+|\\" + separator + "+$)", "g"), "");
        if (truncate && result.length > truncate) {
          lucky = result.charAt(truncate) === separator;
          result = result.slice(0, truncate);
          if (!lucky) {
            result = result.slice(0, result.lastIndexOf(separator));
          }
        }
        if (!maintainCase && !titleCase) {
          result = result.toLowerCase();
        }
        return result;
      };
      var createSlug = function createSlug2(opts) {
        return function getSlugWithConfig(input) {
          return getSlug(input, opts);
        };
      };
      var escapeChars = function escapeChars2(input) {
        return input.replace(/[-\\^$*+?.()|[\]{}\/]/g, "\\$&");
      };
      var isReplacedCustomChar = function(ch, customReplacements) {
        for (var c in customReplacements) {
          if (customReplacements[c] === ch) {
            return true;
          }
        }
      };
      if (typeof module !== "undefined" && module.exports) {
        module.exports = getSlug;
        module.exports.createSlug = createSlug;
      } else if (typeof define !== "undefined" && define.amd) {
        define([], function() {
          return getSlug;
        });
      } else {
        try {
          if (root.getSlug || root.createSlug) {
            throw "speakingurl: globals exists /(getSlug|createSlug)/";
          } else {
            root.getSlug = getSlug;
            root.createSlug = createSlug;
          }
        } catch (e) {
        }
      }
    })(exports);
  }
});

// ../../node_modules/.pnpm/speakingurl@14.0.1/node_modules/speakingurl/index.js
var require_speakingurl2 = __commonJS({
  "../../node_modules/.pnpm/speakingurl@14.0.1/node_modules/speakingurl/index.js"(exports, module) {
    init_esm_shims();
    module.exports = require_speakingurl();
  }
});

// src/index.ts
init_esm_shims();

// src/core/index.ts
init_esm_shims();

// src/compat/index.ts
init_esm_shims();

// src/ctx/index.ts
init_esm_shims();

// src/ctx/api.ts
init_esm_shims();

// src/core/component-highlighter/index.ts
init_esm_shims();

// src/core/component/state/bounding-rect.ts
init_esm_shims();

// src/core/component/utils/index.ts
init_esm_shims();
function getComponentTypeName(options) {
  var _a25;
  const name = options.name || options._componentTag || options.__VUE_DEVTOOLS_COMPONENT_GUSSED_NAME__ || options.__name;
  if (name === "index" && ((_a25 = options.__file) == null ? void 0 : _a25.endsWith("index.vue"))) {
    return "";
  }
  return name;
}
function getComponentFileName(options) {
  const file = options.__file;
  if (file)
    return classify(basename(file, ".vue"));
}
function saveComponentGussedName(instance, name) {
  instance.type.__VUE_DEVTOOLS_COMPONENT_GUSSED_NAME__ = name;
  return name;
}
function getAppRecord(instance) {
  if (instance.__VUE_DEVTOOLS_NEXT_APP_RECORD__)
    return instance.__VUE_DEVTOOLS_NEXT_APP_RECORD__;
  else if (instance.root)
    return instance.appContext.app.__VUE_DEVTOOLS_NEXT_APP_RECORD__;
}
function isFragment(instance) {
  var _a25, _b25;
  const subTreeType = (_a25 = instance.subTree) == null ? void 0 : _a25.type;
  const appRecord = getAppRecord(instance);
  if (appRecord) {
    return ((_b25 = appRecord == null ? void 0 : appRecord.types) == null ? void 0 : _b25.Fragment) === subTreeType;
  }
  return false;
}
function getInstanceName(instance) {
  var _a25, _b25, _c;
  const name = getComponentTypeName((instance == null ? void 0 : instance.type) || {});
  if (name)
    return name;
  if ((instance == null ? void 0 : instance.root) === instance)
    return "Root";
  for (const key in (_b25 = (_a25 = instance.parent) == null ? void 0 : _a25.type) == null ? void 0 : _b25.components) {
    if (instance.parent.type.components[key] === (instance == null ? void 0 : instance.type))
      return saveComponentGussedName(instance, key);
  }
  for (const key in (_c = instance.appContext) == null ? void 0 : _c.components) {
    if (instance.appContext.components[key] === (instance == null ? void 0 : instance.type))
      return saveComponentGussedName(instance, key);
  }
  const fileName = getComponentFileName((instance == null ? void 0 : instance.type) || {});
  if (fileName)
    return fileName;
  return "Anonymous Component";
}
function getUniqueComponentId(instance) {
  var _a25, _b25, _c;
  const appId = (_c = (_b25 = (_a25 = instance == null ? void 0 : instance.appContext) == null ? void 0 : _a25.app) == null ? void 0 : _b25.__VUE_DEVTOOLS_NEXT_APP_RECORD_ID__) != null ? _c : 0;
  const instanceId = instance === (instance == null ? void 0 : instance.root) ? "root" : instance.uid;
  return `${appId}:${instanceId}`;
}
function getComponentInstance(appRecord, instanceId) {
  instanceId = instanceId || `${appRecord.id}:root`;
  const instance = appRecord.instanceMap.get(instanceId);
  return instance || appRecord.instanceMap.get(":root");
}

// src/core/component/state/bounding-rect.ts
function createRect() {
  const rect = {
    top: 0,
    bottom: 0,
    left: 0,
    right: 0,
    get width() {
      return rect.right - rect.left;
    },
    get height() {
      return rect.bottom - rect.top;
    }
  };
  return rect;
}
var range;
function getTextRect(node) {
  if (!range)
    range = document.createRange();
  range.selectNode(node);
  return range.getBoundingClientRect();
}
function getFragmentRect(vnode) {
  const rect = createRect();
  if (!vnode.children)
    return rect;
  for (let i = 0, l = vnode.children.length; i < l; i++) {
    const childVnode = vnode.children[i];
    let childRect;
    if (childVnode.component) {
      childRect = getComponentBoundingRect(childVnode.component);
    } else if (childVnode.el) {
      const el = childVnode.el;
      if (el.nodeType === 1 || el.getBoundingClientRect)
        childRect = el.getBoundingClientRect();
      else if (el.nodeType === 3 && el.data.trim())
        childRect = getTextRect(el);
    }
    if (childRect)
      mergeRects(rect, childRect);
  }
  return rect;
}
function mergeRects(a, b) {
  if (!a.top || b.top < a.top)
    a.top = b.top;
  if (!a.bottom || b.bottom > a.bottom)
    a.bottom = b.bottom;
  if (!a.left || b.left < a.left)
    a.left = b.left;
  if (!a.right || b.right > a.right)
    a.right = b.right;
  return a;
}
var DEFAULT_RECT = {
  top: 0,
  left: 0,
  right: 0,
  bottom: 0,
  width: 0,
  height: 0
};
function getComponentBoundingRect(instance) {
  const el = instance.subTree.el;
  if (typeof window === "undefined") {
    return DEFAULT_RECT;
  }
  if (isFragment(instance))
    return getFragmentRect(instance.subTree);
  else if ((el == null ? void 0 : el.nodeType) === 1)
    return el == null ? void 0 : el.getBoundingClientRect();
  else if (instance.subTree.component)
    return getComponentBoundingRect(instance.subTree.component);
  else
    return DEFAULT_RECT;
}

// src/core/component/tree/el.ts
init_esm_shims();
function getRootElementsFromComponentInstance(instance) {
  if (isFragment(instance))
    return getFragmentRootElements(instance.subTree);
  if (!instance.subTree)
    return [];
  return [instance.subTree.el];
}
function getFragmentRootElements(vnode) {
  if (!vnode.children)
    return [];
  const list = [];
  vnode.children.forEach((childVnode) => {
    if (childVnode.component)
      list.push(...getRootElementsFromComponentInstance(childVnode.component));
    else if (childVnode == null ? void 0 : childVnode.el)
      list.push(childVnode.el);
  });
  return list;
}

// src/core/component-highlighter/index.ts
var CONTAINER_ELEMENT_ID = "__vue-devtools-component-inspector__";
var CARD_ELEMENT_ID = "__vue-devtools-component-inspector__card__";
var COMPONENT_NAME_ELEMENT_ID = "__vue-devtools-component-inspector__name__";
var INDICATOR_ELEMENT_ID = "__vue-devtools-component-inspector__indicator__";
var containerStyles = {
  display: "block",
  zIndex: 2147483640,
  position: "fixed",
  backgroundColor: "#42b88325",
  border: "1px solid #42b88350",
  borderRadius: "5px",
  transition: "all 0.1s ease-in",
  pointerEvents: "none"
};
var cardStyles = {
  fontFamily: "Arial, Helvetica, sans-serif",
  padding: "5px 8px",
  borderRadius: "4px",
  textAlign: "left",
  position: "absolute",
  left: 0,
  color: "#e9e9e9",
  fontSize: "14px",
  fontWeight: 600,
  lineHeight: "24px",
  backgroundColor: "#42b883",
  boxShadow: "0 1px 3px 0 rgba(0, 0, 0, 0.1), 0 1px 2px -1px rgba(0, 0, 0, 0.1)"
};
var indicatorStyles = {
  display: "inline-block",
  fontWeight: 400,
  fontStyle: "normal",
  fontSize: "12px",
  opacity: 0.7
};
function getContainerElement() {
  return document.getElementById(CONTAINER_ELEMENT_ID);
}
function getCardElement() {
  return document.getElementById(CARD_ELEMENT_ID);
}
function getIndicatorElement() {
  return document.getElementById(INDICATOR_ELEMENT_ID);
}
function getNameElement() {
  return document.getElementById(COMPONENT_NAME_ELEMENT_ID);
}
function getStyles(bounds) {
  return {
    left: `${Math.round(bounds.left * 100) / 100}px`,
    top: `${Math.round(bounds.top * 100) / 100}px`,
    width: `${Math.round(bounds.width * 100) / 100}px`,
    height: `${Math.round(bounds.height * 100) / 100}px`
  };
}
function create(options) {
  var _a25;
  const containerEl = document.createElement("div");
  containerEl.id = (_a25 = options.elementId) != null ? _a25 : CONTAINER_ELEMENT_ID;
  Object.assign(containerEl.style, {
    ...containerStyles,
    ...getStyles(options.bounds),
    ...options.style
  });
  const cardEl = document.createElement("span");
  cardEl.id = CARD_ELEMENT_ID;
  Object.assign(cardEl.style, {
    ...cardStyles,
    top: options.bounds.top < 35 ? 0 : "-35px"
  });
  const nameEl = document.createElement("span");
  nameEl.id = COMPONENT_NAME_ELEMENT_ID;
  nameEl.innerHTML = `&lt;${options.name}&gt;&nbsp;&nbsp;`;
  const indicatorEl = document.createElement("i");
  indicatorEl.id = INDICATOR_ELEMENT_ID;
  indicatorEl.innerHTML = `${Math.round(options.bounds.width * 100) / 100} x ${Math.round(options.bounds.height * 100) / 100}`;
  Object.assign(indicatorEl.style, indicatorStyles);
  cardEl.appendChild(nameEl);
  cardEl.appendChild(indicatorEl);
  containerEl.appendChild(cardEl);
  document.body.appendChild(containerEl);
  return containerEl;
}
function update(options) {
  const containerEl = getContainerElement();
  const cardEl = getCardElement();
  const nameEl = getNameElement();
  const indicatorEl = getIndicatorElement();
  if (containerEl) {
    Object.assign(containerEl.style, {
      ...containerStyles,
      ...getStyles(options.bounds)
    });
    Object.assign(cardEl.style, {
      top: options.bounds.top < 35 ? 0 : "-35px"
    });
    nameEl.innerHTML = `&lt;${options.name}&gt;&nbsp;&nbsp;`;
    indicatorEl.innerHTML = `${Math.round(options.bounds.width * 100) / 100} x ${Math.round(options.bounds.height * 100) / 100}`;
  }
}
function highlight(instance) {
  const bounds = getComponentBoundingRect(instance);
  if (!bounds.width && !bounds.height)
    return;
  const name = getInstanceName(instance);
  const container = getContainerElement();
  container ? update({ bounds, name }) : create({ bounds, name });
}
function unhighlight() {
  const el = getContainerElement();
  if (el)
    el.style.display = "none";
}
var inspectInstance = null;
function inspectFn(e) {
  const target21 = e.target;
  if (target21) {
    const instance = target21.__vueParentComponent;
    if (instance) {
      inspectInstance = instance;
      const el = instance.vnode.el;
      if (el) {
        const bounds = getComponentBoundingRect(instance);
        const name = getInstanceName(instance);
        const container = getContainerElement();
        container ? update({ bounds, name }) : create({ bounds, name });
      }
    }
  }
}
function selectComponentFn(e, cb) {
  e.preventDefault();
  e.stopPropagation();
  if (inspectInstance) {
    const uniqueComponentId = getUniqueComponentId(inspectInstance);
    cb(uniqueComponentId);
  }
}
var inspectComponentHighLighterSelectFn = null;
function cancelInspectComponentHighLighter() {
  unhighlight();
  window.removeEventListener("mouseover", inspectFn);
  window.removeEventListener("click", inspectComponentHighLighterSelectFn, true);
  inspectComponentHighLighterSelectFn = null;
}
function inspectComponentHighLighter() {
  window.addEventListener("mouseover", inspectFn);
  return new Promise((resolve) => {
    function onSelect(e) {
      e.preventDefault();
      e.stopPropagation();
      selectComponentFn(e, (id) => {
        window.removeEventListener("click", onSelect, true);
        inspectComponentHighLighterSelectFn = null;
        window.removeEventListener("mouseover", inspectFn);
        const el = getContainerElement();
        if (el)
          el.style.display = "none";
        resolve(JSON.stringify({ id }));
      });
    }
    inspectComponentHighLighterSelectFn = onSelect;
    window.addEventListener("click", onSelect, true);
  });
}
function scrollToComponent(options) {
  const instance = getComponentInstance(activeAppRecord.value, options.id);
  if (instance) {
    const [el] = getRootElementsFromComponentInstance(instance);
    if (typeof el.scrollIntoView === "function") {
      el.scrollIntoView({
        behavior: "smooth"
      });
    } else {
      const bounds = getComponentBoundingRect(instance);
      const scrollTarget = document.createElement("div");
      const styles = {
        ...getStyles(bounds),
        position: "absolute"
      };
      Object.assign(scrollTarget.style, styles);
      document.body.appendChild(scrollTarget);
      scrollTarget.scrollIntoView({
        behavior: "smooth"
      });
      setTimeout(() => {
        document.body.removeChild(scrollTarget);
      }, 2e3);
    }
    setTimeout(() => {
      const bounds = getComponentBoundingRect(instance);
      if (bounds.width || bounds.height) {
        const name = getInstanceName(instance);
        const el2 = getContainerElement();
        el2 ? update({ ...options, name, bounds }) : create({ ...options, name, bounds });
        setTimeout(() => {
          if (el2)
            el2.style.display = "none";
        }, 1500);
      }
    }, 1200);
  }
}

// src/core/component-inspector/index.ts
init_esm_shims();
var _a, _b;
(_b = (_a = target).__VUE_DEVTOOLS_COMPONENT_INSPECTOR_ENABLED__) != null ? _b : _a.__VUE_DEVTOOLS_COMPONENT_INSPECTOR_ENABLED__ = true;
function waitForInspectorInit(cb) {
  let total = 0;
  const timer = setInterval(() => {
    if (target.__VUE_INSPECTOR__) {
      clearInterval(timer);
      total += 30;
      cb();
    }
    if (total >= /* 5s */
    5e3)
      clearInterval(timer);
  }, 30);
}
function setupInspector() {
  const inspector = target.__VUE_INSPECTOR__;
  const _openInEditor = inspector.openInEditor;
  inspector.openInEditor = async (...params) => {
    inspector.disable();
    _openInEditor(...params);
  };
}
function getComponentInspector() {
  return new Promise((resolve) => {
    function setup() {
      setupInspector();
      resolve(target.__VUE_INSPECTOR__);
    }
    if (!target.__VUE_INSPECTOR__) {
      waitForInspectorInit(() => {
        setup();
      });
    } else {
      setup();
    }
  });
}

// src/core/component/state/editor.ts
init_esm_shims();

// src/shared/stub-vue.ts
init_esm_shims();
function isReadonly(value) {
  return !!(value && value["__v_isReadonly" /* IS_READONLY */]);
}
function isReactive(value) {
  if (isReadonly(value)) {
    return isReactive(value["__v_raw" /* RAW */]);
  }
  return !!(value && value["__v_isReactive" /* IS_REACTIVE */]);
}
function isRef(r) {
  return !!(r && r.__v_isRef === true);
}
function toRaw(observed) {
  const raw = observed && observed["__v_raw" /* RAW */];
  return raw ? toRaw(raw) : observed;
}

// src/core/component/state/editor.ts
var StateEditor = class {
  constructor() {
    this.refEditor = new RefStateEditor();
  }
  set(object, path, value, cb) {
    const sections = Array.isArray(path) ? path : path.split(".");
    while (sections.length > 1) {
      const section = sections.shift();
      if (object instanceof Map)
        object = object.get(section);
      else if (object instanceof Set)
        object = Array.from(object.values())[section];
      else object = object[section];
      if (this.refEditor.isRef(object))
        object = this.refEditor.get(object);
    }
    const field = sections[0];
    const item = this.refEditor.get(object)[field];
    if (cb) {
      cb(object, field, value);
    } else {
      if (this.refEditor.isRef(item))
        this.refEditor.set(item, value);
      else object[field] = value;
    }
  }
  get(object, path) {
    const sections = Array.isArray(path) ? path : path.split(".");
    for (let i = 0; i < sections.length; i++) {
      if (object instanceof Map)
        object = object.get(sections[i]);
      else
        object = object[sections[i]];
      if (this.refEditor.isRef(object))
        object = this.refEditor.get(object);
      if (!object)
        return void 0;
    }
    return object;
  }
  has(object, path, parent = false) {
    if (typeof object === "undefined")
      return false;
    const sections = Array.isArray(path) ? path.slice() : path.split(".");
    const size = !parent ? 1 : 2;
    while (object && sections.length > size) {
      const section = sections.shift();
      object = object[section];
      if (this.refEditor.isRef(object))
        object = this.refEditor.get(object);
    }
    return object != null && Object.prototype.hasOwnProperty.call(object, sections[0]);
  }
  createDefaultSetCallback(state) {
    return (object, field, value) => {
      if (state.remove || state.newKey) {
        if (Array.isArray(object))
          object.splice(field, 1);
        else if (toRaw(object) instanceof Map)
          object.delete(field);
        else if (toRaw(object) instanceof Set)
          object.delete(Array.from(object.values())[field]);
        else Reflect.deleteProperty(object, field);
      }
      if (!state.remove) {
        const target21 = object[state.newKey || field];
        if (this.refEditor.isRef(target21))
          this.refEditor.set(target21, value);
        else if (toRaw(object) instanceof Map)
          object.set(state.newKey || field, value);
        else if (toRaw(object) instanceof Set)
          object.add(value);
        else
          object[state.newKey || field] = value;
      }
    };
  }
};
var RefStateEditor = class {
  set(ref, value) {
    if (isRef(ref)) {
      ref.value = value;
    } else {
      if (ref instanceof Set && Array.isArray(value)) {
        ref.clear();
        value.forEach((v) => ref.add(v));
        return;
      }
      const currentKeys = Object.keys(value);
      if (ref instanceof Map) {
        const previousKeysSet2 = new Set(ref.keys());
        currentKeys.forEach((key) => {
          ref.set(key, Reflect.get(value, key));
          previousKeysSet2.delete(key);
        });
        previousKeysSet2.forEach((key) => ref.delete(key));
        return;
      }
      const previousKeysSet = new Set(Object.keys(ref));
      currentKeys.forEach((key) => {
        Reflect.set(ref, key, Reflect.get(value, key));
        previousKeysSet.delete(key);
      });
      previousKeysSet.forEach((key) => Reflect.deleteProperty(ref, key));
    }
  }
  get(ref) {
    return isRef(ref) ? ref.value : ref;
  }
  isRef(ref) {
    return isRef(ref) || isReactive(ref);
  }
};

// src/core/open-in-editor/index.ts
init_esm_shims();

// src/ctx/state.ts
init_esm_shims();

// src/core/timeline/storage.ts
init_esm_shims();
var TIMELINE_LAYERS_STATE_STORAGE_ID = "__VUE_DEVTOOLS_KIT_TIMELINE_LAYERS_STATE__";
function getTimelineLayersStateFromStorage() {
  if (typeof window === "undefined" || !isBrowser || typeof localStorage === "undefined" || localStorage === null) {
    return {
      recordingState: false,
      mouseEventEnabled: false,
      keyboardEventEnabled: false,
      componentEventEnabled: false,
      performanceEventEnabled: false,
      selected: ""
    };
  }
  const state = typeof localStorage.getItem !== "undefined" ? localStorage.getItem(TIMELINE_LAYERS_STATE_STORAGE_ID) : null;
  return state ? JSON.parse(state) : {
    recordingState: false,
    mouseEventEnabled: false,
    keyboardEventEnabled: false,
    componentEventEnabled: false,
    performanceEventEnabled: false,
    selected: ""
  };
}

// src/ctx/hook.ts
init_esm_shims();

// src/ctx/inspector.ts
init_esm_shims();

// src/ctx/timeline.ts
init_esm_shims();
var _a2, _b2;
(_b2 = (_a2 = target).__VUE_DEVTOOLS_KIT_TIMELINE_LAYERS) != null ? _b2 : _a2.__VUE_DEVTOOLS_KIT_TIMELINE_LAYERS = [];
var devtoolsTimelineLayers = new Proxy(target.__VUE_DEVTOOLS_KIT_TIMELINE_LAYERS, {
  get(target21, prop, receiver) {
    return Reflect.get(target21, prop, receiver);
  }
});
function addTimelineLayer(options, descriptor) {
  devtoolsState.timelineLayersState[descriptor.id] = false;
  devtoolsTimelineLayers.push({
    ...options,
    descriptorId: descriptor.id,
    appRecord: getAppRecord(descriptor.app)
  });
}

// src/ctx/inspector.ts
var _a3, _b3;
(_b3 = (_a3 = target).__VUE_DEVTOOLS_KIT_INSPECTOR__) != null ? _b3 : _a3.__VUE_DEVTOOLS_KIT_INSPECTOR__ = [];
var devtoolsInspector = new Proxy(target.__VUE_DEVTOOLS_KIT_INSPECTOR__, {
  get(target21, prop, receiver) {
    return Reflect.get(target21, prop, receiver);
  }
});
var callInspectorUpdatedHook = debounce(() => {
  devtoolsContext.hooks.callHook("sendInspectorToClient" /* SEND_INSPECTOR_TO_CLIENT */, getActiveInspectors());
});
function addInspector(inspector, descriptor) {
  var _a25, _b25;
  devtoolsInspector.push({
    options: inspector,
    descriptor,
    treeFilterPlaceholder: (_a25 = inspector.treeFilterPlaceholder) != null ? _a25 : "Search tree...",
    stateFilterPlaceholder: (_b25 = inspector.stateFilterPlaceholder) != null ? _b25 : "Search state...",
    treeFilter: "",
    selectedNodeId: "",
    appRecord: getAppRecord(descriptor.app)
  });
  callInspectorUpdatedHook();
}
function getActiveInspectors() {
  return devtoolsInspector.filter((inspector) => inspector.descriptor.app === activeAppRecord.value.app).filter((inspector) => inspector.descriptor.id !== "components").map((inspector) => {
    var _a25;
    const descriptor = inspector.descriptor;
    const options = inspector.options;
    return {
      id: options.id,
      label: options.label,
      logo: descriptor.logo,
      icon: `custom-ic-baseline-${(_a25 = options == null ? void 0 : options.icon) == null ? void 0 : _a25.replace(/_/g, "-")}`,
      packageName: descriptor.packageName,
      homepage: descriptor.homepage,
      pluginId: descriptor.id
    };
  });
}
function getInspector(id, app) {
  return devtoolsInspector.find((inspector) => inspector.options.id === id && (app ? inspector.descriptor.app === app : true));
}
function createDevToolsCtxHooks() {
  const hooks2 = createHooks();
  hooks2.hook("addInspector" /* ADD_INSPECTOR */, ({ inspector, plugin }) => {
    addInspector(inspector, plugin.descriptor);
  });
  const debounceSendInspectorTree = debounce(async ({ inspectorId, plugin }) => {
    var _a25;
    if (!inspectorId || !((_a25 = plugin == null ? void 0 : plugin.descriptor) == null ? void 0 : _a25.app) || devtoolsState.highPerfModeEnabled)
      return;
    const inspector = getInspector(inspectorId, plugin.descriptor.app);
    const _payload = {
      app: plugin.descriptor.app,
      inspectorId,
      filter: (inspector == null ? void 0 : inspector.treeFilter) || "",
      rootNodes: []
    };
    await new Promise((resolve) => {
      hooks2.callHookWith(async (callbacks) => {
        await Promise.all(callbacks.map((cb) => cb(_payload)));
        resolve();
      }, "getInspectorTree" /* GET_INSPECTOR_TREE */);
    });
    hooks2.callHookWith(async (callbacks) => {
      await Promise.all(callbacks.map((cb) => cb({
        inspectorId,
        rootNodes: _payload.rootNodes
      })));
    }, "sendInspectorTreeToClient" /* SEND_INSPECTOR_TREE_TO_CLIENT */);
  }, 120);
  hooks2.hook("sendInspectorTree" /* SEND_INSPECTOR_TREE */, debounceSendInspectorTree);
  const debounceSendInspectorState = debounce(async ({ inspectorId, plugin }) => {
    var _a25;
    if (!inspectorId || !((_a25 = plugin == null ? void 0 : plugin.descriptor) == null ? void 0 : _a25.app) || devtoolsState.highPerfModeEnabled)
      return;
    const inspector = getInspector(inspectorId, plugin.descriptor.app);
    const _payload = {
      app: plugin.descriptor.app,
      inspectorId,
      nodeId: (inspector == null ? void 0 : inspector.selectedNodeId) || "",
      state: null
    };
    const ctx = {
      currentTab: `custom-inspector:${inspectorId}`
    };
    if (_payload.nodeId) {
      await new Promise((resolve) => {
        hooks2.callHookWith(async (callbacks) => {
          await Promise.all(callbacks.map((cb) => cb(_payload, ctx)));
          resolve();
        }, "getInspectorState" /* GET_INSPECTOR_STATE */);
      });
    }
    hooks2.callHookWith(async (callbacks) => {
      await Promise.all(callbacks.map((cb) => cb({
        inspectorId,
        nodeId: _payload.nodeId,
        state: _payload.state
      })));
    }, "sendInspectorStateToClient" /* SEND_INSPECTOR_STATE_TO_CLIENT */);
  }, 120);
  hooks2.hook("sendInspectorState" /* SEND_INSPECTOR_STATE */, debounceSendInspectorState);
  hooks2.hook("customInspectorSelectNode" /* CUSTOM_INSPECTOR_SELECT_NODE */, ({ inspectorId, nodeId, plugin }) => {
    const inspector = getInspector(inspectorId, plugin.descriptor.app);
    if (!inspector)
      return;
    inspector.selectedNodeId = nodeId;
  });
  hooks2.hook("timelineLayerAdded" /* TIMELINE_LAYER_ADDED */, ({ options, plugin }) => {
    addTimelineLayer(options, plugin.descriptor);
  });
  hooks2.hook("timelineEventAdded" /* TIMELINE_EVENT_ADDED */, ({ options, plugin }) => {
    var _a25;
    const internalLayerIds = ["performance", "component-event", "keyboard", "mouse"];
    if (devtoolsState.highPerfModeEnabled || !((_a25 = devtoolsState.timelineLayersState) == null ? void 0 : _a25[plugin.descriptor.id]) && !internalLayerIds.includes(options.layerId))
      return;
    hooks2.callHookWith(async (callbacks) => {
      await Promise.all(callbacks.map((cb) => cb(options)));
    }, "sendTimelineEventToClient" /* SEND_TIMELINE_EVENT_TO_CLIENT */);
  });
  hooks2.hook("getComponentInstances" /* GET_COMPONENT_INSTANCES */, async ({ app }) => {
    const appRecord = app.__VUE_DEVTOOLS_NEXT_APP_RECORD__;
    if (!appRecord)
      return null;
    const appId = appRecord.id.toString();
    const instances = [...appRecord.instanceMap].filter(([key]) => key.split(":")[0] === appId).map(([, instance]) => instance);
    return instances;
  });
  hooks2.hook("getComponentBounds" /* GET_COMPONENT_BOUNDS */, async ({ instance }) => {
    const bounds = getComponentBoundingRect(instance);
    return bounds;
  });
  hooks2.hook("getComponentName" /* GET_COMPONENT_NAME */, ({ instance }) => {
    const name = getInstanceName(instance);
    return name;
  });
  hooks2.hook("componentHighlight" /* COMPONENT_HIGHLIGHT */, ({ uid }) => {
    const instance = activeAppRecord.value.instanceMap.get(uid);
    if (instance) {
      highlight(instance);
    }
  });
  hooks2.hook("componentUnhighlight" /* COMPONENT_UNHIGHLIGHT */, () => {
    unhighlight();
  });
  return hooks2;
}

// src/ctx/state.ts
var _a4, _b4;
(_b4 = (_a4 = target).__VUE_DEVTOOLS_KIT_APP_RECORDS__) != null ? _b4 : _a4.__VUE_DEVTOOLS_KIT_APP_RECORDS__ = [];
var _a5, _b5;
(_b5 = (_a5 = target).__VUE_DEVTOOLS_KIT_ACTIVE_APP_RECORD__) != null ? _b5 : _a5.__VUE_DEVTOOLS_KIT_ACTIVE_APP_RECORD__ = {};
var _a6, _b6;
(_b6 = (_a6 = target).__VUE_DEVTOOLS_KIT_ACTIVE_APP_RECORD_ID__) != null ? _b6 : _a6.__VUE_DEVTOOLS_KIT_ACTIVE_APP_RECORD_ID__ = "";
var _a7, _b7;
(_b7 = (_a7 = target).__VUE_DEVTOOLS_KIT_CUSTOM_TABS__) != null ? _b7 : _a7.__VUE_DEVTOOLS_KIT_CUSTOM_TABS__ = [];
var _a8, _b8;
(_b8 = (_a8 = target).__VUE_DEVTOOLS_KIT_CUSTOM_COMMANDS__) != null ? _b8 : _a8.__VUE_DEVTOOLS_KIT_CUSTOM_COMMANDS__ = [];
var STATE_KEY = "__VUE_DEVTOOLS_KIT_GLOBAL_STATE__";
function initStateFactory() {
  return {
    connected: false,
    clientConnected: false,
    vitePluginDetected: true,
    appRecords: [],
    activeAppRecordId: "",
    tabs: [],
    commands: [],
    highPerfModeEnabled: true,
    devtoolsClientDetected: {},
    perfUniqueGroupId: 0,
    timelineLayersState: getTimelineLayersStateFromStorage()
  };
}
var _a9, _b9;
(_b9 = (_a9 = target)[STATE_KEY]) != null ? _b9 : _a9[STATE_KEY] = initStateFactory();
var callStateUpdatedHook = debounce((state) => {
  devtoolsContext.hooks.callHook("devtoolsStateUpdated" /* DEVTOOLS_STATE_UPDATED */, { state });
});
debounce((state, oldState) => {
  devtoolsContext.hooks.callHook("devtoolsConnectedUpdated" /* DEVTOOLS_CONNECTED_UPDATED */, { state, oldState });
});
var devtoolsAppRecords = new Proxy(target.__VUE_DEVTOOLS_KIT_APP_RECORDS__, {
  get(_target, prop, receiver) {
    if (prop === "value")
      return target.__VUE_DEVTOOLS_KIT_APP_RECORDS__;
    return target.__VUE_DEVTOOLS_KIT_APP_RECORDS__[prop];
  }
});
var activeAppRecord = new Proxy(target.__VUE_DEVTOOLS_KIT_ACTIVE_APP_RECORD__, {
  get(_target, prop, receiver) {
    if (prop === "value")
      return target.__VUE_DEVTOOLS_KIT_ACTIVE_APP_RECORD__;
    else if (prop === "id")
      return target.__VUE_DEVTOOLS_KIT_ACTIVE_APP_RECORD_ID__;
    return target.__VUE_DEVTOOLS_KIT_ACTIVE_APP_RECORD__[prop];
  }
});
function updateAllStates() {
  callStateUpdatedHook({
    ...target[STATE_KEY],
    appRecords: devtoolsAppRecords.value,
    activeAppRecordId: activeAppRecord.id,
    tabs: target.__VUE_DEVTOOLS_KIT_CUSTOM_TABS__,
    commands: target.__VUE_DEVTOOLS_KIT_CUSTOM_COMMANDS__
  });
}
function setActiveAppRecord(app) {
  target.__VUE_DEVTOOLS_KIT_ACTIVE_APP_RECORD__ = app;
  updateAllStates();
}
function setActiveAppRecordId(id) {
  target.__VUE_DEVTOOLS_KIT_ACTIVE_APP_RECORD_ID__ = id;
  updateAllStates();
}
var devtoolsState = new Proxy(target[STATE_KEY], {
  get(target21, property) {
    if (property === "appRecords") {
      return devtoolsAppRecords;
    } else if (property === "activeAppRecordId") {
      return activeAppRecord.id;
    } else if (property === "tabs") {
      return target.__VUE_DEVTOOLS_KIT_CUSTOM_TABS__;
    } else if (property === "commands") {
      return target.__VUE_DEVTOOLS_KIT_CUSTOM_COMMANDS__;
    }
    return target[STATE_KEY][property];
  },
  deleteProperty(target21, property) {
    delete target21[property];
    return true;
  },
  set(target21, property, value) {
    ({ ...target[STATE_KEY] });
    target21[property] = value;
    target[STATE_KEY][property] = value;
    return true;
  }
});
function openInEditor(options = {}) {
  var _a25, _b25, _c;
  const { file, host, baseUrl = window.location.origin, line = 0, column = 0 } = options;
  if (file) {
    if (host === "chrome-extension") {
      const fileName = file.replace(/\\/g, "\\\\");
      const _baseUrl = (_b25 = (_a25 = window.VUE_DEVTOOLS_CONFIG) == null ? void 0 : _a25.openInEditorHost) != null ? _b25 : "/";
      fetch(`${_baseUrl}__open-in-editor?file=${encodeURI(file)}`).then((response) => {
        if (!response.ok) {
          const msg = `Opening component ${fileName} failed`;
          console.log(`%c${msg}`, "color:red");
        }
      });
    } else if (devtoolsState.vitePluginDetected) {
      const _baseUrl = (_c = target.__VUE_DEVTOOLS_OPEN_IN_EDITOR_BASE_URL__) != null ? _c : baseUrl;
      target.__VUE_INSPECTOR__.openInEditor(_baseUrl, file, line, column);
    }
  }
}

// src/core/plugin/index.ts
init_esm_shims();

// src/api/index.ts
init_esm_shims();

// src/api/v6/index.ts
init_esm_shims();

// src/core/plugin/plugin-settings.ts
init_esm_shims();

// src/ctx/plugin.ts
init_esm_shims();
var _a10, _b10;
(_b10 = (_a10 = target).__VUE_DEVTOOLS_KIT_PLUGIN_BUFFER__) != null ? _b10 : _a10.__VUE_DEVTOOLS_KIT_PLUGIN_BUFFER__ = [];
var devtoolsPluginBuffer = new Proxy(target.__VUE_DEVTOOLS_KIT_PLUGIN_BUFFER__, {
  get(target21, prop, receiver) {
    return Reflect.get(target21, prop, receiver);
  }
});

// src/core/plugin/plugin-settings.ts
function _getSettings(settings) {
  const _settings = {};
  Object.keys(settings).forEach((key) => {
    _settings[key] = settings[key].defaultValue;
  });
  return _settings;
}
function getPluginLocalKey(pluginId) {
  return `__VUE_DEVTOOLS_NEXT_PLUGIN_SETTINGS__${pluginId}__`;
}
function getPluginSettingsOptions(pluginId) {
  var _a25, _b25, _c;
  const item = (_b25 = (_a25 = devtoolsPluginBuffer.find((item2) => {
    var _a26;
    return item2[0].id === pluginId && !!((_a26 = item2[0]) == null ? void 0 : _a26.settings);
  })) == null ? void 0 : _a25[0]) != null ? _b25 : null;
  return (_c = item == null ? void 0 : item.settings) != null ? _c : null;
}
function getPluginSettings(pluginId, fallbackValue) {
  var _a25, _b25, _c;
  const localKey = getPluginLocalKey(pluginId);
  if (localKey) {
    const localSettings = localStorage.getItem(localKey);
    if (localSettings) {
      return JSON.parse(localSettings);
    }
  }
  if (pluginId) {
    const item = (_b25 = (_a25 = devtoolsPluginBuffer.find((item2) => item2[0].id === pluginId)) == null ? void 0 : _a25[0]) != null ? _b25 : null;
    return _getSettings((_c = item == null ? void 0 : item.settings) != null ? _c : {});
  }
  return _getSettings(fallbackValue);
}
function initPluginSettings(pluginId, settings) {
  const localKey = getPluginLocalKey(pluginId);
  const localSettings = localStorage.getItem(localKey);
  if (!localSettings) {
    localStorage.setItem(localKey, JSON.stringify(_getSettings(settings)));
  }
}
function setPluginSettings(pluginId, key, value) {
  const localKey = getPluginLocalKey(pluginId);
  const localSettings = localStorage.getItem(localKey);
  const parsedLocalSettings = JSON.parse(localSettings || "{}");
  const updated = {
    ...parsedLocalSettings,
    [key]: value
  };
  localStorage.setItem(localKey, JSON.stringify(updated));
  devtoolsContext.hooks.callHookWith((callbacks) => {
    callbacks.forEach((cb) => cb({
      pluginId,
      key,
      oldValue: parsedLocalSettings[key],
      newValue: value,
      settings: updated
    }));
  }, "setPluginSettings" /* SET_PLUGIN_SETTINGS */);
}

// src/hook/index.ts
init_esm_shims();
var _a11, _b11;
var devtoolsHooks = (_b11 = (_a11 = target).__VUE_DEVTOOLS_HOOK) != null ? _b11 : _a11.__VUE_DEVTOOLS_HOOK = createHooks();
var on = {
  vueAppInit(fn) {
    devtoolsHooks.hook("app:init" /* APP_INIT */, fn);
  },
  vueAppUnmount(fn) {
    devtoolsHooks.hook("app:unmount" /* APP_UNMOUNT */, fn);
  },
  vueAppConnected(fn) {
    devtoolsHooks.hook("app:connected" /* APP_CONNECTED */, fn);
  },
  componentAdded(fn) {
    return devtoolsHooks.hook("component:added" /* COMPONENT_ADDED */, fn);
  },
  componentEmit(fn) {
    return devtoolsHooks.hook("component:emit" /* COMPONENT_EMIT */, fn);
  },
  componentUpdated(fn) {
    return devtoolsHooks.hook("component:updated" /* COMPONENT_UPDATED */, fn);
  },
  componentRemoved(fn) {
    return devtoolsHooks.hook("component:removed" /* COMPONENT_REMOVED */, fn);
  },
  setupDevtoolsPlugin(fn) {
    devtoolsHooks.hook("devtools-plugin:setup" /* SETUP_DEVTOOLS_PLUGIN */, fn);
  },
  perfStart(fn) {
    return devtoolsHooks.hook("perf:start" /* PERFORMANCE_START */, fn);
  },
  perfEnd(fn) {
    return devtoolsHooks.hook("perf:end" /* PERFORMANCE_END */, fn);
  }
};
var hook = {
  on,
  setupDevToolsPlugin(pluginDescriptor, setupFn) {
    return devtoolsHooks.callHook("devtools-plugin:setup" /* SETUP_DEVTOOLS_PLUGIN */, pluginDescriptor, setupFn);
  }
};

// src/api/v6/index.ts
var DevToolsV6PluginAPI = class {
  constructor({ plugin, ctx }) {
    this.hooks = ctx.hooks;
    this.plugin = plugin;
  }
  get on() {
    return {
      // component inspector
      visitComponentTree: (handler) => {
        this.hooks.hook("visitComponentTree" /* VISIT_COMPONENT_TREE */, handler);
      },
      inspectComponent: (handler) => {
        this.hooks.hook("inspectComponent" /* INSPECT_COMPONENT */, handler);
      },
      editComponentState: (handler) => {
        this.hooks.hook("editComponentState" /* EDIT_COMPONENT_STATE */, handler);
      },
      // custom inspector
      getInspectorTree: (handler) => {
        this.hooks.hook("getInspectorTree" /* GET_INSPECTOR_TREE */, handler);
      },
      getInspectorState: (handler) => {
        this.hooks.hook("getInspectorState" /* GET_INSPECTOR_STATE */, handler);
      },
      editInspectorState: (handler) => {
        this.hooks.hook("editInspectorState" /* EDIT_INSPECTOR_STATE */, handler);
      },
      // timeline
      inspectTimelineEvent: (handler) => {
        this.hooks.hook("inspectTimelineEvent" /* INSPECT_TIMELINE_EVENT */, handler);
      },
      timelineCleared: (handler) => {
        this.hooks.hook("timelineCleared" /* TIMELINE_CLEARED */, handler);
      },
      // settings
      setPluginSettings: (handler) => {
        this.hooks.hook("setPluginSettings" /* SET_PLUGIN_SETTINGS */, handler);
      }
    };
  }
  // component inspector
  notifyComponentUpdate(instance) {
    var _a25;
    if (devtoolsState.highPerfModeEnabled) {
      return;
    }
    const inspector = getActiveInspectors().find((i) => i.packageName === this.plugin.descriptor.packageName);
    if (inspector == null ? void 0 : inspector.id) {
      if (instance) {
        const args = [
          instance.appContext.app,
          instance.uid,
          (_a25 = instance.parent) == null ? void 0 : _a25.uid,
          instance
        ];
        devtoolsHooks.callHook("component:updated" /* COMPONENT_UPDATED */, ...args);
      } else {
        devtoolsHooks.callHook("component:updated" /* COMPONENT_UPDATED */);
      }
      this.hooks.callHook("sendInspectorState" /* SEND_INSPECTOR_STATE */, { inspectorId: inspector.id, plugin: this.plugin });
    }
  }
  // custom inspector
  addInspector(options) {
    this.hooks.callHook("addInspector" /* ADD_INSPECTOR */, { inspector: options, plugin: this.plugin });
    if (this.plugin.descriptor.settings) {
      initPluginSettings(options.id, this.plugin.descriptor.settings);
    }
  }
  sendInspectorTree(inspectorId) {
    if (devtoolsState.highPerfModeEnabled) {
      return;
    }
    this.hooks.callHook("sendInspectorTree" /* SEND_INSPECTOR_TREE */, { inspectorId, plugin: this.plugin });
  }
  sendInspectorState(inspectorId) {
    if (devtoolsState.highPerfModeEnabled) {
      return;
    }
    this.hooks.callHook("sendInspectorState" /* SEND_INSPECTOR_STATE */, { inspectorId, plugin: this.plugin });
  }
  selectInspectorNode(inspectorId, nodeId) {
    this.hooks.callHook("customInspectorSelectNode" /* CUSTOM_INSPECTOR_SELECT_NODE */, { inspectorId, nodeId, plugin: this.plugin });
  }
  visitComponentTree(payload) {
    return this.hooks.callHook("visitComponentTree" /* VISIT_COMPONENT_TREE */, payload);
  }
  // timeline
  now() {
    if (devtoolsState.highPerfModeEnabled) {
      return 0;
    }
    return Date.now();
  }
  addTimelineLayer(options) {
    this.hooks.callHook("timelineLayerAdded" /* TIMELINE_LAYER_ADDED */, { options, plugin: this.plugin });
  }
  addTimelineEvent(options) {
    if (devtoolsState.highPerfModeEnabled) {
      return;
    }
    this.hooks.callHook("timelineEventAdded" /* TIMELINE_EVENT_ADDED */, { options, plugin: this.plugin });
  }
  // settings
  getSettings(pluginId) {
    return getPluginSettings(pluginId != null ? pluginId : this.plugin.descriptor.id, this.plugin.descriptor.settings);
  }
  // utilities
  getComponentInstances(app) {
    return this.hooks.callHook("getComponentInstances" /* GET_COMPONENT_INSTANCES */, { app });
  }
  getComponentBounds(instance) {
    return this.hooks.callHook("getComponentBounds" /* GET_COMPONENT_BOUNDS */, { instance });
  }
  getComponentName(instance) {
    return this.hooks.callHook("getComponentName" /* GET_COMPONENT_NAME */, { instance });
  }
  highlightElement(instance) {
    const uid = instance.__VUE_DEVTOOLS_NEXT_UID__;
    return this.hooks.callHook("componentHighlight" /* COMPONENT_HIGHLIGHT */, { uid });
  }
  unhighlightElement() {
    return this.hooks.callHook("componentUnhighlight" /* COMPONENT_UNHIGHLIGHT */);
  }
};

// src/api/index.ts
var DevToolsPluginAPI = DevToolsV6PluginAPI;

// src/core/plugin/components.ts
init_esm_shims();

// src/core/component/state/index.ts
init_esm_shims();

// src/core/component/state/process.ts
init_esm_shims();

// src/core/component/state/constants.ts
init_esm_shims();
var UNDEFINED = "__vue_devtool_undefined__";
var INFINITY = "__vue_devtool_infinity__";
var NEGATIVE_INFINITY = "__vue_devtool_negative_infinity__";
var NAN = "__vue_devtool_nan__";

// src/core/component/state/util.ts
init_esm_shims();

// src/core/component/state/is.ts
init_esm_shims();

// src/core/component/state/util.ts
var tokenMap = {
  [UNDEFINED]: "undefined",
  [NAN]: "NaN",
  [INFINITY]: "Infinity",
  [NEGATIVE_INFINITY]: "-Infinity"
};
Object.entries(tokenMap).reduce((acc, [key, value]) => {
  acc[value] = key;
  return acc;
}, {});

// src/core/component/tree/walker.ts
init_esm_shims();

// src/core/component/tree/filter.ts
init_esm_shims();

// src/core/timeline/index.ts
init_esm_shims();

// src/core/timeline/perf.ts
init_esm_shims();

// src/core/vm/index.ts
init_esm_shims();

// src/core/plugin/index.ts
var _a12, _b12;
(_b12 = (_a12 = target).__VUE_DEVTOOLS_KIT__REGISTERED_PLUGIN_APPS__) != null ? _b12 : _a12.__VUE_DEVTOOLS_KIT__REGISTERED_PLUGIN_APPS__ = /* @__PURE__ */ new Set();
function setupDevToolsPlugin(pluginDescriptor, setupFn) {
  return hook.setupDevToolsPlugin(pluginDescriptor, setupFn);
}
function callDevToolsPluginSetupFn(plugin, app) {
  const [pluginDescriptor, setupFn] = plugin;
  if (pluginDescriptor.app !== app)
    return;
  const api = new DevToolsPluginAPI({
    plugin: {
      setupFn,
      descriptor: pluginDescriptor
    },
    ctx: devtoolsContext
  });
  if (pluginDescriptor.packageName === "vuex") {
    api.on.editInspectorState((payload) => {
      api.sendInspectorState(payload.inspectorId);
    });
  }
  setupFn(api);
}
function registerDevToolsPlugin(app, options) {
  if (target.__VUE_DEVTOOLS_KIT__REGISTERED_PLUGIN_APPS__.has(app)) {
    return;
  }
  if (devtoolsState.highPerfModeEnabled && !(options == null ? void 0 : options.inspectingComponent)) {
    return;
  }
  target.__VUE_DEVTOOLS_KIT__REGISTERED_PLUGIN_APPS__.add(app);
  devtoolsPluginBuffer.forEach((plugin) => {
    callDevToolsPluginSetupFn(plugin, app);
  });
}

// src/core/router/index.ts
init_esm_shims();

// src/ctx/router.ts
init_esm_shims();
var ROUTER_KEY = "__VUE_DEVTOOLS_ROUTER__";
var ROUTER_INFO_KEY = "__VUE_DEVTOOLS_ROUTER_INFO__";
var _a13, _b13;
(_b13 = (_a13 = target)[ROUTER_INFO_KEY]) != null ? _b13 : _a13[ROUTER_INFO_KEY] = {
  currentRoute: null,
  routes: []
};
var _a14, _b14;
(_b14 = (_a14 = target)[ROUTER_KEY]) != null ? _b14 : _a14[ROUTER_KEY] = {};
new Proxy(target[ROUTER_INFO_KEY], {
  get(target21, property) {
    return target[ROUTER_INFO_KEY][property];
  }
});
new Proxy(target[ROUTER_KEY], {
  get(target21, property) {
    if (property === "value") {
      return target[ROUTER_KEY];
    }
  }
});

// src/core/router/index.ts
function getRoutes(router) {
  const routesMap = /* @__PURE__ */ new Map();
  return ((router == null ? void 0 : router.getRoutes()) || []).filter((i) => !routesMap.has(i.path) && routesMap.set(i.path, 1));
}
function filterRoutes(routes) {
  return routes.map((item) => {
    let { path, name, children, meta } = item;
    if (children == null ? void 0 : children.length)
      children = filterRoutes(children);
    return {
      path,
      name,
      children,
      meta
    };
  });
}
function filterCurrentRoute(route) {
  if (route) {
    const { fullPath, hash, href, path, name, matched, params, query } = route;
    return {
      fullPath,
      hash,
      href,
      path,
      name,
      params,
      query,
      matched: filterRoutes(matched)
    };
  }
  return route;
}
function normalizeRouterInfo(appRecord, activeAppRecord2) {
  function init() {
    var _a25;
    const router = (_a25 = appRecord.app) == null ? void 0 : _a25.config.globalProperties.$router;
    const currentRoute = filterCurrentRoute(router == null ? void 0 : router.currentRoute.value);
    const routes = filterRoutes(getRoutes(router));
    const c = console.warn;
    console.warn = () => {
    };
    target[ROUTER_INFO_KEY] = {
      currentRoute: currentRoute ? deepClone(currentRoute) : {},
      routes: deepClone(routes)
    };
    target[ROUTER_KEY] = router;
    console.warn = c;
  }
  init();
  hook.on.componentUpdated(debounce(() => {
    var _a25;
    if (((_a25 = activeAppRecord2.value) == null ? void 0 : _a25.app) !== appRecord.app)
      return;
    init();
    if (devtoolsState.highPerfModeEnabled)
      return;
    devtoolsContext.hooks.callHook("routerInfoUpdated" /* ROUTER_INFO_UPDATED */, { state: target[ROUTER_INFO_KEY] });
  }, 200));
}

// src/ctx/api.ts
function createDevToolsApi(hooks2) {
  return {
    // get inspector tree
    async getInspectorTree(payload) {
      const _payload = {
        ...payload,
        app: activeAppRecord.value.app,
        rootNodes: []
      };
      await new Promise((resolve) => {
        hooks2.callHookWith(async (callbacks) => {
          await Promise.all(callbacks.map((cb) => cb(_payload)));
          resolve();
        }, "getInspectorTree" /* GET_INSPECTOR_TREE */);
      });
      return _payload.rootNodes;
    },
    // get inspector state
    async getInspectorState(payload) {
      const _payload = {
        ...payload,
        app: activeAppRecord.value.app,
        state: null
      };
      const ctx = {
        currentTab: `custom-inspector:${payload.inspectorId}`
      };
      await new Promise((resolve) => {
        hooks2.callHookWith(async (callbacks) => {
          await Promise.all(callbacks.map((cb) => cb(_payload, ctx)));
          resolve();
        }, "getInspectorState" /* GET_INSPECTOR_STATE */);
      });
      return _payload.state;
    },
    // edit inspector state
    editInspectorState(payload) {
      const stateEditor2 = new StateEditor();
      const _payload = {
        ...payload,
        app: activeAppRecord.value.app,
        set: (obj, path = payload.path, value = payload.state.value, cb) => {
          stateEditor2.set(obj, path, value, cb || stateEditor2.createDefaultSetCallback(payload.state));
        }
      };
      hooks2.callHookWith((callbacks) => {
        callbacks.forEach((cb) => cb(_payload));
      }, "editInspectorState" /* EDIT_INSPECTOR_STATE */);
    },
    // send inspector state
    sendInspectorState(inspectorId) {
      const inspector = getInspector(inspectorId);
      hooks2.callHook("sendInspectorState" /* SEND_INSPECTOR_STATE */, { inspectorId, plugin: {
        descriptor: inspector.descriptor,
        setupFn: () => ({})
      } });
    },
    // inspect component inspector
    inspectComponentInspector() {
      return inspectComponentHighLighter();
    },
    // cancel inspect component inspector
    cancelInspectComponentInspector() {
      return cancelInspectComponentHighLighter();
    },
    // get component render code
    getComponentRenderCode(id) {
      const instance = getComponentInstance(activeAppRecord.value, id);
      if (instance)
        return !(typeof (instance == null ? void 0 : instance.type) === "function") ? instance.render.toString() : instance.type.toString();
    },
    // scroll to component
    scrollToComponent(id) {
      return scrollToComponent({ id });
    },
    // open in editor
    openInEditor,
    // get vue inspector
    getVueInspector: getComponentInspector,
    // toggle app
    toggleApp(id, options) {
      const appRecord = devtoolsAppRecords.value.find((record) => record.id === id);
      if (appRecord) {
        setActiveAppRecordId(id);
        setActiveAppRecord(appRecord);
        normalizeRouterInfo(appRecord, activeAppRecord);
        callInspectorUpdatedHook();
        registerDevToolsPlugin(appRecord.app, options);
      }
    },
    // inspect dom
    inspectDOM(instanceId) {
      const instance = getComponentInstance(activeAppRecord.value, instanceId);
      if (instance) {
        const [el] = getRootElementsFromComponentInstance(instance);
        if (el) {
          target.__VUE_DEVTOOLS_INSPECT_DOM_TARGET__ = el;
        }
      }
    },
    updatePluginSettings(pluginId, key, value) {
      setPluginSettings(pluginId, key, value);
    },
    getPluginSettings(pluginId) {
      return {
        options: getPluginSettingsOptions(pluginId),
        values: getPluginSettings(pluginId)
      };
    }
  };
}

// src/ctx/env.ts
init_esm_shims();
var _a15, _b15;
(_b15 = (_a15 = target).__VUE_DEVTOOLS_ENV__) != null ? _b15 : _a15.__VUE_DEVTOOLS_ENV__ = {
  vitePluginDetected: false
};

// src/ctx/index.ts
var hooks = createDevToolsCtxHooks();
var _a16, _b16;
(_b16 = (_a16 = target).__VUE_DEVTOOLS_KIT_CONTEXT__) != null ? _b16 : _a16.__VUE_DEVTOOLS_KIT_CONTEXT__ = {
  hooks,
  get state() {
    return {
      ...devtoolsState,
      activeAppRecordId: activeAppRecord.id,
      activeAppRecord: activeAppRecord.value,
      appRecords: devtoolsAppRecords.value
    };
  },
  api: createDevToolsApi(hooks)
};
var devtoolsContext = target.__VUE_DEVTOOLS_KIT_CONTEXT__;

// src/core/app/index.ts
init_esm_shims();
__toESM(require_speakingurl2());
var _a17, _b17;
(_b17 = (_a17 = target).__VUE_DEVTOOLS_NEXT_APP_RECORD_INFO__) != null ? _b17 : _a17.__VUE_DEVTOOLS_NEXT_APP_RECORD_INFO__ = {
  id: 0,
  appIds: /* @__PURE__ */ new Set()
};

// src/core/iframe/index.ts
init_esm_shims();

// src/core/high-perf-mode/index.ts
init_esm_shims();
function toggleHighPerfMode(state) {
  devtoolsState.highPerfModeEnabled = state != null ? state : !devtoolsState.highPerfModeEnabled;
  if (!state && activeAppRecord.value) {
    registerDevToolsPlugin(activeAppRecord.value.app);
  }
}

// src/core/component/state/format.ts
init_esm_shims();

// src/core/component/state/reviver.ts
init_esm_shims();

// src/core/devtools-client/detected.ts
init_esm_shims();
function updateDevToolsClientDetected(params) {
  devtoolsState.devtoolsClientDetected = {
    ...devtoolsState.devtoolsClientDetected,
    ...params
  };
  const devtoolsClientVisible = Object.values(devtoolsState.devtoolsClientDetected).some(Boolean);
  toggleHighPerfMode(!devtoolsClientVisible);
}
var _a18, _b18;
(_b18 = (_a18 = target).__VUE_DEVTOOLS_UPDATE_CLIENT_DETECTED__) != null ? _b18 : _a18.__VUE_DEVTOOLS_UPDATE_CLIENT_DETECTED__ = updateDevToolsClientDetected;

// src/messaging/index.ts
init_esm_shims();

// src/messaging/presets/broadcast-channel/index.ts
init_esm_shims();

// ../../node_modules/.pnpm/superjson@2.2.2/node_modules/superjson/dist/index.js
init_esm_shims();

// ../../node_modules/.pnpm/superjson@2.2.2/node_modules/superjson/dist/class-registry.js
init_esm_shims();

// ../../node_modules/.pnpm/superjson@2.2.2/node_modules/superjson/dist/registry.js
init_esm_shims();

// ../../node_modules/.pnpm/superjson@2.2.2/node_modules/superjson/dist/double-indexed-kv.js
init_esm_shims();
var DoubleIndexedKV = class {
  constructor() {
    this.keyToValue = /* @__PURE__ */ new Map();
    this.valueToKey = /* @__PURE__ */ new Map();
  }
  set(key, value) {
    this.keyToValue.set(key, value);
    this.valueToKey.set(value, key);
  }
  getByKey(key) {
    return this.keyToValue.get(key);
  }
  getByValue(value) {
    return this.valueToKey.get(value);
  }
  clear() {
    this.keyToValue.clear();
    this.valueToKey.clear();
  }
};

// ../../node_modules/.pnpm/superjson@2.2.2/node_modules/superjson/dist/registry.js
var Registry = class {
  constructor(generateIdentifier) {
    this.generateIdentifier = generateIdentifier;
    this.kv = new DoubleIndexedKV();
  }
  register(value, identifier) {
    if (this.kv.getByValue(value)) {
      return;
    }
    if (!identifier) {
      identifier = this.generateIdentifier(value);
    }
    this.kv.set(identifier, value);
  }
  clear() {
    this.kv.clear();
  }
  getIdentifier(value) {
    return this.kv.getByValue(value);
  }
  getValue(identifier) {
    return this.kv.getByKey(identifier);
  }
};

// ../../node_modules/.pnpm/superjson@2.2.2/node_modules/superjson/dist/class-registry.js
var ClassRegistry = class extends Registry {
  constructor() {
    super((c) => c.name);
    this.classToAllowedProps = /* @__PURE__ */ new Map();
  }
  register(value, options) {
    if (typeof options === "object") {
      if (options.allowProps) {
        this.classToAllowedProps.set(value, options.allowProps);
      }
      super.register(value, options.identifier);
    } else {
      super.register(value, options);
    }
  }
  getAllowedProps(value) {
    return this.classToAllowedProps.get(value);
  }
};

// ../../node_modules/.pnpm/superjson@2.2.2/node_modules/superjson/dist/custom-transformer-registry.js
init_esm_shims();

// ../../node_modules/.pnpm/superjson@2.2.2/node_modules/superjson/dist/util.js
init_esm_shims();
function valuesOfObj(record) {
  if ("values" in Object) {
    return Object.values(record);
  }
  const values = [];
  for (const key in record) {
    if (record.hasOwnProperty(key)) {
      values.push(record[key]);
    }
  }
  return values;
}
function find(record, predicate) {
  const values = valuesOfObj(record);
  if ("find" in values) {
    return values.find(predicate);
  }
  const valuesNotNever = values;
  for (let i = 0; i < valuesNotNever.length; i++) {
    const value = valuesNotNever[i];
    if (predicate(value)) {
      return value;
    }
  }
  return void 0;
}
function forEach(record, run) {
  Object.entries(record).forEach(([key, value]) => run(value, key));
}
function includes(arr, value) {
  return arr.indexOf(value) !== -1;
}
function findArr(record, predicate) {
  for (let i = 0; i < record.length; i++) {
    const value = record[i];
    if (predicate(value)) {
      return value;
    }
  }
  return void 0;
}

// ../../node_modules/.pnpm/superjson@2.2.2/node_modules/superjson/dist/custom-transformer-registry.js
var CustomTransformerRegistry = class {
  constructor() {
    this.transfomers = {};
  }
  register(transformer) {
    this.transfomers[transformer.name] = transformer;
  }
  findApplicable(v) {
    return find(this.transfomers, (transformer) => transformer.isApplicable(v));
  }
  findByName(name) {
    return this.transfomers[name];
  }
};

// ../../node_modules/.pnpm/superjson@2.2.2/node_modules/superjson/dist/plainer.js
init_esm_shims();

// ../../node_modules/.pnpm/superjson@2.2.2/node_modules/superjson/dist/is.js
init_esm_shims();
var getType = (payload) => Object.prototype.toString.call(payload).slice(8, -1);
var isUndefined = (payload) => typeof payload === "undefined";
var isNull = (payload) => payload === null;
var isPlainObject2 = (payload) => {
  if (typeof payload !== "object" || payload === null)
    return false;
  if (payload === Object.prototype)
    return false;
  if (Object.getPrototypeOf(payload) === null)
    return true;
  return Object.getPrototypeOf(payload) === Object.prototype;
};
var isEmptyObject = (payload) => isPlainObject2(payload) && Object.keys(payload).length === 0;
var isArray = (payload) => Array.isArray(payload);
var isString = (payload) => typeof payload === "string";
var isNumber = (payload) => typeof payload === "number" && !isNaN(payload);
var isBoolean = (payload) => typeof payload === "boolean";
var isRegExp = (payload) => payload instanceof RegExp;
var isMap = (payload) => payload instanceof Map;
var isSet = (payload) => payload instanceof Set;
var isSymbol = (payload) => getType(payload) === "Symbol";
var isDate = (payload) => payload instanceof Date && !isNaN(payload.valueOf());
var isError = (payload) => payload instanceof Error;
var isNaNValue = (payload) => typeof payload === "number" && isNaN(payload);
var isPrimitive2 = (payload) => isBoolean(payload) || isNull(payload) || isUndefined(payload) || isNumber(payload) || isString(payload) || isSymbol(payload);
var isBigint = (payload) => typeof payload === "bigint";
var isInfinite = (payload) => payload === Infinity || payload === -Infinity;
var isTypedArray = (payload) => ArrayBuffer.isView(payload) && !(payload instanceof DataView);
var isURL = (payload) => payload instanceof URL;

// ../../node_modules/.pnpm/superjson@2.2.2/node_modules/superjson/dist/pathstringifier.js
init_esm_shims();
var escapeKey = (key) => key.replace(/\./g, "\\.");
var stringifyPath = (path) => path.map(String).map(escapeKey).join(".");
var parsePath = (string) => {
  const result = [];
  let segment = "";
  for (let i = 0; i < string.length; i++) {
    let char = string.charAt(i);
    const isEscapedDot = char === "\\" && string.charAt(i + 1) === ".";
    if (isEscapedDot) {
      segment += ".";
      i++;
      continue;
    }
    const isEndOfSegment = char === ".";
    if (isEndOfSegment) {
      result.push(segment);
      segment = "";
      continue;
    }
    segment += char;
  }
  const lastSegment = segment;
  result.push(lastSegment);
  return result;
};

// ../../node_modules/.pnpm/superjson@2.2.2/node_modules/superjson/dist/transformer.js
init_esm_shims();
function simpleTransformation(isApplicable, annotation, transform, untransform) {
  return {
    isApplicable,
    annotation,
    transform,
    untransform
  };
}
var simpleRules = [
  simpleTransformation(isUndefined, "undefined", () => null, () => void 0),
  simpleTransformation(isBigint, "bigint", (v) => v.toString(), (v) => {
    if (typeof BigInt !== "undefined") {
      return BigInt(v);
    }
    console.error("Please add a BigInt polyfill.");
    return v;
  }),
  simpleTransformation(isDate, "Date", (v) => v.toISOString(), (v) => new Date(v)),
  simpleTransformation(isError, "Error", (v, superJson) => {
    const baseError = {
      name: v.name,
      message: v.message
    };
    superJson.allowedErrorProps.forEach((prop) => {
      baseError[prop] = v[prop];
    });
    return baseError;
  }, (v, superJson) => {
    const e = new Error(v.message);
    e.name = v.name;
    e.stack = v.stack;
    superJson.allowedErrorProps.forEach((prop) => {
      e[prop] = v[prop];
    });
    return e;
  }),
  simpleTransformation(isRegExp, "regexp", (v) => "" + v, (regex) => {
    const body = regex.slice(1, regex.lastIndexOf("/"));
    const flags = regex.slice(regex.lastIndexOf("/") + 1);
    return new RegExp(body, flags);
  }),
  simpleTransformation(
    isSet,
    "set",
    // (sets only exist in es6+)
    // eslint-disable-next-line es5/no-es6-methods
    (v) => [...v.values()],
    (v) => new Set(v)
  ),
  simpleTransformation(isMap, "map", (v) => [...v.entries()], (v) => new Map(v)),
  simpleTransformation((v) => isNaNValue(v) || isInfinite(v), "number", (v) => {
    if (isNaNValue(v)) {
      return "NaN";
    }
    if (v > 0) {
      return "Infinity";
    } else {
      return "-Infinity";
    }
  }, Number),
  simpleTransformation((v) => v === 0 && 1 / v === -Infinity, "number", () => {
    return "-0";
  }, Number),
  simpleTransformation(isURL, "URL", (v) => v.toString(), (v) => new URL(v))
];
function compositeTransformation(isApplicable, annotation, transform, untransform) {
  return {
    isApplicable,
    annotation,
    transform,
    untransform
  };
}
var symbolRule = compositeTransformation((s, superJson) => {
  if (isSymbol(s)) {
    const isRegistered = !!superJson.symbolRegistry.getIdentifier(s);
    return isRegistered;
  }
  return false;
}, (s, superJson) => {
  const identifier = superJson.symbolRegistry.getIdentifier(s);
  return ["symbol", identifier];
}, (v) => v.description, (_, a, superJson) => {
  const value = superJson.symbolRegistry.getValue(a[1]);
  if (!value) {
    throw new Error("Trying to deserialize unknown symbol");
  }
  return value;
});
var constructorToName = [
  Int8Array,
  Uint8Array,
  Int16Array,
  Uint16Array,
  Int32Array,
  Uint32Array,
  Float32Array,
  Float64Array,
  Uint8ClampedArray
].reduce((obj, ctor) => {
  obj[ctor.name] = ctor;
  return obj;
}, {});
var typedArrayRule = compositeTransformation(isTypedArray, (v) => ["typed-array", v.constructor.name], (v) => [...v], (v, a) => {
  const ctor = constructorToName[a[1]];
  if (!ctor) {
    throw new Error("Trying to deserialize unknown typed array");
  }
  return new ctor(v);
});
function isInstanceOfRegisteredClass(potentialClass, superJson) {
  if (potentialClass == null ? void 0 : potentialClass.constructor) {
    const isRegistered = !!superJson.classRegistry.getIdentifier(potentialClass.constructor);
    return isRegistered;
  }
  return false;
}
var classRule = compositeTransformation(isInstanceOfRegisteredClass, (clazz, superJson) => {
  const identifier = superJson.classRegistry.getIdentifier(clazz.constructor);
  return ["class", identifier];
}, (clazz, superJson) => {
  const allowedProps = superJson.classRegistry.getAllowedProps(clazz.constructor);
  if (!allowedProps) {
    return { ...clazz };
  }
  const result = {};
  allowedProps.forEach((prop) => {
    result[prop] = clazz[prop];
  });
  return result;
}, (v, a, superJson) => {
  const clazz = superJson.classRegistry.getValue(a[1]);
  if (!clazz) {
    throw new Error(`Trying to deserialize unknown class '${a[1]}' - check https://github.com/blitz-js/superjson/issues/116#issuecomment-773996564`);
  }
  return Object.assign(Object.create(clazz.prototype), v);
});
var customRule = compositeTransformation((value, superJson) => {
  return !!superJson.customTransformerRegistry.findApplicable(value);
}, (value, superJson) => {
  const transformer = superJson.customTransformerRegistry.findApplicable(value);
  return ["custom", transformer.name];
}, (value, superJson) => {
  const transformer = superJson.customTransformerRegistry.findApplicable(value);
  return transformer.serialize(value);
}, (v, a, superJson) => {
  const transformer = superJson.customTransformerRegistry.findByName(a[1]);
  if (!transformer) {
    throw new Error("Trying to deserialize unknown custom value");
  }
  return transformer.deserialize(v);
});
var compositeRules = [classRule, symbolRule, customRule, typedArrayRule];
var transformValue = (value, superJson) => {
  const applicableCompositeRule = findArr(compositeRules, (rule) => rule.isApplicable(value, superJson));
  if (applicableCompositeRule) {
    return {
      value: applicableCompositeRule.transform(value, superJson),
      type: applicableCompositeRule.annotation(value, superJson)
    };
  }
  const applicableSimpleRule = findArr(simpleRules, (rule) => rule.isApplicable(value, superJson));
  if (applicableSimpleRule) {
    return {
      value: applicableSimpleRule.transform(value, superJson),
      type: applicableSimpleRule.annotation
    };
  }
  return void 0;
};
var simpleRulesByAnnotation = {};
simpleRules.forEach((rule) => {
  simpleRulesByAnnotation[rule.annotation] = rule;
});
var untransformValue = (json, type, superJson) => {
  if (isArray(type)) {
    switch (type[0]) {
      case "symbol":
        return symbolRule.untransform(json, type, superJson);
      case "class":
        return classRule.untransform(json, type, superJson);
      case "custom":
        return customRule.untransform(json, type, superJson);
      case "typed-array":
        return typedArrayRule.untransform(json, type, superJson);
      default:
        throw new Error("Unknown transformation: " + type);
    }
  } else {
    const transformation = simpleRulesByAnnotation[type];
    if (!transformation) {
      throw new Error("Unknown transformation: " + type);
    }
    return transformation.untransform(json, superJson);
  }
};

// ../../node_modules/.pnpm/superjson@2.2.2/node_modules/superjson/dist/accessDeep.js
init_esm_shims();
var getNthKey = (value, n) => {
  if (n > value.size)
    throw new Error("index out of bounds");
  const keys = value.keys();
  while (n > 0) {
    keys.next();
    n--;
  }
  return keys.next().value;
};
function validatePath(path) {
  if (includes(path, "__proto__")) {
    throw new Error("__proto__ is not allowed as a property");
  }
  if (includes(path, "prototype")) {
    throw new Error("prototype is not allowed as a property");
  }
  if (includes(path, "constructor")) {
    throw new Error("constructor is not allowed as a property");
  }
}
var getDeep = (object, path) => {
  validatePath(path);
  for (let i = 0; i < path.length; i++) {
    const key = path[i];
    if (isSet(object)) {
      object = getNthKey(object, +key);
    } else if (isMap(object)) {
      const row = +key;
      const type = +path[++i] === 0 ? "key" : "value";
      const keyOfRow = getNthKey(object, row);
      switch (type) {
        case "key":
          object = keyOfRow;
          break;
        case "value":
          object = object.get(keyOfRow);
          break;
      }
    } else {
      object = object[key];
    }
  }
  return object;
};
var setDeep = (object, path, mapper) => {
  validatePath(path);
  if (path.length === 0) {
    return mapper(object);
  }
  let parent = object;
  for (let i = 0; i < path.length - 1; i++) {
    const key = path[i];
    if (isArray(parent)) {
      const index = +key;
      parent = parent[index];
    } else if (isPlainObject2(parent)) {
      parent = parent[key];
    } else if (isSet(parent)) {
      const row = +key;
      parent = getNthKey(parent, row);
    } else if (isMap(parent)) {
      const isEnd = i === path.length - 2;
      if (isEnd) {
        break;
      }
      const row = +key;
      const type = +path[++i] === 0 ? "key" : "value";
      const keyOfRow = getNthKey(parent, row);
      switch (type) {
        case "key":
          parent = keyOfRow;
          break;
        case "value":
          parent = parent.get(keyOfRow);
          break;
      }
    }
  }
  const lastKey = path[path.length - 1];
  if (isArray(parent)) {
    parent[+lastKey] = mapper(parent[+lastKey]);
  } else if (isPlainObject2(parent)) {
    parent[lastKey] = mapper(parent[lastKey]);
  }
  if (isSet(parent)) {
    const oldValue = getNthKey(parent, +lastKey);
    const newValue = mapper(oldValue);
    if (oldValue !== newValue) {
      parent.delete(oldValue);
      parent.add(newValue);
    }
  }
  if (isMap(parent)) {
    const row = +path[path.length - 2];
    const keyToRow = getNthKey(parent, row);
    const type = +lastKey === 0 ? "key" : "value";
    switch (type) {
      case "key": {
        const newKey = mapper(keyToRow);
        parent.set(newKey, parent.get(keyToRow));
        if (newKey !== keyToRow) {
          parent.delete(keyToRow);
        }
        break;
      }
      case "value": {
        parent.set(keyToRow, mapper(parent.get(keyToRow)));
        break;
      }
    }
  }
  return object;
};

// ../../node_modules/.pnpm/superjson@2.2.2/node_modules/superjson/dist/plainer.js
function traverse(tree, walker2, origin = []) {
  if (!tree) {
    return;
  }
  if (!isArray(tree)) {
    forEach(tree, (subtree, key) => traverse(subtree, walker2, [...origin, ...parsePath(key)]));
    return;
  }
  const [nodeValue, children] = tree;
  if (children) {
    forEach(children, (child, key) => {
      traverse(child, walker2, [...origin, ...parsePath(key)]);
    });
  }
  walker2(nodeValue, origin);
}
function applyValueAnnotations(plain, annotations, superJson) {
  traverse(annotations, (type, path) => {
    plain = setDeep(plain, path, (v) => untransformValue(v, type, superJson));
  });
  return plain;
}
function applyReferentialEqualityAnnotations(plain, annotations) {
  function apply(identicalPaths, path) {
    const object = getDeep(plain, parsePath(path));
    identicalPaths.map(parsePath).forEach((identicalObjectPath) => {
      plain = setDeep(plain, identicalObjectPath, () => object);
    });
  }
  if (isArray(annotations)) {
    const [root, other] = annotations;
    root.forEach((identicalPath) => {
      plain = setDeep(plain, parsePath(identicalPath), () => plain);
    });
    if (other) {
      forEach(other, apply);
    }
  } else {
    forEach(annotations, apply);
  }
  return plain;
}
var isDeep = (object, superJson) => isPlainObject2(object) || isArray(object) || isMap(object) || isSet(object) || isInstanceOfRegisteredClass(object, superJson);
function addIdentity(object, path, identities) {
  const existingSet = identities.get(object);
  if (existingSet) {
    existingSet.push(path);
  } else {
    identities.set(object, [path]);
  }
}
function generateReferentialEqualityAnnotations(identitites, dedupe) {
  const result = {};
  let rootEqualityPaths = void 0;
  identitites.forEach((paths) => {
    if (paths.length <= 1) {
      return;
    }
    if (!dedupe) {
      paths = paths.map((path) => path.map(String)).sort((a, b) => a.length - b.length);
    }
    const [representativePath, ...identicalPaths] = paths;
    if (representativePath.length === 0) {
      rootEqualityPaths = identicalPaths.map(stringifyPath);
    } else {
      result[stringifyPath(representativePath)] = identicalPaths.map(stringifyPath);
    }
  });
  if (rootEqualityPaths) {
    if (isEmptyObject(result)) {
      return [rootEqualityPaths];
    } else {
      return [rootEqualityPaths, result];
    }
  } else {
    return isEmptyObject(result) ? void 0 : result;
  }
}
var walker = (object, identities, superJson, dedupe, path = [], objectsInThisPath = [], seenObjects = /* @__PURE__ */ new Map()) => {
  var _a25;
  const primitive = isPrimitive2(object);
  if (!primitive) {
    addIdentity(object, path, identities);
    const seen = seenObjects.get(object);
    if (seen) {
      return dedupe ? {
        transformedValue: null
      } : seen;
    }
  }
  if (!isDeep(object, superJson)) {
    const transformed2 = transformValue(object, superJson);
    const result2 = transformed2 ? {
      transformedValue: transformed2.value,
      annotations: [transformed2.type]
    } : {
      transformedValue: object
    };
    if (!primitive) {
      seenObjects.set(object, result2);
    }
    return result2;
  }
  if (includes(objectsInThisPath, object)) {
    return {
      transformedValue: null
    };
  }
  const transformationResult = transformValue(object, superJson);
  const transformed = (_a25 = transformationResult == null ? void 0 : transformationResult.value) != null ? _a25 : object;
  const transformedValue = isArray(transformed) ? [] : {};
  const innerAnnotations = {};
  forEach(transformed, (value, index) => {
    if (index === "__proto__" || index === "constructor" || index === "prototype") {
      throw new Error(`Detected property ${index}. This is a prototype pollution risk, please remove it from your object.`);
    }
    const recursiveResult = walker(value, identities, superJson, dedupe, [...path, index], [...objectsInThisPath, object], seenObjects);
    transformedValue[index] = recursiveResult.transformedValue;
    if (isArray(recursiveResult.annotations)) {
      innerAnnotations[index] = recursiveResult.annotations;
    } else if (isPlainObject2(recursiveResult.annotations)) {
      forEach(recursiveResult.annotations, (tree, key) => {
        innerAnnotations[escapeKey(index) + "." + key] = tree;
      });
    }
  });
  const result = isEmptyObject(innerAnnotations) ? {
    transformedValue,
    annotations: !!transformationResult ? [transformationResult.type] : void 0
  } : {
    transformedValue,
    annotations: !!transformationResult ? [transformationResult.type, innerAnnotations] : innerAnnotations
  };
  if (!primitive) {
    seenObjects.set(object, result);
  }
  return result;
};

// ../../node_modules/.pnpm/copy-anything@3.0.5/node_modules/copy-anything/dist/index.js
init_esm_shims();

// ../../node_modules/.pnpm/is-what@4.1.16/node_modules/is-what/dist/index.js
init_esm_shims();
function getType2(payload) {
  return Object.prototype.toString.call(payload).slice(8, -1);
}
function isArray2(payload) {
  return getType2(payload) === "Array";
}
function isPlainObject3(payload) {
  if (getType2(payload) !== "Object")
    return false;
  const prototype = Object.getPrototypeOf(payload);
  return !!prototype && prototype.constructor === Object && prototype === Object.prototype;
}

// ../../node_modules/.pnpm/copy-anything@3.0.5/node_modules/copy-anything/dist/index.js
function assignProp(carry, key, newVal, originalObject, includeNonenumerable) {
  const propType = {}.propertyIsEnumerable.call(originalObject, key) ? "enumerable" : "nonenumerable";
  if (propType === "enumerable")
    carry[key] = newVal;
  if (includeNonenumerable && propType === "nonenumerable") {
    Object.defineProperty(carry, key, {
      value: newVal,
      enumerable: false,
      writable: true,
      configurable: true
    });
  }
}
function copy(target21, options = {}) {
  if (isArray2(target21)) {
    return target21.map((item) => copy(item, options));
  }
  if (!isPlainObject3(target21)) {
    return target21;
  }
  const props = Object.getOwnPropertyNames(target21);
  const symbols = Object.getOwnPropertySymbols(target21);
  return [...props, ...symbols].reduce((carry, key) => {
    if (isArray2(options.props) && !options.props.includes(key)) {
      return carry;
    }
    const val = target21[key];
    const newVal = copy(val, options);
    assignProp(carry, key, newVal, target21, options.nonenumerable);
    return carry;
  }, {});
}

// ../../node_modules/.pnpm/superjson@2.2.2/node_modules/superjson/dist/index.js
var SuperJSON = class {
  /**
   * @param dedupeReferentialEqualities  If true, SuperJSON will make sure only one instance of referentially equal objects are serialized and the rest are replaced with `null`.
   */
  constructor({ dedupe = false } = {}) {
    this.classRegistry = new ClassRegistry();
    this.symbolRegistry = new Registry((s) => {
      var _a25;
      return (_a25 = s.description) != null ? _a25 : "";
    });
    this.customTransformerRegistry = new CustomTransformerRegistry();
    this.allowedErrorProps = [];
    this.dedupe = dedupe;
  }
  serialize(object) {
    const identities = /* @__PURE__ */ new Map();
    const output = walker(object, identities, this, this.dedupe);
    const res = {
      json: output.transformedValue
    };
    if (output.annotations) {
      res.meta = {
        ...res.meta,
        values: output.annotations
      };
    }
    const equalityAnnotations = generateReferentialEqualityAnnotations(identities, this.dedupe);
    if (equalityAnnotations) {
      res.meta = {
        ...res.meta,
        referentialEqualities: equalityAnnotations
      };
    }
    return res;
  }
  deserialize(payload) {
    const { json, meta } = payload;
    let result = copy(json);
    if (meta == null ? void 0 : meta.values) {
      result = applyValueAnnotations(result, meta.values, this);
    }
    if (meta == null ? void 0 : meta.referentialEqualities) {
      result = applyReferentialEqualityAnnotations(result, meta.referentialEqualities);
    }
    return result;
  }
  stringify(object) {
    return JSON.stringify(this.serialize(object));
  }
  parse(string) {
    return this.deserialize(JSON.parse(string));
  }
  registerClass(v, options) {
    this.classRegistry.register(v, options);
  }
  registerSymbol(v, identifier) {
    this.symbolRegistry.register(v, identifier);
  }
  registerCustom(transformer, name) {
    this.customTransformerRegistry.register({
      name,
      ...transformer
    });
  }
  allowErrorProps(...props) {
    this.allowedErrorProps.push(...props);
  }
};
SuperJSON.defaultInstance = new SuperJSON();
SuperJSON.serialize = SuperJSON.defaultInstance.serialize.bind(SuperJSON.defaultInstance);
SuperJSON.deserialize = SuperJSON.defaultInstance.deserialize.bind(SuperJSON.defaultInstance);
SuperJSON.stringify = SuperJSON.defaultInstance.stringify.bind(SuperJSON.defaultInstance);
SuperJSON.parse = SuperJSON.defaultInstance.parse.bind(SuperJSON.defaultInstance);
SuperJSON.registerClass = SuperJSON.defaultInstance.registerClass.bind(SuperJSON.defaultInstance);
SuperJSON.registerSymbol = SuperJSON.defaultInstance.registerSymbol.bind(SuperJSON.defaultInstance);
SuperJSON.registerCustom = SuperJSON.defaultInstance.registerCustom.bind(SuperJSON.defaultInstance);
SuperJSON.allowErrorProps = SuperJSON.defaultInstance.allowErrorProps.bind(SuperJSON.defaultInstance);

// src/messaging/presets/broadcast-channel/context.ts
init_esm_shims();

// src/messaging/presets/electron/client.ts
init_esm_shims();

// src/messaging/presets/electron/context.ts
init_esm_shims();

// src/messaging/presets/electron/proxy.ts
init_esm_shims();

// src/messaging/presets/electron/server.ts
init_esm_shims();

// src/messaging/presets/extension/client.ts
init_esm_shims();

// src/messaging/presets/extension/context.ts
init_esm_shims();

// src/messaging/presets/extension/proxy.ts
init_esm_shims();

// src/messaging/presets/extension/server.ts
init_esm_shims();

// src/messaging/presets/iframe/client.ts
init_esm_shims();

// src/messaging/presets/iframe/context.ts
init_esm_shims();

// src/messaging/presets/iframe/server.ts
init_esm_shims();

// src/messaging/presets/vite/client.ts
init_esm_shims();

// src/messaging/presets/vite/context.ts
init_esm_shims();

// src/messaging/presets/vite/server.ts
init_esm_shims();

// src/messaging/index.ts
var _a19, _b19;
(_b19 = (_a19 = target).__VUE_DEVTOOLS_KIT_MESSAGE_CHANNELS__) != null ? _b19 : _a19.__VUE_DEVTOOLS_KIT_MESSAGE_CHANNELS__ = [];
var _a20, _b20;
(_b20 = (_a20 = target).__VUE_DEVTOOLS_KIT_RPC_CLIENT__) != null ? _b20 : _a20.__VUE_DEVTOOLS_KIT_RPC_CLIENT__ = null;
var _a21, _b21;
(_b21 = (_a21 = target).__VUE_DEVTOOLS_KIT_RPC_SERVER__) != null ? _b21 : _a21.__VUE_DEVTOOLS_KIT_RPC_SERVER__ = null;
var _a22, _b22;
(_b22 = (_a22 = target).__VUE_DEVTOOLS_KIT_VITE_RPC_CLIENT__) != null ? _b22 : _a22.__VUE_DEVTOOLS_KIT_VITE_RPC_CLIENT__ = null;
var _a23, _b23;
(_b23 = (_a23 = target).__VUE_DEVTOOLS_KIT_VITE_RPC_SERVER__) != null ? _b23 : _a23.__VUE_DEVTOOLS_KIT_VITE_RPC_SERVER__ = null;
var _a24, _b24;
(_b24 = (_a24 = target).__VUE_DEVTOOLS_KIT_BROADCAST_RPC_SERVER__) != null ? _b24 : _a24.__VUE_DEVTOOLS_KIT_BROADCAST_RPC_SERVER__ = null;

// src/shared/util.ts
init_esm_shims();

// src/core/component/state/replacer.ts
init_esm_shims();

// src/core/component/state/custom.ts
init_esm_shims();

// src/shared/transfer.ts
init_esm_shims();

/*!
 * pinia v3.0.4
 * (c) 2025 Eduardo San Martin Morote
 * @license MIT
 */

const IS_CLIENT = typeof window !== 'undefined';

/**
 * setActivePinia must be called to handle SSR at the top of functions like
 * `fetch`, `setup`, `serverPrefetch` and others
 */
let activePinia;
/**
 * Sets or unsets the active pinia. Used in SSR and internally when calling
 * actions and getters
 *
 * @param pinia - Pinia instance
 */
// @ts-expect-error: cannot constrain the type of the return
const setActivePinia = (pinia) => (activePinia = pinia);
const piniaSymbol = (/* istanbul ignore next */ Symbol());

function isPlainObject(
// eslint-disable-next-line @typescript-eslint/no-explicit-any
o) {
    return (o &&
        typeof o === 'object' &&
        Object.prototype.toString.call(o) === '[object Object]' &&
        typeof o.toJSON !== 'function');
}
// type DeepReadonly<T> = { readonly [P in keyof T]: DeepReadonly<T[P]> }
// TODO: can we change these to numbers?
/**
 * Possible types for SubscriptionCallback
 */
var MutationType;
(function (MutationType) {
    /**
     * Direct mutation of the state:
     *
     * - `store.name = 'new name'`
     * - `store.$state.name = 'new name'`
     * - `store.list.push('new item')`
     */
    MutationType["direct"] = "direct";
    /**
     * Mutated the state with `$patch` and an object
     *
     * - `store.$patch({ name: 'newName' })`
     */
    MutationType["patchObject"] = "patch object";
    /**
     * Mutated the state with `$patch` and a function
     *
     * - `store.$patch(state => state.name = 'newName')`
     */
    MutationType["patchFunction"] = "patch function";
    // maybe reset? for $state = {} and $reset
})(MutationType || (MutationType = {}));

/*
 * FileSaver.js A saveAs() FileSaver implementation.
 *
 * Originally by Eli Grey, adapted as an ESM module by Eduardo San Martin
 * Morote.
 *
 * License : MIT
 */
// The one and only way of getting global scope in all environments
// https://stackoverflow.com/q/3277182/1008999
const _global = /*#__PURE__*/ (() => typeof window === 'object' && window.window === window
    ? window
    : typeof self === 'object' && self.self === self
        ? self
        : typeof global === 'object' && global.global === global
            ? global
            : typeof globalThis === 'object'
                ? globalThis
                : { HTMLElement: null })();
function bom(blob, { autoBom = false } = {}) {
    // prepend BOM for UTF-8 XML and text/* types (including HTML)
    // note: your browser will automatically convert UTF-16 U+FEFF to EF BB BF
    if (autoBom &&
        /^\s*(?:text\/\S*|application\/xml|\S*\/\S*\+xml)\s*;.*charset\s*=\s*utf-8/i.test(blob.type)) {
        return new Blob([String.fromCharCode(0xfeff), blob], { type: blob.type });
    }
    return blob;
}
function download(url, name, opts) {
    const xhr = new XMLHttpRequest();
    xhr.open('GET', url);
    xhr.responseType = 'blob';
    xhr.onload = function () {
        saveAs(xhr.response, name, opts);
    };
    xhr.onerror = function () {
        console.error('could not download file');
    };
    xhr.send();
}
function corsEnabled(url) {
    const xhr = new XMLHttpRequest();
    // use sync to avoid popup blocker
    xhr.open('HEAD', url, false);
    try {
        xhr.send();
    }
    catch (e) { }
    return xhr.status >= 200 && xhr.status <= 299;
}
// `a.click()` doesn't work for all browsers (#465)
function click(node) {
    try {
        node.dispatchEvent(new MouseEvent('click'));
    }
    catch (e) {
        const evt = new MouseEvent('click', {
            bubbles: true,
            cancelable: true,
            view: window,
            detail: 0,
            screenX: 80,
            screenY: 20,
            clientX: 80,
            clientY: 20,
            ctrlKey: false,
            altKey: false,
            shiftKey: false,
            metaKey: false,
            button: 0,
            relatedTarget: null,
        });
        node.dispatchEvent(evt);
    }
}
const _navigator = typeof navigator === 'object' ? navigator : { userAgent: '' };
// Detect WebView inside a native macOS app by ruling out all browsers
// We just need to check for 'Safari' because all other browsers (besides Firefox) include that too
// https://www.whatismybrowser.com/guides/the-latest-user-agent/macos
const isMacOSWebView = /*#__PURE__*/ (() => /Macintosh/.test(_navigator.userAgent) &&
    /AppleWebKit/.test(_navigator.userAgent) &&
    !/Safari/.test(_navigator.userAgent))();
const saveAs = !IS_CLIENT
    ? () => { } // noop
    : // Use download attribute first if possible (#193 Lumia mobile) unless this is a macOS WebView or mini program
        typeof HTMLAnchorElement !== 'undefined' &&
            'download' in HTMLAnchorElement.prototype &&
            !isMacOSWebView
            ? downloadSaveAs
            : // Use msSaveOrOpenBlob as a second approach
                'msSaveOrOpenBlob' in _navigator
                    ? msSaveAs
                    : // Fallback to using FileReader and a popup
                        fileSaverSaveAs;
function downloadSaveAs(blob, name = 'download', opts) {
    const a = document.createElement('a');
    a.download = name;
    a.rel = 'noopener'; // tabnabbing
    // TODO: detect chrome extensions & packaged apps
    // a.target = '_blank'
    if (typeof blob === 'string') {
        // Support regular links
        a.href = blob;
        if (a.origin !== location.origin) {
            if (corsEnabled(a.href)) {
                download(blob, name, opts);
            }
            else {
                a.target = '_blank';
                click(a);
            }
        }
        else {
            click(a);
        }
    }
    else {
        // Support blobs
        a.href = URL.createObjectURL(blob);
        setTimeout(function () {
            URL.revokeObjectURL(a.href);
        }, 4e4); // 40s
        setTimeout(function () {
            click(a);
        }, 0);
    }
}
function msSaveAs(blob, name = 'download', opts) {
    if (typeof blob === 'string') {
        if (corsEnabled(blob)) {
            download(blob, name, opts);
        }
        else {
            const a = document.createElement('a');
            a.href = blob;
            a.target = '_blank';
            setTimeout(function () {
                click(a);
            });
        }
    }
    else {
        // @ts-ignore: works on windows
        navigator.msSaveOrOpenBlob(bom(blob, opts), name);
    }
}
function fileSaverSaveAs(blob, name, opts, popup) {
    // Open a popup immediately do go around popup blocker
    // Mostly only available on user interaction and the fileReader is async so...
    popup = popup || open('', '_blank');
    if (popup) {
        popup.document.title = popup.document.body.innerText = 'downloading...';
    }
    if (typeof blob === 'string')
        return download(blob, name, opts);
    const force = blob.type === 'application/octet-stream';
    const isSafari = /constructor/i.test(String(_global.HTMLElement)) || 'safari' in _global;
    const isChromeIOS = /CriOS\/[\d]+/.test(navigator.userAgent);
    if ((isChromeIOS || (force && isSafari) || isMacOSWebView) &&
        typeof FileReader !== 'undefined') {
        // Safari doesn't allow downloading of blob URLs
        const reader = new FileReader();
        reader.onloadend = function () {
            let url = reader.result;
            if (typeof url !== 'string') {
                popup = null;
                throw new Error('Wrong reader.result type');
            }
            url = isChromeIOS
                ? url
                : url.replace(/^data:[^;]*;/, 'data:attachment/file;');
            if (popup) {
                popup.location.href = url;
            }
            else {
                location.assign(url);
            }
            popup = null; // reverse-tabnabbing #460
        };
        reader.readAsDataURL(blob);
    }
    else {
        const url = URL.createObjectURL(blob);
        if (popup)
            popup.location.assign(url);
        else
            location.href = url;
        popup = null; // reverse-tabnabbing #460
        setTimeout(function () {
            URL.revokeObjectURL(url);
        }, 4e4); // 40s
    }
}

/**
 * Shows a toast or console.log
 *
 * @param message - message to log
 * @param type - different color of the tooltip
 */
function toastMessage(message, type) {
    const piniaMessage = '🍍 ' + message;
    if (typeof __VUE_DEVTOOLS_TOAST__ === 'function') {
        // No longer available :(
        __VUE_DEVTOOLS_TOAST__(piniaMessage, type);
    }
    else if (type === 'error') {
        console.error(piniaMessage);
    }
    else if (type === 'warn') {
        console.warn(piniaMessage);
    }
    else {
        console.log(piniaMessage);
    }
}
function isPinia(o) {
    return '_a' in o && 'install' in o;
}

/**
 * This file contain devtools actions, they are not Pinia actions.
 */
// ---
function checkClipboardAccess() {
    if (!('clipboard' in navigator)) {
        toastMessage(`Your browser doesn't support the Clipboard API`, 'error');
        return true;
    }
}
function checkNotFocusedError(error) {
    if (error instanceof Error &&
        error.message.toLowerCase().includes('document is not focused')) {
        toastMessage('You need to activate the "Emulate a focused page" setting in the "Rendering" panel of devtools.', 'warn');
        return true;
    }
    return false;
}
async function actionGlobalCopyState(pinia) {
    if (checkClipboardAccess())
        return;
    try {
        await navigator.clipboard.writeText(JSON.stringify(pinia.state.value));
        toastMessage('Global state copied to clipboard.');
    }
    catch (error) {
        if (checkNotFocusedError(error))
            return;
        toastMessage(`Failed to serialize the state. Check the console for more details.`, 'error');
        console.error(error);
    }
}
async function actionGlobalPasteState(pinia) {
    if (checkClipboardAccess())
        return;
    try {
        loadStoresState(pinia, JSON.parse(await navigator.clipboard.readText()));
        toastMessage('Global state pasted from clipboard.');
    }
    catch (error) {
        if (checkNotFocusedError(error))
            return;
        toastMessage(`Failed to deserialize the state from clipboard. Check the console for more details.`, 'error');
        console.error(error);
    }
}
async function actionGlobalSaveState(pinia) {
    try {
        saveAs(new Blob([JSON.stringify(pinia.state.value)], {
            type: 'text/plain;charset=utf-8',
        }), 'pinia-state.json');
    }
    catch (error) {
        toastMessage(`Failed to export the state as JSON. Check the console for more details.`, 'error');
        console.error(error);
    }
}
let fileInput;
function getFileOpener() {
    if (!fileInput) {
        fileInput = document.createElement('input');
        fileInput.type = 'file';
        fileInput.accept = '.json';
    }
    function openFile() {
        return new Promise((resolve, reject) => {
            fileInput.onchange = async () => {
                const files = fileInput.files;
                if (!files)
                    return resolve(null);
                const file = files.item(0);
                if (!file)
                    return resolve(null);
                return resolve({ text: await file.text(), file });
            };
            // @ts-ignore: TODO: changed from 4.3 to 4.4
            fileInput.oncancel = () => resolve(null);
            fileInput.onerror = reject;
            fileInput.click();
        });
    }
    return openFile;
}
async function actionGlobalOpenStateFile(pinia) {
    try {
        const open = getFileOpener();
        const result = await open();
        if (!result)
            return;
        const { text, file } = result;
        loadStoresState(pinia, JSON.parse(text));
        toastMessage(`Global state imported from "${file.name}".`);
    }
    catch (error) {
        toastMessage(`Failed to import the state from JSON. Check the console for more details.`, 'error');
        console.error(error);
    }
}
function loadStoresState(pinia, state) {
    for (const key in state) {
        const storeState = pinia.state.value[key];
        // store is already instantiated, patch it
        if (storeState) {
            Object.assign(storeState, state[key]);
        }
        else {
            // store is not instantiated, set the initial state
            pinia.state.value[key] = state[key];
        }
    }
}

function formatDisplay(display) {
    return {
        _custom: {
            display,
        },
    };
}
const PINIA_ROOT_LABEL = '🍍 Pinia (root)';
const PINIA_ROOT_ID = '_root';
function formatStoreForInspectorTree(store) {
    return isPinia(store)
        ? {
            id: PINIA_ROOT_ID,
            label: PINIA_ROOT_LABEL,
        }
        : {
            id: store.$id,
            label: store.$id,
        };
}
function formatStoreForInspectorState(store) {
    if (isPinia(store)) {
        const storeNames = Array.from(store._s.keys());
        const storeMap = store._s;
        const state = {
            state: storeNames.map((storeId) => ({
                editable: true,
                key: storeId,
                value: store.state.value[storeId],
            })),
            getters: storeNames
                .filter((id) => storeMap.get(id)._getters)
                .map((id) => {
                const store = storeMap.get(id);
                return {
                    editable: false,
                    key: id,
                    value: store._getters.reduce((getters, key) => {
                        getters[key] = store[key];
                        return getters;
                    }, {}),
                };
            }),
        };
        return state;
    }
    const state = {
        state: Object.keys(store.$state).map((key) => ({
            editable: true,
            key,
            value: store.$state[key],
        })),
    };
    // avoid adding empty getters
    if (store._getters && store._getters.length) {
        state.getters = store._getters.map((getterName) => ({
            editable: false,
            key: getterName,
            value: store[getterName],
        }));
    }
    if (store._customProperties.size) {
        state.customProperties = Array.from(store._customProperties).map((key) => ({
            editable: true,
            key,
            value: store[key],
        }));
    }
    return state;
}
function formatEventData(events) {
    if (!events)
        return {};
    if (Array.isArray(events)) {
        // TODO: handle add and delete for arrays and objects
        return events.reduce((data, event) => {
            data.keys.push(event.key);
            data.operations.push(event.type);
            data.oldValue[event.key] = event.oldValue;
            data.newValue[event.key] = event.newValue;
            return data;
        }, {
            oldValue: {},
            keys: [],
            operations: [],
            newValue: {},
        });
    }
    else {
        return {
            operation: formatDisplay(events.type),
            key: formatDisplay(events.key),
            oldValue: events.oldValue,
            newValue: events.newValue,
        };
    }
}
function formatMutationType(type) {
    switch (type) {
        case MutationType.direct:
            return 'mutation';
        case MutationType.patchFunction:
            return '$patch';
        case MutationType.patchObject:
            return '$patch';
        default:
            return 'unknown';
    }
}

// timeline can be paused when directly changing the state
let isTimelineActive = true;
const componentStateTypes = [];
const MUTATIONS_LAYER_ID = 'pinia:mutations';
const INSPECTOR_ID = 'pinia';
const { assign: assign$1 } = Object;
/**
 * Gets the displayed name of a store in devtools
 *
 * @param id - id of the store
 * @returns a formatted string
 */
const getStoreType = (id) => '🍍 ' + id;
/**
 * Add the pinia plugin without any store. Allows displaying a Pinia plugin tab
 * as soon as it is added to the application.
 *
 * @param app - Vue application
 * @param pinia - pinia instance
 */
function registerPiniaDevtools(app, pinia) {
    setupDevToolsPlugin({
        id: 'dev.esm.pinia',
        label: 'Pinia 🍍',
        logo: 'https://pinia.vuejs.org/logo.svg',
        packageName: 'pinia',
        homepage: 'https://pinia.vuejs.org',
        componentStateTypes,
        app,
    }, (api) => {
        if (typeof api.now !== 'function') {
            toastMessage('You seem to be using an outdated version of Vue Devtools. Are you still using the Beta release instead of the stable one? You can find the links at https://devtools.vuejs.org/guide/installation.html.');
        }
        api.addTimelineLayer({
            id: MUTATIONS_LAYER_ID,
            label: `Pinia 🍍`,
            color: 0xe5df88,
        });
        api.addInspector({
            id: INSPECTOR_ID,
            label: 'Pinia 🍍',
            icon: 'storage',
            treeFilterPlaceholder: 'Search stores',
            actions: [
                {
                    icon: 'content_copy',
                    action: () => {
                        actionGlobalCopyState(pinia);
                    },
                    tooltip: 'Serialize and copy the state',
                },
                {
                    icon: 'content_paste',
                    action: async () => {
                        await actionGlobalPasteState(pinia);
                        api.sendInspectorTree(INSPECTOR_ID);
                        api.sendInspectorState(INSPECTOR_ID);
                    },
                    tooltip: 'Replace the state with the content of your clipboard',
                },
                {
                    icon: 'save',
                    action: () => {
                        actionGlobalSaveState(pinia);
                    },
                    tooltip: 'Save the state as a JSON file',
                },
                {
                    icon: 'folder_open',
                    action: async () => {
                        await actionGlobalOpenStateFile(pinia);
                        api.sendInspectorTree(INSPECTOR_ID);
                        api.sendInspectorState(INSPECTOR_ID);
                    },
                    tooltip: 'Import the state from a JSON file',
                },
            ],
            nodeActions: [
                {
                    icon: 'restore',
                    tooltip: 'Reset the state (with "$reset")',
                    action: (nodeId) => {
                        const store = pinia._s.get(nodeId);
                        if (!store) {
                            toastMessage(`Cannot reset "${nodeId}" store because it wasn't found.`, 'warn');
                        }
                        else if (typeof store.$reset !== 'function') {
                            toastMessage(`Cannot reset "${nodeId}" store because it doesn't have a "$reset" method implemented.`, 'warn');
                        }
                        else {
                            store.$reset();
                            toastMessage(`Store "${nodeId}" reset.`);
                        }
                    },
                },
            ],
        });
        api.on.inspectComponent((payload) => {
            const proxy = (payload.componentInstance &&
                payload.componentInstance.proxy);
            if (proxy && proxy._pStores) {
                const piniaStores = payload.componentInstance.proxy._pStores;
                Object.values(piniaStores).forEach((store) => {
                    payload.instanceData.state.push({
                        type: getStoreType(store.$id),
                        key: 'state',
                        editable: true,
                        value: store._isOptionsAPI
                            ? {
                                _custom: {
                                    value: toRaw$1(store.$state),
                                    actions: [
                                        {
                                            icon: 'restore',
                                            tooltip: 'Reset the state of this store',
                                            action: () => store.$reset(),
                                        },
                                    ],
                                },
                            }
                            : // NOTE: workaround to unwrap transferred refs
                                Object.keys(store.$state).reduce((state, key) => {
                                    state[key] = store.$state[key];
                                    return state;
                                }, {}),
                    });
                    if (store._getters && store._getters.length) {
                        payload.instanceData.state.push({
                            type: getStoreType(store.$id),
                            key: 'getters',
                            editable: false,
                            value: store._getters.reduce((getters, key) => {
                                try {
                                    getters[key] = store[key];
                                }
                                catch (error) {
                                    // @ts-expect-error: we just want to show it in devtools
                                    getters[key] = error;
                                }
                                return getters;
                            }, {}),
                        });
                    }
                });
            }
        });
        api.on.getInspectorTree((payload) => {
            if (payload.app === app && payload.inspectorId === INSPECTOR_ID) {
                let stores = [pinia];
                stores = stores.concat(Array.from(pinia._s.values()));
                payload.rootNodes = (payload.filter
                    ? stores.filter((store) => '$id' in store
                        ? store.$id
                            .toLowerCase()
                            .includes(payload.filter.toLowerCase())
                        : PINIA_ROOT_LABEL.toLowerCase().includes(payload.filter.toLowerCase()))
                    : stores).map(formatStoreForInspectorTree);
            }
        });
        // Expose pinia instance as $pinia to window
        globalThis.$pinia = pinia;
        api.on.getInspectorState((payload) => {
            if (payload.app === app && payload.inspectorId === INSPECTOR_ID) {
                const inspectedStore = payload.nodeId === PINIA_ROOT_ID
                    ? pinia
                    : pinia._s.get(payload.nodeId);
                if (!inspectedStore) {
                    // this could be the selected store restored for a different project
                    // so it's better not to say anything here
                    return;
                }
                if (inspectedStore) {
                    // Expose selected store as $store to window
                    if (payload.nodeId !== PINIA_ROOT_ID)
                        globalThis.$store = toRaw$1(inspectedStore);
                    payload.state = formatStoreForInspectorState(inspectedStore);
                }
            }
        });
        api.on.editInspectorState((payload) => {
            if (payload.app === app && payload.inspectorId === INSPECTOR_ID) {
                const inspectedStore = payload.nodeId === PINIA_ROOT_ID
                    ? pinia
                    : pinia._s.get(payload.nodeId);
                if (!inspectedStore) {
                    return toastMessage(`store "${payload.nodeId}" not found`, 'error');
                }
                const { path } = payload;
                if (!isPinia(inspectedStore)) {
                    // access only the state
                    if (path.length !== 1 ||
                        !inspectedStore._customProperties.has(path[0]) ||
                        path[0] in inspectedStore.$state) {
                        path.unshift('$state');
                    }
                }
                else {
                    // Root access, we can omit the `.value` because the devtools API does it for us
                    path.unshift('state');
                }
                isTimelineActive = false;
                payload.set(inspectedStore, path, payload.state.value);
                isTimelineActive = true;
            }
        });
        api.on.editComponentState((payload) => {
            if (payload.type.startsWith('🍍')) {
                const storeId = payload.type.replace(/^🍍\s*/, '');
                const store = pinia._s.get(storeId);
                if (!store) {
                    return toastMessage(`store "${storeId}" not found`, 'error');
                }
                const { path } = payload;
                if (path[0] !== 'state') {
                    return toastMessage(`Invalid path for store "${storeId}":\n${path}\nOnly state can be modified.`);
                }
                // rewrite the first entry to be able to directly set the state as
                // well as any other path
                path[0] = '$state';
                isTimelineActive = false;
                payload.set(store, path, payload.state.value);
                isTimelineActive = true;
            }
        });
    });
}
function addStoreToDevtools(app, store) {
    if (!componentStateTypes.includes(getStoreType(store.$id))) {
        componentStateTypes.push(getStoreType(store.$id));
    }
    setupDevToolsPlugin({
        id: 'dev.esm.pinia',
        label: 'Pinia 🍍',
        logo: 'https://pinia.vuejs.org/logo.svg',
        packageName: 'pinia',
        homepage: 'https://pinia.vuejs.org',
        componentStateTypes,
        app,
        settings: {
            logStoreChanges: {
                label: 'Notify about new/deleted stores',
                type: 'boolean',
                defaultValue: true,
            },
            // useEmojis: {
            //   label: 'Use emojis in messages ⚡️',
            //   type: 'boolean',
            //   defaultValue: true,
            // },
        },
    }, (api) => {
        // gracefully handle errors
        const now = typeof api.now === 'function' ? api.now.bind(api) : Date.now;
        store.$onAction(({ after, onError, name, args }) => {
            const groupId = runningActionId++;
            api.addTimelineEvent({
                layerId: MUTATIONS_LAYER_ID,
                event: {
                    time: now(),
                    title: '🛫 ' + name,
                    subtitle: 'start',
                    data: {
                        store: formatDisplay(store.$id),
                        action: formatDisplay(name),
                        args,
                    },
                    groupId,
                },
            });
            after((result) => {
                activeAction = undefined;
                api.addTimelineEvent({
                    layerId: MUTATIONS_LAYER_ID,
                    event: {
                        time: now(),
                        title: '🛬 ' + name,
                        subtitle: 'end',
                        data: {
                            store: formatDisplay(store.$id),
                            action: formatDisplay(name),
                            args,
                            result,
                        },
                        groupId,
                    },
                });
            });
            onError((error) => {
                activeAction = undefined;
                api.addTimelineEvent({
                    layerId: MUTATIONS_LAYER_ID,
                    event: {
                        time: now(),
                        logType: 'error',
                        title: '💥 ' + name,
                        subtitle: 'end',
                        data: {
                            store: formatDisplay(store.$id),
                            action: formatDisplay(name),
                            args,
                            error,
                        },
                        groupId,
                    },
                });
            });
        }, true);
        store._customProperties.forEach((name) => {
            watch(() => unref(store[name]), (newValue, oldValue) => {
                api.notifyComponentUpdate();
                api.sendInspectorState(INSPECTOR_ID);
                if (isTimelineActive) {
                    api.addTimelineEvent({
                        layerId: MUTATIONS_LAYER_ID,
                        event: {
                            time: now(),
                            title: 'Change',
                            subtitle: name,
                            data: {
                                newValue,
                                oldValue,
                            },
                            groupId: activeAction,
                        },
                    });
                }
            }, { deep: true });
        });
        store.$subscribe(({ events, type }, state) => {
            api.notifyComponentUpdate();
            api.sendInspectorState(INSPECTOR_ID);
            if (!isTimelineActive)
                return;
            // rootStore.state[store.id] = state
            const eventData = {
                time: now(),
                title: formatMutationType(type),
                data: assign$1({ store: formatDisplay(store.$id) }, formatEventData(events)),
                groupId: activeAction,
            };
            if (type === MutationType.patchFunction) {
                eventData.subtitle = '⤵️';
            }
            else if (type === MutationType.patchObject) {
                eventData.subtitle = '🧩';
            }
            else if (events && !Array.isArray(events)) {
                eventData.subtitle = events.type;
            }
            if (events) {
                eventData.data['rawEvent(s)'] = {
                    _custom: {
                        display: 'DebuggerEvent',
                        type: 'object',
                        tooltip: 'raw DebuggerEvent[]',
                        value: events,
                    },
                };
            }
            api.addTimelineEvent({
                layerId: MUTATIONS_LAYER_ID,
                event: eventData,
            });
        }, { detached: true, flush: 'sync' });
        const hotUpdate = store._hotUpdate;
        store._hotUpdate = markRaw((newStore) => {
            hotUpdate(newStore);
            api.addTimelineEvent({
                layerId: MUTATIONS_LAYER_ID,
                event: {
                    time: now(),
                    title: '🔥 ' + store.$id,
                    subtitle: 'HMR update',
                    data: {
                        store: formatDisplay(store.$id),
                        info: formatDisplay(`HMR update`),
                    },
                },
            });
            // update the devtools too
            api.notifyComponentUpdate();
            api.sendInspectorTree(INSPECTOR_ID);
            api.sendInspectorState(INSPECTOR_ID);
        });
        const { $dispose } = store;
        store.$dispose = () => {
            $dispose();
            api.notifyComponentUpdate();
            api.sendInspectorTree(INSPECTOR_ID);
            api.sendInspectorState(INSPECTOR_ID);
            api.getSettings().logStoreChanges &&
                toastMessage(`Disposed "${store.$id}" store 🗑`);
        };
        // trigger an update so it can display new registered stores
        api.notifyComponentUpdate();
        api.sendInspectorTree(INSPECTOR_ID);
        api.sendInspectorState(INSPECTOR_ID);
        api.getSettings().logStoreChanges &&
            toastMessage(`"${store.$id}" store installed 🆕`);
    });
}
let runningActionId = 0;
let activeAction;
/**
 * Patches a store to enable action grouping in devtools by wrapping the store with a Proxy that is passed as the
 * context of all actions, allowing us to set `runningAction` on each access and effectively associating any state
 * mutation to the action.
 *
 * @param store - store to patch
 * @param actionNames - list of actionst to patch
 */
function patchActionForGrouping(store, actionNames, wrapWithProxy) {
    // original actions of the store as they are given by pinia. We are going to override them
    const actions = actionNames.reduce((storeActions, actionName) => {
        // use toRaw to avoid tracking #541
        storeActions[actionName] = toRaw$1(store)[actionName];
        return storeActions;
    }, {});
    for (const actionName in actions) {
        store[actionName] = function () {
            // the running action id is incremented in a before action hook
            const _actionId = runningActionId;
            const trackedStore = wrapWithProxy
                ? new Proxy(store, {
                    get(...args) {
                        activeAction = _actionId;
                        return Reflect.get(...args);
                    },
                    set(...args) {
                        activeAction = _actionId;
                        return Reflect.set(...args);
                    },
                })
                : store;
            // For Setup Stores we need https://github.com/tc39/proposal-async-context
            activeAction = _actionId;
            const retValue = actions[actionName].apply(trackedStore, arguments);
            // this is safer as async actions in Setup Stores would associate mutations done outside of the action
            activeAction = undefined;
            return retValue;
        };
    }
}
/**
 * pinia.use(devtoolsPlugin)
 */
function devtoolsPlugin({ app, store, options }) {
    // HMR module
    if (store.$id.startsWith('__hot:')) {
        return;
    }
    // detect option api vs setup api
    store._isOptionsAPI = !!options.state;
    // Do not overwrite actions mocked by @pinia/testing (#2298)
    if (!store._p._testing) {
        patchActionForGrouping(store, Object.keys(options.actions), store._isOptionsAPI);
        // Upgrade the HMR to also update the new actions
        const originalHotUpdate = store._hotUpdate;
        toRaw$1(store)._hotUpdate = function (newStore) {
            originalHotUpdate.apply(this, arguments);
            patchActionForGrouping(store, Object.keys(newStore._hmrPayload.actions), !!store._isOptionsAPI);
        };
    }
    addStoreToDevtools(app, 
    // FIXME: is there a way to allow the assignment from Store<Id, S, G, A> to StoreGeneric?
    store);
}

/**
 * Creates a Pinia instance to be used by the application
 */
function createPinia() {
    const scope = effectScope(true);
    // NOTE: here we could check the window object for a state and directly set it
    // if there is anything like it with Vue 3 SSR
    const state = scope.run(() => ref({}));
    let _p = [];
    // plugins added before calling app.use(pinia)
    let toBeInstalled = [];
    const pinia = markRaw({
        install(app) {
            // this allows calling useStore() outside of a component setup after
            // installing pinia's plugin
            setActivePinia(pinia);
            pinia._a = app;
            app.provide(piniaSymbol, pinia);
            app.config.globalProperties.$pinia = pinia;
            /* istanbul ignore else */
            if ((((typeof __VUE_PROD_DEVTOOLS__ !== 'undefined' && __VUE_PROD_DEVTOOLS__)) && true) && IS_CLIENT) {
                registerPiniaDevtools(app, pinia);
            }
            toBeInstalled.forEach((plugin) => _p.push(plugin));
            toBeInstalled = [];
        },
        use(plugin) {
            if (!this._a) {
                toBeInstalled.push(plugin);
            }
            else {
                _p.push(plugin);
            }
            return this;
        },
        _p,
        // it's actually undefined here
        // @ts-expect-error
        _a: null,
        _e: scope,
        _s: new Map(),
        state,
    });
    // pinia devtools rely on dev only features so they cannot be forced unless
    // the dev build of Vue is used. Avoid old browsers like IE11.
    if ((((typeof __VUE_PROD_DEVTOOLS__ !== 'undefined' && __VUE_PROD_DEVTOOLS__)) && true) && IS_CLIENT && typeof Proxy !== 'undefined') {
        pinia.use(devtoolsPlugin);
    }
    return pinia;
}

const noop = () => { };
function addSubscription(subscriptions, callback, detached, onCleanup = noop) {
    subscriptions.add(callback);
    const removeSubscription = () => {
        const isDel = subscriptions.delete(callback);
        isDel && onCleanup();
    };
    if (!detached && getCurrentScope()) {
        onScopeDispose(removeSubscription);
    }
    return removeSubscription;
}
function triggerSubscriptions(subscriptions, ...args) {
    subscriptions.forEach((callback) => {
        callback(...args);
    });
}

const fallbackRunWithContext = (fn) => fn();
/**
 * Marks a function as an action for `$onAction`
 * @internal
 */
const ACTION_MARKER = Symbol();
/**
 * Action name symbol. Allows to add a name to an action after defining it
 * @internal
 */
const ACTION_NAME = Symbol();
function mergeReactiveObjects(target, patchToApply) {
    // Handle Map instances
    if (target instanceof Map && patchToApply instanceof Map) {
        patchToApply.forEach((value, key) => target.set(key, value));
    }
    else if (target instanceof Set && patchToApply instanceof Set) {
        // Handle Set instances
        patchToApply.forEach(target.add, target);
    }
    // no need to go through symbols because they cannot be serialized anyway
    for (const key in patchToApply) {
        if (!patchToApply.hasOwnProperty(key))
            continue;
        const subPatch = patchToApply[key];
        const targetValue = target[key];
        if (isPlainObject(targetValue) &&
            isPlainObject(subPatch) &&
            target.hasOwnProperty(key) &&
            !isRef$1(subPatch) &&
            !isReactive$1(subPatch)) {
            // NOTE: here I wanted to warn about inconsistent types but it's not possible because in setup stores one might
            // start the value of a property as a certain type e.g. a Map, and then for some reason, during SSR, change that
            // to `undefined`. When trying to hydrate, we want to override the Map with `undefined`.
            target[key] = mergeReactiveObjects(targetValue, subPatch);
        }
        else {
            // @ts-expect-error: subPatch is a valid value
            target[key] = subPatch;
        }
    }
    return target;
}
const skipHydrateSymbol = /* istanbul ignore next */ Symbol();
/**
 * Returns whether a value should be hydrated
 *
 * @param obj - target variable
 * @returns true if `obj` should be hydrated
 */
function shouldHydrate(obj) {
    return (!isPlainObject(obj) ||
        !Object.prototype.hasOwnProperty.call(obj, skipHydrateSymbol));
}
const { assign } = Object;
function isComputed(o) {
    return !!(isRef$1(o) && o.effect);
}
function createOptionsStore(id, options, pinia, hot) {
    const { state, actions, getters } = options;
    const initialState = pinia.state.value[id];
    let store;
    function setup() {
        if (!initialState && (true)) {
            /* istanbul ignore if */
            pinia.state.value[id] = state ? state() : {};
        }
        // avoid creating a state in pinia.state.value
        const localState = toRefs(pinia.state.value[id]);
        return assign(localState, actions, Object.keys(getters || {}).reduce((computedGetters, name) => {
            computedGetters[name] = markRaw(computed(() => {
                setActivePinia(pinia);
                // it was created just before
                const store = pinia._s.get(id);
                // allow cross using stores
                // @ts-expect-error
                // return getters![name].call(context, context)
                // TODO: avoid reading the getter while assigning with a global variable
                return getters[name].call(store, store);
            }));
            return computedGetters;
        }, {}));
    }
    store = createSetupStore(id, setup, options, pinia, hot, true);
    return store;
}
function createSetupStore($id, setup, options = {}, pinia, hot, isOptionsStore) {
    let scope;
    const optionsForPlugin = assign({ actions: {} }, options);
    // watcher options for $subscribe
    const $subscribeOptions = { deep: true };
    // internal state
    let isListening; // set to true at the end
    let isSyncListening; // set to true at the end
    let subscriptions = new Set();
    let actionSubscriptions = new Set();
    let debuggerEvents;
    const initialState = pinia.state.value[$id];
    // avoid setting the state for option stores if it is set
    // by the setup
    if (!isOptionsStore && !initialState && (true)) {
        /* istanbul ignore if */
        pinia.state.value[$id] = {};
    }
    const hotState = ref({});
    // avoid triggering too many listeners
    // https://github.com/vuejs/pinia/issues/1129
    let activeListener;
    function $patch(partialStateOrMutator) {
        let subscriptionMutation;
        isListening = isSyncListening = false;
        if (typeof partialStateOrMutator === 'function') {
            partialStateOrMutator(pinia.state.value[$id]);
            subscriptionMutation = {
                type: MutationType.patchFunction,
                storeId: $id,
                events: debuggerEvents,
            };
        }
        else {
            mergeReactiveObjects(pinia.state.value[$id], partialStateOrMutator);
            subscriptionMutation = {
                type: MutationType.patchObject,
                payload: partialStateOrMutator,
                storeId: $id,
                events: debuggerEvents,
            };
        }
        const myListenerId = (activeListener = Symbol());
        nextTick().then(() => {
            if (activeListener === myListenerId) {
                isListening = true;
            }
        });
        isSyncListening = true;
        // because we paused the watcher, we need to manually call the subscriptions
        triggerSubscriptions(subscriptions, subscriptionMutation, pinia.state.value[$id]);
    }
    const $reset = isOptionsStore
        ? function $reset() {
            const { state } = options;
            const newState = state ? state() : {};
            // we use a patch to group all changes into one single subscription
            this.$patch(($state) => {
                // @ts-expect-error: FIXME: shouldn't error?
                assign($state, newState);
            });
        }
        : /* istanbul ignore next */
            noop;
    function $dispose() {
        scope.stop();
        subscriptions.clear();
        actionSubscriptions.clear();
        pinia._s.delete($id);
    }
    /**
     * Helper that wraps function so it can be tracked with $onAction
     * @param fn - action to wrap
     * @param name - name of the action
     */
    const action = (fn, name = '') => {
        if (ACTION_MARKER in fn) {
            fn[ACTION_NAME] = name;
            return fn;
        }
        const wrappedAction = function () {
            setActivePinia(pinia);
            const args = Array.from(arguments);
            const afterCallbackSet = new Set();
            const onErrorCallbackSet = new Set();
            function after(callback) {
                afterCallbackSet.add(callback);
            }
            function onError(callback) {
                onErrorCallbackSet.add(callback);
            }
            // @ts-expect-error
            triggerSubscriptions(actionSubscriptions, {
                args,
                name: wrappedAction[ACTION_NAME],
                store,
                after,
                onError,
            });
            let ret;
            try {
                ret = fn.apply(this && this.$id === $id ? this : store, args);
                // handle sync errors
            }
            catch (error) {
                triggerSubscriptions(onErrorCallbackSet, error);
                throw error;
            }
            if (ret instanceof Promise) {
                return ret
                    .then((value) => {
                    triggerSubscriptions(afterCallbackSet, value);
                    return value;
                })
                    .catch((error) => {
                    triggerSubscriptions(onErrorCallbackSet, error);
                    return Promise.reject(error);
                });
            }
            // trigger after callbacks
            triggerSubscriptions(afterCallbackSet, ret);
            return ret;
        };
        wrappedAction[ACTION_MARKER] = true;
        wrappedAction[ACTION_NAME] = name; // will be set later
        // @ts-expect-error: we are intentionally limiting the returned type to just Fn
        // because all the added properties are internals that are exposed through `$onAction()` only
        return wrappedAction;
    };
    const _hmrPayload = /*#__PURE__*/ markRaw({
        actions: {},
        getters: {},
        state: [],
        hotState,
    });
    const partialStore = {
        _p: pinia,
        // _s: scope,
        $id,
        $onAction: addSubscription.bind(null, actionSubscriptions),
        $patch,
        $reset,
        $subscribe(callback, options = {}) {
            const removeSubscription = addSubscription(subscriptions, callback, options.detached, () => stopWatcher());
            const stopWatcher = scope.run(() => watch(() => pinia.state.value[$id], (state) => {
                if (options.flush === 'sync' ? isSyncListening : isListening) {
                    callback({
                        storeId: $id,
                        type: MutationType.direct,
                        events: debuggerEvents,
                    }, state);
                }
            }, assign({}, $subscribeOptions, options)));
            return removeSubscription;
        },
        $dispose,
    };
    const store = reactive(((((typeof __VUE_PROD_DEVTOOLS__ !== 'undefined' && __VUE_PROD_DEVTOOLS__)) && true) && IS_CLIENT)
        ? assign({
            _hmrPayload,
            _customProperties: markRaw(new Set()), // devtools custom properties
        }, partialStore
        // must be added later
        // setupStore
        )
        : partialStore);
    // store the partial store now so the setup of stores can instantiate each other before they are finished without
    // creating infinite loops.
    pinia._s.set($id, store);
    const runWithContext = (pinia._a && pinia._a.runWithContext) || fallbackRunWithContext;
    // TODO: idea create skipSerialize that marks properties as non serializable and they are skipped
    const setupStore = runWithContext(() => pinia._e.run(() => (scope = effectScope()).run(() => setup({ action }))));
    // overwrite existing actions to support $onAction
    for (const key in setupStore) {
        const prop = setupStore[key];
        if ((isRef$1(prop) && !isComputed(prop)) || isReactive$1(prop)) {
            // mark it as a piece of state to be serialized
            if (!isOptionsStore) {
                // in setup stores we must hydrate the state and sync pinia state tree with the refs the user just created
                if (initialState && shouldHydrate(prop)) {
                    if (isRef$1(prop)) {
                        prop.value = initialState[key];
                    }
                    else {
                        // probably a reactive object, lets recursively assign
                        // @ts-expect-error: prop is unknown
                        mergeReactiveObjects(prop, initialState[key]);
                    }
                }
                // transfer the ref to the pinia state to keep everything in sync
                pinia.state.value[$id][key] = prop;
            }
            // action
        }
        else if (typeof prop === 'function') {
            const actionValue = action(prop, key);
            // this a hot module replacement store because the hotUpdate method needs
            // to do it with the right context
            // @ts-expect-error
            setupStore[key] = actionValue;
            // list actions so they can be used in plugins
            // @ts-expect-error
            optionsForPlugin.actions[key] = prop;
        }
        else ;
    }
    // add the state, getters, and action properties
    /* istanbul ignore if */
    assign(store, setupStore);
    // allows retrieving reactive objects with `storeToRefs()`. Must be called after assigning to the reactive object.
    // Make `storeToRefs()` work with `reactive()` #799
    assign(toRaw$1(store), setupStore);
    // use this instead of a computed with setter to be able to create it anywhere
    // without linking the computed lifespan to wherever the store is first
    // created.
    Object.defineProperty(store, '$state', {
        get: () => (pinia.state.value[$id]),
        set: (state) => {
            $patch(($state) => {
                // @ts-expect-error: FIXME: shouldn't error?
                assign($state, state);
            });
        },
    });
    if ((((typeof __VUE_PROD_DEVTOOLS__ !== 'undefined' && __VUE_PROD_DEVTOOLS__)) && true) && IS_CLIENT) {
        const nonEnumerable = {
            writable: true,
            configurable: true,
            // avoid warning on devtools trying to display this property
            enumerable: false,
        };
        ['_p', '_hmrPayload', '_getters', '_customProperties'].forEach((p) => {
            Object.defineProperty(store, p, assign({ value: store[p] }, nonEnumerable));
        });
    }
    // apply all plugins
    pinia._p.forEach((extender) => {
        /* istanbul ignore else */
        if ((((typeof __VUE_PROD_DEVTOOLS__ !== 'undefined' && __VUE_PROD_DEVTOOLS__)) && true) && IS_CLIENT) {
            const extensions = scope.run(() => extender({
                store: store,
                app: pinia._a,
                pinia,
                options: optionsForPlugin,
            }));
            Object.keys(extensions || {}).forEach((key) => store._customProperties.add(key));
            assign(store, extensions);
        }
        else {
            assign(store, scope.run(() => extender({
                store: store,
                app: pinia._a,
                pinia,
                options: optionsForPlugin,
            })));
        }
    });
    // only apply hydrate to option stores with an initial state in pinia
    if (initialState &&
        isOptionsStore &&
        options.hydrate) {
        options.hydrate(store.$state, initialState);
    }
    isListening = true;
    isSyncListening = true;
    return store;
}
// allows unused stores to be tree shaken
/*! #__NO_SIDE_EFFECTS__ */
function defineStore(
// TODO: add proper types from above
id, setup, setupOptions) {
    let options;
    const isSetupStore = typeof setup === 'function';
    // the option store setup will contain the actual options in this case
    options = isSetupStore ? setupOptions : setup;
    function useStore(pinia, hot) {
        const hasContext = hasInjectionContext();
        pinia =
            // in test mode, ignore the argument provided as we can always retrieve a
            // pinia instance with getActivePinia()
            (pinia) ||
                (hasContext ? inject(piniaSymbol, null) : null);
        if (pinia)
            setActivePinia(pinia);
        pinia = activePinia;
        if (!pinia._s.has(id)) {
            // creating the store registers it in `pinia._s`
            if (isSetupStore) {
                createSetupStore(id, setup, options, pinia);
            }
            else {
                createOptionsStore(id, options, pinia);
            }
        }
        const store = pinia._s.get(id);
        // StoreGeneric cannot be casted towards Store
        return store;
    }
    useStore.$id = id;
    return useStore;
}

/**
 * KaleidoPanel（§6.1/§6.2）：Vue3 + Pinia 面板。
 *
 * - 双入口：作者/玩家共用同一状态后端（inject 注入 bridge/adapter + nlkaleido:* 事件驱动，
 *   §6.1 铁律：玩家视图是只读投影，作者视图是读写控制台）。
 * - §11.1 Vue 实例隔离：createApp 实例级局部注册 + 独立 DOM 容器 + Pinia store `nlkaleido:*`
 *   前缀；不写 window.Vue、不调全局 app.component。
 * - 组件全用 h() 渲染函数（runtime-only Vue 即可，无需 SFC 编译 → 打包零 esbuild）。
 */
const INJECT_BRIDGE = 'nlkaleido:bridge';
const INJECT_ADAPTER = 'nlkaleido:adapter';
/** Pinia store（§6.2 状态拆分；命名全 nlkaleido: 前缀，§11.1） */
const useNlStore = defineStore('nlkaleido:panel', () => {
    const compat = ref(null);
    const statData = ref({});
    const pending = ref([]);
    const changelog = ref([]);
    const lastTurnId = ref(0);
    const authorMode = ref(false);
    const contractText = ref('');
    const contractError = ref('');
    /** @since M13 面板页签：player / author / memory（§20.10 记忆独立 Tab） */
    const activeTab = ref('player');
    /** @since M13 记忆刷新计数（nlkaleido:memory_changed → +1 触发重渲染） */
    const memoryVersion = ref(0);
    /** @since M15 剧情刷新计数（nlkaleido:plot_changed → +1 触发重渲染） */
    const plotVersion = ref(0);
    /** @since M16 检定刷新计数（nlkaleido:dice_rolled → +1 触发重渲染） */
    const diceVersion = ref(0);
    /** @since M14 配置刷新计数（nlkaleido:config_changed → +1 触发重渲染） */
    const configVersionCount = ref(0);
    return { compat, statData, pending, changelog, lastTurnId, authorMode, contractText, contractError, activeTab, memoryVersion, plotVersion, diceVersion, configVersionCount };
});
function json(value) {
    return JSON.stringify(value, null, 2);
}
function useAdapter() {
    // shallowRef：类实例不走 UnwrapRef（保留 private 成员类型面）
    return inject(INJECT_ADAPTER, shallowRef(null)).value;
}
function readState() {
    const adapter = useAdapter();
    return { contract: adapter.adapter.contract, state: adapter.adapter.state };
}
function dispatch(payload) {
    const bridge = inject(INJECT_BRIDGE, shallowRef(null)).value;
    return bridge.dispatch(payload);
}
/** 状态板（玩家视图，§6.1：只读展示，不暴露契约/调试） */
const PlayerView = defineComponent({
    name: 'NlPlayerView',
    setup() {
        const store = useNlStore();
        const adapter = useAdapter();
        const statuses = () => {
            const contract = adapter.adapter.contract;
            if (!contract)
                return [];
            return Object.values(contract.updateRules)
                .filter((f) => f.display)
                .map((f) => {
                const top = f.path.split('.')[0];
                const value = store.statData[top];
                return { path: f.path, value };
            });
        };
        return () => h('div', { class: 'nlk-section' }, [
            h('div', { class: 'nlk-statusbar' }, [
                h('span', { class: 'nlk-on' }, '万花筒 ON'),
                h('span', null, `轮次 ${store.lastTurnId}`),
                h('span', null, `待复核 ${store.pending.length}`),
                store.compat && !store.compat.compatible
                    ? h('span', { class: 'nlk-warn' }, `版本不兼容：${store.compat.missing.join(', ')}`)
                    : null,
            ]),
            h('div', { class: 'nlk-vars' }, statuses().map((s) => h('div', { class: 'nlk-var-row' }, [
                h('span', { class: 'nlk-var-path' }, String(s.path)),
                h('span', { class: 'nlk-var-value' }, json(s.value)),
            ]))),
            store.pending.length
                ? h('div', { class: 'nlk-pending' }, `有 ${store.pending.length} 个字段待确认（作者模式可见详情）`)
                : null,
        ]);
    },
});
/** 契约编辑器（作者视图）：JSON 文本 + 校验 + 保存 + 导出 */
const ContractEditor = defineComponent({
    name: 'NlContractEditor',
    setup() {
        const store = useNlStore();
        const save = () => {
            try {
                const raw = JSON.parse(store.contractText);
                const result = dispatch({ action: 'editContract', contract: raw });
                store.contractError = result.ok ? '' : result.error ?? '未知错误';
            }
            catch (error) {
                store.contractError = `JSON 解析失败：${error instanceof Error ? error.message : String(error)}`;
            }
        };
        const exportJson = () => {
            const { contract, state } = readState();
            if (!state || !contract)
                return;
            const blob = new Blob([exportBundle(contract, state)], { type: 'application/json' });
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = `nlkaleido-${contract.id}-v${contract.version}.json`;
            a.click();
            URL.revokeObjectURL(url);
        };
        return () => h('div', { class: 'nlk-section' }, [
            h('div', { class: 'nlk-row' }, [
                h('button', { onClick: save, class: 'nlk-btn' }, '保存契约（校验通过生效）'),
                h('button', { onClick: exportJson, class: 'nlk-btn' }, '导出打包（契约+数据+日志）'),
            ]),
            store.contractError
                ? h('div', { class: 'nlk-error' }, store.contractError)
                : null,
            h('textarea', {
                class: 'nlk-contract-input',
                value: store.contractText,
                onInput: (event) => { store.contractText = event.target.value; },
                rows: 18,
            }),
        ]);
    },
});
/** 状态预览 + 观察层预览（§6.1 StatePreview / ObservationPreview） */
const PreviewView = defineComponent({
    name: 'NlPreviewView',
    setup() {
        useNlStore();
        const mode = ref('full');
        const stateTable = () => {
            const { contract, state } = readState();
            if (!contract || !state)
                return '';
            return renderStateTable(contract, state, mode.value);
        };
        const observation = () => {
            const { contract, state } = readState();
            if (!contract || !state)
                return [];
            const due = dueFields(state.meta, contract, state.meta.lastTurnId + 1);
            const deps = computeDependencies(contract, due);
            return observe(contract, state, due, deps).fields;
        };
        return () => h('div', { class: 'nlk-section' }, [
            h('div', { class: 'nlk-row' }, [
                ['full', 'summary', 'incremental'].map((m) => h('button', {
                    key: m,
                    class: mode.value === m ? 'nlk-btn nlk-active' : 'nlk-btn',
                    onClick: () => { mode.value = m; },
                }, m)),
            ]),
            h('pre', { class: 'nlk-pre' }, stateTable()),
            h('div', { class: 'nlk-h3' }, '观察层预览（Agent 本轮可见）'),
            h('div', { class: 'nlk-vars' }, observation().map((f) => h('div', { class: 'nlk-var-row' }, [
                h('span', { class: 'nlk-var-path' }, f.path),
                h('span', { class: 'nlk-var-value' }, f.masked ? '[已脱敏]' : json(f.value)),
            ]))),
        ]);
    },
});
/** 调试面板（§6.1 DebugPanel：changelog / pending / 回滚 / diff） */
const DebugPanel = defineComponent({
    name: 'NlDebugPanel',
    setup() {
        const store = useNlStore();
        const rollback = (seq) => { dispatch({ action: 'rollback', seq }); };
        const resolve = (id, accept) => { dispatch({ action: 'resolvePending', id, accept }); };
        return () => h('div', { class: 'nlk-section' }, [
            h('div', { class: 'nlk-h3' }, `变更日志（最近 ${store.changelog.length} 条）`),
            h('div', { class: 'nlk-log' }, store.changelog.slice(-30).reverse().map((e) => h('div', { class: 'nlk-log-row' }, [
                h('span', null, `#${e.seq} `),
                h('span', null, `${e.path} ${e.op.op} `),
                h('span', { class: 'nlk-diff' }, `${json(e.old)} → ${json(e.new)}`),
                h('span', null, `（${e.confidence}/${e.source}）`),
                h('button', { class: 'nlk-btn nlk-btn-sm', onClick: () => rollback(e.seq) }, '回滚'),
            ]))),
            h('div', { class: 'nlk-h3' }, `待复核（${store.pending.length}）`),
            h('div', { class: 'nlk-log' }, store.pending.map((p) => h('div', { class: 'nlk-log-row' }, [
                h('span', null, `${p.op.op} ${p.op.path} = ${json(p.op.value)}`),
                h('span', null, `（${p.reason ?? ''}）`),
                h('button', { class: 'nlk-btn nlk-btn-sm', onClick: () => resolve(p.id, true) }, '接受'),
                h('button', { class: 'nlk-btn nlk-btn-sm', onClick: () => resolve(p.id, false) }, '丢弃'),
            ]))),
        ]);
    },
});
/** @since M13 记忆面板（§20.10：记忆浏览 / 衰减可视化 / 手动 search / 手动归档 / 原子管理） */
const MemoryView = defineComponent({
    name: 'NlMemoryView',
    setup() {
        const store = useNlStore();
        const adapter = useAdapter();
        const query = ref('');
        const searchResult = ref('');
        const atoms = () => {
            void store.memoryVersion; // 事件驱动重渲染
            return adapter.adapter.memoryStore.atoms;
        };
        const tables = () => adapter.adapter.memoryTables;
        const enabled = () => adapter.adapter.contract?.memory?.enabled === true;
        const decayOf = (atom) => {
            const daysSince = Math.max(0, (Date.now() - atom.lastAccessedAt) / 86400000);
            return computeDecayScore(atom.decay, atom.ttlDays, daysSince);
        };
        const search = () => {
            const result = dispatch({ action: 'memorySearch', query: query.value, topK: 5 });
            searchResult.value = result.ok ? String(result.result ?? '') : `检索失败：${result.error}`;
        };
        const forget = (id) => { dispatch({ action: 'memoryForget', atomId: id }); };
        const revive = (id) => { dispatch({ action: 'memoryRevive', atomId: id }); };
        const remove = (id) => { dispatch({ action: 'memoryDelete', atomId: id }); };
        const archiveNow = () => { dispatch({ action: 'memoryArchiveNow' }); };
        const TYPE_NAMES = { episodic: '情景', factual: '事实', relational: '关系', preference: '偏好', planned: '计划', unknown: '未知' };
        const STATUS_NAMES = { active: '活跃', dormant: '休眠', superseded: '被替代', expired: '过期', forgotten: '遗忘' };
        return () => {
            if (!enabled()) {
                return h('div', { class: 'nlk-section' }, [
                    h('div', { class: 'nlk-hint' }, '记忆系统未启用：作者需在契约 memory.enabled=true 声明（§20，默认关闭零开销）。'),
                ]);
            }
            const list = atoms().slice().sort((a, b) => b.lastAccessedAt - a.lastAccessedAt).slice(0, 60);
            return h('div', { class: 'nlk-section' }, [
                h('div', { class: 'nlk-h3' }, `长期记忆（${atoms().length} 原子 / ${tables().length} 表）`),
                h('div', { class: 'nlk-row' }, [
                    h('input', {
                        class: 'nlk-contract-input',
                        style: 'flex:1; min-width: 160px;',
                        value: query.value,
                        onInput: (event) => { query.value = event.target.value; },
                        placeholder: '检索记忆（BM25）…',
                    }),
                    h('button', { class: 'nlk-btn', onClick: search }, '搜索'),
                    h('button', { class: 'nlk-btn', onClick: archiveNow }, '手动归档'),
                ]),
                searchResult.value
                    ? h('pre', { class: 'nlk-pre' }, searchResult.value)
                    : null,
                h('div', { class: 'nlk-log' }, list.map((atom) => {
                    const decay = decayOf(atom);
                    const pct = Math.round(atom.importance * 100);
                    const decayPct = Math.round(decay * 100);
                    return h('div', { class: 'nlk-log-row', key: atom.id }, [
                        h('span', null, `[${TYPE_NAMES[atom.type] ?? atom.type}]`),
                        h('span', { style: 'flex:1;' }, atom.content),
                        h('span', { class: 'nlk-diff' }, `重要 ${pct}%`),
                        h('span', { class: decay < 0.3 ? 'nlk-warn' : 'nlk-diff' }, `衰减 ${decayPct}%`),
                        h('span', null, `强化×${atom.reinforcementCount}`),
                        h('span', null, `[${STATUS_NAMES[atom.status] ?? atom.status}]`),
                        atom.status !== 'active'
                            ? h('button', { class: 'nlk-btn nlk-btn-sm', onClick: () => revive(atom.id) }, '复活')
                            : h('button', { class: 'nlk-btn nlk-btn-sm', onClick: () => forget(atom.id) }, '遗忘'),
                        h('button', { class: 'nlk-btn nlk-btn-sm', onClick: () => remove(atom.id) }, '删除'),
                    ]);
                })),
                tables().length
                    ? h('div', { class: 'nlk-h3' }, `记忆表（${tables().length}）`)
                    : null,
                tables().map((table) => h('div', { key: table.id }, [
                    h('div', null, `${table.name}（${table.columns.join(' / ')}${table.floorScoped ? '，按楼层隔离' : ''}，${table.rows.length} 行）`),
                ])),
            ]);
        };
    },
});
/** @since M15 剧情面板（§22.6：事件链阶段进度 / Lv / 风声列表 + 手动推进 / 停滞 / 终局干预） */
const PlotView = defineComponent({
    name: 'NlPlotView',
    setup() {
        const store = useNlStore();
        const adapter = useAdapter();
        const events = () => {
            void store.plotVersion; // 事件驱动重渲染
            return adapter.adapter.plotEvents;
        };
        const winds = () => adapter.adapter.plotWinds;
        const enabled = () => adapter.adapter.contract?.plot?.enabled === true;
        const regional = () => adapter.adapter.regionalIncident;
        const advance = (id) => { dispatch({ action: 'plotAdvance', eventId: id }); };
        const stall = (id) => { dispatch({ action: 'plotStall', eventId: id }); };
        const terminal = (id, stage) => { dispatch({ action: 'plotTerminal', eventId: id, stage }); };
        const TYPE_NAMES = { conflict: '冲突', progress: '推进' };
        const WIND_NAMES = { announcement: '公告', report: '报道', rumor: '流言', sentiment: '舆情' };
        return () => {
            if (!enabled()) {
                return h('div', { class: 'nlk-section' }, [
                    h('div', { class: 'nlk-hint' }, '剧情编排未启用：作者需在契约 plot.enabled=true 声明（§22，默认关闭零开销）。'),
                ]);
            }
            const list = events();
            const windList = winds();
            const incident = regional();
            return h('div', { class: 'nlk-section' }, [
                h('div', { class: 'nlk-h3' }, `事件链（${list.length}）与风声（${windList.length}）`),
                incident.active
                    ? h('div', { class: 'nlk-warn' }, `区域突发事件：${incident.active.label}（剩余 ${incident.active.roundsLeft} 轮）`)
                    : null,
                h('div', { class: 'nlk-log' }, list.map((event) => {
                    const total = 9;
                    const filled = Math.min(total, event.stageRound ?? 1);
                    return h('div', { class: 'nlk-log-row', key: event.id }, [
                        h('span', null, `[${TYPE_NAMES[event.type] ?? event.type} Lv${event.level}]`),
                        h('span', { style: 'flex:1;' }, `${event.name}：${event.desc}`),
                        h('span', { class: 'nlk-diff' }, `${event.stage} ${event.stageRound}/9`),
                        h('span', { class: 'nlk-diff' }, `[${'■'.repeat(filled)}${'□'.repeat(total - filled)}]`),
                        h('span', null, event.evolveResult ? `（${event.evolveResult}）` : ''),
                        event.stall ? h('span', { class: 'nlk-warn' }, '停滞') : null,
                        h('button', { class: 'nlk-btn nlk-btn-sm', onClick: () => advance(event.id) }, '推进'),
                        h('button', { class: 'nlk-btn nlk-btn-sm', onClick: () => stall(event.id) }, event.stall ? '解除停滞' : '停滞'),
                        event.type === 'conflict'
                            ? h('button', { class: 'nlk-btn nlk-btn-sm', onClick: () => terminal(event.id, '已消散') }, '终局·消散')
                            : h('button', { class: 'nlk-btn nlk-btn-sm', onClick: () => terminal(event.id, '已失败') }, '终局·失败'),
                    ]);
                })),
                windList.length
                    ? h('div', { class: 'nlk-h3' }, `风声（${windList.length}）`)
                    : null,
                windList.map((wind) => h('div', { class: 'nlk-log-row', key: wind.id }, [
                    h('span', null, `[${WIND_NAMES[wind.type] ?? wind.type} Lv${wind.level}]`),
                    h('span', { style: 'flex:1;' }, `${wind.topic}：${wind.content}`),
                    h('span', { class: 'nlk-hint' }, `沉寂 ${wind.quietRounds} 轮`),
                ])),
            ]);
        };
    },
});
/** @since M16 检定面板（§23.7：快速检定 / 历史 / 预设导入 + 建议行执行；点击才执行不自动改状态） */
const DiceView = defineComponent({
    name: 'NlDiceView',
    setup() {
        const store = useNlStore();
        const adapter = useAdapter();
        const formula = ref('1d100');
        const target = ref('50');
        const suggestion = ref('');
        const presetText = ref('');
        const lastResult = ref('');
        const history = () => {
            void store.diceVersion;
            return adapter.adapter.diceHistory;
        };
        const presets = () => adapter.adapter.dicePresets.map((p) => ({ id: p.id, name: p.name }));
        const enabled = () => adapter.adapter.contract?.dice?.enabled === true;
        const roll = () => {
            const result = dispatch({ action: 'diceRoll', formula: formula.value });
            lastResult.value = result.ok ? `掷骰 ${formula.value}：${json(result.result)}` : `失败：${result.error}`;
        };
        const checkRoll = () => {
            const result = dispatch({ action: 'diceCheck', targetValue: Number(target.value), diceType: 100 });
            lastResult.value = result.ok ? `检定：${json(result.result)}` : `失败：${result.error}`;
        };
        const runSuggestion = () => {
            const result = dispatch({ action: 'diceSuggestion', line: suggestion.value });
            lastResult.value = result.ok ? `建议执行：${json(result.result)}` : `失败：${result.error}`;
        };
        const importPreset = () => {
            try {
                const raw = JSON.parse(presetText.value);
                const result = dispatch({ action: 'diceImportPreset', preset: raw });
                lastResult.value = result.ok ? `预设导入成功：${result.preset?.name ?? ''}` : `导入被拒：${result.error}`;
            }
            catch (error) {
                lastResult.value = `JSON 解析失败：${error instanceof Error ? error.message : String(error)}`;
            }
        };
        return () => {
            if (!enabled()) {
                return h('div', { class: 'nlk-section' }, [
                    h('div', { class: 'nlk-hint' }, '检定系统未启用：作者需在契约 dice.enabled=true 声明（§23，默认关闭零开销）。'),
                ]);
            }
            return h('div', { class: 'nlk-section' }, [
                h('div', { class: 'nlk-h3' }, `检定（预设 ${presets().length} / 历史 ${history().length}）`),
                h('div', { class: 'nlk-row' }, [
                    h('input', { class: 'nlk-contract-input', style: 'flex:1;', value: formula.value, onInput: (e) => { formula.value = e.target.value; }, placeholder: '骰子表达式（如 4d6kh3 / 1d100b1）' }),
                    h('button', { class: 'nlk-btn', onClick: roll }, '掷骰'),
                ]),
                h('div', { class: 'nlk-row' }, [
                    h('input', { class: 'nlk-contract-input', style: 'width: 90px;', value: target.value, onInput: (e) => { target.value = e.target.value; }, placeholder: '目标值' }),
                    h('button', { class: 'nlk-btn', onClick: checkRoll }, 'COC 检定'),
                ]),
                h('div', { class: 'nlk-row' }, [
                    h('input', { class: 'nlk-contract-input', style: 'flex:1;', value: suggestion.value, onInput: (e) => { suggestion.value = e.target.value; }, placeholder: '检定建议行（检定 <user> 侦查 难度=50 / 对抗 … / 必成 / 必败）' }),
                    h('button', { class: 'nlk-btn', onClick: runSuggestion }, '执行建议'),
                ]),
                lastResult.value ? h('pre', { class: 'nlk-pre' }, lastResult.value) : null,
                h('div', { class: 'nlk-h3' }, '预设导入（AI 生成协议 nlkaleido_dice_preset_agent_v1）'),
                h('textarea', { class: 'nlk-contract-input', rows: 4, value: presetText.value, onInput: (e) => { presetText.value = e.target.value; }, placeholder: '粘贴 AI 生成的预设 JSON（含 format/tests；tests 不通过拒绝导入）' }),
                h('button', { class: 'nlk-btn', onClick: importPreset }, '导入预设（tests 校验）'),
                h('div', { class: 'nlk-h3' }, `检定历史（最近 ${Math.min(history().length, 10)} 条）`),
                h('div', { class: 'nlk-log' }, history().slice(0, 10).map((entry) => h('div', { class: 'nlk-log-row', key: entry.id }, [
                    h('span', null, `[${entry.kind}]`),
                    h('span', { style: 'flex:1;' }, entry.text),
                    h('span', { class: 'nlk-diff' }, json(entry.result).slice(0, 160)),
                ]))),
            ]);
        };
    },
});
/** @since M9 迁移页签（§24.2 五阶段流程；动态 import 分包——默认关闭不加载迁移代码，§24.1） */
const MigrationView = defineComponent({
    name: 'NlMigrationView',
    setup() {
        useNlStore();
        const worldbookText = ref('');
        const scriptsText = ref('');
        const reportText = ref('');
        const draftText = ref('');
        const busy = ref(false);
        const run = async () => {
            busy.value = true;
            try {
                // 动态 import：迁移代码独立 chunk，默认关闭主 bundle 不含（§24.1 代码分包）
                const migration = await import('./migration-DNk4Lemz.js');
                let worldbookEntries = [];
                let scripts = [];
                try {
                    const parsed = JSON.parse(worldbookText.value || '[]');
                    worldbookEntries = Array.isArray(parsed) ? parsed : [];
                }
                catch {
                    // 非 JSON → 视为单条纯文本条目
                    worldbookEntries = worldbookText.value.trim()
                        ? [{ uid: 'paste-1', name: '粘贴条目', enabled: true, content: worldbookText.value }]
                        : [];
                }
                const scriptsRaw = scriptsText.value.trim();
                scripts = scriptsRaw ? [{ name: 'paste-script.js', content: scriptsRaw }] : [];
                const detection = migration.detectMvuCard({ worldbookEntries: worldbookEntries, scripts });
                const lines = [`# MVU 检测报告`, detection.summary];
                if (detection.risks.length) {
                    lines.push('## 兼容风险点');
                    for (const risk of detection.risks)
                        lines.push(`- ${risk}`);
                }
                if (detection.hits > 0 && (detection.confidence === '高' || detection.confidence === '中')) {
                    const variables = scriptsRaw ? migration.parseZodSchema(scriptsRaw) : [];
                    const rules = migration.extractMvuUpdateRules(worldbookEntries.map((entry) => entry.content ?? ''));
                    const draft = migration.assembleContractSkeleton({ cardId: `migrated-${Date.now()}`, variables, rules });
                    draftText.value = JSON.stringify(draft.contract, null, 2);
                    lines.push('');
                    lines.push(migration.renderMigrationReport(draft));
                }
                else {
                    lines.push(detection.hits === 0 ? '未命中 MVU 特征：请确认卡来源。' : '置信度「低」：可能不是 MVU 卡，请确认后重试。');
                }
                reportText.value = lines.join('\n');
            }
            catch (error) {
                reportText.value = `迁移失败：${error instanceof Error ? error.message : String(error)}`;
            }
            finally {
                busy.value = false;
            }
        };
        const importDraft = () => {
            try {
                const raw = JSON.parse(draftText.value);
                const result = dispatch({ action: 'editContract', contract: raw });
                reportText.value += result.ok ? '\n\n✅ 契约初稿已导入（可在「作者」页签继续编辑）' : `\n\n❌ 导入失败：${result.error}`;
            }
            catch (error) {
                reportText.value += `\n\n❌ JSON 解析失败：${error instanceof Error ? error.message : String(error)}`;
            }
        };
        return () => h('div', { class: 'nlk-section' }, [
            h('div', { class: 'nlk-hint' }, 'MVU 存量卡迁移脚手架（§24：检测 → 解析 ZOD → 提取规则 → 组装契约初稿 → 预览导入；难翻译构造显式标注，不静默丢弃）。'),
            h('div', { class: 'nlk-h3' }, '① 世界书条目（JSON 数组或 [initvar]/[mvu_update] 条目文本）'),
            h('textarea', { class: 'nlk-contract-input', rows: 6, value: worldbookText.value, onInput: (e) => { worldbookText.value = e.target.value; }, placeholder: '[{"uid":"1","name":"[InitVar]初始变量","enabled":true,"content":"..."}]' }),
            h('div', { class: 'nlk-h3' }, '② 角色卡 ZOD 脚本（registerMvuSchema / Schema = z.object(...)）'),
            h('textarea', { class: 'nlk-contract-input', rows: 6, value: scriptsText.value, onInput: (e) => { scriptsText.value = e.target.value; }, placeholder: 'import { registerMvuSchema } ...; export const Schema = z.object({...});' }),
            h('div', { class: 'nlk-row' }, [
                h('button', { class: 'nlk-btn', onClick: run, disabled: busy.value }, busy.value ? '迁移中…' : '③ 检测并生成迁移报告'),
                draftText.value ? h('button', { class: 'nlk-btn', onClick: importDraft }, '④ 导入契约初稿') : null,
            ]),
            reportText.value ? h('pre', { class: 'nlk-pre' }, reportText.value) : null,
            draftText.value ? h('div', { class: 'nlk-h3' }, '契约初稿（可编辑后导入）') : null,
            draftText.value ? h('textarea', { class: 'nlk-contract-input', rows: 12, value: draftText.value, onInput: (e) => { draftText.value = e.target.value; } }) : null,
        ]);
    },
});
/** @since M14 配置页签（§20.13：一键档位 / 自检 / 快照回滚 / 恢复出厂；防奶人核心四项） */
const ConfigView = defineComponent({
    name: 'NlConfigView',
    setup() {
        const store = useNlStore();
        const adapter = useAdapter();
        const config = () => {
            void store.configVersionCount;
            return adapter.adapter.config;
        };
        const report = () => adapter.adapter.lastConfigReport;
        const snapshot = () => adapter.adapter.configSnapshot;
        const applyTier = (tier) => {
            dispatch({ action: 'configApplyTier', tier });
        };
        const rollback = () => {
            const result = dispatch({ action: 'configRollback' });
            if (!result.ok)
                window.alert(result.error ?? '回滚失败');
        };
        const factoryReset = () => {
            if (window.confirm('恢复出厂设置会清空全部自定义配置（破坏性操作，已有自动备份）。确认继续？')) {
                dispatch({ action: 'configFactoryReset', confirmed: true });
            }
        };
        const TIER_LABEL = { minimal: '极简', standard: '标准', advanced: '进阶' };
        return () => {
            const current = config();
            const last = report();
            const snap = snapshot();
            return h('div', { class: 'nlk-section' }, [
                h('div', { class: 'nlk-h3' }, `玩家配置（当前：${TIER_LABEL[current.tier] ?? current.tier} / 存储 ${current.storage} / 检索 ${current.retrieval}）`),
                h('div', { class: 'nlk-row' }, [
                    ['minimal', 'standard', 'advanced'].map((tier) => h('button', {
                        key: tier,
                        class: current.tier === tier ? 'nlk-btn nlk-active' : 'nlk-btn',
                        onClick: () => applyTier(tier),
                    }, tier === 'minimal' ? '极简档（零配置直用）' : tier === 'standard' ? '标准档' : '进阶档（向量）')),
                ]),
                h('div', { class: 'nlk-row' }, [
                    h('button', { class: 'nlk-btn', onClick: rollback, disabled: !snap }, '一键回滚快照'),
                    h('button', { class: 'nlk-btn', onClick: factoryReset }, '恢复出厂设置'),
                ]),
                snap
                    ? h('div', { class: 'nlk-hint' }, `最近快照：${new Date(snap.takenAt).toLocaleString()}（原因：${snap.reason}）`)
                    : h('div', { class: 'nlk-hint' }, '无配置快照（破坏性操作前自动创建）'),
                last
                    ? h('div', null, [
                        last.ok ? null : h('div', { class: 'nlk-error' }, `配置失败：${last.error ?? ''}`),
                        last.degradations.length ? h('div', null, last.degradations.map((d) => h('div', { class: 'nlk-hint' }, `降级：${d}`))) : null,
                        last.warnings.length ? h('div', null, last.warnings.map((w) => h('div', { class: 'nlk-warn' }, `提示：${w}`))) : null,
                        h('div', { class: 'nlk-h3' }, '连通性自检'),
                        last.checks.map((check) => h('div', { class: 'nlk-log-row', key: check.id }, [
                            h('span', { class: check.status === 'ok' ? 'nlk-on' : check.status === 'warn' ? 'nlk-warn' : 'nlk-error' }, check.status === 'ok' ? '●' : check.status === 'warn' ? '◐' : '✕'),
                            h('span', null, check.name),
                            h('span', { class: 'nlk-hint' }, check.message),
                            check.fixAction ? h('span', { class: 'nlk-hint' }, `（修复：${check.fixAction}）`) : null,
                        ])),
                    ])
                    : h('div', { class: 'nlk-hint' }, '切换档位后显示探测降级与连通性自检结果。'),
                h('div', { class: 'nlk-hint' }, '资源上限保护：向量维度 ≤4096 / 记忆 ≤5000 条 / L3 预算 ≤4000 tokens / 注入 ≤10 条（防一键打爆）。'),
            ]);
        };
    },
});
/** 面板根组件（§6.1 双入口分流 + M13 记忆 + M15 剧情 + M16 检定 + M9 迁移 + M14 配置） */
const PanelRoot = defineComponent({
    name: 'NlPanelRoot',
    setup() {
        const store = useNlStore();
        const tab = (name, label) => h('button', {
            class: store.activeTab === name ? 'nlk-btn nlk-active' : 'nlk-btn',
            onClick: () => {
                store.activeTab = name;
                store.authorMode = name === 'author';
            },
        }, label);
        return () => h('div', { class: 'nlk-root' }, [
            h('div', { class: 'nlk-tabs' }, [
                tab('player', '玩家'),
                tab('author', '作者'),
                tab('memory', '记忆'),
                tab('plot', '剧情'),
                tab('dice', '检定'),
                tab('config', '配置'),
                tab('migration', '迁移'),
            ]),
            store.activeTab === 'author'
                ? h('div', null, [h(ContractEditor), h(PreviewView), h(DebugPanel)])
                : store.activeTab === 'memory'
                    ? h(MemoryView)
                    : store.activeTab === 'plot'
                        ? h(PlotView)
                        : store.activeTab === 'dice'
                            ? h(DiceView)
                            : store.activeTab === 'migration'
                                ? h(MigrationView)
                                : store.activeTab === 'config'
                                    ? h(ConfigView)
                                    : h(PlayerView),
        ]);
    },
});
const CSS = `
.nlk-root { font-size: 13px; color: var(--white70a, #ccc); line-height: 1.5; }
.nlk-section { margin-bottom: 8px; }
.nlk-statusbar { display: flex; gap: 10px; align-items: center; padding: 6px 8px; background: var(--black30a, rgba(0,0,0,.3)); border-radius: 6px; }
.nlk-on { color: var(--green, #6f6); font-weight: bold; }
.nlk-warn { color: var(--yellow, #fa3); }
.nlk-vars { margin: 6px 0; }
.nlk-var-row { display: flex; gap: 8px; padding: 2px 0; border-bottom: 1px dashed var(--white30a, rgba(255,255,255,.15)); }
.nlk-var-path { min-width: 160px; color: var(--white, #fff); }
.nlk-var-value { font-family: monospace; }
.nlk-pending { color: var(--yellow, #fa3); }
.nlk-row { display: flex; gap: 8px; margin: 6px 0; flex-wrap: wrap; }
.nlk-btn { padding: 3px 10px; border: 1px solid var(--white30a, rgba(255,255,255,.2)); background: var(--black50a, rgba(0,0,0,.4)); color: var(--white, #eee); border-radius: 4px; cursor: pointer; }
.nlk-btn:hover { background: var(--black70a, rgba(0,0,0,.6)); }
.nlk-btn-sm { padding: 1px 6px; font-size: 11px; }
.nlk-active { border-color: var(--accent, #4af); color: var(--accent, #4af); }
.nlk-error { color: var(--red, #f66); white-space: pre-wrap; }
.nlk-h3 { margin: 8px 0 4px; font-weight: bold; color: var(--white, #fff); }
.nlk-pre { background: var(--black30a, rgba(0,0,0,.3)); padding: 6px; border-radius: 4px; overflow: auto; max-height: 220px; font-family: monospace; font-size: 12px; white-space: pre-wrap; }
.nlk-contract-input { width: 100%; background: var(--black30a, rgba(0,0,0,.3)); color: var(--white, #eee); border: 1px solid var(--white30a, rgba(255,255,255,.2)); border-radius: 4px; font-family: monospace; font-size: 12px; padding: 6px; box-sizing: border-box; }
.nlk-log { max-height: 260px; overflow: auto; }
.nlk-log-row { display: flex; gap: 8px; align-items: center; padding: 2px 0; border-bottom: 1px solid var(--white10a, rgba(255,255,255,.08)); flex-wrap: wrap; }
.nlk-diff { color: var(--accent, #4af); font-family: monospace; }
.nlk-hint { color: var(--white50a, rgba(255,255,255,.5)); font-size: 12px; }
.nlk-tabs { display: flex; gap: 8px; align-items: center; margin-bottom: 6px; }
`;
/**
 * 挂载面板（§11.1：独立容器 + createApp 实例级隔离）。
 * 容器为自建 div（script_id 标记），不写入 ST 既有扩展共享的 DOM 节点。
 */
function mountPanel(deps) {
    const containerId = 'nlkaleido_panel_container';
    let container = document.getElementById(containerId);
    if (!container) {
        container = document.createElement('div');
        container.id = containerId;
        container.className = 'nlkaleido-panel';
        document.body.appendChild(container);
    }
    const styleId = 'nlkaleido_panel_style';
    if (!document.getElementById(styleId)) {
        const style = document.createElement('style');
        style.id = styleId;
        style.textContent = CSS;
        document.head.appendChild(style);
    }
    // §11.1 实例级隔离：不写 window.Vue、不调全局 app.component
    const app = createApp(PanelRoot);
    const pinia = createPinia();
    app.use(pinia);
    app.provide(INJECT_BRIDGE, shallowRef(deps.bridge));
    app.provide(INJECT_ADAPTER, shallowRef(deps.adapter));
    app.mount(container);
    // 订阅 nlkaleido:* 事件驱动刷新（§6.4 事件驱动不轮询）
    const store = useNlStore(pinia);
    const refresh = () => {
        const state = deps.adapter.adapter.state;
        if (!state)
            return;
        store.statData = state.stat_data;
        store.pending = state.meta.pending;
        store.changelog = state.changelog;
        store.lastTurnId = state.meta.lastTurnId;
        const contract = deps.adapter.adapter.contract;
        if (contract && !store.contractText) {
            store.contractText = json(contract);
        }
    };
    refresh();
    const eventSource = deps.adapter.stGlobals.getContext().eventSource;
    eventSource.on('nlkaleido:status_changed', refresh);
    eventSource.on('nlkaleido:pending_updated', refresh);
    eventSource.on('nlkaleido:contract_changed', refresh);
    // §20.10 记忆事件驱动刷新（不轮询）
    eventSource.on('nlkaleido:memory_changed', () => { store.memoryVersion += 1; });
    // §22.6 剧情事件驱动刷新（不轮询）
    eventSource.on('nlkaleido:plot_changed', () => { store.plotVersion += 1; });
    // §23.7 检定事件驱动刷新（不轮询）
    eventSource.on('nlkaleido:dice_rolled', () => { store.diceVersion += 1; });
    // §20.13.7 配置事件驱动刷新（不轮询）
    eventSource.on('nlkaleido:config_changed', () => { store.configVersionCount += 1; });
}

/**
 * NLKaleido 扩展入口（§11/§12 时序 A：manifest 的 js 指向本文件打包产物）。
 *
 * 装配顺序：StGlobals（SillyTavern.getContext() 稳定 API，§Writing-Extensions 文档）→
 * detectVersion（版本嗅探，F1 退路）→ KaleidoStAdapter.init（U8 GENERATION_ENDED 锚点）→
 * 契约/状态加载（chatMetadata）→ KaleidoStateBridge（nlkaleido:* 事件）→ 面板挂载（§11.1）。
 *
 * 触发方式：APP_READY 事件（文档保证：加载后新挂的监听会被立即 auto-fire，覆盖「页面加载」
 * 与「运行中启用扩展」两种路径）；start() 幂等（重复触发只刷新引用）。
 * 零相对导入（文档标注相对导入不可靠）：全部经 globalThis.SillyTavern.getContext()。
 *
 * 命名空间隔离（§11.1）：只暴露 window.NLKaleido，不写 window.Vue、不调全局 app.component。
 */
let bridge = null;
let adapter = null;
let started = false;
/** 稳定 API 入口（每次取新鲜引用：chatMetadata 在切聊天后引用会变，文档警告不可长持） */
function getStContext() {
    const globalObject = globalThis;
    if (!globalObject.SillyTavern || typeof globalObject.SillyTavern.getContext !== 'function') {
        throw new Error('[NLKaleido] SillyTavern 全局对象缺失（非酒馆环境？）');
    }
    return globalObject.SillyTavern.getContext();
}
/** 从真实 ST 全局装配 StGlobals（F11/F14/F12 + U2/U6 探明结论；引用全部即取即用） */
function createStGlobals() {
    const fresh = () => getStContext();
    return {
        getContext: () => fresh(),
        getChat: () => fresh().chat,
        getChatMetadata: () => fresh().chatMetadata,
        setChatMetadata: (meta) => {
            // U2 探明：updateChatMetadata 只改内存；直接复用其赋值语义（新鲜引用）
            const chatMetadata = fresh().chatMetadata;
            Object.assign(chatMetadata, meta);
        },
        saveChat: () => {
            const context = fresh();
            if (typeof context.saveChat === 'function') {
                void context.saveChat(); // getContext().saveChat = saveChatConditional（st-context.js:151）
            }
        },
        getExtensionSettings: () => (fresh().extensionSettings ?? {}),
        saveSettings: () => {
            const context = fresh();
            if (typeof context.saveSettingsDebounced === 'function') {
                context.saveSettingsDebounced(); // U6：debounce → POST /api/settings/save
            }
        },
    };
}
/** 启动（幂等：重复调用只刷新引用，§12 时序 A） */
function start() {
    if (started)
        return;
    started = true;
    const globals = createStGlobals();
    adapter = new KaleidoStAdapter(globals, { l0Template: L0_TEMPLATE });
    const compat = adapter.init();
    bridge = new KaleidoStateBridge(globals, adapter);
    bridge.notifyCompat(compat);
    // 加载契约 + 状态（chatMetadata；bootstrap 兜底，§4.4 恢复；§16.1 run/global 层水合）
    const loaded = adapter.loadState();
    const contract = loadContract(loaded);
    adapter.adapter.contract = contract;
    adapter.adapter.state = loaded
        ? adapter.hydratePersistLayers(reconcileState(contract, loaded), contract)
        : bootstrapState(contract);
    // M10 生命周期事件（§16.3：nlkaleido:run_changed / nlkaleido:achievement_unlocked）
    adapter.onRunChanged = (runId, message) => bridge.notifyRunChanged(runId, message);
    adapter.onAchievementUnlocked = (achievements) => bridge.notifyAchievementUnlocked(achievements);
    // M13 记忆生命周期（§20.10：nlkaleido:memory_changed；默认关闭零路径）
    adapter.onMemoryChanged = () => bridge.notifyMemoryChanged();
    // M15 剧情生命周期（§22.6：nlkaleido:plot_changed；默认关闭零路径）
    adapter.onPlotChanged = () => bridge.notifyPlotChanged();
    // M16 检定生命周期（§23.7：nlkaleido:dice_rolled；默认关闭零路径）
    adapter.onDiceRolled = (result) => bridge.notifyDiceRolled(result);
    // M14 配置生命周期（§20.13.7：nlkaleido:config_changed）
    adapter.onConfigChanged = () => bridge.notifyConfigChanged();
    // M14 配置加载（§20.13.6：configVersion 迁移 + 恢复默认；极简档零配置直用）
    adapter.loadConfig();
    // M13 记忆水合（§20.5：存量记忆/表加载 + 契约表列结构水合；未启用只加载不执行）
    if (contract.memory?.enabled) {
        adapter.loadMemoryStore();
        adapter.hydrateMemoryTables(contract);
    }
    // M15 剧情水合（§22.5：存量事件链/风声加载；未启用不加载）
    if (contract.plot?.enabled) {
        adapter.loadPlotState();
    }
    // M16 检定水合（§23.4：存量预设库/历史加载；未启用不加载）
    if (contract.dice?.enabled) {
        adapter.loadDiceState();
    }
    // 面板挂载（§11.1 独立容器 + createApp 实例级隔离；失败静默降级不炸主链，§0.5）
    try {
        mountPanel({ bridge, adapter });
    }
    catch (error) {
        console.error('[NLKaleido] 面板挂载失败（核心链路不受影响）：', error);
    }
    // window 命名空间（§11.1）
    window.NLKaleido = {
        version: '0.1.0',
        adapter,
        bridge,
        getState: () => adapter.adapter.state,
        getContract: () => adapter.adapter.contract,
        dispatch: (payload) => bridge.dispatch(payload),
    };
}
/** 契约加载：chatMetadata.variables['nlkaleido'].contract 优先；缺省 → 空契约占位 */
function loadContract(loaded) {
    const stored = loaded?.contract;
    if (stored) {
        try {
            const parsed = normalizeContract(parseContract(stored));
            const errors = validateContract(parsed);
            if (!errors.length)
                return parsed;
            console.warn('[NLKaleido] 存量契约校验失败（回退空契约）：', errors);
        }
        catch (error) {
            console.warn('[NLKaleido] 存量契约解析失败（回退空契约）：', error);
        }
    }
    return emptyContract();
}
function emptyContract() {
    return {
        version: 1,
        id: 'unconfigured',
        schema: { type: 'object', loose: true },
        updateRules: {},
        displayRules: [],
        guardrails: {
            maxStatusTokens: 1500, maxOpsPerTurn: 20, minConfidence: 'medium',
            maxRetries: 1, maxSteps: 0, maxTokensPerStep: 2048, maxDependencyDepth: 3,
        },
        invariants: [],
    };
}
/** 存量状态调和（§4.4：contractVersion 变化 → 用新契约调和旧数据） */
function reconcileState(contract, loaded) {
    if (loaded.contractVersion === contract.version)
        return loaded;
    const stat_data = reconcileData(contract, loaded.stat_data);
    return { ...loaded, contractVersion: contract.version, stat_data };
}
function bootstrapState(contract) {
    return {
        contractVersion: contract.version,
        stat_data: reconcileData(contract, {}),
        revision: { seq: 0, hash: '', updatedAt: Date.now() },
        meta: {
            lastTurnId: 0, runId: 1, confidence: {}, pending: [],
            lastContractVersion: contract.version, lastUpdated: {},
        },
        changelog: [],
        checkpoints: [],
    };
}
/** L0 任务模板（变量 Agent 系统提示，§5.1：全社区统一、字节恒定；作者可经注册表覆盖） */
const L0_TEMPLATE = [
    '你是变量状态维护 Agent。根据最近剧情与用户输入，维护契约声明的变量状态。',
    '规则：',
    '1. 只修改本轮到期（due）或与你判断相关且你有权写入的字段；',
    '2. 输出严格 JSON：{"analysis":"...","json_patch":[{"op":"replace|delta|add|remove|move","path":"...","value":...,"confidence":"high|medium|low","rationale":"..."}]}；',
    '3. delta 只用于数值字段；replace 必须类型一致；不确定的更新给 low 置信度或省略；',
    '4. <STABLE_BATCH> 引用的静态字段值在契约层维护：禁止凭对话上下文推断、改写或猜测；',
    '5. 禁止把 <STABLE_BATCH> 标签复制到自己输出里；禁止给标签内任一字段「补一个新值」；',
    '6. 只对真正改变的字段输出 op；稳定（stable）与冻结（frozen）字段保持沉默；',
    '7. 不输出 JSON 之外的任何内容。',
].join('\n');
// ============================================================
// 触发（APP_READY auto-fire 覆盖「页面加载」与「运行中启用」两种路径）
// ============================================================
try {
    const context = getStContext();
    context.eventSource
        .on(context.eventTypes.APP_READY, () => start());
}
catch (error) {
    console.error('[NLKaleido] 初始化失败（SillyTavern 全局不可用）：', error);
}

export { hash64 as h, start as s };
