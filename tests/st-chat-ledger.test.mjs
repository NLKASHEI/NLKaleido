import test from 'node:test';
import assert from 'node:assert/strict';
import { extractChatTimeline, assertTimelineCompatible, chatScope } from '../.build/runtime/chat-timeline.js';
import { createStChatUpdateLedger, UPDATE_ARCHIVE_KEY } from '../.build/runtime/update-ledger.js';
import { demoContract } from '../.build/ui/model.js';

function fixture(){
  const context={
    chatId:'room-a',characterId:1,groupId:null,
    chat:[
      {is_user:true,mes:'我捡起了钥匙'},
      {is_user:false,mes:'你将锈迹斑斑的钥匙收入背包。',name:'角色'},
      {is_user:true,mes:'我把钥匙交给伙伴'},
      {is_user:false,mes:'伙伴接过钥匙并点头。',name:'角色'},
    ],
    chatMetadata:{}
  };
  let current=context;
  let saveCount=0;
  let stored=null;
  let verified=true;
  return {
    context,
    setCurrent(c){current=c},
    setVerified(v){verified=v},
    get stored(){return stored},
    get saveCount(){return saveCount},
    port:{
      current:()=>current,
      saveAndConfirm:async ctx=>{
        saveCount++;
        if(verified)stored=structuredClone(ctx.chatMetadata);
        return {durable:verified};
      }
    }
  };
}

test('ST chat extractor uses only completed assistant replies and fingerprints swipe/edit history',async()=>{
  const f=fixture();
  const timeline=await extractChatTimeline(f.context);
  assert.equal(timeline.turns.length,2);
  assert.deepEqual(timeline.turns,[1,2]);
  assert.equal(timeline.documents[0].turn,1);
  assert.match(timeline.documents[0].fields.body,/玩家：我捡起了钥匙/);
  assert.match(timeline.documents[0].fields.body,/角色：你将锈迹斑斑/);
  assert.equal(timeline.hashes[0].length,64);
  f.context.chat[1].mes='你忽然转身离开。';
  const changed=await extractChatTimeline(f.context);
  assert.notEqual(changed.hashes[0],timeline.hashes[0]);
  assert.throws(()=>assertTimelineCompatible(timeline.hashes,changed),/已处理的历史/);
  assert.equal(chatScope({...f.context,chatId:'room-b'})===timeline.scope,false);
});

test('explicit install persists isolated archive without touching v0.10.0 metadata',async()=>{
  const f=fixture();
  f.context.chatMetadata.variables={nlkaleido:{legacy:true}};
  const ledger=createStChatUpdateLedger(f.port);
  const archive=await ledger.install(demoContract);
  assert.equal(archive.schemaVersion,1);
  assert.equal(archive.snapshot.stat_data.角色.好感度,50);
  assert.equal(f.context.chatMetadata.variables.nlkaleido.legacy,true);
  assert.equal(f.stored[UPDATE_ARCHIVE_KEY].contract.id,demoContract.id);
  assert.equal((await ledger.preview()).turns.length,2);
  assert.equal((await ledger.preview()).pending,2);
  await assert.rejects(ledger.install(demoContract),/已有变量契约/);
});

test('real-context observations commit unchanged fields and persist watermarks in the SAME archive',async()=>{
  const f=fixture();
  const ledger=createStChatUpdateLedger(f.port);
  await ledger.install(demoContract);
  let calls=0;
  const update=await ledger.run(async observation=>{
    calls++;
    assert.equal(observation.scope,chatScope(f.context));
    assert.equal(observation.turns.length,2);
    assert.ok(observation.evidence.some(e=>e.fields.body.includes('钥匙')));
    return {decisions:observation.fields.map(field=>({
      path:field.path,action:'unchanged',reason:'当前剧情没有符合变量规则的可证实变化',evidenceIds:[]
    }))};
  });
  assert.equal(update.errors.length,0);
  assert.equal(update.committed,1);
  assert.equal(calls,1);
  const archive=ledger.read();
  assert.equal(archive.watermarks['角色.好感度'],2);
  assert.equal(archive.processedHashes.length,2);
  assert.equal(archive.audit.length,1);
  assert.deepEqual(archive.audit[0].changed,[]);
  assert.equal(f.stored[UPDATE_ARCHIVE_KEY].watermarks['角色.好感度'],2);
  const again=await ledger.run(async()=>{throw new Error('already checked, no model call');});
  assert.equal(again.planned,0);
  assert.equal(again.committed,0);
});

test('after a processed message swipe, refuse further updates before calling model',async()=>{
  const f=fixture();
  const ledger=createStChatUpdateLedger(f.port);
  await ledger.install(demoContract);
  await ledger.run(async obs=>({decisions:obs.fields.map(field=>({
    path:field.path,action:'unchanged',reason:'未出现能够确认的变量变化',evidenceIds:[]
  }))}));
  f.context.chat[1].mes='这一条已重生成';
  await assert.rejects(ledger.run(async()=>{throw new Error('must not call')}),/已处理的历史/);
  assert.equal(f.stored[UPDATE_ARCHIVE_KEY].audit.length,1);
});

test('chat switch while model is responding cannot write to the new chat',async()=>{
  const f=fixture();
  const ledger=createStChatUpdateLedger(f.port);
  await ledger.install(demoContract);
  let release;
  const gate=new Promise(resolve=>{release=resolve});
  let entered;
  const entering=new Promise(resolve=>{entered=resolve});
  const job=ledger.run(async obs=>{
    entered();
    await gate;
    return {decisions:obs.fields.map(field=>({
      path:field.path,action:'unchanged',reason:'无确定性变化，保持原值',evidenceIds:[]
    }))};
  });
  await entering;
  const fresh={chatId:'room-b',characterId:1,groupId:null,chat:[],chatMetadata:{}};
  f.setCurrent(fresh);
  release();
  const result=await job;
  assert.equal(result.committed,0);
  assert.equal(result.errors.length,1);
  assert.match(result.errors[0].reason,/聊天已经切换/);
  assert.equal(fresh.chatMetadata[UPDATE_ARCHIVE_KEY],undefined);
});

test('unconfirmed ST save locks further auto-updates instead of claiming durable success',async()=>{
  const f=fixture();
  f.setVerified(false);
  const ledger=createStChatUpdateLedger(f.port);
  await assert.rejects(ledger.install(demoContract),/保存未确认/);
  assert.equal(f.context.chatMetadata[UPDATE_ARCHIVE_KEY],undefined);
  assert.equal(ledger.quarantined,true);
  await assert.rejects(ledger.preview(),/锁定/);
});

test('no selected chat means no install or evidence extraction',async()=>{
  const f=fixture();
  f.context.chatId=null;
  const ledger=createStChatUpdateLedger(f.port);
  await assert.rejects(ledger.install(demoContract),/未选择聊天/);
  assert.equal(f.saveCount,0);
});
