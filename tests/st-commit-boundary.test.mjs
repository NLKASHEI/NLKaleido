import test from 'node:test';
import assert from 'node:assert/strict';
import {createStChatUpdateLedger,UPDATE_ARCHIVE_KEY} from '../.build/runtime/update-ledger.js';
import {extractChatTimeline} from '../.build/runtime/chat-timeline.js';
import {demoContract} from '../.build/ui/model.js';

test('commit boundary independently checks citations, decisions, expected fields, and idempotency',async()=>{
  const ctx={chatId:'chat-secure',characterId:3,groupId:null,chat:[
    {is_user:true,mes:'我递出了水'},
    {is_user:false,mes:'她接过水，感激地点头。'},
  ],chatMetadata:{}};
  let saved=0;
  const ledger=createStChatUpdateLedger({
    current:()=>ctx,
    saveAndConfirm:async()=>{saved++;return {durable:true};}
  });
  await ledger.install(demoContract);
  const baseline=await extractChatTimeline(ctx);
  const scope=baseline.scope;
  const id=baseline.documents[0].id;
  const legitimate={
    scope,key:scope+'|one-field-test|1',
    expected:{'角色.好感度':50},
    updates:{'角色.好感度':53},
    advance:{'角色.好感度':1},
    decisions:[{path:'角色.好感度',action:'set',value:53,
      reason:'同伴明确感谢玩家的援助',evidenceIds:[id]}],
  };
  await assert.rejects(ledger.commit({...legitimate,key:'__proto__'},baseline),/提交标识/);
  await assert.rejects(ledger.commit({...legitimate,decisions:[]},baseline),/不一致/);
  await assert.rejects(ledger.commit({...legitimate,decisions:[
    {...legitimate.decisions[0],evidenceIds:['nonexistent-id']}
  ]},baseline),/有效证据/);
  await assert.rejects(ledger.commit({...legitimate,updates:{'角色.好感度':90}},baseline),/提案内容与事务/);
  await assert.rejects(ledger.commit({...legitimate,expected:{}},baseline),/缺少.*旧值/);
  assert.equal(saved,1); // only the explicit contract install was saved
  assert.equal(ledger.read().snapshot.stat_data.角色.好感度,50);
  assert.equal(await ledger.commit(legitimate,baseline),'applied');
  assert.equal(saved,2);
  assert.equal(ledger.read().snapshot.stat_data.角色.好感度,53);
  assert.equal(await ledger.commit(legitimate,baseline),'duplicate');
  assert.equal(saved,2);
  assert.equal(ledger.read().audit.length,1);
  assert.ok(ctx.chatMetadata[UPDATE_ARCHIVE_KEY]);
});
