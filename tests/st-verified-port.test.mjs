import test from 'node:test';
import assert from 'node:assert/strict';
import {createStChatUpdateLedger,UPDATE_ARCHIVE_KEY} from '../.build/runtime/update-ledger.js';
import {createVerifiedStChatPort} from '../.build/runtime/st-verified-port.js';
import {demoContract} from '../.build/ui/model.js';

function fake(){
  let remote=null,requests=0,skipSave=false;
  const character={name:'角色一',avatar:'char.png',chat:'room-a'};
  const ctx={
    chatId:'room-a',characterId:0,groupId:null,
    characters:[character],
    chat:[{is_user:true,mes:'你好'},{is_user:false,mes:'你好呀'}],
    chatMetadata:{variables:{nlkaleido:{legacy:true}}},
    getRequestHeaders:()=>({'Content-Type':'application/json','X-Test':'yes'}),
    saveMetadata:async()=>{if(!skipSave)remote=structuredClone(ctx.chatMetadata);}
  };
  const fetchChat=async(url,init)=>{
    requests++;
    assert.equal(url,'/api/chats/get');
    assert.equal(init.method,'POST');
    assert.equal(JSON.parse(init.body).file_name,'room-a');
    assert.equal(init.headers['X-Test'],'yes');
    return {ok:true,json:async()=>remote?[{chat_metadata:remote}]:[]};
  };
  return {ctx,fetchChat,get requests(){return requests;},setSkip(value){skipSave=value;}};
}
test('SillyTavern verified port confirms installed contract through server read-back',async()=>{
  const f=fake();
  const ledger=createStChatUpdateLedger(createVerifiedStChatPort(()=>f.ctx,f.fetchChat));
  const value=await ledger.install(demoContract);
  assert.equal(value.contract.id,'星海旅人');
  assert.equal(f.ctx.chatMetadata.variables.nlkaleido.legacy,true);
  assert.equal(f.requests,1);
  assert.ok(f.ctx.chatMetadata[UPDATE_ARCHIVE_KEY]);
});

test('ST saveMetadata swallowing an error is caught by independent read-back',async()=>{
  const f=fake();f.setSkip(true);
  const ledger=createStChatUpdateLedger(createVerifiedStChatPort(()=>f.ctx,f.fetchChat));
  await assert.rejects(ledger.install(demoContract),/保存未确认/);
  assert.equal(f.ctx.chatMetadata[UPDATE_ARCHIVE_KEY],undefined);
  assert.equal(f.requests,1);
  assert.equal(ledger.quarantined,true);
});

test('ST group chats are unsupported until independent verified group storage is implemented',async()=>{
  const f=fake();f.ctx.groupId='group-1';
  const ledger=createStChatUpdateLedger(createVerifiedStChatPort(()=>f.ctx,f.fetchChat));
  await assert.rejects(ledger.install(demoContract),/保存未确认/);
  assert.equal(f.requests,0);
});

test('ST server returning stale older contract is rejected rather than treated as success',async()=>{
  const f=fake();f.setSkip(true);
  const response=async()=>({ok:true,json:async()=>[{chat_metadata:{[UPDATE_ARCHIVE_KEY]:{schemaVersion:1,scope:'wrong'}}}]});
  const ledger=createStChatUpdateLedger(createVerifiedStChatPort(()=>f.ctx,response));
  await assert.rejects(ledger.install(demoContract),/保存未确认/);
});
