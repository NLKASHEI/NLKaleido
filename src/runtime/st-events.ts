import type { createStChatUpdateLedger } from './update-ledger.js';
import { createStRawProposalProvider, type StGenerationContext } from './st-generation.js';
import type { UpdateCycleResult } from '../update/pipeline.js';

export type StEventContext=StGenerationContext & {
  eventTypes?:{GENERATION_ENDED?:string;GENERATION_STOPPED?:string;CHAT_CHANGED?:string};
  eventSource?:{
    on:(event:string,handler:()=>void)=>void;
    removeListener?:(event:string,handler:()=>void)=>void;
  };
};
export type RuntimeSignal={
  kind:'updated'|'skipped'|'error'; scope?:string; message:string; result?:UpdateCycleResult;
};

/**
 * Opt-in lifecycle: only successful completed generations may trigger
 * a review request. Never update on user STOP, partial stream, or chat change.
 */
export function attachStAutoUpdateEvents(
  getContext:()=>StEventContext,
  ledger:ReturnType<typeof createStChatUpdateLedger>,
  onSignal:(signal:RuntimeSignal)=>void=()=>{},
){
  const context=getContext();
  const emitter=context.eventSource;
  const ended=context.eventTypes?.GENERATION_ENDED;
  if(!emitter||!ended)throw new Error('酒馆未提供生成完成事件，自动更新不可用');
  let active=false;
  let disposed=false;
  const run=async():Promise<void>=>{
    if(active||disposed)return;
    let archive:ReturnType<typeof ledger.read>=null;
    try{archive=ledger.read();}
    catch(err){onSignal({kind:'error',message:err instanceof Error?err.message:String(err)});return;}
    if(!archive?.autoEnabled)return;
    active=true;
    try{
      const proposer=createStRawProposalProvider(getContext);
      const result=await ledger.run(proposer,true);
      if(disposed)return;
      if(result.errors.length){
        onSignal({kind:'error',scope:archive.scope,
          message:result.errors.map(e=>e.reason).join('；').slice(0,380),result});
      }else if(result.committed){
        onSignal({kind:'updated',scope:archive.scope,
          message:'已检查 '+result.processed.length+' 个变量字段',result});
      }else{
        onSignal({kind:'skipped',scope:archive.scope,message:'本轮没有到期变量',result});
      }
    }catch(err){
      if(!disposed)onSignal({kind:'error',scope:archive.scope,
        message:err instanceof Error?err.message:String(err)});
    }finally{active=false;}
  };
  const onEnd=():void=>{void run();};
  emitter.on(ended,onEnd);
  return {
    runNow:run,
    dispose:()=>{
      disposed=true;
      emitter.removeListener?.(ended,onEnd);
    },
  };
}
