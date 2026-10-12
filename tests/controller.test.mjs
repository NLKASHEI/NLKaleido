import test from 'node:test';
import assert from 'node:assert/strict';
import { createVariableController, createStVariableBridge, EXPERIMENTAL_METADATA_KEY } from '../.build/index.js';

const contract = {
  id: '测试卡', version: 1,
  updateRules: {
    '角色.好感度': { path: '角色.好感度', type: 'number', default: 50, display: true },
    '背包.物资': { path: '背包.物资', type: 'list', default: [] },
    '世界.阶段': { path: '世界.阶段', type: 'string', default: '序章', updateMode: 'fixed' },
  },
};
const store = () => {
  let disk = null, calls = 0, fail = false, identity = {};
  return {
    storage: {
      identity: () => identity,
      load: () => disk,
      save: async snap => { calls++; if (fail) throw new Error('存档失败'); disk = structuredClone(snap); },
    },
    reads: () => ({ disk, calls }),
    reject: value => { fail = value; },
    nextChat: () => { identity = {}; disk = null; },
  };
};

test('default state and copies are safe; fixed fields are manually editable', async () => {
  const s = store();
  const api = createVariableController(contract, s.storage);
  assert.equal(api.get('角色.好感度'), 50);
  assert.equal(api.get('未知'), undefined);
  const list = api.list();
  list[1].value.push({ name: 'changed outside' });
  assert.deepEqual(api.get('背包.物资'), []);
  assert.deepEqual(await api.set('世界.阶段', '第一章'), { ok: true, changed: ['世界.阶段'] });
  assert.equal(api.get('世界.阶段'), '第一章');
  assert.equal(s.reads().calls, 1);
});

test('atomic validation: invalid second update prevents first, and no save', async () => {
  const s = store();
  const api = createVariableController(contract, s.storage);
  const result = await api.setMany({ '角色.好感度': 99, '世界.阶段': 42 });
  assert.equal(result.ok, false);
  assert.equal(api.get('角色.好感度'), 50);
  assert.equal(s.reads().calls, 0);
  assert.deepEqual(await api.set('未声明.变量', 1), { ok: false, error: '变量未在契约声明: 未声明.变量' });
});

test('serial writes, no-op saves and notifications only after durable success', async () => {
  const s = store();
  const api = createVariableController(contract, s.storage);
  const observed = [];
  const un = api.subscribe(values => observed.push(values.find(v => v.path === '角色.好感度').value));
  const [a,b] = await Promise.all([api.set('角色.好感度', 51), api.set('角色.好感度', 52)]);
  assert.equal(a.ok, true); assert.equal(b.ok, true);
  assert.deepEqual(observed, [51,52]);
  assert.equal(s.reads().disk.stat_data.角色.好感度, 52);
  assert.deepEqual(await api.set('角色.好感度', 52), {ok:true,changed:[]});
  assert.equal(s.reads().calls, 2);
  un();
});

test('save failure rejects without exposing uncommitted state', async () => {
  const s = store();
  const api = createVariableController(contract, s.storage);
  s.reject(true);
  await assert.rejects(api.set('角色.好感度', 90), /存档失败/);
  assert.equal(api.get('角色.好感度'), 50);
  s.reject(false);
  assert.equal((await api.set('角色.好感度', 60)).ok, true);
});

test('switching chats reloads default state, blocks queued writes from previous chat', async () => {
  const s = store();
  const api = createVariableController(contract, s.storage);
  const a = api.set('角色.好感度', 55);
  s.nextChat();
  assert.deepEqual(await a, { ok:false, error:'聊天已切换，取消旧聊天写入' });
  assert.equal(api.get('角色.好感度'), 50);
  assert.equal((await api.set('角色.好感度', 70)).ok, true);
  assert.equal(api.get('角色.好感度'), 70);
});

test('reject dangerous keys, non-finite numbers, cycles, and invalid archive versions', async () => {
  const s = store();
  const api = createVariableController(contract, s.storage);
  assert.equal((await api.set('角色.好感度', Infinity)).ok, false);
  const value = JSON.parse('{"__proto__":{"polluted":true}}');
  assert.match((await api.set('背包.物资', [value])).error, /危险字段/);
  const cyclic = []; cyclic.push(cyclic);
  assert.match((await api.set('背包.物资', cyclic)).error, /循环引用/);
  assert.equal({}.polluted, undefined);
  assert.throws(() => createVariableController(contract, {...s.storage,load:()=>({schemaVersion:999})}), /存档版本/);
});

test('SillyTavern adapter uses isolated namespace; failed saves restore metadata', async () => {
  const original = { chatMetadata: { variables: { nlkaleido: { stat_data: {legacy:true} } } },
    saveMetadata: async () => {}, event_types:{CHAT_CHANGED:'chat_id_changed'}, eventSource:{on:()=>{}} };
  let current = original;
  const api = createStVariableBridge(contract, () => current);
  assert.equal((await api.set('角色.好感度', 61)).ok, true);
  assert.equal(original.chatMetadata[EXPERIMENTAL_METADATA_KEY].stat_data.角色.好感度, 61);
  assert.equal(original.chatMetadata.variables.nlkaleido.stat_data.legacy, true);
  original.saveMetadata = async()=>{throw new Error('disk full')};
  await assert.rejects(api.set('角色.好感度', 62), /存档失败/);
  assert.equal(original.chatMetadata[EXPERIMENTAL_METADATA_KEY].stat_data.角色.好感度, 61);
  current={...original,chatMetadata:{}};
  assert.equal(api.get('角色.好感度'), 50);
});

test('chat switches during an in-flight ST save never publish old state into new chat', async () => {
  let releaseSave;
  const old = { chatMetadata: {}, saveMetadata: () => new Promise(resolve => { releaseSave = resolve; }) };
  let current = old;
  const api = createStVariableBridge(contract, () => current);
  const write = api.set('角色.好感度', 80);
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(typeof releaseSave, 'function');
  current = { chatMetadata: {}, saveMetadata: async () => {} };
  releaseSave();
  await assert.rejects(write, /存档失败/);
  assert.equal(current.chatMetadata[EXPERIMENTAL_METADATA_KEY], undefined);
  assert.equal(old.chatMetadata[EXPERIMENTAL_METADATA_KEY], undefined);
  assert.equal(api.get('角色.好感度'), 50);
});
