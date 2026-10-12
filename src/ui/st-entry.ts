/**
 * Optional isolated SillyTavern UI preview. No generation hooks,
 * no chat writes and no contact with the released NLKaleido runtime.
 */
import { mountAuthorStudio } from './app.js';
import styles from '../../studio/styles.css?inline';

const LAUNCHER_ID = 'nlkaleido-author-studio-preview-launcher';
const OVERLAY_ID = 'nlkaleido-author-studio-preview-overlay';
let closePreview: (() => void) | null = null;

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
    mountAuthorStudio(root);
    close.focus();
  } catch (error) {
    console.error('[NLKaleido Preview] Studio failed to mount:', error);
    dismiss();
  }
}

export function initializePreview(): void {
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
  closePreview?.();
  document.getElementById(LAUNCHER_ID)?.remove();
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initializePreview, { once:true });
} else {
  initializePreview();
}
