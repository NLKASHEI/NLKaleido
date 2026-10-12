import { copyJson, parseContract, type Contract, type FieldRule, type FieldType } from '../core/contract.js';
import { applyValues } from '../core/state.js';
import { createVariableController, type SnapshotStorage } from '../runtime/controller.js';
import { acceptedUpdates, addField, defaultFor, demoContract, demoProposals, removeField, STORAGE_CONTRACT, STORAGE_HISTORY, STORAGE_STATE, TYPE_LABELS, UPDATE_LABELS, updateField, type AuditEntry, type Proposal } from './model.js';

type Page = 'contract' | 'audit';
const SYMBOLS: Record<string,string> = {
  home:'⌂', contract:'◇', rules:'⚙', eye:'◉', audit:'▤', memory:'◈',
  puzzle:'⬡', settings:'⚙', plus:'＋', save:'▣', import:'↧', export:'↥',
  play:'▷', shield:'⬡', check:'✓', clock:'◷', sparkle:'✦', trash:'♧',
  undo:'↶', search:'⌕', bag:'▣', heart:'♡', world:'◎', down:'⌄',
};
const glyph = (name: string) => '<span class="glyph" aria-hidden="true">'+(SYMBOLS[name]??'◇')+'</span>';
const escapeHtml = (value: unknown): string => String(value??'').replace(/[&<>"']/g,c=>({
  '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'
}[c]??c));
const short = (value: unknown, limit=40): string => {
  const text = typeof value==='string'?value:JSON.stringify(value);
  return text.length>limit?text.slice(0,limit-1)+'…':text;
};
const valueLabel = (value: unknown) => Array.isArray(value)?value.length+' 项':
  value && typeof value==='object'?Object.keys(value).length+' 个键':String(value);
const types: FieldType[]=['string','number','boolean','list','object','kv'];
const modes=['afterReply','manual','immediate','fixed'];

export class AuthorStudio {
  private root: HTMLElement;
  private contract: Contract;
  private controller!: ReturnType<typeof createVariableController>;
  private storage: SnapshotStorage;
  private selected = '';
  private page: Page='contract';
  private search = '';
  private typeFilter = 'all';
  private grouped = false;
  private dark = false;
  private message = '';
  private isError = false;
  private stateError = '';
  private dirty = false;
  private busy = false;
  private proposals: Proposal[] = [];
  private history: AuditEntry[] = [];

  constructor(root: HTMLElement) {
    this.root = root;
    try {
      this.contract = parseContract(JSON.parse(localStorage.getItem(STORAGE_CONTRACT)??'null'));
    } catch {
      this.contract = copyJson(demoContract);
    }
    this.selected = Object.keys(this.contract.updateRules)[0]??'';
    try {
      const entries: unknown = JSON.parse(localStorage.getItem(STORAGE_HISTORY)??'[]');
      this.history = Array.isArray(entries)?entries.slice(0,30).filter(
        (x): x is AuditEntry => typeof x?.id==='string' && Array.isArray(x?.changed)
      ):[];
    } catch { this.history=[]; }
    const identity={};
    this.storage = {
      identity:()=>identity,
      load:()=>{ const data=localStorage.getItem(STORAGE_STATE);return data?JSON.parse(data):null; },
      save:async(snapshot)=>{localStorage.setItem(STORAGE_STATE,JSON.stringify(snapshot));},
    };
    this.setupController();
    this.bind();
    this.render();
  }

  private setupController(): void {
    try {
      this.controller=createVariableController(this.contract,this.storage);
      this.stateError='';
    } catch(error) {
      this.stateError='演示存档与当前契约不兼容，请手动重置预览存档。'+
        (error instanceof Error?'（'+error.message+'）':'');
      // Show the author a valid preview but never silently overwrite persisted data.
      const identity={};
      this.controller=createVariableController(this.contract,{
        identity:()=>identity, load:()=>null,
        save:async()=>{throw new Error('演示存档不兼容，写入已锁定');},
      });
    }
    this.proposals=[];
  }

  private notify(message: string, isError=false): void {
    this.message=message;
    this.isError=isError;
    this.render();
  }

  private mutate(callback:()=>Contract, selection?:string): void {
    try {
      const next=callback();
      this.contract=next;
      this.dirty=true;
      if(selection!==undefined)this.selected=selection;
      if(!Object.hasOwn(next.updateRules,this.selected))this.selected=Object.keys(next.updateRules)[0]??'';
      this.setupController();
      this.message='契约已修改，点击右上角「保存」写入本地工作台。';
      this.isError=false;
      this.render();
    } catch(error) { this.notify(error instanceof Error?error.message:String(error),true); }
  }

  private bind(): void {
    this.root.addEventListener('click',event=>{
      const target=(event.target as HTMLElement).closest<HTMLElement>('[data-action]');
      if(!target)return;
      const action=target.dataset.action;
      const path=target.dataset.path??'';
      if(action==='contract'){this.page='contract';this.render();}
      if(action==='audit'){this.page='audit';this.render();}
      if(action==='select'){this.selected=path;this.render();}
      if(action==='add'){
        try {
          const next=addField(this.contract);
          const added=Object.keys(next.updateRules).find(p=>!Object.hasOwn(this.contract.updateRules,p));
          this.mutate(()=>next,added);
        } catch(e) {this.notify(String(e),true);}
      }
      if(action==='delete' && this.selected && window.confirm('确定删除「'+this.selected+'」吗？所依赖它的字段将自动移除依赖。')){
        this.mutate(()=>removeField(this.contract,this.selected));
      }
      if(action==='save'){this.save();}
      if(action==='export'){this.export();}
      if(action==='import'){this.root.querySelector<HTMLInputElement>('#contract-import')?.click();}
      if(action==='group'){this.grouped=!this.grouped;this.render();}
      if(action==='dark'){this.dark=!this.dark;this.render();}
      if(action==='remove-dependency'){
        const rule=this.contract.updateRules[this.selected];
        if(rule)this.mutate(()=>updateField(this.contract,this.selected,{
          dependencies:(rule.dependencies??[]).filter(x=>x!==path)
        }));
      }
      if(action==='generate'){this.generate();}
      if(action==='approve'){
        const index=Number(target.dataset.index);
        this.proposals=this.proposals.map((p,i)=>i===index?{...p,approved:!p.approved}:p);
        this.render();
      }
      if(action==='commit'){void this.commit();}
      if(action==='rollback'){void this.rollback();}
      if(action==='reset' && window.confirm('将删除当前本地演示状态，恢复契约默认值。继续吗？')){
        localStorage.removeItem(STORAGE_STATE);
        this.setupController();
        this.notify('演示状态已重置。');
      }
      if(action==='dismiss'){this.message='';this.isError=false;this.render();}
    });

    this.root.addEventListener('input',event=>{
      const input=event.target as HTMLInputElement;
      if(input.dataset.search==='yes'){
        this.search=input.value;
        this.filterRows();
      }
    });

    this.root.addEventListener('change',event=>{
      const el=event.target as HTMLInputElement|HTMLSelectElement|HTMLTextAreaElement;
      if(el.id==='contract-import' && el instanceof HTMLInputElement){void this.import(el);return;}
      if(el.dataset.filter==='type'){this.typeFilter=el.value;this.render();return;}
      if(el.dataset.addDependency==='yes'){
        const rule=this.contract.updateRules[this.selected];
        if(el.value && rule)this.mutate(()=>updateField(this.contract,this.selected,{
          dependencies:[...(rule.dependencies??[]),el.value]
        }));
        return;
      }
      const key=el.dataset.edit as keyof FieldRule|undefined;
      if(!key || !this.selected)return;
      const path=this.selected;
      const rule=this.contract.updateRules[path];
      if(!rule)return;
      try {
        let patch:Partial<FieldRule>;
        if(key==='display')patch={display:(el as HTMLInputElement).checked};
        else if(key==='type'){
          const type=el.value as FieldType;
          patch={type,default:defaultFor(type),min:type==='number'?0:undefined,max:type==='number'?100:undefined};
        } else if(key==='default'){
          patch={default:rule.type==='string'?el.value:JSON.parse(el.value)};
        } else if(key==='min'||key==='max'){
          const value=el.value.trim()===''?undefined:Number(el.value);
          patch={ [key]:value };
        } else patch={ [key]:el.value };
        this.mutate(()=>updateField(this.contract,path,patch),key==='path'?el.value:path);
      } catch(error) {
        this.notify('字段未修改：'+(error instanceof Error?error.message:String(error)),true);
      }
    });
  }

  private filterRows():void {
    this.root.querySelectorAll<HTMLElement>('[data-searchable]').forEach(row=>{
      row.hidden=!(row.dataset.searchable??'').toLocaleLowerCase().includes(this.search.trim().toLocaleLowerCase());
    });
  }

  private save():void {
    try {
      this.contract=parseContract(this.contract);
      localStorage.setItem(STORAGE_CONTRACT,JSON.stringify(this.contract));
      this.dirty=false;
      this.notify('契约已保存到当前浏览器。尚未写入 SillyTavern 正式聊天存档。');
    } catch(error){this.notify('保存失败：'+String(error),true);}
  }

  private export():void {
    const blob=new Blob([JSON.stringify(this.contract,null,2)],{type:'application/json;charset=utf-8'});
    const url=URL.createObjectURL(blob);
    const link=document.createElement('a');
    link.href=url;link.download='NLKaleido-contract.json';
    link.click();
    setTimeout(()=>URL.revokeObjectURL(url),1000);
    this.notify('已导出契约 JSON。');
  }

  private async import(input:HTMLInputElement):Promise<void> {
    const file=input.files?.[0];
    input.value='';
    if(!file)return;
    if(file.size>1024*1024){this.notify('文件超过 1MiB 导入限制。',true);return;}
    try {
      const next=parseContract(JSON.parse(await file.text()));
      this.contract=next;
      this.selected=Object.keys(next.updateRules)[0]??'';
      this.dirty=true;
      this.setupController();
      this.notify('已导入契约到编辑区，检查后点击「保存」。');
    } catch(error){this.notify('导入失败：'+String(error),true);}
  }

  private generate():void {
    if(this.stateError){this.notify('请先重置不兼容的演示存档。',true);return;}
    this.proposals=demoProposals(this.contract,this.controller.snapshot());
    this.notify('已生成本地规则演示建议。它们不是 LLM 的真实输出。');
  }

  private validationError():string|null {
    if(this.stateError)return '演示存档不兼容';
    if(!this.proposals.length)return '尚未生成建议';
    try {
      applyValues(this.contract,this.controller.snapshot(),acceptedUpdates(this.proposals));
      return null;
    }catch(e){return e instanceof Error?e.message:String(e);}
  }

  private async commit():Promise<void>{
    if(this.busy)return;
    const error=this.validationError();
    if(error){this.notify(error,true);return;}
    const updates=acceptedUpdates(this.proposals);
    const paths=Object.keys(updates);
    if(!paths.length){this.notify('没有选中的实际变更。');return;}
    const before:Record<string,unknown>=Object.create(null);
    for(const path of paths)before[path]=this.controller.get(path);
    this.busy=true;this.render();
    try {
      const result=await this.controller.setMany(updates);
      if(!result.ok)throw new Error(result.error);
      const entry:AuditEntry={
        id:Date.now().toString(36)+'-'+Math.random().toString(36).slice(2,7),
        at:new Date().toLocaleString('zh-CN'),
        source:'演示模拟', before, after:copyJson(updates),changed:result.changed,
      };
      this.history.unshift(entry);
      this.history=this.history.slice(0,30);
      localStorage.setItem(STORAGE_HISTORY,JSON.stringify(this.history));
      this.proposals=[];
      this.message='本地演示更新已提交：'+result.changed.length+' 个变量。';
      this.isError=false;
    } catch(error) {
      this.message='写入失败：'+String(error);this.isError=true;
    } finally {this.busy=false;this.render();}
  }

  private async rollback():Promise<void>{
    if(this.busy||this.stateError)return;
    const entry=this.history.find(x=>!x.reverted&&x.changed.length>0);
    if(!entry){this.notify('没有可回滚的提交。');return;}
    for(const path of entry.changed){
      if(!this.contract.updateRules[path] ||
          JSON.stringify(this.controller.get(path))!==JSON.stringify(entry.after[path])){
        this.notify('有字段已被再次修改。为避免覆盖后续更新，本次自动回滚已停止。',true);
        return;
      }
    }
    if(!window.confirm('确定回滚最近一次演示提交吗？'))return;
    this.busy=true;this.render();
    try {
      const result=await this.controller.setMany(entry.before);
      if(!result.ok)throw new Error(result.error);
      entry.reverted=true;
      localStorage.setItem(STORAGE_HISTORY,JSON.stringify(this.history));
      this.proposals=[];
      this.message='已回滚最近一次演示提交。';this.isError=false;
    } catch(e){this.message='回滚失败：'+String(e);this.isError=true;}
    finally{this.busy=false;this.render();}
  }

  private sidebar():string {
    const items:[string,string,Page|null][]=[
      ['总览','home',null],['变量契约','contract','contract'],['更新规则','rules',null],
      ['观察视图','eye',null],['审计记录','audit','audit'],['记忆系统','memory',null],
      ['扩展模块','puzzle',null],['设置','settings',null],
    ];
    return '<aside class="nk-sidebar"><div class="brand"><div class="brand-icon">✦</div><div><strong>万花筒 <span>NLKaleido</span></strong><small>变量驱动的故事工作台</small></div></div>'+
      '<div class="side-label">工作空间</div><nav class="nav" aria-label="主导航">'+items.map(([title,symbol,page])=>
        page?'<button type="button" data-action="'+page+'" class="nav-link '+(this.page===page?'active':'')+'">'+glyph(symbol)+title+'</button>':
        '<div class="nav-link locked" title="将在后续开发阶段开放">'+glyph(symbol)+title+'<span class="soon">规划中</span></div>'
      ).join('')+'</nav><div class="sidebar-footer"><div class="orbit">✦　·　✧</div><strong>让角色拥有真正的<br>记忆与成长。</strong><small>Variables for richer stories.</small></div></aside>';
  }

  private topbar():string {
    return '<div class="nk-topbar"><div class="project-picker"><div class="project-icon">✧</div><span><small>当前项目</small><strong>'+
      escapeHtml(this.contract.id)+'</strong></span><span class="picker-arrow">⌄</span></div>'+
      '<div class="global-search">'+glyph('search')+'变量 · 规则 · 更新审计 <kbd>Preview</kbd></div>'+
      '<div class="top-profile"><button type="button" class="icon-button" data-action="dark" title="切换亮色/深色">◐</button>'+
      '<div class="mini-avatar">万</div><div class="profile-label"><strong>作者工作台</strong><small>本地开发预览</small></div></div></div>';
  }

  private alerts():string {
    return (this.stateError?'<div role="alert" class="banner error">'+glyph('shield')+escapeHtml(this.stateError)+
      '<button class="button small" data-action="reset">重置演示状态</button></div>':'')+
      (this.message?'<div role="status" class="banner '+(this.isError?'error':'notice')+'">'+
      glyph(this.isError?'shield':'check')+escapeHtml(this.message)+
      '<button class="quiet-icon" data-action="dismiss" aria-label="关闭通知">×</button></div>':'');
  }

  private summary():string {
    return '<section class="summary-card"><div class="cover-art">✦<span>☾</span></div><div class="summary-text"><strong>'+
      escapeHtml(this.contract.id)+'</strong><p>用清晰的结构管理角色、世界与剧情状态。</p><div class="tagline"><span class="chip">角色卡</span><span class="chip">契约 v1</span><span class="chip">开发预览</span></div></div>'+
      '<div class="summary-stat"><small>变量数量</small><strong>'+Object.keys(this.contract.updateRules).length+'</strong></div>'+
      '<div class="summary-stat"><small>编辑状态</small><strong>'+(this.dirty?'未保存':'正常')+'</strong></div>'+
      '<div class="summary-stat"><small>结构校验</small><strong class="ok-text">● 有效</strong></div></section>';
  }

  private fieldList():string {
    let fields=Object.values(this.contract.updateRules);
    if(this.typeFilter!=='all')fields=fields.filter(f=>f.type===this.typeFilter);
    if(this.grouped)fields.sort((a,b)=>a.path.localeCompare(b.path,'zh-CN'));
    const rows=fields.map(f=>{
      const name=f.label||f.path.split('.').at(-1)||f.path;
      return '<button class="field-row '+(this.selected===f.path?'selected':'')+'" data-action="select" data-path="'+escapeHtml(f.path)+
        '" data-searchable="'+escapeHtml(f.path+' '+name+' '+(f.description??''))+'">'+
        '<span class="field-title"><span class="field-symbol">'+glyph(f.type==='number'?'heart':f.type==='list'?'bag':'world')+'</span><span><strong>'+
        escapeHtml(f.path)+'</strong><small>'+escapeHtml(f.description||name)+'</small></span></span>'+
        '<span><span class="type-tag t-'+f.type+'">'+escapeHtml(TYPE_LABELS[f.type])+'</span></span>'+
        '<span class="mono">'+escapeHtml(short(f.default,21))+'</span>'+
        '<span><span class="chip">'+escapeHtml(UPDATE_LABELS[f.updateMode??'afterReply']??f.updateMode??'按规则')+'</span></span>'+
        '<span class="truncate">'+(f.dependencies?.length?escapeHtml(f.dependencies.join(', ')):'—')+'</span>'+
        '<span class="visibility">'+(f.display===false?'隐藏':'◉ 可见')+'</span>'+
        '<span class="ok-text">✓ 有效</span></button>';
    }).join('');
    return '<section class="panel variables-panel"><div class="panel-toolbar"><div class="tabs"><button data-action="group" class="tab '+
      (!this.grouped?'active':'')+'">变量列表 <span class="tab-counter">'+Object.keys(this.contract.updateRules).length+'</span></button>'+
      '<button data-action="group" class="tab '+(this.grouped?'active':'')+'">分组视图</button></div>'+
      '<div class="toolbar-right"><label class="search-field">'+glyph('search')+
      '<input data-search="yes" aria-label="搜索变量" placeholder="搜索变量..." value="'+escapeHtml(this.search)+'"></label>'+
      '<select data-filter="type" aria-label="类型筛选"><option value="all">全部类型</option>'+types.map(type=>
        '<option value="'+type+'" '+(this.typeFilter===type?'selected':'')+'>'+TYPE_LABELS[type]+'</option>').join('')+'</select>'+
      '<button class="button primary" data-action="add">'+glyph('plus')+'新增变量</button></div></div>'+
      '<div class="table-scroll"><div class="field-head"><span>名称 / 说明</span><span>类型</span><span>默认值</span>'+
      '<span>更新时机</span><span>依赖</span><span>玩家视图</span><span>状态</span></div>'+
      (rows||'<div class="empty">还没有变量，点击「新增变量」开始吧。</div>')+
      '</div><div class="panel-foot">✓ 所有字段均由契约结构进行校验 · 表单变更不会直接影响原版插件</div></section>';
  }

  private inspector():string {
    const rule=this.contract.updateRules[this.selected];
    if(!rule)return '<section class="panel inspector"><div class="panel-title">字段详情</div><div class="empty">请选择一个字段</div></section>';
    const input=(label:string,key:keyof FieldRule,value:unknown,placeholder='')=>
      '<label class="form-control"><span>'+label+'</span><input data-edit="'+key+'" value="'+escapeHtml(value??'')+
      '" placeholder="'+escapeHtml(placeholder)+'"></label>';
    const available=Object.keys(this.contract.updateRules).filter(path=>path!==rule.path&&!(rule.dependencies??[]).includes(path));
    return '<section class="panel inspector"><div class="panel-title"><span>⬡　字段详情</span><button class="quiet-icon trash" data-action="delete" title="删除字段">'+glyph('trash')+'</button></div>'+
      '<div class="inspector-fields">'+input('变量路径 *','path',rule.path,'例：角色.好感度')+
      '<div class="two-column">'+input('显示名称','label',rule.label,'例：好感度')+
      '<label class="form-control"><span>字段类型</span><select data-edit="type">'+types.map(type=>
        '<option value="'+type+'" '+(rule.type===type?'selected':'')+'>'+TYPE_LABELS[type]+'</option>').join('')+'</select></label></div>'+
      '<label class="form-control"><span>字段说明</span><textarea rows="2" data-edit="description" placeholder="这个变量代表什么？">'+
      escapeHtml(rule.description??'')+'</textarea></label>'+
      '<div class="two-column"><label class="form-control"><span>默认值</span>'+
      (rule.type==='string'?'<input data-edit="default" value="'+escapeHtml(rule.default)+'">':
        '<textarea data-edit="default" rows="2" spellcheck="false">'+escapeHtml(JSON.stringify(rule.default))+'</textarea>')+
      '</label><label class="form-control"><span>更新时机</span><select data-edit="updateMode">'+modes.map(mode=>
        '<option value="'+mode+'" '+(mode===rule.updateMode?'selected':'')+'>'+
        escapeHtml(UPDATE_LABELS[mode])+'</option>').join('')+'</select></label></div>'+
      (rule.type==='number'?'<div class="two-column">'+input('最小值','min',rule.min,'不限制')+input('最大值','max',rule.max,'不限制')+'</div>':'')+
      '<label class="form-control"><span>AI 更新规则 <em>自然语言即可</em></span><textarea data-edit="changeRule" rows="4" placeholder="明确何时更改、何时保持，以及单次变化幅度。">'+
      escapeHtml(rule.changeRule??'')+'</textarea></label>'+
      '<div class="form-control"><span>依赖字段</span><div class="dependency-chips">'+
      ((rule.dependencies??[]).length?(rule.dependencies??[]).map(path=>
        '<span class="dependency-chip">'+escapeHtml(path)+'<button data-action="remove-dependency" data-path="'+escapeHtml(path)+
        '" title="移除该依赖">×</button></span>').join(''):'<small>无依赖</small>')+
      '</div><select data-add-dependency="yes" aria-label="添加依赖字段"><option value="">＋ 添加依赖字段</option>'+
      available.map(path=>'<option value="'+escapeHtml(path)+'">'+escapeHtml(path)+'</option>').join('')+'</select></div>'+
      '<label class="visibility-switch"><span>◉　对玩家显示<small>玩家只看到允许公开的变量</small></span>'+
      '<input type="checkbox" data-edit="display" '+(rule.display!==false?'checked':'')+'></label></div></section>';
  }

  private preview():string {
    return '<section class="panel preview-panel"><div class="panel-title"><span>◉　玩家视图预览</span><small>隐藏变量不会暴露给玩家</small></div>'+
      '<div class="preview-layout"><div class="character-preview"><div class="preview-stars">✧　⋆　✦　✧</div><div class="preview-moon">☾</div>'+
      '<strong>'+escapeHtml(this.contract.id)+'</strong><small>每一段故事，都值得被记住。</small></div>'+
      '<div class="preview-states">'+this.controller.list().filter(x=>x.display).slice(0,5).map(x=>
        '<div class="preview-value"><span>'+glyph(x.type==='number'?'heart':x.type==='list'?'bag':'world')+
        escapeHtml(this.contract.updateRules[x.path]?.label??x.path)+'</span><strong>'+
        escapeHtml(valueLabel(x.value))+'</strong></div>').join('')+
      '</div></div></section>';
  }

  private validator():string {
    const rules=Object.values(this.contract.updateRules);
    const checkRows=[
      ['基础结构','字段路径和契约结构正确'],
      ['类型与默认值','所有变量初始值有效'],
      ['依赖关系','未发现循环依赖'],
      ['更新规则',rules.every(r=>r.changeRule?.trim())?'全部已配置':'仍有字段尚未编写更新说明'],
    ];
    return '<section class="panel validation-panel"><div class="panel-title"><span>⬡　契约校验与提示</span>'+
      '<span class="pill success-pill">结构正常</span></div><div class="validation-grid"><div class="validation-items">'+
      checkRows.map(([title,desc],i)=>'<div class="validation-item"><span class="check-disc">✓</span><strong>'+title+'</strong>'+
      '<span class="'+(i===3&&!rules.every(r=>r.changeRule?.trim())?'warn-text':'ok-text')+'">'+
      (i===3&&!rules.every(r=>r.changeRule?.trim())?'待完善':'通过')+'</span><small>'+desc+'</small></div>').join('')+
      '</div><div class="validation-success"><div>✦</div><strong>基础校验通过</strong><p>可保存和导出契约。<br>真实模型更新尚未接入。</p></div></div></section>';
  }

  private contractPage():string{
    return '<div class="page-title-row"><div><div class="eyebrow">AUTHOR STUDIO · VARIABLE CONTRACT</div>'+
      '<h1>变量契约</h1><p>定义角色卡的变量结构、类型与更新规则，让每一次状态变化都可靠且清晰。</p></div>'+
      '<div class="page-actions"><button class="button subtle" data-action="import">'+glyph('import')+'导入</button>'+
      '<button class="button subtle" data-action="export">'+glyph('export')+'导出</button>'+
      '<button class="button subtle" data-action="audit">'+glyph('play')+'测试更新</button>'+
      '<button class="button primary" data-action="save">'+glyph('save')+'保存'+(this.dirty?' *':'')+'</button></div></div>'+
      this.summary()+'<div class="editor-columns">'+this.fieldList()+this.inspector()+'</div>'+
      '<div class="bottom-columns">'+this.preview()+this.validator()+'</div>';
  }

  private snapshot():string{
    return '<div class="snapshot-box"><div class="subheading">当前状态快照 <span class="pill">只读</span></div>'+
      this.controller.list().slice(0,6).map(item=>'<div class="snapshot-row"><span>'+
        escapeHtml(item.path)+'</span><strong>'+escapeHtml(short(item.value,24))+'</strong></div>').join('')+'</div>';
  }

  private proposal(item:Proposal,index:number):string{
    return '<div class="proposal-card"><div class="proposal-title"><span class="proposal-index">'+(index+1)+'</span>'+
      '<strong>'+escapeHtml(item.path)+'</strong><span class="pill '+(item.mode==='change'?'blue-pill':'')+'">'+
      (item.mode==='change'?'建议变更':'保持不变')+'</span></div>'+
      '<div class="proposal-values"><div><small>当前值</small><strong>'+escapeHtml(short(item.before,24))+'</strong></div>'+
      '<span>→</span><div><small>建议值</small><strong>'+escapeHtml(short(item.after,24))+'</strong></div></div>'+
      '<div class="proposal-reason"><strong>建议依据 · 演示</strong><p>'+escapeHtml(item.reason)+'</p></div>'+
      (item.mode==='change'?'<label class="approval"><input type="checkbox" data-action="approve" data-index="'+index+'" '+
      (item.approved?'checked':'')+'>接受该变更</label>':'<div class="no-change">✓　无需写入</div>')+'</div>';
  }

  private auditPage():string{
    const accepted=this.proposals.filter(p=>p.mode==='change'&&p.approved).length;
    const unchanged=this.proposals.filter(p=>p.mode==='unchanged').length;
    const error=this.validationError();
    const canRollback=this.history.some(x=>!x.reverted&&x.changed.length>0);
    return '<div class="page-title-row"><div><div class="eyebrow">RUNTIME · SAFE UPDATE REVIEW</div>'+
      '<h1>变量更新中心</h1><p>观察对话、审阅建议、比较差异，再由本地契约校验并提交。</p></div>'+
      '<div class="page-actions"><button class="button subtle" data-action="rollback" '+(!canRollback||this.busy?'disabled':'')+'>'+glyph('undo')+'回滚上次</button>'+
      '<button class="button subtle" data-action="generate" '+(this.busy?'disabled':'')+'>'+glyph('sparkle')+'生成演示建议</button>'+
      '<button class="button primary" data-action="commit" '+(!!error||accepted===0||this.busy?'disabled':'')+'>'+glyph('check')+'提交更新 ('+accepted+')</button></div></div>'+
      '<div class="banner demo"><strong>演示模式</strong> 当前没有连接真实 LLM；以下对话与建议仅用于验证作者工作流，绝非真实的 AI 输出。</div>'+
      '<div class="audit-stats"><div><small>当前项目</small><strong>'+escapeHtml(this.contract.id)+'</strong></div>'+
      '<div><small>本轮建议</small><strong>'+this.proposals.length+' 项</strong></div>'+
      '<div><small>待提交</small><strong class="blue-text">'+accepted+' 项</strong></div>'+
      '<div><small>保持不变</small><strong>'+unchanged+' 项</strong></div>'+
      '<div><small>历史记录</small><strong>'+this.history.length+' 条</strong></div></div>'+
      '<div class="audit-columns"><section class="panel"><div class="panel-title">◉　对话与观察 <span class="pill">演示</span></div>'+
      '<div class="conversation"><div class="chat-message"><span class="chat-avatar">玩</span><div><strong>玩家</strong><p>我仔细搜索了房间，在书架后发现了一把生锈的钥匙。</p></div></div>'+
      '<div class="chat-message"><span class="chat-avatar ai-avatar">角</span><div><strong>角色（样例）</strong><p>你找到了一把旧钥匙，它或许能打开隔壁那扇紧闭的门。</p></div></div></div>'+
      this.snapshot()+'<div class="observation-note"><strong>观察说明</strong><p>玩家找到了道具，但章节是否变化、关系是否提升，仍需遵守各变量的契约规则。</p></div></section>'+
      '<section class="panel"><div class="panel-title">✦　变量更新建议 <span class="pill">'+this.proposals.length+' 项</span></div>'+
      '<div class="proposals">'+(this.proposals.length?this.proposals.map((p,i)=>this.proposal(p,i)).join(''):
        '<div class="empty-state"><div>✧</div><strong>尚无待审阅建议</strong><p>点击下面的按钮，生成基于样例状态的演示建议。</p>'+
        '<button class="button primary" data-action="generate">▷　生成演示建议</button></div>')+'</div></section>'+
      '<section class="panel"><div class="panel-title">⬡　校验与最终结果</div>'+
      '<div class="validation-banner '+(error?'soft-warning':'soft-success')+'">'+(error?'◷ '+escapeHtml(error):'✓　选中的建议通过契约类型与范围校验')+'</div>'+
      '<div class="subheading">变更审阅</div>'+
      (this.proposals.length?this.proposals.map(p=>
        '<div class="decision-item"><span class="decision-glyph">'+(p.mode==='unchanged'?'◷':p.approved?'✓':'×')+'</span>'+
        '<span><strong>'+escapeHtml(p.path)+'</strong><small>'+
        (p.mode==='unchanged'?'保持不变':p.approved?'接受':'不提交')+'</small></span>'+
        '<b>'+escapeHtml(short(p.after,18))+'</b></div>').join(''):'<div class="empty small-empty">等待建议生成</div>')+
      '<div class="diff-view"><div class="subheading">变更差异预览</div>'+
      (this.proposals.some(p=>p.mode==='change'&&p.approved)?
        this.proposals.filter(p=>p.mode==='change'&&p.approved).map(p=>
          '<div class="diff-old">− '+escapeHtml(p.path)+' = '+escapeHtml(short(p.before,28))+'</div>'+
          '<div class="diff-new">+ '+escapeHtml(p.path)+' = '+escapeHtml(short(p.after,28))+'</div>').join(''):
        '<div class="empty small-empty">暂无选中的实际变更</div>')+
      '</div><button class="button primary full" data-action="commit" '+(!!error||accepted===0||this.busy?'disabled':'')+'>✓　提交选中变更 ('+accepted+')</button></section></div>'+
      '<section class="panel history"><div class="panel-title">▤　更新历史记录 <span class="pill">本地演示存档</span></div>'+
      '<div class="history-head"><span>时间</span><span>来源</span><span>涉及变量</span><span>状态</span></div>'+
      (this.history.length?this.history.map(h=>'<div class="history-row"><span>'+escapeHtml(h.at)+'</span>'+
        '<span>'+escapeHtml(h.source)+'</span><span>'+escapeHtml(h.changed.join('、'))+'</span>'+
        '<span class="pill '+(h.reverted?'':'success-pill')+'">'+(h.reverted?'已回滚':'已提交')+'</span></div>').join(''):
        '<div class="empty">暂无历史。成功提交演示更新后将在此显示。</div>')+'</section>';
  }

  render():void {
    this.root.className='nk-shell'+(this.dark?' dark':'');
    this.root.innerHTML=this.sidebar()+'<main class="nk-main">'+this.topbar()+
      '<div class="nk-content">'+this.alerts()+(this.page==='contract'?this.contractPage():this.auditPage())+
      '</div></main><input type="file" id="contract-import" accept=".json,application/json" hidden>';
    this.filterRows();
  }
}

export function mountAuthorStudio(root: HTMLElement): AuthorStudio {
  return new AuthorStudio(root);
}
