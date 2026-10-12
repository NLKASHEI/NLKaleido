import './player.css';
import { mountPlayerStatus, type PlayerStatusResult } from '../src/player/ui.js';
import { buildPlayerView } from '../src/player/model.js';
import { demoContract, STORAGE_CONTRACT, STORAGE_HISTORY, STORAGE_STATE } from '../src/ui/model.js';
import { parseContract } from '../src/core/contract.js';
import { initialSnapshot, readSnapshot } from '../src/core/state.js';

const target=document.getElementById('player');
if(!target) throw new Error('Player preview root missing');

async function load():Promise<PlayerStatusResult>{
  try{
    let contract=demoContract;
    const raw=localStorage.getItem(STORAGE_CONTRACT);
    if(raw)contract=parseContract(JSON.parse(raw));
    const saved=localStorage.getItem(STORAGE_STATE);
    const snapshot=saved?readSnapshot(contract,JSON.parse(saved)):initialSnapshot(contract);
    const history=JSON.parse(localStorage.getItem(STORAGE_HISTORY)??'[]');
    return {kind:'ready',mode:'demo',view:buildPlayerView(contract,snapshot,Array.isArray(history)?history:[])};
  }catch{
    return {kind:'error',message:'演示状态无法读取，请检查作者工作台保存的契约。'};
  }
}
mountPlayerStatus(target,load,true);
