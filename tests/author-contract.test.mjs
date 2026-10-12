import test from 'node:test';
import assert from 'node:assert/strict';
import { parseContract, initialSnapshot, applyValues } from '../.build/index.js';

const make = (rules) => ({ id: 'demo', version: 1, updateRules: rules });
test('UI metadata survives contract validation and round-trip', () => {
  const validated = parseContract(make({
    '世界.阶段': { path: '世界.阶段', type: 'string', default: '序章' },
    '角色.好感度': { path: '角色.好感度', type: 'number', default: 40, min: 0, max: 100, label: '好感度', changeRule: '互动时缓慢变化', dependencies: ['世界.阶段'], updateMode: 'afterReply', display: true },
  }));
  assert.equal(validated.updateRules['角色.好感度'].changeRule, '互动时缓慢变化');
  assert.deepEqual(parseContract(JSON.parse(JSON.stringify(validated))), validated);
  assert.throws(() => applyValues(validated, initialSnapshot(validated), { '角色.好感度': 101 }), /大于最大值/);
});
test('visual editor contracts reject bad dependencies and cycles', () => {
  const a = { path: '甲', type: 'number', default: 0, dependencies: ['乙'] };
  const b = { path: '乙', type: 'number', default: 0, dependencies: ['甲'] };
  assert.throws(() => parseContract(make({甲:a,乙:b})), /循环/);
  assert.throws(() => parseContract(make({甲:{...a,dependencies:['丙']}})), /未声明/);
  assert.throws(() => parseContract(make({甲:{...a,dependencies:[],min:5,max:2}})), /最小值/);
});
