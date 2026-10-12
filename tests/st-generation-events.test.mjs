import test from 'node:test';
import assert from 'node:assert/strict';
import {createStRawProposalProvider} from '../.build/runtime/st-generation.js';
import {attachStAutoUpdateEvents} from '../.build/runtime/st-events.js';
import {createStChatUpdateLedger} from '../.build/runtime/update-ledger.js';
import {demoContract} from '../.build/ui/model.js';

function fakeContext(){
  const handlers=new Map();
  let generationCount=0;
  const ctx={
    chatId:'sample',characterId:0,groupId:null,
    chat:[{is_user:true,mes:'谢谢你愿意帮忙'},
      {is_user:false,mes:'角色表示愿意继续同行'}],
    chatMetadata:{},
    eventTypes:{GENERATION_ENDED:'generation_ended',GENERATION_STOPPED:'generation_stopped'},
    eventSource:{
      on:(name,fn)=>{handlers.set(name,fn);},
      removeListener:(name)=>{handlers.delete(name);}
    },
    generateRaw:async({systemPrompt,prompt,responseLength})=>{
      generationCount++;
      assert.match(systemPrompt,/PROPOSAL agent/);
      assert.equal(responseLength,2000);
      const obs=JSON.parse(prompt);
      return JSON.stringify({decisions:obs.fields.map(f=>({
        path:f.path,action:'unchanged',reason:'本轮剧情不足以支持具体的状态修改',evidenceIds:[]
      }))});
    }
  };
  return {
    ctx,handlers,
    emit(name){handlers.get(name)?.()},
    get generationCount(){return generationCount},
  };
}
test('official generateRaw proposal uses selected model and does not write chat text',async()=>{
  const f=fakeContext();
  const before=f.ctx.chat.map(m=>m.mes);
  const provider=createStRawProposalProvider(()=>f.ctx);
  const observation={scope:JSON.stringify(['none','0','sample']),turns:[1],
    fields:[{path:'角色.好感度',type:'number',value:50,description:'',changeRule:'谨慎变化',dependencies:{}}],
    evidence:[{id:'turn-1',scope:JSON.stringify(['none','0','sample']),turn:1,fields:{body:'人物对话'}}]
  };
  const result=await provider(observation);
  assert.equal(JSON.parse(result).decisions.length,1);
  assert.deepEqual(f.ctx.chat.map(m=>m.mes),before);
  assert.equal(f.generationCount,1);
});

test('generation-ended event opt-in launches exactly one checked cycle; stopped does nothing',async()=>{
  const f=fakeContext();
  const ledger=createStChatUpdateLedger({
    current:()=>f.ctx,
    saveAndConfirm:async()=>({durable:true}),
  });
  await ledger.install(demoContract);
  let lastSignal;
  let done;
  const finished=new Promise(resolve=>{done=resolve;});
  const observer=attachStAutoUpdateEvents(()=>f.ctx,ledger,signal=>{
    lastSignal=signal;
    done();
  });
  assert.equal(ledger.read().autoEnabled,false);
  f.emit('generation_ended');
  await Promise.resolve();
  assert.equal(f.generationCount,0);
  await ledger.setAutoEnabled(true);
  f.emit('generation_stopped');
  await Promise.resolve();
  assert.equal(f.generationCount,0);
  f.emit('generation_ended');
  await finished;
  assert.equal(f.generationCount,1);
  assert.equal(lastSignal.kind,'updated');
  assert.equal(ledger.read().watermarks['角色.好感度'],1);
  assert.equal(ledger.read().audit.length,1);
  await ledger.setAutoEnabled(false);
  f.emit('generation_ended');
  await Promise.resolve();
  assert.equal(f.generationCount,1);
  observer.dispose();
  assert.equal(f.handlers.size,0);
});

test('raw provider rejects chat switch after the in-flight LLM request',async()=>{
  const f=fakeContext();
  let release;
  const wait=new Promise(resolve=>{release=resolve;});
  f.ctx.generateRaw=async()=>{await wait;return '{"decisions":[]}';};
  const provider=createStRawProposalProvider(()=>f.ctx);
  const obs={scope:JSON.stringify(['none','0','sample']),turns:[1],fields:[],evidence:[]};
  const promise=provider(obs);
  await Promise.resolve();
  f.ctx.chatId='new-room';
  release();
  await assert.rejects(promise,/聊天已切换/);
});
