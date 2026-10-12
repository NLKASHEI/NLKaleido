import test from 'node:test';
import assert from 'node:assert/strict';
import { BM25FIndex, tokenizeEvidence } from '../.build/update/bm25f.js';
import { buildVariableUpdatePlan } from '../.build/update/scheduler.js';
import { prepareVariableObservation, validateVariableDecisions, runVariableUpdateCycle } from '../.build/update/pipeline.js';
import { demoContract } from '../.build/ui/model.js';
import { initialSnapshot } from '../.build/index.js';

const doc=(id,turn,fields,scope='chat-a')=>({id,scope,turn,fields});
const corpus=[
  doc('a',1,{title:'生锈的钥匙',tags:'关键道具',summary:'在旧书架后发现了生锈钥匙',body:'玩家在旧书架后捡起了一把钥匙'}),
  doc('b',2,{title:'人物对话',tags:'普通聊天',summary:'旅行者询问关于星港的事',body:'朋友和你继续交谈'}),
  doc('c',3,{title:'星港阶段',tags:'剧情推进',summary:'世界阶段仍是序章',body:'目前没有打开星港的门'}),
];

test('Chinese tokenizer supports unsegmented characters and bigrams',()=>{
  const tokens=tokenizeEvidence('生锈的钥匙 旧书架 HELLO-WORLD');
  for(const part of ['生','生锈','锈的','的钥','钥匙','旧书','书架','hello-world'])assert.ok(tokens.includes(part),part);
});

test('BM25F boosts short title, supports per-field lengths and exact chat isolation',()=>{
  const index=new BM25FIndex('chat-a');
  index.rebuild([doc('title',1,{title:'生锈钥匙'}),doc('body',1,{body:'发现生锈钥匙'})]);
  const results=index.search('生锈钥匙');
  assert.equal(results[0].id,'title');
  assert.ok(results[0].score>results[1].score);
  assert.throws(()=>index.rebuild([doc('wrong',4,{title:'钥匙'},'chat-b')]),/跨聊天/);
  assert.equal(index.search('钥匙').length,2); // index rebuild was rejected, original corpus remains
});

test('BM25F reset invalidates deleted or edited content',()=>{
  const index=new BM25FIndex('chat-a');
  index.rebuild(corpus);
  assert.equal(index.search('生锈钥匙')[0].id,'a');
  index.rebuild([doc('a',1,{title:'一块星石'}),corpus[1],corpus[2]]);
  assert.equal(index.search('钥匙').some(hit=>hit.id==='a'),false);
  index.rebuild([]);
  assert.deepEqual(index.search('钥匙'),[]);
});

test('BM25F produces bounded deterministic hits and rejects unsafe settings',()=>{
  const idx=new BM25FIndex('chat-a',{fields:{title:{boost:4,b:.3}}});
  idx.rebuild(corpus);
  assert.deepEqual(idx.search('钥匙',1).map(x=>x.id),['a']);
  assert.equal(idx.search('ultraunrelatedtoken998').length,0);
  assert.throws(()=>new BM25FIndex('chat-a',{fields:{body:{b:1.5}}}),/参数/);
  assert.throws(()=>idx.search('钥匙',101),/数量/);
});

test('distributed schedule updates fast fields every turn and slow fields independently',()=>{
  const input={
    contract:demoContract,completedTurns:[1,2,3,4,5],
    lastProcessed:{'角色.好感度':4,'背包.物资':1,'世界.阶段':3},
    policies:{
      '角色.好感度':{every:1,batchSize:2,contextDepth:1,group:'relations'},
      '背包.物资':{every:2,batchSize:2,contextDepth:3,group:'items'},
      '世界.阶段':{every:3,batchSize:5},
      '角色.信任等级':{every:0},
    }
  };
  const plan=buildVariableUpdatePlan(input);
  const affection=plan.groups.find(g=>g.paths.includes('角色.好感度'));
  const inventory=plan.groups.find(g=>g.paths.includes('背包.物资'));
  assert.deepEqual(affection.turns,[5]);
  assert.deepEqual(inventory.turns,[2,3]);
  assert.equal(inventory.advanceTo,3);
  assert.equal(plan.groups.some(g=>g.paths.includes('世界.阶段')),false);
  assert.ok(plan.pending.includes('世界.阶段'));
  assert.ok(plan.disabled.includes('剧情.关键标记'));
  assert.ok(plan.disabled.includes('角色.信任等级'));
});

test('skipping newest turns and small context never discards historical backlog',()=>{
  const p=buildVariableUpdatePlan({
    contract:demoContract,completedTurns:[1,2,3,4,5,6,7,8,9],
    lastProcessed:{'角色.好感度':0}, policies:{'角色.好感度':{
      every:1,skipLatest:2,batchSize:3,contextDepth:1
    }}
  });
  const one=p.groups.find(x=>x.paths.includes('角色.好感度'));
  assert.deepEqual(one.turns,[1,2,3]);
  assert.equal(one.advanceTo,3);
  assert.equal(one.contextDepth,1);
  assert.throws(()=>buildVariableUpdatePlan({
    contract:demoContract,completedTurns:[1,1],lastProcessed:{}
  }),/重复/);
});

test('observation includes latest batch evidence even when BM25F sparse misses',()=>{
  const contract=demoContract;
  const snapshot=initialSnapshot(contract);
  const group={key:'g',paths:['角色.好感度'],turns:[2],advanceTo:2,contextDepth:1,group:'relationships'};
  const idx=new BM25FIndex('chat-a');
  idx.rebuild(corpus);
  const obs=prepareVariableObservation(contract,snapshot,group,corpus,idx);
  assert.ok(obs.evidence.some(e=>e.id==='b'));
  assert.equal(obs.fields.length,1);
  assert.equal(Object.keys(obs.fields[0].dependencies).length,0);
  assert.ok(obs.evidence.every(e=>e.turn<=2));
});

test('strict agent proposal rejects missing fields, false citations, no batch proof, bad values',()=>{
  const group={key:'g',paths:['角色.好感度','世界.阶段'],turns:[3],advanceTo:3,contextDepth:2,group:'default'};
  const index=new BM25FIndex('chat-a'); index.rebuild(corpus);
  const snap=initialSnapshot(demoContract);
  const obs=prepareVariableObservation(demoContract,snap,group,corpus,index);
  const unchanged={path:'世界.阶段',action:'unchanged',reason:'未有推进章节的明确剧情',evidenceIds:[]};
  const changed={path:'角色.好感度',action:'set',value:53,reason:'对方明确认可玩家的帮助',evidenceIds:['c']};
  assert.deepEqual(Object.keys(validateVariableDecisions({decisions:[changed,unchanged]},obs,demoContract,snap).updates),['角色.好感度']);
  assert.throws(()=>validateVariableDecisions({decisions:[changed]},obs,demoContract,snap),/每个/);
  assert.throws(()=>validateVariableDecisions({decisions:[{...changed,evidenceIds:['not-real']},unchanged]},obs,demoContract,snap),/观察范围以外/);
  assert.throws(()=>validateVariableDecisions({decisions:[{...changed,value:800},unchanged]},obs,demoContract,snap),/大于最大值/);
  assert.throws(()=>validateVariableDecisions({decisions:[{...changed,evidenceIds:['b']},unchanged]},obs,demoContract,snap),/本批次/);
  assert.throws(()=>validateVariableDecisions({decisions:[{...changed,action:'unchanged'},unchanged]},obs,demoContract,snap),/不应提供新值/);
});

test('cycle commits only validated groups and advances watermarks for unchanged decisions',async()=>{
  const seen=[];
  const snapshot=initialSnapshot(demoContract);
  const result=await runVariableUpdateCycle({
    contract:demoContract,scope:'chat-a',snapshot,documents:corpus,completedTurns:[1,2,3],lastProcessed:{},
    policies:{'背包.物资':{every:0},'世界.阶段':{every:0},'角色.信任等级':{every:0},'记忆.已知线索':{every:0}},
    propose:async observation=>({decisions:observation.fields.map(f=>({
      path:f.path,action:'unchanged',reason:'当前没有充分的变化证据',evidenceIds:[]
    }))}),
    atomicCommit:async commit=>{seen.push(commit);},
  });
  assert.equal(result.errors.length,0);
  assert.equal(result.committed,1);
  assert.equal(seen.length,1);
  assert.deepEqual(Object.keys(seen[0].updates),[]);
  assert.equal(seen[0].advance['角色.好感度'],3);
  assert.equal(result.advanced['角色.好感度'],3);
});

test('cycle never advances a field after rejected model output or rejected transaction',async()=>{
  let commits=0;
  const base={
    contract:demoContract,scope:'chat-a',snapshot:initialSnapshot(demoContract),
    documents:corpus,completedTurns:[1,2],lastProcessed:{},
    policies:{'背包.物资':{every:0},'世界.阶段':{every:0},'角色.信任等级':{every:0},'记忆.已知线索':{every:0}},
  };
  const invalid=await runVariableUpdateCycle({...base,propose:async()=>({decisions:[]}),atomicCommit:async()=>{commits++;}});
  assert.equal(invalid.committed,0);
  assert.equal(invalid.errors.length,1);
  assert.equal(commits,0);
  assert.equal(invalid.advanced['角色.好感度'],undefined);
  const rejected=await runVariableUpdateCycle({...base,
    propose:async obs=>({decisions:obs.fields.map(f=>({path:f.path,action:'unchanged',reason:'未发生新的变化',evidenceIds:[]}))}),
    atomicCommit:async()=>{throw new Error('save failed');}
  });
  assert.equal(rejected.committed,0);
  assert.match(rejected.errors[0].reason,/save failed/);
});
