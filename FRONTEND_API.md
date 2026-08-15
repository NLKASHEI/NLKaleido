# NLKaleido 角色卡前端变量 API

角色卡前端通过 `window.NLKaleido.variables` 访问当前聊天的变量。API 只接受作者契约中已经声明的路径；无需在作者界面逐变量授权。

## 快速开始

```js
const api = window.NLKaleido?.variables;
if (!api) throw new Error('NLKaleido 尚未加载');

const affection = api.get('角色.好感度');
const result = await api.set('角色.好感度', 80);
if (!result.ok) console.warn(result.error);

const unsubscribe = api.subscribe((variables) => {
  renderCharacterPanel(variables);
});

// 页面卸载时取消监听
unsubscribe();
```

## 方法

### `get(path)`

读取一个声明变量。返回的是副本，直接修改返回对象不会修改存档。路径未声明或当前没有状态时返回 `undefined`。

### `list()`

返回变量描述数组：

```ts
interface VariableDescriptor {
  path: string;
  type: 'string' | 'number' | 'boolean' | 'list' | 'object' | 'kv';
  value: unknown;
  display: boolean;
  frontendWritable: true;
  description?: string;
}
```

适合根据契约自动生成角色状态栏、表单或调试面板。

### `await set(path, value)`

写入一个变量。Promise 完成时，校验、派生变量重算、审计日志和聊天存档均已完成。

```js
const result = await api.set('背包.金币', 120);
// 成功：{ ok: true, changed: ['背包.金币'] }
// 拒绝：{ ok: false, error: '给作者看的可读原因' }
```

### `await setMany(values)`

一次提交多个变量。所有修改先一起校验；任何一项非法时全部不写入。

```js
await api.setMany({
  '角色.好感度': 80,
  '世界.章节': '第二章',
});
```

### `subscribe(listener)`

状态成功保存后调用监听器，并传入与 `list()` 相同的变量描述数组。返回取消监听函数。

## 写入边界

- 只能写作者契约中已经声明的路径，不能临时创建任意变量。
- 值必须符合变量类型；拒绝 `NaN`、`Infinity`、危险对象键和异常深度的数据。
- 契约中的跨字段不变量仍会执行。
- 多次并发写入按调用顺序串行提交。
- 存档失败时内存状态会自动回滚，Promise 会 reject。
- `updateMode: "fixed"` 只禁止变量 AI 自动改写，不禁止作者或前端显式写入。

如果希望增加前端可用的新变量，请先在作者端“变量设计”中声明并保存，再调用 API。
