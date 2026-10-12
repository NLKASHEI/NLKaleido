import test from 'node:test';
import assert from 'node:assert/strict';
import { buildPlayerView, playerEmptyMessage } from '../.build/player/model.js';
import { demoContract } from '../.build/ui/model.js';
import { initialSnapshot, applyValues } from '../.build/index.js';

const init=initialSnapshot(demoContract);

test('player status makes only publicly declared metrics visible',()=>{
  const snap=applyValues(demoContract,init,{
    '角色.好感度':72, '角色.信任等级':3, '背包.物资':['旧书','蓝色水晶','生锈的钥匙'],
    '记忆.已知线索':{'星港':'信号来自旧码头'},
    '剧情.关键标记':true,
  }).snapshot;
  const data=buildPlayerView(demoContract,snap,[
    {at:'today',changed:['剧情.关键标记','角色.好感度','背包.物资'],
     before:{'剧情.关键标记':false,'角色.好感度':69,'背包.物资':[]},
     after:{'剧情.关键标记':true,'角色.好感度':72,'背包.物资':['旧书','蓝色水晶','生锈的钥匙']}},
  ]);
  assert.equal(data.title,'星海旅人');
  assert.equal(data.featured[0].text,'72');
  assert.equal(data.featured[0].percentage,72);
  assert.equal(data.featured[1].text,'3');
  assert.deepEqual(data.inventory,['旧书','蓝色水晶','生锈的钥匙']);
  assert.deepEqual(data.clues,[{title:'星港',detail:'信号来自旧码头'}]);
  assert.equal(data.metrics.some(x=>x.path==='剧情.关键标记'),false);
  assert.equal(data.recent.some(x=>x.path==='剧情.关键标记'),false);
  assert.equal(JSON.stringify(data).includes('关键标记'),false);
});

test('never leak a hidden field through inventory, clues or change history',()=>{
  const minimal={version:1,id:'隐私测试',updateRules:{
    '秘密.线索':{path:'秘密.线索',type:'object',default:{'机密':'无人可知'},display:false},
    '秘密.物品':{path:'秘密.物品',type:'list',default:['私人物件'],display:false},
    '公开.状态':{path:'公开.状态',type:'string',default:'正常',display:true}
  }};
  const projected=buildPlayerView(minimal,initialSnapshot(minimal),[
    {at:'2026',changed:['秘密.线索','秘密.物品','公开.状态'],
     before:{'秘密.线索':{},'秘密.物品':[],'公开.状态':'之前'},
     after:{'秘密.线索':{'机密':'不会展示'},'秘密.物品':['非常秘密'],'公开.状态':'正常'}},
  ]);
  assert.equal(projected.metrics.length,1);
  assert.deepEqual(projected.inventory,[]);
  assert.deepEqual(projected.clues,[]);
  assert.equal(projected.recent.length,1);
  const serialized=JSON.stringify(projected);
  for(const secret of ['无人可知','非常秘密','不会展示','秘密.'])assert.equal(serialized.includes(secret),false);
});

test('unknown metrics are shown in a generic section, not silently lost',()=>{
  const contract={version:1,id:'通用状态',updateRules:{
    '玩家.饥饿度':{path:'玩家.饥饿度',type:'number',default:5,min:0,max:10},
    '世界.天气':{path:'世界.天气',type:'string',default:'晴朗'},
  }};
  const data=buildPlayerView(contract,initialSnapshot(contract));
  assert.equal(data.others.length,2);
  assert.equal(data.others[0].percentage,50);
  assert.equal(data.others[1].text,'晴朗');
  assert.equal(data.featured.length,0);
  assert.deepEqual(data.recent,[]);
});

test('bad archive is rejected, never replaced by fabricated status',()=>{
  assert.throws(()=>buildPlayerView(demoContract,{schemaVersion:999}),/存档版本/);
  assert.match(playerEmptyMessage('missing'),/还没有配置/);
});
