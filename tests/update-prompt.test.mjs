import test from 'node:test';
import assert from 'node:assert/strict';
import { buildUpdatePrompt, parseProposalText, fuseRankedEvidence } from '../.build/index.js';
import { buildVariableUpdatePlan } from '../.build/update/scheduler.js';
import { demoContract } from '../.build/ui/model.js';

test('stable system prompt and changing trailing observation',()=>{
  const common={scope:'c',turns:[2],fields:[{path:'角色.好感度',type:'number',value:30,changeRule:'只随互动变化',description:'',dependencies:{}}],evidence:[
    {id:'reply-2',scope:'c',turn:2,fields:{body:'玩家道谢'}},
  ]};
  const first=buildUpdatePrompt(common);
  const second=buildUpdatePrompt({...common,evidence:[{...common.evidence[0],fields:{body:'玩家道歉'}}]});
  assert.equal(first.system,second.system);
  assert.notEqual(first.user,second.user);
  assert.match(first.system,/unchanged/);
  assert.match(first.system,/untrusted/);
  assert.match(first.user,/reply-2/);
});
test('model envelope parser rejects non-JSON text and accepts strict or fenced JSON',()=>{
  assert.deepEqual(parseProposalText('{"decisions":[]}'),{decisions:[]});
  const fence=String.fromCharCode(96).repeat(3);
  assert.deepEqual(parseProposalText(fence+'json\n{"decisions":[]}\n'+fence),{decisions:[]});
  assert.throws(()=>parseProposalText('Ok, here you go: {"decisions":[]}'),/JSON 对象/);
});
test('RRF merges sparse and optional dense rankings without duplication',()=>{
  const hit=(id,turn=1)=>({id,turn,score:1,fields:{title:id}});
  const result=fuseRankedEvidence([[hit('x'),hit('y')],[hit('y'),hit('z')]],60,3);
  assert.equal(result.length,3);
  assert.equal(result[0].id,'y');
  assert.equal(new Set(result.map(x=>x.id)).size,3);
});
test('author updateEvery is used when no runtime override is supplied',()=>{
  const contract=structuredClone(demoContract);
  contract.updateRules['角色.好感度'].updateEvery=3;
  const plan=buildVariableUpdatePlan({
    contract,completedTurns:[1,2],lastProcessed:{},
    policies:{'背包.物资':{every:0},'世界.阶段':{every:0},'角色.信任等级':{every:0},'记忆.已知线索':{every:0}}
  });
  assert.equal(plan.groups.some(g=>g.paths.includes('角色.好感度')),false);
  assert.ok(plan.pending.includes('角色.好感度'));
  const ready=buildVariableUpdatePlan({
    contract,completedTurns:[1,2,3],lastProcessed:{},
    policies:{'背包.物资':{every:0},'世界.阶段':{every:0},'角色.信任等级':{every:0},'记忆.已知线索':{every:0}}
  });
  assert.equal(ready.groups.some(g=>g.paths.includes('角色.好感度')),true);
});
