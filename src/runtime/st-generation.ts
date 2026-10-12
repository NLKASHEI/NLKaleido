import { chatScope, type StChatContext } from './chat-timeline.js';
import { buildUpdatePrompt } from '../update/prompt.js';
import type { UpdateObservation } from '../update/pipeline.js';

export type StGenerationContext=StChatContext & {
  generateRaw?: (opts:{
    systemPrompt:string;prompt:string;responseLength?:number;trimNames?:boolean;
  })=>Promise<string>;
};

/** Use the selected SillyTavern model without writing any message to chat. */
export function createStRawProposalProvider(
  getCurrentContext:()=>StGenerationContext,
  responseLength=2000,
){
  if(!Number.isSafeInteger(responseLength)||responseLength<256||responseLength>8192)
    throw new Error('模型输出预算必须在 256~8192 tokens 之间');
  return async (observation:UpdateObservation,feedback?:string):Promise<string>=>{
    const before=getCurrentContext();
    if(chatScope(before)!==observation.scope)
      throw new Error('生成提案前聊天已切换');
    if(typeof before.generateRaw!=='function')
      throw new Error('酒馆当前版本缺少官方 generateRaw 能力');
    const {system,user}=buildUpdatePrompt(observation);
    // Keep stable system prefix; append correction feedback only to dynamic tail.
    const prompt=feedback?user+'\n\n上一轮校验失败：'+feedback.slice(0,350)+
      '\n仅重试合法的 JSON 提案，不要解释。':user;
    const result=await before.generateRaw({
      systemPrompt:system,prompt,responseLength,trimNames:false,
    });
    if(chatScope(getCurrentContext())!==observation.scope)
      throw new Error('生成提案期间聊天已切换');
    if(typeof result!=='string'||!result.trim())
      throw new Error('酒馆模型没有返回有效文本');
    return result;
  };
}
