import { parseContract } from '../core/contract.js';
import { readSnapshot } from '../core/state.js';
import { EXPERIMENTAL_METADATA_KEY } from '../runtime/st.js';
import { UPDATE_ARCHIVE_KEY, getCurrentUpdateArchive } from '../runtime/update-ledger.js';
import { buildPlayerView } from './model.js';
import type { PlayerStatusResult, PlayerStatusSource } from './ui.js';

/**
 * Read-only ST adapter. This preview deliberately does not use the
 * v0.10.0 legacy storage format, write metadata, or silently invent demo state.
 */
export type PlayerStContext = {
  chatId?: string | null;
  chatMetadata?: Record<string,unknown>;
};

export function createStPlayerSource(
  getCurrentContext: () => Promise<PlayerStContext | null>,
  getSavedContract: () => string | null,
): PlayerStatusSource {
  return async ():Promise<PlayerStatusResult>=>{
    const context=await getCurrentContext();
    if(!context)return {kind:'empty',message:'暂时无法连接酒馆状态。请使用独立玩家预览页查看示例。'};
    if(!context.chatId)return {kind:'empty',message:'选择一个聊天后，这里会显示角色状态。'};
    // Prefer the explicitly verified, chat-scoped ledger. This contains the
    // contract and snapshot together; never reuse another chat's localStorage.
    if(context.chatMetadata?.[UPDATE_ARCHIVE_KEY]!=null){
      try{
        const archive=getCurrentUpdateArchive(context);
        if(!archive)throw new Error('archive missing');
        const history=[...archive.audit].reverse().map(item=>({
          at:item.at,changed:item.changed,before:item.before,after:item.after,
        }));
        return {kind:'ready',mode:'chat',
          view:buildPlayerView(archive.contract,archive.snapshot,history)};
      }catch{
        return {kind:'error',message:'当前聊天的变量存档需要检查，已停止显示不可靠数据。'};
      }
    }
    const raw=context.chatMetadata?.[EXPERIMENTAL_METADATA_KEY];
    if(raw==null)return {kind:'empty',message:'当前聊天尚无新版万花筒状态。旧版变量不会被预览版自动读取。'};
    const text=getSavedContract();
    if(!text)return {kind:'empty',message:'作者尚未保存可用于这个预览的变量契约。'};
    try{
      const contract=parseContract(JSON.parse(text));
      const snapshot=readSnapshot(contract,raw);
      return {kind:'ready',mode:'chat',view:buildPlayerView(contract,snapshot)};
    }catch{
      return {kind:'error',message:'当前聊天的变量存档与契约不匹配，请联系角色卡作者检查。'};
    }
  };
}
