/**
 * In-house BM25F implementation, inspired by shujuku's Chinese BM25 baseline.
 * Unlike shujuku's whole-chunk BM25, this scores independently normalized
 * fields with explicit boosts. No embeddings, network calls or external service.
 */
export type EvidenceField = 'title'|'tags'|'summary'|'body';
export type EvidenceDocument = {
  id: string;
  scope: string;
  turn: number;
  fields: Partial<Record<EvidenceField,string>>;
};
export type EvidenceHit = { id: string; score: number; turn: number; fields: EvidenceDocument['fields'] };
export type FieldOption = { boost: number; b: number };
export type BM25FOptions = {
  k1?: number;
  fields?: Partial<Record<EvidenceField,Partial<FieldOption>>>;
};
type IndexedDoc = { doc: EvidenceDocument; lengths: Record<EvidenceField,number>; freq: Record<EvidenceField,Map<string,number>> };
const FIELD_NAMES: EvidenceField[]=['title','tags','summary','body'];
const DEFAULTS:Record<EvidenceField,FieldOption>={
  title:{boost:3.2,b:0.25},tags:{boost:2.7,b:0.25},
  summary:{boost:1.8,b:0.55},body:{boost:1,b:0.78},
};
const HAN=/\p{Script=Han}/u;
const TOKENS=/[\p{Script=Han}]+|[\p{Letter}\p{Number}_-]+/gu;

/** Chinese character and bigram indexing, case-insensitive Latin words. */
export function tokenizeEvidence(input:string):string[]{
  const normalized=String(input).normalize('NFKC').toLowerCase();
  const chunks=normalized.match(TOKENS)??[];
  const tokens:string[]=[];
  for(const chunk of chunks){
    if(HAN.test(chunk[0]??'')){
      for(let i=0;i<chunk.length;i++){
        tokens.push(chunk[i]??'');
        if(i+1<chunk.length)tokens.push(chunk.slice(i,i+2));
      }
    }else tokens.push(chunk);
  }
  return tokens.filter(Boolean);
}

function settings(options:BM25FOptions):Record<EvidenceField,FieldOption>{
  const out={} as Record<EvidenceField,FieldOption>;
  for(const field of FIELD_NAMES){
    const user=options.fields?.[field];
    const boost=user?.boost??DEFAULTS[field].boost;
    const b=user?.b??DEFAULTS[field].b;
    if(!Number.isFinite(boost)||boost<0||!Number.isFinite(b)||b<0||b>1)
      throw new Error('BM25F 参数必须满足 boost>=0、0<=b<=1');
    out[field]={boost,b};
  }
  return out;
}

export class BM25FIndex {
  private docs=new Map<string,IndexedDoc>();
  private df=new Map<string,number>();
  private average={} as Record<EvidenceField,number>;
  private fields:Record<EvidenceField,FieldOption>;
  private k1:number;
  readonly scope:string;

  constructor(scope:string,options:BM25FOptions={}){
    if(!scope.trim())throw new Error('检索作用域不能为空');
    this.scope=scope;
    this.fields=settings(options);
    this.k1=options.k1??1.5;
    if(!Number.isFinite(this.k1)||this.k1<=0)throw new Error('BM25F k1 必须大于 0');
    this.rebuild([]);
  }

  /** Rebuild from an immutable, bounded scope-specific corpus. */
  rebuild(source:readonly EvidenceDocument[]):void{
    if(source.length>5000)throw new Error('BM25F 单索引最大 5000 条证据');
    const indexed=new Map<string,IndexedDoc>();
    for(const doc of source){
      if(doc.scope!==this.scope)throw new Error('不能跨聊天作用域建立索引');
      if(!doc.id||!Number.isSafeInteger(doc.turn)||doc.turn<0||indexed.has(doc.id))
        throw new Error('证据 ID 重复或轮次不合法');
      const fields={} as EvidenceDocument['fields'];
      const lengths={} as Record<EvidenceField,number>;
      const freq={} as Record<EvidenceField,Map<string,number>>;
      for(const field of FIELD_NAMES){
        const value=doc.fields[field]??'';
        if(typeof value!=='string'||value.length>16000)throw new Error('证据文本格式或大小不合法');
        fields[field]=value;
        const tokens=tokenizeEvidence(value);
        lengths[field]=tokens.length;
        freq[field]=new Map<string,number>();
        for(const token of tokens)freq[field].set(token,(freq[field].get(token)??0)+1);
      }
      indexed.set(doc.id,{doc:{id:doc.id,scope:doc.scope,turn:doc.turn,fields},lengths,freq});
    }
    this.docs=indexed;
    this.df=new Map();
    this.average={} as Record<EvidenceField,number>;
    for(const field of FIELD_NAMES){
      let length=0;
      for(const entry of indexed.values())length+=entry.lengths[field];
      this.average[field]=indexed.size?length/indexed.size:0;
    }
    for(const entry of indexed.values()){
      const terms=new Set<string>();
      for(const field of FIELD_NAMES)for(const term of entry.freq[field].keys())terms.add(term);
      for(const term of terms)this.df.set(term,(this.df.get(term)??0)+1);
    }
  }

  /** Editing/deleting is exact: caller must rebuild on the new snapshot. */
  get size():number{return this.docs.size;}

  search(query:string,limit=8,excludeIds:ReadonlySet<string>=new Set()):EvidenceHit[]{
    if(!Number.isSafeInteger(limit)||limit<0||limit>100)throw new Error('检索数量必须在 0~100');
    if(query.length>2000)throw new Error('BM25F 查询过长');
    if(!limit)return [];
    const tokens=[...new Set(tokenizeEvidence(query))];
    if(!tokens.length||!this.docs.size)return [];
    const ranked:EvidenceHit[]=[];
    for(const {doc,lengths,freq} of this.docs.values()){
      if(excludeIds.has(doc.id))continue;
      let score=0;
      for(const term of tokens){
        const df=this.df.get(term)??0;
        if(!df)continue;
        let tf=0;
        for(const field of FIELD_NAMES){
          const count=freq[field].get(term)??0;
          if(!count)continue;
          const {boost,b}=this.fields[field];
          const normalizer=(1-b)+b*(lengths[field]/Math.max(1,this.average[field]));
          tf+=(boost*count)/Math.max(1e-9,normalizer);
        }
        if(!tf)continue;
        const idf=Math.log(1+(this.docs.size-df+.5)/(df+.5));
        score+=idf*(tf*(this.k1+1))/(tf+this.k1);
      }
      if(score>0)ranked.push({id:doc.id,score,turn:doc.turn,fields:{...doc.fields}});
    }
    return ranked.sort((a,b)=>b.score-a.score||b.turn-a.turn||a.id.localeCompare(b.id)).slice(0,limit);
  }
}
