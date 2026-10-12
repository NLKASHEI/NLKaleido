import test from 'node:test';
import assert from 'node:assert/strict';
import {createStPlayerSource} from '../.build/player/st-source.js';
import {demoContract} from '../.build/ui/model.js';
import {initialSnapshot} from '../.build/index.js';

const key='nlkaleido_rebuild_v1';
const saved=JSON.stringify(demoContract);
test('ST status uses current-chat opt-in namespace only and never demo values',async()=>{
  let ctx={chatId:'chat1',chatMetadata:{[key]:initialSnapshot(demoContract)}};
  const read=createStPlayerSource(async()=>ctx,()=>saved);
  const first=await read();
  assert.equal(first.kind,'ready');
  assert.equal(first.mode,'chat');
  assert.equal(first.view.metrics.find(m=>m.path==='角色.好感度').text,'50');
  ctx={chatId:'chat2',chatMetadata:{}};
  const second=await read();
  assert.equal(second.kind,'empty');
  assert.match(second.message,/尚无新版/);
});
test('missing chat or incompatible contract return an empty/error view',async()=>{
  const noChat=createStPlayerSource(async()=>({chatId:null,chatMetadata:{}}),()=>saved);
  assert.equal((await noChat()).kind,'empty');
  const bad=createStPlayerSource(async()=>({chatId:'x',chatMetadata:{[key]:{schemaVersion:99}}}),()=>saved);
  assert.equal((await bad()).kind,'error');
});

test('player reads verified per-chat update archive without global localStorage contract',async()=>{
  const {createStPlayerSource}=await import('../.build/player/st-source.js');
  const {createStChatUpdateLedger,UPDATE_ARCHIVE_KEY}=await import('../.build/runtime/update-ledger.js');
  const {demoContract}=await import('../.build/ui/model.js');
  const ctx={chatId:'chat-ready',characterId:0,groupId:null,
    chat:[{is_user:true,mes:'hello'},{is_user:false,mes:'world'}],chatMetadata:{}};
  const ledger=createStChatUpdateLedger({
    current:()=>ctx,
    saveAndConfirm:async()=>({durable:true})
  });
  await ledger.install(demoContract);
  const view=await createStPlayerSource(async()=>ctx,()=>null)();
  assert.equal(view.kind,'ready');
  assert.equal(view.view.title,'星海旅人');
  assert.equal(view.view.metrics.find(x=>x.path==='角色.好感度').text,'50');
  assert.ok(ctx.chatMetadata[UPDATE_ARCHIVE_KEY]);
});
