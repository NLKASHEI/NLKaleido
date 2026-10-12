import test from 'node:test';
import assert from 'node:assert/strict';
import { demoContract, addField, updateField, removeField, demoProposals, acceptedUpdates } from '../.build/ui/model.js';
import { initialSnapshot, applyValues } from '../.build/index.js';

test('author UI can create, rename and delete fields and maintain dependencies', () => {
  const created=addField(demoContract);
  assert.equal(Object.keys(created.updateRules).length,7);
  const renamed=updateField(created,'角色.好感度',{path:'角色.关系',label:'关系'});
  assert.deepEqual(renamed.updateRules['角色.信任等级'].dependencies,['角色.关系']);
  assert.throws(()=>updateField(renamed,'角色.关系',{path:'背包.物资'}),/已存在/);
  const removed=removeField(renamed,'角色.关系');
  assert.deepEqual(removed.updateRules['角色.信任等级'].dependencies,[]);
  assert.equal(Object.keys(removed.updateRules).length,6);
});

test('demonstration proposals are explicitly local and never self-commit', () => {
  const snapshot=initialSnapshot(demoContract);
  const proposals=demoProposals(demoContract,snapshot);
  assert.equal(proposals.length,3);
  assert.equal(proposals.find(p=>p.path==='世界.阶段').mode,'unchanged');
  assert.equal(snapshot.stat_data.角色.好感度,50);
  const updates=acceptedUpdates(proposals);
  assert.equal(updates['角色.好感度'],53);
  assert.deepEqual(updates['背包.物资'],['生锈的钥匙']);
  assert.equal(Object.hasOwn(updates,'世界.阶段'),false);
  const committed=applyValues(demoContract,snapshot,updates).snapshot;
  assert.equal(committed.stat_data.角色.好感度,53);
  assert.equal(snapshot.stat_data.角色.好感度,50);
});
