import test from 'node:test';
import assert from 'node:assert/strict';
import { runVariableUpdateCycle } from '../.build/index.js';
import { initialSnapshot } from '../.build/index.js';
import { demoContract } from '../.build/ui/model.js';

test('malformed first proposal gets one correction retry then a durable commit',async()=>{
  let calls=0;
  const commits=[];
  const result=await runVariableUpdateCycle({
    scope:'recovery-chat',contract:demoContract,snapshot:initialSnapshot(demoContract),
    completedTurns:[1],lastProcessed:{},
    documents:[{id:'reply-1',scope:'recovery-chat',turn:1,fields:{body:'角色认可了玩家的帮助'}}],
    policies:{
      '背包.物资':{every:0},'世界.阶段':{every:0},
      '角色.信任等级':{every:0},'记忆.已知线索':{every:0},
    },
    propose:async(obs,feedback)=>{
      calls++;
      if(calls===1){assert.equal(feedback,undefined);return '{oops';}
      assert.match(feedback,/JSON/);
      return JSON.stringify({decisions:obs.fields.map(f=>({
        path:f.path,action:'set',value:51,reason:'角色直接表达了感谢和认同',evidenceIds:['reply-1']
      }))});
    },
    atomicCommit:async tx=>{commits.push(tx);}
  });
  assert.equal(calls,2);
  assert.equal(commits.length,1);
  assert.equal(result.committed,1);
  assert.equal(result.errors.length,0);
  assert.equal(result.advanced['角色.好感度'],1);
});

test('repeat malformed proposals fail closed after one retry with unchanged checkpoint',async()=>{
  let calls=0;
  const result=await runVariableUpdateCycle({
    scope:'recovery-chat',contract:demoContract,snapshot:initialSnapshot(demoContract),
    completedTurns:[1],lastProcessed:{},
    documents:[{id:'reply-1',scope:'recovery-chat',turn:1,fields:{body:'普通交谈'}}],
    policies:{
      '背包.物资':{every:0},'世界.阶段':{every:0},
      '角色.信任等级':{every:0},'记忆.已知线索':{every:0},
    },
    propose:async()=>{calls++;return 'not json'},
    atomicCommit:async()=>{throw new Error('should not call');},
  });
  assert.equal(calls,2);
  assert.equal(result.committed,0);
  assert.equal(result.advanced['角色.好感度'],undefined);
  assert.equal(result.errors.length,1);
});
