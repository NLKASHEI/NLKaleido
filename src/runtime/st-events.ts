import type { createStChatUpdateLedger } from './update-ledger.js';
import { createStRawProposalProvider, type StGenerationContext } from './st-generation.js';
import type { UpdateCycleResult } from '../update/pipeline.js';

export type StEventContext=StGenerationContext & {
  eventTypes?:{GENERATION_STARTED?:string;GENERATION_ENDED?:string;GENERATION_STOPPED?:string;CHAT_CHANGED?:string};
  eventSource?:{
    on:(event:string,handler:()=>void)=>void;
    removeListener?:(event:string,handler:()=>void)=>void;
  };
};
export type RuntimeSignal={
  kind:'updated'|'skipped'|'error'; scope?:string; message:string; result?:UpdateCycleResult;
};

/**
 * Opt-in lifecycle. WARNING: ST emits GENERATION_ENDED from hideStopButton()
 * even when the user presses Stop, before GENERATION_STOPPED fires.
 * Defer the ended callback for one event-loop tick to observe the stop event.
 * This guard covers explicit stops, not all failure modes; a live ST QA pass
 * is still required before promoting this to the default extension.
 */
export function attachStAutoUpdateEvents(
  getContext:()=>StEventContext,
  ledger:ReturnType<typeof createStChatUpdateLedger>,
  onSignal:(signal:RuntimeSignal)=>void=()=>{},
){
  const context=getContext();
  const emitter=context.eventSource;
  const ended=context.eventTypes?.GENERATION_ENDED;
  const stoppedEvent=context.eventTypes?.GENERATION_STOPPED;
  const startedEvent=context.eventTypes?.GENERATION_STARTED;
  if(!emitter||!ended||!stoppedEvent||!startedEvent)
    throw new Error('酒馆缺少生成开始/停止/结束事件，禁止自动更新');
  let active=false;
  let disposed=false;
  let stopped=false;
  let stopVersion=0;
  let pendingEnd:ReturnType<typeof setTimeout>|null=null;
  const run=async():Promise<void>=>{
    if(active||disposed)return;
    let archive:ReturnType<typeof ledger.read>=null;
    try{archive=ledger.read();}
    catch(err){onSignal({kind:'error',message:err instanceof Error?err.message:String(err)});return;}
    if(!archive?.autoEnabled)return;
    active=true;
    try{
      const proposer=createStRawProposalProvider(getContext);
      const startedWithStopVersion=stopVersion;
      const result=await ledger.run(async (observation,feedback)=>{
        if(disposed||stopped||stopVersion!==startedWithStopVersion)
          throw new Error('用户已中止变量更新请求');
        const response=await proposer(observation,feedback);
        if(disposed||stopped||stopVersion!==startedWithStopVersion)
          throw new Error('用户中止生成，禁止采用已结束请求的提案');
        return response;
      },true);
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
  const onStart=():void=>{stopped=false;};
  const onStop=():void=>{
    stopped=true;
    stopVersion++;
    if(pendingEnd!==null){clearTimeout(pendingEnd);pendingEnd=null;}
  };
  const onEnd=():void=>{
    if(disposed||stopped||pendingEnd!==null)return;
    // ST Stop invokes hideStopButton() -> ENDED before emitting STOPPED.
    pendingEnd=setTimeout(()=>{
      pendingEnd=null;
      if(!disposed&&!stopped)void run();
    },0);
  };
  emitter.on(startedEvent,onStart);
  emitter.on(stoppedEvent,onStop);
  emitter.on(ended,onEnd);
  return {
    runNow:run,
    dispose:()=>{
      disposed=true;
      if(pendingEnd!==null){clearTimeout(pendingEnd);pendingEnd=null;}
      emitter.removeListener?.(startedEvent,onStart);
      emitter.removeListener?.(stoppedEvent,onStop);
      emitter.removeListener?.(ended,onEnd);
    },
  };
}
