import { h as hash64, e as estimateTokens } from '../index.js';

/**
 * M13 记忆系统核心（§20，作者可选、默认关闭；纯 JS 零依赖）。
 *
 * 能力面（详见交接稿 §20.1-§20.9）：
 * - 记忆原子（五类型 + TTL + 三种衰减 + 访问强化 + 遗忘状态机）；
 * - 反思写入（合并进变量请求，不新增请求）；BM25 零向量检索（bigram 分词 + k1=1.5/b=0.75）；
 * - 注入只进 L3「记忆段」（system 前缀注入破坏前缀缓存 → 废弃）；
 * - 近/远两层记忆（近 = changelog 本地 append；远 = 达阈值批量归档 + 按楼层快照）；
 * - 结构化记忆表（列定义 + 行记录 + 楼层作用域）、实体关系图、检索注册点（M13f）。
 *
 * 本模块只做纯逻辑（可单测）；IO（StorageProvider 持久化 / Scheduler 调度 / L3 注入挂点 /
 * Agent 工具注册）由 adapter 与 §18 扩展架构接线。默认关闭时本模块代码不被执行（§21.6 零开销）。
 */
// ============================================================
// §20.2 常量：五类型基础 TTL 与衰减曲线
// ============================================================
/** 基础 TTL（天），按类型（情景 7 / 计划 2 / 事实 180 / 关系 90 / 偏好 60 / 未知 30） */
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
/** 远记忆归档：未归档 changelog 达阈值才批量归档（§20.5 归档语义） */
const ARCHIVE_THRESHOLD = 50;
/** 归档批大小：每批选最早 3 条压缩（整批成功才删原日志，失败保留、下轮重试） */
const ARCHIVE_BATCH_SIZE = 3;
/** RRF 融合常数（多路召回融合） */
const RRF_K = 60;
/** BM25 参数（bigram 分词 + k1=1.5/b=0.75） */
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
// §20.4 分词与 BM25（纯 JS：CJK bigram + 拉丁整词）
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
 * L3「记忆段」注入文本（`<记忆回溯>` 包裹；只进 L3 尾部，绝不碰 L0-L2 前缀）。
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
 * 失败（summaryText 空）→ 原批保留、下轮重试（§20.5 整批成功才删语义）。
 */
function commitArchive(entries, batch, summaryText) {
    if (!summaryText)
        return { entries, summary: null }; // 失败：整批保留
    const batchIds = new Set(batch.map((entry) => entry.id ?? `${entry.turnId}:${entry.path}:${String(entry.source ?? '')}`));
    const kept = entries.filter((entry) => !batchIds.has(entry.id ?? `${entry.turnId}:${entry.path}:${String(entry.source ?? '')}`));
    return { entries: kept, summary: summaryText };
}
/** 按楼层快照（楼层回退不被未来污染；§20.5） */
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
// §20.7 结构化记忆表（列定义 + 行记录；档案/物品/世界设定）
// ============================================================
/**
 * 列前缀语义：
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

export { ARCHIVE_BATCH_SIZE, ARCHIVE_THRESHOLD, ATOM_TYPES, BASE_TTL_DAYS, BM25_B, BM25_K1, Bm25Index, DEFAULT_DECAY, FORGET_WINDOWS_MS, MAX_ENTITIES, MEMORY_CONFIDENCE_GATE, REFLECTION_EVERY_N_TURNS, REINFORCE_EMA, REINFORCE_JACCARD_THRESHOLD, REINFORCE_TTL_CAP, REINFORCE_TTL_STEP, RRF_K, SEARCH_MIN_IMPORTANCE_DECAY, advanceAtomStatus, bm25Retriever, buildEntityGraph, buildReflectionSchema, classifyAtom, collectMemoryCandidates, columnSemantics, commitArchive, computeDecayScore, computeTtl, createMemoryTable, hybridSearchMemory, isPurgeDue, maintainMemory, makeAtom, memorySearchScore, queryTable, reinforceAtom, renderMemorySegment, rrfFusion, searchMemory, selectArchiveBatch, snapshotByFloor, tokenJaccard, tokenize, upsertTableRow, writeMemoryCandidates };
