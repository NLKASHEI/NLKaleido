import { copyJson, parseContract, type Contract, type FieldRule, type FieldType } from '../core/contract.js';
import { getValue, type Snapshot } from '../core/state.js';

export const STORAGE_CONTRACT = 'nlkaleido_ui_contract_preview_v1';
export const STORAGE_STATE = 'nlkaleido_ui_state_preview_v1';
export const STORAGE_HISTORY = 'nlkaleido_ui_history_preview_v1';

export const TYPE_LABELS: Record<FieldType, string> = {
  string: '文本', number: '数值', boolean: '布尔', list: '数组', object: '对象', kv: '键值',
};
export const UPDATE_LABELS: Record<string, string> = {
  afterReply: '对话结束后', manual: '仅手动更新', immediate: '事件触发', fixed: '固定状态',
};

export const demoContract: Contract = parseContract({
  version: 1, id: '星海旅人',
  updateRules: {
    '角色.好感度': {path:'角色.好感度',label:'角色好感度',type:'number',default:50,min:0,max:100,description:'玩家与角色之间的好感程度',changeRule:'只有与角色直接相关、能够改变关系的互动才能缓慢变化，单次不超过 5。',updateMode:'afterReply',display:true,dependencies:[]},
    '背包.物资': {path:'背包.物资',label:'背包物资',type:'list',default:[],description:'玩家持有的重要物品',changeRule:'确实拾取物品后加入；消耗或丢弃后移除，不得无依据新增。',updateMode:'afterReply',display:true,dependencies:[]},
    '世界.阶段': {path:'世界.阶段',label:'世界阶段',type:'string',default:'序章',description:'当前所处的叙事章节',changeRule:'重大章节条件完成后才推进；普通对话保持不变。',updateMode:'afterReply',display:true,dependencies:[]},
    '剧情.关键标记': {path:'剧情.关键标记',label:'剧情标记',type:'boolean',default:false,description:'重要剧情节点是否被触发',changeRule:'仅在关键事件明确发生时写为 true。',updateMode:'manual',display:false,dependencies:['世界.阶段']},
    '角色.信任等级': {path:'角色.信任等级',label:'信任等级',type:'number',default:0,min:0,max:5,description:'角色对玩家的长期信任',changeRule:'仅有值得信任的长期行为可提升。',updateMode:'afterReply',display:true,dependencies:['角色.好感度']},
    '记忆.已知线索': {path:'记忆.已知线索',label:'已知线索',type:'object',default:{},description:'已公开的重要剧情线索',changeRule:'有直接证据时记录或修正。',updateMode:'afterReply',display:true,dependencies:['世界.阶段']},
  },
});

export function defaultFor(type: FieldType): unknown {
  switch(type) {
    case 'number': return 0;
    case 'string': return '';
    case 'boolean': return false;
    case 'list': return [];
    case 'object': case 'kv': return {};
  }
}

export function newFieldPath(contract: Contract): string {
  for(let i=1;i<=300;i++){
    const candidate = i===1 ? '新变量' : '新变量' + i;
    if(!Object.hasOwn(contract.updateRules,candidate)) return candidate;
  }
  throw new Error('字段数量已达上限');
}

export function addField(contract: Contract): Contract {
  const path = newFieldPath(contract);
  return parseContract({...contract, updateRules:{...contract.updateRules,[path]:{
    path, label:'新变量', type:'number', default:0, min:0, max:100,
    display:true, updateMode:'afterReply', changeRule:'请在这里写明何时、为何及如何更新。', dependencies:[],
  }}});
}

export function updateField(contract: Contract, oldPath: string, patch: Partial<FieldRule>): Contract {
  const original = contract.updateRules[oldPath];
  if(!original) throw new Error('目标变量已不存在');
  const candidate: FieldRule = {...original, ...patch};
  const nextPath = candidate.path;
  if(nextPath !== oldPath && Object.hasOwn(contract.updateRules,nextPath)) throw new Error('变量名称已存在');
  const updated: Contract['updateRules'] = Object.create(null);
  for(const [key,rule] of Object.entries(contract.updateRules)){
    if(key===oldPath){ updated[nextPath] = candidate; }
    else {updated[key]={...rule,dependencies:rule.dependencies?.map(d=>d===oldPath?nextPath:d)};}
  }
  // A field cannot depend on itself after renaming or editing.
  return parseContract({...contract, updateRules: updated});
}

export function removeField(contract: Contract, path: string): Contract {
  const updated: Contract['updateRules'] = Object.create(null);
  for(const [key,rule] of Object.entries(contract.updateRules)){
    if(key===path) continue;
    updated[key] = {...rule, dependencies:rule.dependencies?.filter(dep=>dep!==path)};
  }
  return parseContract({...contract, updateRules:updated});
}

export type Proposal = {
  path: string; before: unknown; after: unknown; mode: 'change'|'unchanged';
  reason: string; approved: boolean;
};
export type AuditEntry = {
  id: string; at: string; source: '演示模拟'|'手动回滚';
  before: Record<string,unknown>; after: Record<string,unknown>;
  changed: string[]; reverted?: boolean;
};

/** Explicitly deterministic local samples, NEVER claim these are real LLM responses. */
export function demoProposals(contract: Contract, snapshot: Snapshot): Proposal[] {
  const choices = Object.values(contract.updateRules).slice(0, 6);
  return choices.slice(0,3).map((rule,i) => {
    const before = getValue(contract,snapshot,rule.path);
    let after = copyJson(before);
    let reason = '没有明确证据，建议维持原值。此建议仅用于演示审阅流程。';
    if(i===0 && rule.type==='number' && typeof before==='number' && before + 3 <= (rule.max??Infinity)){
      after=before+3;
      reason='演示：假设发生了积极互动，建议小幅增加。真实更新须由模型根据规则给出依据。';
    }
    if(rule.type==='list' && Array.isArray(before)){
      after=[...before,'生锈的钥匙'];
      reason='演示：假设玩家确实拾取了钥匙。实际提交前应核对原始对话。';
    }
    const mode = JSON.stringify(before)===JSON.stringify(after)?'unchanged':'change';
    return {path:rule.path,before,after,mode,reason,approved:mode==='change'};
  });
}

export function acceptedUpdates(proposals: Proposal[]): Record<string, unknown> {
  const updates: Record<string,unknown> = Object.create(null);
  for(const proposal of proposals){
    if(proposal.approved && proposal.mode==='change') updates[proposal.path]=copyJson(proposal.after);
  }
  return updates;
}
