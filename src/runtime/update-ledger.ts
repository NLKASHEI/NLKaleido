import { assertRuleValue, copyJson, parseContract, type Contract } from '../core/contract.js';
import { applyValues, getValue, initialSnapshot, readSnapshot, type Snapshot } from '../core/state.js';
import { extractChatTimeline, assertTimelineCompatible, chatScope, type ChatTimeline, type StChatContext } from './chat-timeline.js';
import { runVariableUpdateCycle, type UpdateCommit, type UpdateCycleResult, type UpdateObservation } from '../update/pipeline.js';

export const UPDATE_ARCHIVE_KEY='nlkaleido_update_runtime_v1';

export type ArchiveAudit={
  id:string; at:string; source:'agent'; changed:string[];
  before:Record<string,unknown>;after:Record<string,unknown>;
  decisions:UpdateCommit['decisions'];
};
export type UpdateArchive={
  schemaVersion:1;
  scope:string;
  /** Off by default: automatic requests may cost tokens. */
  autoEnabled:boolean;
  contract:Contract;
  snapshot:Snapshot;
  watermarks:Record<string,number>;
  processedHashes:string[];
  receipts:Record<string,string>;
  audit:ArchiveAudit[];
};
export type SaveProof={durable:boolean};
export type ChatLedgerPort={
  current:()=>StChatContext;
  /**
   * Must provide independent persistence confirmation; ST saveMetadata()
   * alone does NOT satisfy this, because it swallows server errors.
   */
  saveAndConfirm:(captured:StChatContext)=>Promise<SaveProof>;
};
export type CommitStatus='applied'|'duplicate';
export type UpdatePreviewPlan={
  scope:string;turns:number[];pending:number;contractId:string;
  committedTurns:number;
};

function record(value:unknown):value is Record<string,unknown>{
  return !!value&&typeof value==='object'&&!Array.isArray(value);
}
async function digest(value:unknown):Promise<string>{
  const bytes=new TextEncoder().encode(JSON.stringify(value));
  const hash=await crypto.subtle.digest('SHA-256',bytes);
  return [...new Uint8Array(hash)].map(b=>b.toString(16).padStart(2,'0')).join('');
}
function assertCurrent(getContext:()=>StChatContext,captured:StChatContext,scope:string):void{
  const now=getContext();
  if(!now.chatMetadata||now.chatMetadata!==captured.chatMetadata||chatScope(now)!==scope)
    throw new Error('聊天已经切换或聊天元数据已替换；禁止提交');
}
function readArchive(captured:StChatContext):UpdateArchive|null{
  const metadata=captured.chatMetadata;
  if(!metadata)throw new Error('当前聊天元数据不可用');
  const raw=metadata[UPDATE_ARCHIVE_KEY];
  if(raw===undefined||raw===null)return null;
  if(!record(raw)||raw.schemaVersion!==1||typeof raw.scope!=='string'||
     !record(raw.watermarks)||!Array.isArray(raw.processedHashes)||
     !record(raw.receipts)||!Array.isArray(raw.audit))
    throw new Error('更新存档结构损坏，拒绝覆盖');
  // The stored record is untrusted until validated; never accept prototype keys.
  const saved=copyJson(raw);
  if(saved.autoEnabled!==undefined&&typeof saved.autoEnabled!=='boolean')
    throw new Error('自动更新开关数据不合法');
  const contract=parseContract(saved.contract);
  const snapshot=readSnapshot(contract,raw.snapshot);
  if(snapshot.contractId!==contract.id)throw new Error('更新存档的契约不匹配');
  if(raw.scope!==chatScope(captured))throw new Error('更新存档与聊天作用域不匹配');
  for(const value of Object.values(raw.watermarks))
    if(!Number.isSafeInteger(value)||typeof value!=='number'||value<0)throw new Error('非法更新进度');
  if(raw.processedHashes.length>30000||raw.processedHashes.some(x=>typeof x!=='string'||!/^[0-9a-f]{64}$/.test(x)))
    throw new Error('非法历史指纹列表');
  if(raw.audit.length>1000||Object.keys(raw.receipts).length>2000)
    throw new Error('审计或提交记录超出安全上限');
  return {...saved,autoEnabled:saved.autoEnabled===true} as UpdateArchive;
}

export function getCurrentUpdateArchive(context:StChatContext):UpdateArchive|null{
  return readArchive(context);
}

export function createStChatUpdateLedger(port:ChatLedgerPort){
  let queue:Promise<unknown>=Promise.resolve();
  let quarantined=false;
  const serialized=<T>(fn:()=>Promise<T>):Promise<T>=>{
    const result=queue.then(fn,fn);
    queue=result.then(()=>undefined,()=>undefined);
    return result;
  };
  async function capture():Promise<{ctx:StChatContext;timeline:ChatTimeline;archive:UpdateArchive|null}>{
    if(quarantined)throw new Error('此前聊天保存结果不确定，本次会话已锁定；请重载酒馆核对');
    const ctx=port.current();
    const timeline=await extractChatTimeline(ctx);
    assertCurrent(port.current,ctx,timeline.scope);
    return {ctx,timeline,archive:readArchive(ctx)};
  }
  async function persist(ctx:StChatContext,scope:string,archive:UpdateArchive):Promise<void>{
    assertCurrent(port.current,ctx,scope);
    const meta=ctx.chatMetadata!;
    const before=meta[UPDATE_ARCHIVE_KEY];
    const existed=Object.hasOwn(meta,UPDATE_ARCHIVE_KEY);
    meta[UPDATE_ARCHIVE_KEY]=copyJson(archive);
    try{
      const proof=await port.saveAndConfirm(ctx);
      assertCurrent(port.current,ctx,scope);
      if(!proof?.durable)throw new Error('聊天保存未得到独立的持久化确认');
    }catch(error){
      // Restore the captured object only; never mutate the newly selected chat.
      if(existed)meta[UPDATE_ARCHIVE_KEY]=before;
      else delete meta[UPDATE_ARCHIVE_KEY];
      // Commit might have reached disk; require manual reconciliation before retry.
      quarantined=true;
      throw new Error('保存未确认，已锁定自动更新，须重新加载聊天核对', {cause:error});
    }
  }

  async function install(contractInput:unknown):Promise<UpdateArchive>{
    return serialized(async()=>{
      const {ctx,timeline,archive}=await capture();
      if(archive)throw new Error('聊天已有变量契约；安装不会覆盖已有数据');
      const contract=parseContract(contractInput);
      const draft:UpdateArchive={
        schemaVersion:1,scope:timeline.scope,autoEnabled:false,contract:JSON.parse(JSON.stringify(contract)) as Contract,
        snapshot:initialSnapshot(contract),watermarks:{},processedHashes:[],
        receipts:{},audit:[],
      };
      await persist(ctx,timeline.scope,draft);
      return copyJson(draft);
    });
  }

  async function setAutoEnabled(enabled:boolean):Promise<boolean>{
    return serialized(async()=>{
      if(typeof enabled!=='boolean')throw new Error('自动更新设置必须为布尔值');
      const {ctx,timeline,archive}=await capture();
      if(!archive)throw new Error('请先为当前聊天绑定变量契约');
      assertTimelineCompatible(archive.processedHashes,timeline);
      if(archive.autoEnabled===enabled)return enabled;
      const next=copyJson(archive);
      next.autoEnabled=enabled;
      await persist(ctx,timeline.scope,next);
      return enabled;
    });
  }

  async function preview():Promise<UpdatePreviewPlan|null>{
    const {ctx,timeline,archive}=await capture();
    if(!archive)return null;
    assertTimelineCompatible(archive.processedHashes,timeline);
    return {
      scope:timeline.scope,turns:timeline.turns,
      pending:Math.max(0,...Object.keys(archive.contract.updateRules).map(
        path=>timeline.turns.length-(archive.watermarks[path]??0)
      )),
      contractId:archive.contract.id,committedTurns:archive.processedHashes.length
    };
  }

  /**
   * Same-process serialized optimistic transaction. No commit without an
   * independently verified durable save result. This cannot by itself
   * provide cross-tab ACID guarantees.
   */
  async function commit(tx:UpdateCommit,baseline:ChatTimeline,requireAutoEnabled=false):Promise<CommitStatus>{
    return serialized(async()=>{
      const {ctx,timeline,archive}=await capture();
      if(!archive)throw new Error('当前聊天尚未安装变量契约');
      if(requireAutoEnabled&&!archive.autoEnabled)throw new Error('该聊天已关闭自动更新');
      if(tx.scope!==archive.scope||baseline.scope!==tx.scope)
        throw new Error('更新来源聊天不一致');
      assertTimelineCompatible(archive.processedHashes,timeline);
      if(baseline.hashes.length>timeline.hashes.length||
         baseline.hashes.some((hash,i)=>timeline.hashes[i]!==hash))
        throw new Error('提案生成期间消息被修改、重生成或切换，拒绝提交');
      const hash=await digest(tx);
      assertCurrent(port.current,ctx,tx.scope);
      const oldReceipt=archive.receipts[tx.key];
      if(oldReceipt){
        if(oldReceipt!==hash)throw new Error('重复提交键对应了不同内容');
        return 'duplicate';
      }
      if(Object.keys(archive.receipts).length>=1900||archive.audit.length>=950)
        throw new Error('审计/收据接近上限，需要导出归档后再继续');
      const next=copyJson(archive);
      const updates=tx.updates;
      const before:Record<string,unknown>=Object.create(null);
      for(const [path,value] of Object.entries(tx.expected)){
        if(!Object.hasOwn(archive.contract.updateRules,path))throw new Error('期望字段不存在: '+path);
        if(JSON.stringify(getValue(archive.contract,next.snapshot,path))!==JSON.stringify(value))
          throw new Error('变量状态已变化，拒绝覆盖旧状态: '+path);
      }
      for(const [path,value] of Object.entries(updates)){
        const rule=archive.contract.updateRules[path];
        if(!rule)throw new Error('未授权变量写入: '+path);
        assertRuleValue(rule,value);
        const prior=getValue(archive.contract,next.snapshot,path);
        before[path]=prior;
        if(rule.type==='number'&&rule.maxDelta!==undefined&&
           typeof prior==='number'&&typeof value==='number'&&
           Math.abs(value-prior)>rule.maxDelta)
          throw new Error('变量更新超过允许幅度: '+path);
      }
      for(const [path,turn] of Object.entries(tx.advance)){
        if(!archive.contract.updateRules[path])throw new Error('未知字段进度: '+path);
        if(!Number.isSafeInteger(turn)||turn<1||turn>baseline.turns.length)
          throw new Error('提交的对话轮次无效');
        if(turn<=(archive.watermarks[path]??0))
          throw new Error('更新进度倒退或存在未确认的重复处理');
        next.watermarks[path]=turn;
      }
      if(!Object.keys(tx.advance).length)throw new Error('缺少字段更新进度');
      // Recheck source version before persisting and advance only accepted turns.
      const processedTo=Math.max(0,...Object.values(next.watermarks));
      next.processedHashes=baseline.hashes.slice(0,processedTo);
      next.snapshot=applyValues(archive.contract,next.snapshot,updates).snapshot;
      next.receipts[tx.key]=hash;
      next.audit.push({
        id:tx.key,at:new Date().toISOString(),source:'agent',
        changed:Object.keys(updates),before:copyJson(before),
        after:copyJson(updates),decisions:copyJson(tx.decisions),
      });
      await persist(ctx,tx.scope,next);
      return 'applied';
    });
  }

  async function run(propose:(observation:UpdateObservation,feedback?:string)=>Promise<unknown>,requireAutoEnabled=false):Promise<UpdateCycleResult>{
    const {ctx,timeline,archive}=await capture();
    if(!archive)throw new Error('请先将契约明确安装到当前聊天');
    if(requireAutoEnabled&&!archive.autoEnabled)throw new Error('当前聊天未启用自动更新');
    assertTimelineCompatible(archive.processedHashes,timeline);
    return runVariableUpdateCycle({
      scope:timeline.scope,
      contract:archive.contract,
      snapshot:archive.snapshot,
      documents:timeline.documents,
      completedTurns:timeline.turns,
      lastProcessed:archive.watermarks,
      propose,
      atomicCommit:async tx=>{
        assertCurrent(port.current,ctx,timeline.scope);
        await commit(tx,timeline,requireAutoEnabled);
      },
    });
  }
  return {install,setAutoEnabled,preview,commit,run,read:()=>readArchive(port.current()),
    get quarantined(){return quarantined;}};
}
