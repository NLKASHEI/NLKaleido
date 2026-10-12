import { parseContract, type Contract } from '../core/contract.js';

export type UpdateFieldPolicy = {
  /** 0 disables automatic updates, default 1 = check every assistant reply. */
  every?: number;
  /** Latest completed turns deliberately held back, default 0. */
  skipLatest?: number;
  /** Bounded number of unprocessed turns per batch, default 3. */
  batchSize?: number;
  /** Optional author grouping. Separate groups cannot mix. */
  group?: string;
  /** Only affects observation text, never changes history checkpoint. */
  contextDepth?: number;
};
export type ScheduledGroup = {
  key: string;
  paths: string[];
  turns: number[];
  advanceTo: number;
  contextDepth: number;
  group: string;
};
export type ScheduledUpdatePlan = { groups: ScheduledGroup[]; pending: string[]; disabled: string[] };
export type ScheduleInput = {
  contract: Contract;
  /** Immutable numeric logical assistant-turn identities, ascending. */
  completedTurns: number[];
  lastProcessed: Readonly<Record<string,number>>;
  policies?: Readonly<Record<string,UpdateFieldPolicy>>;
  maxFieldsPerGroup?: number;
  maxGroups?: number;
};

function integer(value:number|undefined,fallback:number,min:number,max:number):number{
  if(value===undefined)return fallback;
  if(!Number.isSafeInteger(value)||value<min||value>max)
    throw new Error('更新调度配置超出允许范围 '+min+'~'+max);
  return value;
}

/**
 * shujuku-inspired independent schedule per field, grouped by identical
 * unprocessed turn slices and author group, with bounded catch-up batches.
 * A short contextDepth does NOT erase unprocessed turns from the watermark.
 */
export function buildVariableUpdatePlan(input:ScheduleInput):ScheduledUpdatePlan{
  const contract=parseContract(input.contract);
  const ordered=input.completedTurns;
  if(ordered.length>100000)throw new Error('对话轮次记录过多');
  for(let i=0;i<ordered.length;i++){
    const turn=ordered[i]!;
    if(!Number.isSafeInteger(turn)||turn<1||i>0&&turn<ordered[i-1]!)
      throw new Error('对话轮次必须为非负、有序、不重复的逻辑序号');
    if(i>0&&turn===ordered[i-1])throw new Error('不能提交重复的对话轮次');
  }
  const maxFields=integer(input.maxFieldsPerGroup,6,1,50);
  const maxGroups=integer(input.maxGroups,8,1,100);
  const groups=new Map<string,ScheduledGroup[]>();
  const pending:string[]=[];
  const disabled:string[]=[];
  for(const rule of Object.values(contract.updateRules)){
    const mode=rule.updateMode??'afterReply';
    if(mode==='manual'||mode==='fixed'){disabled.push(rule.path);continue;}
    if(mode!=='afterReply'&&mode!=='immediate'){disabled.push(rule.path);continue;}
    const policy=input.policies?.[rule.path]??{};
    const every=integer(policy.every,1,0,1000);
    if(!every){disabled.push(rule.path);continue;}
    const skip=integer(policy.skipLatest,0,0,1000);
    const batchSize=integer(policy.batchSize,3,1,100);
    const depth=integer(policy.contextDepth,4,1,100);
    const keyGroup=policy.group??'default';
    if(!/^[\p{L}\p{N}_-]{1,50}$/u.test(keyGroup))throw new Error('非法更新分组名称');
    const watermark=input.lastProcessed[rule.path]??0;
    if(!Number.isSafeInteger(watermark)||watermark<0)throw new Error('非法历史处理进度: '+rule.path);
    const eligible=skip?ordered.slice(0,-skip):ordered;
    const unseen=eligible.filter(turn=>turn>watermark);
    if(unseen.length<every){pending.push(rule.path);continue;}
    // Process earliest backlog first. Never silently drop a turn just because
    // its data is older than the contextDepth or batchSize.
    const turns=unseen.slice(0,batchSize);
    const advanceTo=turns.at(-1);
    if(advanceTo===undefined){pending.push(rule.path);continue;}
    const signature=JSON.stringify([keyGroup,turns,depth]);
    const members=groups.get(signature)??[];
    let group=members.at(-1);
    if(!group||group.paths.length>=maxFields){
      group={key:signature+'#'+members.length,paths:[],turns,advanceTo,contextDepth:depth,group:keyGroup};
      members.push(group);
      groups.set(signature,members);
    }
    group.paths.push(rule.path);
  }
  const all=[...groups.values()].flat();
  const selected=all.slice(0,maxGroups);
  for(const overflow of all.slice(maxGroups))pending.push(...overflow.paths);
  return {groups:selected,pending,disabled};
}
