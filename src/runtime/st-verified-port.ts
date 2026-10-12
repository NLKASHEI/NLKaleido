import type { StChatContext } from './chat-timeline.js';
import { UPDATE_ARCHIVE_KEY, type ChatLedgerPort } from './update-ledger.js';

/**
 * Official SillyTavern native chat save is allowed to swallow save failures.
 * For 1:1 chats, verify persistence through an independent read-back using
 * the same-origin /api/chats/get request used by ST itself.
 * Group chats require a separate verified adapter and are not supported here.
 */
export type VerifiedStContext=StChatContext & {
  characterId?:string|number|null;
  groupId?:string|number|null;
  characters?: {name?:string;chat?:string;avatar?:string}[];
  getRequestHeaders?:()=>Record<string,string>;
  saveMetadata?:()=>Promise<unknown>;
};
export type FetchLike=(url:string,init:RequestInit)=>Promise<Pick<Response,'ok'|'json'>>;
const equal=(a:unknown,b:unknown):boolean=>JSON.stringify(a)===JSON.stringify(b);

export function createVerifiedStChatPort(
  getContext:()=>VerifiedStContext,
  fetchChat:FetchLike=(url,init)=>fetch(url,init)
):ChatLedgerPort{
  return {
    current:getContext,
    saveAndConfirm:async captured=>{
      const ctx=captured as VerifiedStContext;
      if(ctx.groupId!==null&&ctx.groupId!==undefined&&ctx.groupId!=='')
        throw new Error('暂不支持群聊存档的独立写入验证');
      if(typeof ctx.characterId!=='number'||!Number.isSafeInteger(ctx.characterId)||ctx.characterId<0)
        throw new Error('仅支持已选定角色的单人聊天');
      const character=ctx.characters?.[ctx.characterId];
      if(!character?.name||!character.avatar||!character.chat||character.chat!==ctx.chatId)
        throw new Error('角色身份或聊天文件已改变，拒绝保存');
      if(typeof ctx.saveMetadata!=='function'||typeof ctx.getRequestHeaders!=='function')
        throw new Error('酒馆版本缺少可验证的聊天保存接口');
      await ctx.saveMetadata();
      const current=getContext();
      if(current.chatId!==ctx.chatId||current.chatMetadata!==ctx.chatMetadata||
         current.characterId!==ctx.characterId||current.groupId!==ctx.groupId)
        throw new Error('保存时聊天切换，无法确认原聊天状态');
      const response=await fetchChat('/api/chats/get',{
        method:'POST',
        headers:ctx.getRequestHeaders(),
        cache:'no-cache',
        body:JSON.stringify({
          ch_name:character.name,
          file_name:character.chat,
          avatar_url:character.avatar,
        })
      });
      if(!response.ok)return {durable:false};
      const body:unknown=await response.json();
      if(!Array.isArray(body)||!body.length)return {durable:false};
      const header=body[0] as {chat_metadata?:Record<string,unknown>};
      const fromDisk=header?.chat_metadata?.[UPDATE_ARCHIVE_KEY];
      const expected=ctx.chatMetadata?.[UPDATE_ARCHIVE_KEY];
      const same=!!fromDisk&&!!expected&&equal(fromDisk,expected);
      const after=getContext();
      if(after.chatId!==ctx.chatId||after.chatMetadata!==ctx.chatMetadata)return {durable:false};
      return {durable:same};
    }
  };
}
