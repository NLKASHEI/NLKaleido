import { copyJson } from '../core/contract.js';
import type { EvidenceDocument } from '../update/bm25f.js';

export type StChatMessage={
  is_user?:boolean;
  is_system?:boolean;
  mes?:string;
  name?:string;
};
export type StChatContext={
  chatId?:string|null;
  characterId?:string|number|null;
  groupId?:string|number|null;
  chat?:unknown[];
  chatMetadata?:Record<string,unknown>;
  saveMetadata?:()=>Promise<unknown>;
};
export type ExtractedTurn={
  number:number;
  hash:string;
  messageIndex:number;
  document:EvidenceDocument;
};
export type ChatTimeline={
  scope:string;
  turns:number[];
  hashes:string[];
  documents:EvidenceDocument[];
  lastMessageIndex:number;
};

const trimmed=(value:string,max:number)=>value.length<=max?value:value.slice(0,max);
function message(value:unknown):value is StChatMessage{
  return typeof value==='object'&&value!==null&&!Array.isArray(value);
}

export function chatScope(context:StChatContext):string|null{
  if(!context.chatId||typeof context.chatId!=='string')return null;
  const group=context.groupId==null?'none':String(context.groupId);
  const char=context.characterId==null?'none':String(context.characterId);
  return JSON.stringify([group,char,context.chatId]);
}

async function sha256(text:string):Promise<string>{
  const bytes=new TextEncoder().encode(text);
  const result=await crypto.subtle.digest('SHA-256',bytes);
  return [...new Uint8Array(result)].map(x=>x.toString(16).padStart(2,'0')).join('');
}

/**
 * Completed logical assistant turns only. The generated hash combines the
 * preceding user message and selected assistant text to detect edits/swipes.
 * Caller invokes this only after GENERATION_ENDED, never at stop/start.
 */
export async function extractChatTimeline(context:StChatContext):Promise<ChatTimeline>{
  const scope=chatScope(context);
  if(!scope)throw new Error('未选择聊天，禁止提取变量证据');
  if(!Array.isArray(context.chat))throw new Error('酒馆未提供可用的聊天消息列表');
  if(context.chat.length>30000)throw new Error('聊天记录超过提取限制');
  const turns:ExtractedTurn[]=[];
  let mostRecentUser='';
  let lastMessageIndex=-1;
  for(let i=0;i<context.chat.length;i++){
    const entry=context.chat[i];
    if(!message(entry)||entry.is_system===true)continue;
    if(typeof entry.mes!=='string')continue;
    const body=entry.mes.trim();
    if(entry.is_user===true){
      mostRecentUser=trimmed(body,8192);
      continue;
    }
    if(!body)continue;
    const number=turns.length+1;
    const normalized=trimmed(body,12000);
    const combined=JSON.stringify([mostRecentUser,normalized]);
    const hash=await sha256(combined);
    const item:EvidenceDocument={
      id:'turn-'+number+'-'+hash.slice(0,16),
      scope,turn:number,fields:{
        title:'对话第 '+number+' 轮',
        tags:entry.name&&typeof entry.name==='string'?trimmed(entry.name,80):'角色回复',
        summary:mostRecentUser.slice(0,1200),
        body:trimmed('玩家：'+mostRecentUser+'\n角色：'+normalized,15000),
      }
    };
    turns.push({number,hash,messageIndex:i,document:item});
    lastMessageIndex=i;
  }
  return {
    scope,turns:turns.map(t=>t.number),
    hashes:turns.map(t=>t.hash),
    documents:turns.map(t=>copyJson(t.document)),
    lastMessageIndex,
  };
}

/** Fail closed if any previously committed turn was regenerated or edited. */
export function assertTimelineCompatible(previousHashes:readonly string[],now:ChatTimeline):void{
  if(now.hashes.length<previousHashes.length)
    throw new Error('聊天消息少于已处理历史；需人工核对分支或回滚');
  for(let i=0;i<previousHashes.length;i++){
    if(previousHashes[i]!==now.hashes[i])
      throw new Error('已处理的历史对话发生修改或重生成，已暂停变量自动更新');
  }
}
