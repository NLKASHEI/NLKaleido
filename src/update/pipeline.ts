import { assertRuleValue, copyJson, parseContract, type Contract } from '../core/contract.js';
import { applyValues, getValue, readSnapshot, type Snapshot } from '../core/state.js';
import { BM25FIndex, type EvidenceDocument, type EvidenceHit } from './bm25f.js';
import { buildVariableUpdatePlan, type ScheduleInput, type ScheduledGroup } from './scheduler.js';
import { parseProposalText } from './prompt.js';

export type FieldDecision = {
  path: string;
  action: 'set'|'unchanged';
  value?: unknown;
  reason: string;
  evidenceIds: string[];
};
export type UpdateObservation = {
  scope: string;
  turns: number[];
  fields: {path:string; type:string; value:unknown; description:string; changeRule:string; dependencies:Record<string,unknown>}[];
  evidence: EvidenceDocument[];
};
export type PreparedGroup = { group:ScheduledGroup; observation:UpdateObservation };
export type UpdateCommit = {
  /** MUST atomically verify expected, persist the changed snapshot, and advance all watermarks.
   * The host MUST make repeated (scope,key) calls idempotent across reload/crash. */
  scope:string;
  key:string;
  expected:Record<string,unknown>;
  updates:Record<string,unknown>;
  advance:Record<string,number>;
  decisions:FieldDecision[];
};
export type UpdateCycleInput = ScheduleInput & {
  scope:string;
  snapshot:Snapshot;
  documents:readonly EvidenceDocument[];
  /** Production adapter must implement one durable transaction for all three. */
  atomicCommit: (commit:UpdateCommit)=>Promise<void>;
  /** Model adapter only PROPOSES; it cannot touch mutable state. */
  /** Optional feedback is a compact validation error for one correction retry. */
  propose: (observation:UpdateObservation,feedback?:string)=>Promise<unknown>;
  /** Default 1. Never exceed 2 correction attempts. */
  maxRepairAttempts?:number;
};
export type UpdateCycleResult = {
  planned:number;
  committed:number;
  processed:string[];
  errors:{group:string;reason:string}[];
  advanced:Record<string,number>;
};

function object(value:unknown):value is Record<string,unknown>{
  return typeof value==='object'&&value!==null&&!Array.isArray(value);
}
function excerpt(fields:EvidenceDocument['fields']):EvidenceDocument['fields']{
  return {
    title:fields.title?.slice(0,160),
    tags:fields.tags?.slice(0,200),
    summary:fields.summary?.slice(0,600),
    body:fields.body?.slice(0,1600),
  };
}
function normalizeDocs(scope:string,documents:readonly EvidenceDocument[]):EvidenceDocument[]{
  if(documents.length>5000)throw new Error('证据过多，拒绝超预算检索');
  const ids=new Set<string>();
  return documents.map(document=>{
    if(document.scope!==scope||ids.has(document.id)||!document.id)
      throw new Error('证据作用域不一致或 ID 重复');
    ids.add(document.id);
    return document;
  });
}

/**
 * Build an auditable observation for each independently scheduled group.
 * Mandatory turn evidence is not dependent on sparse scores. Matching archive
 * evidence is optional and BM25F-ranked. No "search miss => do not update".
 */
export function prepareVariableObservation(
  contract:Contract,
  snapshot:Snapshot,
  group:ScheduledGroup,
  documents:readonly EvidenceDocument[],
  index:BM25FIndex,
):UpdateObservation{
  const rules=parseContract(contract).updateRules;
  if(!group.paths.length||!group.turns.length)throw new Error('空更新组');
  const requested=group.paths.map(path=>{
    const rule=rules[path];
    if(!rule)throw new Error('调度字段不存在: '+path);
    const dependencies:Record<string,unknown>=Object.create(null);
    for(const dep of rule.dependencies??[]){
      dependencies[dep]=getValue(contract,snapshot,dep);
    }
    return {path,type:rule.type,value:getValue(contract,snapshot,path),
      description:rule.description??'',changeRule:rule.changeRule??'',dependencies};
  });
  const upto=group.advanceTo;
  const relevant=documents.filter(doc=>doc.turn<=upto);
  const mandatory=relevant.filter(doc=>group.turns.includes(doc.turn)).sort((a,b)=>a.turn-b.turn||a.id.localeCompare(b.id));
  if(mandatory.length>24)throw new Error('待更新轮次证据超过 24 条，必须拆分批次');
  if(!mandatory.length)throw new Error('待更新轮次无可验证的原始对话证据');
  const candidateIds=new Set(mandatory.map(doc=>doc.id));
  const contextStart=Math.max(0,upto-group.contextDepth+1);
  const recent=relevant.filter(doc=>doc.turn>=contextStart).sort((a,b)=>b.turn-a.turn).slice(0,6);
  const query=requested.map(f=>f.path+' '+f.description+' '+f.changeRule).join(' ').slice(0,2000);
  const hits=index.search(query,8,candidateIds).filter(hit=>hit.turn<=upto);
  const byId=new Map(relevant.map(doc=>[doc.id,doc]));
  const assembled=[...mandatory];
  for(const doc of recent){
    if(assembled.length>=30)break;
    if(!candidateIds.has(doc.id)){assembled.push(doc);candidateIds.add(doc.id);}
  }
  for(const hit of hits){
    if(assembled.length>=36)break;
    const doc=byId.get(hit.id);
    if(doc&&!candidateIds.has(doc.id)){assembled.push(doc);candidateIds.add(doc.id);}
  }
  return {
    scope:index.scope,
    turns:[...group.turns],
    fields:requested,
    evidence:assembled.map(doc=>({id:doc.id,scope:doc.scope,turn:doc.turn,fields:excerpt(doc.fields)})),
  };
}

/** Strict semantic envelope: every due field requires set or explicit unchanged. */
export function validateVariableDecisions(
  raw:unknown,
  observation:UpdateObservation,
  contract:Contract,
  snapshot:Snapshot,
):{decisions:FieldDecision[];updates:Record<string,unknown>;expected:Record<string,unknown>}{
  const rules=parseContract(contract).updateRules;
  if(!object(raw)||!Array.isArray(raw.decisions)||raw.decisions.length!==observation.fields.length)
    throw new Error('模型必须为每个待更新字段提供一条决定');
  const expectedPaths=new Set(observation.fields.map(f=>f.path));
  const evidenceById=new Map(observation.evidence.map(e=>[e.id,e]));
  const decisions:FieldDecision[]=[];
  const updates:Record<string,unknown>=Object.create(null);
  const expected:Record<string,unknown>=Object.create(null);
  const seen=new Set<string>();
  for(const rawDecision of raw.decisions){
    if(!object(rawDecision)||typeof rawDecision.path!=='string'||
       !expectedPaths.has(rawDecision.path)||seen.has(rawDecision.path))
      throw new Error('模型返回未授权字段或重复字段');
    seen.add(rawDecision.path);
    const rule=rules[rawDecision.path];
    if(!rule)throw new Error('字段未声明');
    const action=rawDecision.action;
    if(action!=='set'&&action!=='unchanged')throw new Error('字段缺少明确的 set / unchanged 动作');
    if(typeof rawDecision.reason!=='string'||rawDecision.reason.trim().length<4||rawDecision.reason.length>1500)
      throw new Error('每项决定必须包含简洁具体的更新理由');
    const ids=rawDecision.evidenceIds;
    if(!Array.isArray(ids)||ids.length>12||ids.some(v=>typeof v!=='string'))
      throw new Error('证据 ID 列表不合法');
    for(const id of ids)if(!evidenceById.has(id))throw new Error('模型引用了观察范围以外的证据');
    const prior=getValue(contract,snapshot,rule.path);
    expected[rule.path]=prior;
    for(const dependency of rule.dependencies??[])expected[dependency]=getValue(contract,snapshot,dependency);
    if(action==='set'){
      if(!Object.hasOwn(rawDecision,'value'))throw new Error('set 操作缺少值');
      assertRuleValue(rule,rawDecision.value);
      if(rule.type==='number' && rule.maxDelta!==undefined &&
         typeof prior==='number' && typeof rawDecision.value==='number' &&
         Math.abs(rawDecision.value-prior)>rule.maxDelta)
        throw new Error('单次变量变化超过作者设定的上限: '+rule.path);
      if(JSON.stringify(rawDecision.value)===JSON.stringify(prior))throw new Error('值未变化，应显式返回 unchanged');
      if(!ids.some(id=>observation.turns.includes(evidenceById.get(id)?.turn??-1)))
        throw new Error('更新必须引用至少一条本批次对话证据');
      updates[rule.path]=copyJson(rawDecision.value);
    }else if(Object.hasOwn(rawDecision,'value')){
      throw new Error('unchanged 不应提供新值');
    }
    decisions.push({path:rule.path,action,reason:rawDecision.reason.trim(),
      ...(action==='set'?{value:copyJson(rawDecision.value)}:{}),
      evidenceIds:[...ids]});
  }
  if(seen.size!==expectedPaths.size)throw new Error('模型遗漏待更新字段');
  applyValues(contract,snapshot,updates);
  return {decisions,updates,expected};
}

/**
 * Optional orchestration seam. The caller owns persistent state and must supply
 * an atomic compare-and-commit adapter; NEVER assume localStorage or a model
 * proposal is a transactional write.
 */
export async function runVariableUpdateCycle(input:UpdateCycleInput):Promise<UpdateCycleResult>{
  if(!input.scope.trim())throw new Error('更新聊天作用域不能为空');
  const contract=parseContract(input.contract);
  const snapshot=readSnapshot(contract,input.snapshot);
  const documents=normalizeDocs(input.scope,input.documents);
  const retryLimit=input.maxRepairAttempts??1;
  if(!Number.isSafeInteger(retryLimit)||retryLimit<0||retryLimit>2)throw new Error('纠错重试次数必须为 0~2');
  const index=new BM25FIndex(input.scope);
  index.rebuild(documents);
  const plan=buildVariableUpdatePlan(input);
  const errors:UpdateCycleResult['errors']=[];
  const advanced:Record<string,number>={...input.lastProcessed};
  const processed:string[]=[];
  let committed=0;
  for(const group of plan.groups){
    try{
      const observation=prepareVariableObservation(contract,snapshot,group,documents,index);
      let checked:ReturnType<typeof validateVariableDecisions>|undefined;
      let feedback: string|undefined;
      for(let attempt=0;attempt<=retryLimit;attempt++){
        const raw=await input.propose(observation,feedback);
        try{
          checked=validateVariableDecisions(
            typeof raw==='string'?parseProposalText(raw):raw,
            observation,contract,snapshot
          );
          break;
        }catch(error){
          feedback='修正上一轮格式/契约校验错误：'+
            (error instanceof Error?error.message:String(error));
          if(attempt===retryLimit)throw error;
        }
      }
      if(!checked)throw new Error('模型未返回可用的变量更新提案');
      const advance:Record<string,number>=Object.create(null);
      for(const path of group.paths)advance[path]=group.advanceTo;
      await input.atomicCommit({
        scope:input.scope,key:input.scope+'|'+group.key+'|'+group.advanceTo,
        updates:checked.updates,expected:checked.expected,advance,
        decisions:checked.decisions,
      });
      Object.assign(advanced,advance);
      processed.push(...group.paths);
      committed++;
    }catch(error){
      errors.push({group:group.key,reason:error instanceof Error?error.message:String(error)});
    }
  }
  return {planned:plan.groups.length,committed,processed,errors,advanced};
}
