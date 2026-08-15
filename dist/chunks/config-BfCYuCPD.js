import { h as hash64 } from '../index.js';

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
const TIER_NAMES = Object.freeze({
    minimal: '极简模式（零配置）',
    standard: '标准模式',
    advanced: '进阶模式',
});
const CONFIG_VERSION = 3;
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
        primaryAi: {
            mode: 'sillytavern', baseUrl: '', apiKey: '', model: '', timeoutMs: 60_000,
        },
        embeddingApi: {
            enabled: false, baseUrl: '', apiKey: '', model: '', dimensions: 1024,
        },
        agent: {
            maxRequestsPerTurn: 1, minRequestIntervalMs: 1200,
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
            degradations.push(probe.webllm === 'timeout' ? '本地向量组件超时 → 暂用关键词检索' : '尚未配置向量模型 → 暂用关键词检索（进阶设置仍然保留）');
        }
    }
    else {
        degradations.push('标准/极简档：检索固定 BM25（纯 JS 零依赖）');
    }
    if (tier === 'advanced' && retrieval !== 'vector') {
        warnings.push('进阶设置已开启；填写可选向量模型后可启用语义检索，目前使用关键词检索');
    }
    if (probe.bridges.length) {
        warnings.push(`检测到可选桥接：${probe.bridges.join('、')}（需高级配置）`);
    }
    if (!probe.indexedDB && !probe.privacyMode) {
        // 无高级后端 → 纯 JS 默认路径，功能不缺失只降级高级特性
        degradations.push('无任何高级后端 → 纯 JS 默认路径（功能不缺失，仅降级高级特性）');
    }
    const config = tierDefaults(tier, storage);
    config.retrieval = retrieval;
    return { tier, config, degradations, warnings };
}
/** 配置后自动自检（存储读写 / 检索 / 注入各跑一次） */
function runSelfCheck(config, env) {
    const items = [];
    items.push({
        id: 'storage',
        name: '存储读写',
        status: env.storageWriteOk ? 'ok' : 'fail',
        message: env.storageWriteOk
            ? `存储正常（${config.storage}）`
            : `存储写入失败（${config.storage}）`,
        fixAction: env.storageWriteOk ? undefined : 'reset-storage',
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
        status: env.injectionOk ? 'ok' : 'fail',
        message: env.injectionOk ? '注入正常（记忆只进 L3，前缀不受影响）' : '注入失败',
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
/** v1 → v2：补充双模型端点；旧用户继续复用酒馆 API，不要求重新填写。 */
const migrateConfigV1ToV2 = (old) => ({
    ...old,
    primaryAi: {
        mode: 'sillytavern', baseUrl: '', apiKey: '', model: '', timeoutMs: 60_000,
    },
    embeddingApi: {
        enabled: false, baseUrl: '', apiKey: '', model: '', dimensions: 1024,
    },
});
/** v2 → v3：补充玩家可控的 Agent 请求预算；默认保持单次模式。 */
const migrateConfigV2ToV3 = (old) => ({
    ...old,
    agent: {
        maxRequestsPerTurn: 1,
        minRequestIntervalMs: 1200,
    },
});
/** 配置版本迁移：configVersion 落后 → 逐版本链式迁移（对齐 contractVersion 模式） */
function migrateConfig(stored, migrations = [migrateConfigV1ToV2, migrateConfigV2ToV3], targetVersion = CONFIG_VERSION) {
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
    const defaults = tierDefaults(tier);
    return {
        config: {
            ...defaults,
            ...record,
            memory: { ...defaults.memory, ...(record.memory ?? {}) },
            resources: { ...defaults.resources, ...(record.resources ?? {}) },
            primaryAi: { ...defaults.primaryAi, ...(record.primaryAi ?? {}) },
            embeddingApi: { ...defaults.embeddingApi, ...(record.embeddingApi ?? {}) },
            agent: { ...defaults.agent, ...(record.agent ?? {}) },
        },
        migrated,
        errors,
    };
}
/** 配置快照（破坏性操作前自动调用） */
function takeSnapshot(config, reason, now = Date.now()) {
    return { id: hash64(`${now}:${reason}`), takenAt: now, reason, config: JSON.parse(JSON.stringify(config)) };
}
/** 破坏性操作分类（需要二次确认 + 自动备份） */
function isDestructiveAction(action) {
    return /^(clear-memory|switch-storage|override-config|factory-reset|import-config)$/.test(action);
}
/** 资源上限保护（§20.13.1：防一键打爆） */
const RESOURCE_LIMITS = Object.freeze({
    maxVectorDims: 4096,
    maxAtoms: 5000,
    maxMemoryTokens: 4000,
    maxTopK: 10,
    maxRequestsPerTurn: 8,
    maxRequestIntervalMs: 10_000,
});
/** 钳制配置到资源上限 */
function clampConfig(config) {
    const clamped = [];
    if (config.resources.maxVectorDims > RESOURCE_LIMITS.maxVectorDims) {
        config.resources.maxVectorDims = RESOURCE_LIMITS.maxVectorDims;
        clamped.push(`向量维度超上限 → ${RESOURCE_LIMITS.maxVectorDims}`);
    }
    if (config.memory.maxAtoms > RESOURCE_LIMITS.maxAtoms) {
        config.memory.maxAtoms = RESOURCE_LIMITS.maxAtoms;
        clamped.push(`记忆条数超上限 → ${RESOURCE_LIMITS.maxAtoms}`);
    }
    if (config.resources.maxMemoryTokens > RESOURCE_LIMITS.maxMemoryTokens) {
        config.resources.maxMemoryTokens = RESOURCE_LIMITS.maxMemoryTokens;
        clamped.push(`L3 记忆预算超上限 → ${RESOURCE_LIMITS.maxMemoryTokens}`);
    }
    if (config.memory.injectTopK > RESOURCE_LIMITS.maxTopK) {
        config.memory.injectTopK = RESOURCE_LIMITS.maxTopK;
        clamped.push(`注入条数超上限 → ${RESOURCE_LIMITS.maxTopK}`);
    }
    const requests = Math.max(1, Math.min(RESOURCE_LIMITS.maxRequestsPerTurn, Math.floor(config.agent.maxRequestsPerTurn || 1)));
    if (requests !== config.agent.maxRequestsPerTurn) {
        config.agent.maxRequestsPerTurn = requests;
        clamped.push(`每轮 AI 请求数已限制为 ${requests}`);
    }
    const interval = Math.max(0, Math.min(RESOURCE_LIMITS.maxRequestIntervalMs, Math.floor(config.agent.minRequestIntervalMs || 0)));
    if (interval !== config.agent.minRequestIntervalMs) {
        config.agent.minRequestIntervalMs = interval;
        clamped.push(`请求间隔已限制为 ${interval}ms`);
    }
    return { config, clamped };
}
/** dry-run：候选配置在沙箱验证（不写盘）；失败 → 返回回滚建议 */
function dryRunConfig(candidate, env) {
    const errors = [];
    const { clamped } = clampConfig(candidate);
    if (clamped.length)
        errors.push(...clamped.map((item) => `资源钳制：${item}`));
    try {
        if (!env.storageWrite())
            errors.push('存储写测试失败（配置未生效，保留原配置）');
        if (!env.retrieval())
            errors.push('检索测试失败（自动降级 BM25）');
    }
    catch (error) {
        errors.push(`dry-run 抛错：${error instanceof Error ? error.message : String(error)}`);
    }
    return { ok: errors.length === 0 || errors.every((e) => e.startsWith('资源钳制')), errors };
}

export { CONFIG_VERSION, RESOURCE_LIMITS, TIER_NAMES, applyOverrides, clampConfig, decideTier, dryRunConfig, isDestructiveAction, migrateConfig, migrateConfigV1ToV2, migrateConfigV2ToV3, probeEnvironment, runSelfCheck, takeSnapshot, tierDefaults };
