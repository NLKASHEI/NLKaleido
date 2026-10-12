import { parseContract, type Contract, type FieldRule } from '../core/contract.js';
import { getValue, readSnapshot, type Snapshot } from '../core/state.js';

export type PlayerMetric = {
  path: string;
  title: string;
  text: string;
  hint?: string;
  percentage?: number;
  maximum?: number;
  numericValue?: number;
  kind: 'affection'|'trust'|'chapter'|'world'|'inventory'|'clues'|'goal'|'ordinary';
};
export type PlayerChange = { path: string; label: string; summary: string; at: string };
export type PlayerClue = { title: string; detail: string };
export type PlayerView = {
  title: string;
  metrics: PlayerMetric[];
  featured: PlayerMetric[];
  others: PlayerMetric[];
  inventory: string[];
  clues: PlayerClue[];
  recent: PlayerChange[];
};
export type PlayerHistoryEntry = {
  at: string;
  changed: string[];
  before: Record<string,unknown>;
  after: Record<string,unknown>;
  reverted?: boolean;
};

const bounded = (text: string, max=90): string =>
  text.length > max ? text.slice(0,max-1) + '…' : text;

function visibleName(rule: FieldRule): string {
  return bounded(rule.label?.trim() || rule.path.split('.').at(-1) || rule.path, 35);
}

function kindOf(rule: FieldRule): PlayerMetric['kind'] {
  const text = rule.path + ' ' + (rule.label??'');
  if (/好感|亲密|affection/i.test(text)) return 'affection';
  if (/信任|trust/i.test(text)) return 'trust';
  if (/章节|章目|chapter/i.test(text)) return 'chapter';
  if (/阶段|世界进度|world/i.test(text)) return 'world';
  if (/物资|背包|道具|inventory/i.test(text)) return 'inventory';
  if (/线索|已知|clue/i.test(text)) return 'clues';
  if (/目标|任务|objective|quest/i.test(text)) return 'goal';
  return 'ordinary';
}

function valueText(value: unknown): string {
  if (typeof value === 'boolean') return value ? '已完成' : '未完成';
  if (typeof value === 'number') return String(value);
  if (typeof value === 'string') return bounded(value);
  if (Array.isArray(value)) return value.length + ' 项';
  if (value && typeof value === 'object') return Object.keys(value).length + ' 条';
  return '暂无';
}

function itemNames(value: unknown, limit: number): string[] {
  if (Array.isArray(value)) {
    return value.slice(0,limit).map(item => {
      if (typeof item === 'string') return bounded(item,35);
      if (typeof item === 'number') return String(item);
      if (item && typeof item === 'object' && !Array.isArray(item)) {
        const record=item as Record<string,unknown>;
        for(const key of ['name','名称','物品','title']){
          if(typeof record[key] === 'string') return bounded(record[key] as string,35);
        }
      }
      return '未命名物品';
    });
  }
  if (value && typeof value === 'object') return Object.keys(value).slice(0,limit).map(x => bounded(x,35));
  return [];
}

function clueItems(value: unknown, limit: number): PlayerClue[] {
  if (Array.isArray(value)) return value.slice(0,limit).map((item,index) => {
    if (typeof item === 'string') return {title:bounded(item,42), detail:''};
    if (item && typeof item==='object' && !Array.isArray(item)) {
      const data=item as Record<string,unknown>;
      const title=data.name??data.title??data['名称'];
      const desc=data.description??data.detail??data['描述'];
      return {title:typeof title==='string'?bounded(title,42):'线索 '+(index+1),
        detail:typeof desc==='string'?bounded(desc,100):''};
    }
    return {title:'已发现线索 '+(index+1),detail:''};
  });
  if (value && typeof value === 'object') {
    return Object.entries(value).slice(0,limit).map(([key,entry])=>({
      title:bounded(key,42),
      detail:typeof entry==='string'?bounded(entry,100):'',
    }));
  }
  return [];
}

function changeText(before: unknown, after: unknown): string {
  if (typeof before==='number' && typeof after==='number') {
    const d=after-before;
    return d>0?'+'+d:String(d);
  }
  if(Array.isArray(before)&&Array.isArray(after)){
    const d=after.length-before.length;
    return d>0?'新增 '+d+' 项':d<0?'减少 '+(-d)+' 项':'物品已更新';
  }
  return bounded(valueText(after),40);
}

/**
 * Read-only player projection. Strict allowlist: fields with display!==false
 * are the ONLY source for metrics, recent changes, inventory and clues.
 * Nothing from contract author notes, rules, or other private fields is copied.
 */
export function buildPlayerView(raw: Contract, snapshot: Snapshot, history: PlayerHistoryEntry[]=[]): PlayerView {
  const contract = parseContract(raw);
  const safeSnapshot=readSnapshot(contract,snapshot);
  const fields=Object.values(contract.updateRules).filter(rule=>rule.display!==false);
  const metrics: PlayerMetric[]=fields.map(rule=>{
    const value=getValue(contract,safeSnapshot,rule.path);
    const kind=kindOf(rule);
    const item:PlayerMetric={
      path:rule.path,
      title:visibleName(rule),
      text:valueText(value),
      kind,
    };
    if(typeof value==='number'){
      item.numericValue=value;
      if(rule.max!==undefined) item.maximum=rule.max;
      if(rule.min!==undefined && rule.max!==undefined && rule.max>rule.min){
        item.percentage=Math.max(0,Math.min(100,(value-rule.min)/(rule.max-rule.min)*100));
      }
    }
    return item;
  });
  const byKind=(kind:PlayerMetric['kind'])=>metrics.find(metric=>metric.kind===kind);
  const featured=[byKind('affection'),byKind('trust')].filter((v):v is PlayerMetric=>Boolean(v));
  const others=metrics.filter(m=>!featured.includes(m)&&!['inventory','clues'].includes(m.kind));
  const inventoryRule=fields.find(rule=>kindOf(rule)==='inventory');
  const cluesRule=fields.find(rule=>kindOf(rule)==='clues');
  const inventory=inventoryRule?itemNames(getValue(contract,safeSnapshot,inventoryRule.path),8):[];
  const clues=cluesRule?clueItems(getValue(contract,safeSnapshot,cluesRule.path),5):[];
  const recent:PlayerChange[]=[];
  for(const entry of history.slice(0,40)){
    if(entry.reverted || !Array.isArray(entry.changed)) continue;
    for(const path of entry.changed){
      const rule=contract.updateRules[path];
      if(!rule || rule.display===false || !Object.hasOwn(entry.after,path)) continue;
      if(recent.length>=4) break;
      recent.push({
        path,
        label:visibleName(rule),
        summary:changeText(entry.before[path],entry.after[path]),
        at:bounded(entry.at||'',32),
      });
    }
    if(recent.length>=4)break;
  }
  return {
    title:bounded(contract.id,65), metrics, featured, others, inventory, clues, recent,
  };
}

export function playerEmptyMessage(reason: 'missing'|'invalid'|'disconnected'): string {
  if(reason==='missing')return '这段对话还没有配置可显示的状态。';
  if(reason==='disconnected')return '暂时无法读取这段对话的状态。';
  return '状态数据与当前契约不匹配，请联系作者检查。';
}
