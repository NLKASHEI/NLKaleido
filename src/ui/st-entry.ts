/**
 * Optional isolated SillyTavern UI preview. No generation hooks,
 * no chat writes and no contact with the released NLKaleido runtime.
 */
import { mountAuthorStudio } from './app.js';
import styles from '../../studio/styles.css?inline';
import { mountPlayerStatus } from '../player/ui.js';
import { createStPlayerSource, type PlayerStContext } from '../player/st-source.js';
import { STORAGE_CONTRACT } from './model.js';
import playerStyles from '../../studio/player.css?inline';
import { createStChatUpdateLedger } from '../runtime/update-ledger.js';
import { createVerifiedStChatPort } from '../runtime/st-verified-port.js';
import type { Contract } from '../core/contract.js';

const LAUNCHER_ID = 'nlkaleido-author-studio-preview-launcher';
const OVERLAY_ID = 'nlkaleido-author-studio-preview-overlay';
let closePreview: (() => void) | null = null;
const PLAYER_HOST_ID = 'nlkaleido-player-preview-host';
type EventContext = PlayerStContext & {
  eventSource?: {on:(event:string,fn:()=>void)=>void; removeListener?:(event:string,fn:()=>void)=>void};
  eventTypes?: {CHAT_CHANGED?:string; GENERATION_ENDED?:string};
};
type StApi = {getContext?:()=>EventContext};
let stApiPromise: Promise<StApi | null> | null = null;
let playerDestroy:(()=>void)|null=null;
let playerRefresh:(()=>Promise<void>)|null=null;
let ledger:ReturnType<typeof createStChatUpdateLedger>|null=null;
async function bindCurrentChat(contract:Contract):Promise<void>{
  if(!stApiPromise)await getCurrentStContext();
  const api=await stApiPromise;
  if(typeof api?.getContext!=='function')
    throw new Error('酒馆扩展 API 不可用');
  // Keep one quarantine guard per extension session, even after a failed save.
  if(!ledger)ledger=createStChatUpdateLedger(createVerifiedStChatPort(()=>api.getContext!()));
  await ledger.install(contract);
  await playerRefresh?.();
}

async function getCurrentStContext():Promise<EventContext|null>{
  try{
    if(!stApiPromise){
      const moduleUrl = new URL('scripts/extensions.js', document.baseURI).href;
      stApiPromise=import(/* @vite-ignore */ moduleUrl).then(
        (module:unknown)=>module as StApi,
        ()=>null
      );
    }
    const api=await stApiPromise;
    return typeof api?.getContext==='function'?api.getContext():null;
  }catch{return null;}
}

function initializePlayerPreview():void {
  if(document.getElementById(PLAYER_HOST_ID))return;
  const host=document.createElement('div');
  host.id=PLAYER_HOST_ID;
  const shadow=host.attachShadow({mode:'open'});
  const style=document.createElement('style');
  style.textContent=playerStyles;
  const root=document.createElement('div');
  shadow.append(style,root);
  document.body.append(host);

  const read=createStPlayerSource(
    getCurrentStContext,
    ()=>localStorage.getItem(STORAGE_CONTRACT)
  );
  const hud=mountPlayerStatus(root,read);
  playerRefresh=()=>hud.refresh();
  let unsubscribe:(()=>void)|null=null;
  playerDestroy=()=>{
    unsubscribe?.();
    hud.destroy();
    playerRefresh=null;
    host.remove();
    playerDestroy=null;
  };

  // Refresh after supported ST chat changes; read current chat on each event.
  void getCurrentStContext().then(context=>{
    if(!context||!host.isConnected)return;
    const source=context.eventSource;
    const eventNames=[context.eventTypes?.CHAT_CHANGED,context.eventTypes?.GENERATION_ENDED].filter(
      (name):name is string=>typeof name==='string'&&name.length>0
    );
    const onChange=()=>{void hud.refresh();};
    for(const name of eventNames)source?.on(name,onChange);
    unsubscribe=()=>{
      for(const name of eventNames)source?.removeListener?.(name,onChange);
    };
  });
}


export function openPreview(): void {
  if (document.getElementById(OVERLAY_ID)) return;

  const overlay = document.createElement('div');
  overlay.id = OVERLAY_ID;
  overlay.setAttribute('role', 'presentation');
  Object.assign(overlay.style, {
    position: 'fixed', inset: '0', zIndex: '2147482000',
    background: 'rgba(9, 19, 42, .62)', display: 'grid',
    placeItems: 'center', padding: '12px',
  });

  const windowFrame = document.createElement('section');
  windowFrame.setAttribute('role', 'dialog');
  windowFrame.setAttribute('aria-label', '万花筒作者工作台预览');
  windowFrame.setAttribute('aria-modal', 'true');
  Object.assign(windowFrame.style, {
    position: 'relative',
    width: 'min(1710px, 98vw)', height: 'min(960px, 96vh)',
    overflow: 'auto', borderRadius: '16px',
    boxShadow: '0 28px 100px rgba(0,0,0,.32)',
    background: '#f5f7fc',
  });

  // Styles never escape the shadow root into the host SillyTavern UI.
  const shadow = windowFrame.attachShadow({ mode: 'open' });
  const styleTag = document.createElement('style');
  styleTag.textContent = ':host{display:block} .nk-shell{font-family:Inter,"Noto Sans SC",system-ui,sans-serif;min-height:100%;} ' + styles;
  shadow.append(styleTag);

  const root = document.createElement('div');
  root.id = 'nlkaleido-author-studio-root';
  shadow.append(root);

  const close = document.createElement('button');
  close.type = 'button';
  close.setAttribute('aria-label', '关闭万花筒预览');
  close.title = '关闭预览（Esc）';
  close.textContent = '×';
  Object.assign(close.style, {
    position: 'fixed', zIndex: '2147482002', top: 'max(18px, 3vh)',
    right: 'max(20px, 3vw)', width: '38px', height: '38px',
    background: '#27396d', color: '#fff', border: '1px solid #6880b1',
    borderRadius: '10px', cursor: 'pointer', fontSize: '25px',
  });

  const handleKey = (event: KeyboardEvent): void => {
    if (event.key === 'Escape') closePreview?.();
  };
  const dismiss = (): void => {
    document.removeEventListener('keydown', handleKey);
    overlay.remove();
    closePreview = null;
  };
  closePreview = dismiss;
  close.addEventListener('click', dismiss);
  overlay.addEventListener('click', event => {
    if (event.target === overlay) dismiss();
  });
  overlay.append(windowFrame, close);
  document.body.append(overlay);
  document.addEventListener('keydown', handleKey);

  try {
    mountAuthorStudio(root,bindCurrentChat);
    close.focus();
  } catch (error) {
    console.error('[NLKaleido Preview] Studio failed to mount:', error);
    dismiss();
  }
}

export function initializePreview(): void {
  initializePlayerPreview();
  if (document.getElementById(LAUNCHER_ID)) return;
  const button = document.createElement('button');
  button.id = LAUNCHER_ID;
  button.type = 'button';
  button.textContent = '✦ 万花筒·新版工作台';
  button.title = '打开独立的变量作者工作台预览（不修改正式角色卡存档）';
  Object.assign(button.style, {
    position: 'fixed', bottom: '76px', right: '20px',
    zIndex: '3000', background: '#334db5', color: '#fff',
    border: '1px solid #7280ce', borderRadius: '12px',
    padding: '11px 14px', boxShadow: '0 7px 24px rgba(0,0,0,.22)',
    fontSize: '13px', fontWeight: '700', cursor: 'pointer',
  });
  button.addEventListener('click', openPreview);
  document.body.append(button);
}

export function destroyPreview(): void {
  playerDestroy?.();
  closePreview?.();
  document.getElementById(LAUNCHER_ID)?.remove();
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initializePreview, { once:true });
} else {
  initializePreview();
}
