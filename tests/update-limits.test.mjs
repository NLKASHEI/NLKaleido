import test from 'node:test';
import assert from 'node:assert/strict';
import { parseContract, initialSnapshot } from '../.build/index.js';
import { validateVariableDecisions } from '../.build/update/pipeline.js';

test('author-set maxDelta blocks a believable-looking but oversized model change',()=>{
  const contract=parseContract({version:1,id:'角色关系',
    updateRules:{'角色.好感度':{
      path:'角色.好感度',type:'number',default:50,min:0,max:100,maxDelta:5,
      changeRule:'单次好感度变化不超过 5'
    }}
  });
  const snapshot=initialSnapshot(contract);
  const observation={
    scope:'c',turns:[1],
    fields:[{path:'角色.好感度',type:'number',value:50,description:'',changeRule:'不超过 5',dependencies:{}}],
    evidence:[{id:'turn1',scope:'c',turn:1,fields:{body:'发生一次友好交谈'}}]
  };
  const decide=(value)=>({decisions:[{path:'角色.好感度',action:'set',value,
    reason:'双方明确建立了更进一步的友好关系',evidenceIds:['turn1']}]});
  assert.throws(()=>validateVariableDecisions(decide(90),observation,contract,snapshot),/单次变量变化超过/);
  assert.equal(validateVariableDecisions(decide(55),observation,contract,snapshot).updates['角色.好感度'],55);
});

test('maxDelta only belongs to numerical contract fields and survives JSON roundtrip',()=>{
  const c={version:1,id:'delta',updateRules:{a:{path:'a',type:'number',default:20,maxDelta:4,updateEvery:1}}};
  assert.equal(parseContract(c).updateRules.a.maxDelta,4);
  assert.equal(parseContract(JSON.parse(JSON.stringify(c))).updateRules.a.updateEvery,1);
  const bad={version:1,id:'bad',updateRules:{a:{path:'a',type:'string',default:'x',maxDelta:5}}};
  assert.throws(()=>parseContract(bad),/只有数值字段/);
});
