import type { PlayerMetric, PlayerView } from './model.js';

export type PlayerStatusResult =
  | { kind:'ready'; view:PlayerView; mode:'chat'|'demo' }
  | { kind:'empty'|'error'; message:string };

export type PlayerStatusSource = () => Promise<PlayerStatusResult>;

const html=(s:unknown):string=>String(s??'').replace(/[&<>"']/g,c=>({
  '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'
}[c]??c));
const clamp=(n:number)=>Math.max(0,Math.min(100,n));

function icon(kind:PlayerMetric['kind']|string):string{
  const symbols:Record<string,string>={
    affection:'♡',trust:'✦',chapter:'▤',world:'◎',inventory:'▣',clues:'✧',
    goal:'⚑',ordinary:'◆',recent:'↗',refresh:'↻',
  };
  return symbols[kind]??'◆';
}
const TYPE_STYLE:Record<string,string>={
  affection:'pink',trust:'blue',chapter:'lavender',world:'teal',
  inventory:'blue',clues:'lavender',goal:'teal',ordinary:'blue',
};

function metricCard(item:PlayerMetric,large=false):string{
  const range=item.maximum!==undefined?' / '+html(item.maximum):'';
  const progress=item.percentage===undefined?'':(
    '<div class="p-progress" role="progressbar" aria-label="'+html(item.title)+
    '" aria-valuenow="'+clamp(item.percentage).toFixed(0)+'" aria-valuemin="0" aria-valuemax="100">'+
    '<span style="width:'+clamp(item.percentage).toFixed(2)+'%"></span></div>'
  );
  return '<div class="p-metric '+TYPE_STYLE[item.kind]+' '+(large?'large':'')+'">'+
    '<div class="p-metric-top"><span class="p-icon">'+icon(item.kind)+'</span>'+
    '<span class="p-metric-label">'+html(item.title)+'</span></div>'+
    '<div class="p-metric-value">'+html(item.text)+
    (item.numericValue!==undefined && item.maximum!==undefined?'<small>'+range+'</small>':'')+'</div>'+
    progress+'</div>';
}

function renderReady(data:PlayerView,mode:'chat'|'demo'):string{
  const primary=data.featured.slice(0,2);
  const others=data.others.slice(0,6);
  const hasAnything=Boolean(data.metrics.length);
  const tagline=mode==='demo'?'本地示例 · 非真实对话数据':'当前聊天 · 只读状态';
  return '<div class="p-header"><span class="p-emblem">✧</span><div class="p-heading"><small>万花筒 · 我的状态</small><strong>'+
    html(data.title)+'</strong><span>'+html(tagline)+'</span></div><button type="button" class="p-quiet" data-p-action="refresh" aria-label="刷新状态" title="刷新">↻</button>'+
    '<button type="button" class="p-quiet" data-p-action="close" aria-label="收起状态栏">×</button></div>'+
    (!hasAnything?'<div class="p-empty">作者暂未开放可显示的变量。</div>':
      '<div class="p-section"><div class="p-section-heading">角色状态 <small>一眼看清当前情况</small></div>'+
      (primary.length?'<div class="p-primary-grid">'+primary.map(x=>metricCard(x,true)).join('')+'</div>':'')+
      (others.length?'<div class="p-mini-grid">'+others.map(x=>metricCard(x)).join('')+'</div>':'')+'</div>')+
    (data.inventory.length?'<details class="p-details" open><summary><span class="p-detail-icon">▣</span>背包物资 <span class="p-count">'+data.inventory.length+' 项</span></summary>'+
      '<div class="p-tags">'+data.inventory.map(i=>'<span class="p-item">'+html(i)+'</span>').join('')+'</div></details>':'')+
    (data.recent.length?'<details class="p-details"><summary><span class="p-detail-icon">↗</span>最近变化 <span class="p-count">'+data.recent.length+' 条</span></summary>'+
      '<div class="p-log">'+data.recent.map(i=>'<div class="p-log-row"><strong>'+html(i.label)+'</strong><span>'+html(i.summary)+'</span><small>'+html(i.at)+'</small></div>').join('')+'</div></details>':'')+
    (data.clues.length?'<details class="p-details"><summary><span class="p-detail-icon">✧</span>已知线索 <span class="p-count">'+data.clues.length+' 条</span></summary>'+
      '<div class="p-clues">'+data.clues.map(i=>'<div class="p-clue"><strong>'+html(i.title)+'</strong>'+
      (i.detail?'<p>'+html(i.detail)+'</p>':'')+'</div>').join('')+'</div></details>':'')+
    '<div class="p-footnote">仅显示角色卡作者设置为公开的变量。</div>';
}

/** Compact read-only, player-first HUD. No write controls, author DSL or debug jargon. */
export class PlayerStatusHUD {
  private root:HTMLElement;
  private source:PlayerStatusSource;
  private opened:boolean;
  private loading=false;
  private result:PlayerStatusResult|null=null;
  private request=0;
  private destroyed=false;
  private onWindowClick:(event:MouseEvent)=>void;
  private onStorage:()=>void;

  constructor(root:HTMLElement,source:PlayerStatusSource,initiallyOpen=false){
    this.root=root;
    this.source=source;
    this.opened=initiallyOpen;
    this.root.className='p-hud'+(initiallyOpen?' p-standalone':'');
    this.root.addEventListener('click',event=>{
      const button=(event.target as HTMLElement).closest<HTMLElement>('[data-p-action]');
      if(!button)return;
      const action=button.dataset.pAction;
      if(action==='open'){this.opened=true;void this.refresh();}
      if(action==='close'){this.opened=false;this.render();}
      if(action==='refresh')void this.refresh();
    });
    this.onWindowClick=event=>{
      if(!this.opened||this.root.classList.contains('p-standalone'))return;
      const path=event.composedPath();
      if(path.includes(this.root)||path.includes(this.root.getRootNode() as EventTarget))return;
      this.opened=false;this.render();
    };
    this.onStorage=()=>{if(this.opened)void this.refresh();};
    document.addEventListener('click',this.onWindowClick);
    window.addEventListener('storage',this.onStorage);
    document.addEventListener('visibilitychange',this.onStorage);
    if(initiallyOpen)void this.refresh();
    else this.render();
  }

  async refresh():Promise<void>{
    const seq=++this.request;
    this.loading=true;this.render();
    try{
      const latest=await this.source();
      if(this.destroyed||seq!==this.request)return;
      this.result=latest;
    }catch(err){
      if(this.destroyed||seq!==this.request)return;
      console.warn('[NLKaleido Player] State read failed',err);
      this.result={kind:'error',message:'无法读取当前状态，请点击刷新重试。'};
    }finally{
      if(!this.destroyed&&seq===this.request){this.loading=false;this.render();}
    }
  }

  private render():void{
    if(this.destroyed)return;
    const dock='<button type="button" class="p-dock" data-p-action="'+(this.opened?'close':'open')+
      '" aria-label="'+(this.opened?'收起':'打开')+'万花筒状态栏" aria-expanded="'+this.opened+'">'+
      '<span class="p-dock-mark">✦</span><span>角色状态</span><span class="p-dock-indicator">'+(this.opened?'⌄':'⌃')+'</span></button>';
    if(!this.opened){this.root.innerHTML=dock;return;}
    const content=this.loading&&!this.result?'<div class="p-loading">正在读取状态…</div>':
      this.result?.kind==='ready'?renderReady(this.result.view,this.result.mode):
      '<div class="p-header"><span class="p-emblem">✧</span><div class="p-heading"><small>万花筒</small><strong>角色状态</strong></div>'+
      '<button class="p-quiet" data-p-action="close" aria-label="收起状态栏">×</button></div>'+
      '<div class="p-empty">'+html(this.result?.message??'暂无状态数据')+'</div>'+
      '<button type="button" class="p-retry" data-p-action="refresh">↻ 刷新状态</button>';
    this.root.innerHTML='<section class="p-panel" aria-label="角色状态栏">'+content+'</section>'+dock;
  }

  destroy():void{
    this.destroyed=true;this.request++;
    document.removeEventListener('click',this.onWindowClick);
    window.removeEventListener('storage',this.onStorage);
    document.removeEventListener('visibilitychange',this.onStorage);
    this.root.replaceChildren();
  }
}

export function mountPlayerStatus(root:HTMLElement,source:PlayerStatusSource,initiallyOpen=false):PlayerStatusHUD{
  return new PlayerStatusHUD(root,source,initiallyOpen);
}
