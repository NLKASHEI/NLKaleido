import type { EvidenceHit } from './bm25f.js';
/**
 * RRF adapter for an optional trusted dense retriever.
 * The dense index/provider is NOT included; BM25F works standalone.
 * Callers enforce chat scope on both lists before fusion.
 */
export function fuseRankedEvidence(
  lists: readonly (readonly EvidenceHit[])[],
  rrfK=60,
  limit=8,
):EvidenceHit[]{
  if(!Number.isSafeInteger(rrfK)||rrfK<1||rrfK>10000||
     !Number.isSafeInteger(limit)||limit<0||limit>100)
    throw new Error('RRF 参数不合法');
  const hits=new Map<string,{hit:EvidenceHit;score:number}>();
  for(const results of lists){
    const seen=new Set<string>();
    results.forEach((item,rank)=>{
      if(!item.id||seen.has(item.id))return;
      seen.add(item.id);
      const prev=hits.get(item.id);
      hits.set(item.id,{
        hit:prev?.hit??item,
        score:(prev?.score??0)+1/(rrfK+rank+1),
      });
    });
  }
  return [...hits.values()].sort((a,b)=>b.score-a.score||
    b.hit.turn-a.hit.turn||a.hit.id.localeCompare(b.hit.id))
    .slice(0,limit).map(({hit,score})=>({...hit,score}));
}
