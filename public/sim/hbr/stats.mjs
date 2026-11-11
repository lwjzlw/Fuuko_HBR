// 面板推算：由游戏缓存（编队成员的卡面/角色/装备原始数据）+ 公开主数据（stats.json、equipment.json）。
// 结构由用户 2026-11-08 的游戏截图（茅森〈Glorious Blades〉角色详情与饰品页）逐行核对：
//   基础状态值   = 角色等级曲线(Lv = CLv + SLv) + 转生；“+”列 = 称号 + 同角色全部卡面的共享节点(RealNumber) + 各卡突破能力加成
//   战术型态状态值 = 卡面基础% + 突破×每级% + 本卡 Ratio 节点 + 才能开花 10% + 基本衣装完凸 10%（DP 只有卡面基础%）；固定值 = 本卡 Addition 节点
//   合计 = ⌈(基础 + “+”列 + 潜在面板×2) × (1+战术%)⌋ + 战术固定值 + 饰品 + 增幅器与芯片 + 固有潜在 + 支援(支援卡面状态值的 10%)
//   饰品：+6 的随机词条取各组最大值；吊饰按主词条 ID 末位；灵魂 5+4×强化；“+枠”每条 +3；HP 不吃战术%
import {accessoryEffects} from './deck.mjs';
import {canEquip} from '../../equipment.mjs';

export const STAT_KEYS=['str','dex','con','spr','wis','luk'];
const ALL=[...STAT_KEYS,'dp','hp'];
const TYPE_KEY={Power:'str',Dexterity:'dex',Toughness:'con',Spirit:'spr',Wisdom:'wis',Luck:'luk',Dp:'dp',Hp:'hp'};
const PANEL_ORDER=['str','dex','con','spr','wis','luk'];
// 饰品“+枠”：4240001x = 六项 +3（用户确认）；42400005 = 体力 +2（蒼井项链，截图反推）；其余 4240000x 暂无样本
export const EXPANSION={42400011:['str',3],42400012:['dex',3],42400013:['con',3],42400014:['spr',3],42400015:['wis',3],42400016:['luk',3],42400005:['con',2]};

export const STAT_MODEL={
  latentPerNode:2,reincarnationPerCount:1,accountFlat:0,daphneRate:10,outfitRate:10,soulBase:5,soulPerPlus:4,plusSlotValue:3,supportRate:0.1,
  titleRankAll:[2,3,4,6,7,8,11,12,13],titleRankDp:[5,9,14,15],
  confirmed:['等级=CLv+SLv','“+”列构成','战术%/固定值构成','饰品合计','DP/HP 与支援 10%'],
  status:'partly-confirmed',
};

// 游戏取整为向上取整（2026-11-08 用 4 人合计与 2 张支援面板核对）
const ceil=x=>Math.ceil(x-1e-9);
const zero=()=>Object.fromEntries(ALL.map(k=>[k,0]));
const add=(o,k,v)=>{if(k==='all'){for(const s of STAT_KEYS)o[s]+=v;}else if(k in o)o[k]+=v;};

export function titleRank(exp){let r=1;while(r<15&&exp>=250*(r+1)*r)r++;return r;}

/** 一张卡已取得的能力树节点（0/1 分区默认全取得；其余按缓存取得数，部分取得按公开顺序取前 N 个）。 */
export function treeNodes(styleData,treeParts){
  const tree=styleData?.tree||[];
  const got=new Map((treeParts||[]).map(p=>[Number(p.id)%10,p.count]));
  const out=[];let partial=false;
  tree.forEach((nodes,idx)=>{const n=idx<=1?nodes.length:(got.get(idx)??0);if(n>0&&n<nodes.length)partial=true;out.push(...nodes.slice(0,n));});
  return {nodes:out,partial};
}

/** 角色（不含饰品）的状态值：返回各部分与 styleValue = ⌊B×(1+P)⌋+F（支援用的就是这个）。 */
export function styleStatus(src,S,catalog,model=STAT_MODEL){
  const styleData=S.styles[src.styleId],style=catalog.styles.find(s=>s.id===src.styleId);
  const charData=S.characters[style?.characterId];
  if(!styleData||!charData)return null;
  const notes=[];
  const lv=(src.character?.level||1)+(src.card?.level||0),[l0,l1]=charData.level||[1,200],t=Math.max(0,Math.min(1,(lv-l0)/(l1-l0)));
  const level=zero();for(const k of ALL){const r=charData[k]||[0,0];level[k]=r[0]+(r[1]-r[0])*t;}
  const reinc=zero();add(reinc,'all',(src.character?.reincarnation||0)*model.reincarnationPerCount);
  const rank=titleRank(src.character?.titleExp||0),title=zero();add(title,'all',model.titleRankAll.filter(r=>r<=rank).length);title.dp=model.titleRankDp.filter(r=>r<=rank).length*50;
  const shared=zero(),lbBonus=zero();let outfit=false;
  for(const c of src.characterCards||[]){
    const sd=S.styles[c.styleId];if(!sd)continue;
    for(const n of treeNodes(sd,c.treeParts).nodes)if(n.k==='shared')add(shared,n.t,n.v);
    for(const b of sd.lbBonus||[]){if(b.step>(c.limitBreak||0))continue;if(b.t==='allOther'){if(c.styleId!==src.styleId)outfit=true;}else add(lbBonus,b.t,b.v);}
  }
  const latent=zero();(src.card?.latentPanels||[]).forEach((c,i)=>{if(PANEL_ORDER[i])latent[PANEL_ORDER[i]]+=c*model.latentPerNode;});
  const own=treeNodes(styleData,src.card?.treeParts);if(own.partial)notes.push('有能力树分区只取得一部分：按公开顺序取前 N 个');
  const ratio=zero(),flat=zero();for(const n of own.nodes){if(n.k==='ratio')add(ratio,n.t,n.v);else if(n.k==='add')add(flat,n.t,n.v);}
  const lb=src.limitBreak||0,rate=zero();
  for(const k of STAT_KEYS)rate[k]=(styleData.base[k]||0)+lb*(styleData.statUpPerLb||0)+ratio[k]+(src.card?.daphne?model.daphneRate:0)+(outfit?model.outfitRate:0);
  rate.dp=styleData.base.dp||0;rate.hp=0;
  const B=zero(),value=zero();
  for(const k of ALL){B[k]=level[k]+reinc[k]+title[k]+shared[k]+lbBonus[k]+latent[k];value[k]=ceil(B[k]*(1+rate[k]/100))+flat[k];}
  return {characterId:style.characterId,lv,rank,outfit,level,reinc,title,shared,lbBonus,latent,rate,flat,B,value,notes};
}

/**
 * 推算一名成员的面板。m：/api/cache-decks 的成员；data：{stats, equipment, catalog}
 * 返回 {final, parts:[{key,label,kind,values}], rate, notes[], support}
 */
export function computePanel(m,data,model=STAT_MODEL){
  const S=data.stats,notes=[],parts=[];
  const me=styleStatus(m,S,data.catalog,model);
  if(!me)return {final:null,parts,notes:['主数据里没有这张卡面'],rate:{}};
  notes.push(...me.notes);
  const push=(key,label,kind,values)=>parts.push({key,label,kind,values});
  push('level',`角色等级 Lv${me.lv}（CLv+SLv）`,'base',me.level);
  push('reincarnation',`转生 +${m.character?.reincarnation||0}`,'base',me.reinc);
  push('title',`称号 Rank${me.rank}`,'base',me.title);
  push('shared','同角色共享节点（各卡能力树）','base',me.shared);
  push('lbBonus','各卡突破能力加成','base',me.lbBonus);
  push('latent','潜在面板（每格 +2）','base',me.latent);
  push('rate',`战术型态 %（卡面+突破+本卡节点${m.card?.daphne?'+才能开花':''}${me.outfit?'+基本衣装完凸':''}）`,'rate',me.rate);
  push('flat','战术型态 固定值（本卡节点）','flat',me.flat);
  // ---- 饰品
  const eqBy=data.equipmentById||new Map((data.equipment.entries||[]).map(e=>[e.sourceId,e]));
  const gear=zero(),plus=zero();let soul=null;
  const owner={styleId:m.styleId,characterId:me.characterId};
  for(const slot of m.unresolvedAccessories||[])if(!m.accessories?.[slot])notes.push(`饰品 ${slot} 的编队记录未匹配库存`);
  for(const [slot,a] of Object.entries(m.accessories||{})){
    const e=eqBy.get(a.masterId);
    if(!e){notes.push(`饰品 ${slot}:${a.masterId} 不在目录`);continue;}
    if(!canEquip(e,owner)){notes.push(`${e.name} 的专属限制与当前卡面不符`);continue;}
    if(slot==='soul')soul=a;
    else for(const f of accessoryEffects(e,a.main)){const k=TYPE_KEY[f.type];if(k)gear[k]+=Number(f.value?.[0])||0;}
    for(const x of a.expansion||[]){const e=EXPANSION[x];if(e)plus[e[0]]+=e[1];else notes.push(`饰品+枠 ${x} 未知`);}
  }
  if(soul)add(gear,'all',model.soulBase+model.soulPerPlus*(soul.plus||0));
  for(const k of ALL)gear[k]+=plus[k];
  push('gear',`饰品（含吊饰、灵魂${soul?' +'+(soul.plus||0):''}、+枠每条 +${model.plusSlotValue}）`,'flat',gear);
  const bo=zero();
  for(const id of [m.boosterId,...(m.sphereIds||[])].filter(Boolean)){const e=eqBy.get(id);if(!e){notes.push(`增幅器/芯片 ${id} 不在目录`);continue;}for(const f of e.effects||[]){const k=TYPE_KEY[f.type];if(k)bo[k]+=Number(f.value?.[0])||0;}}
  push('booster','增幅模组（增幅器与芯片）','flat',bo);
  const la=zero();for(const id of m.latentIds||[]){const L=S.latents[String(id)];if(L?.unique)for(const [k,v] of Object.entries(L.stats))la[k]+=v;}
  push('latentAbility','固有潜在能力','flat',la);
const ms=zero();
  let sup=null;const supv=zero();
  if(m.support){sup=styleStatus(m.support,S,data.catalog,model);if(sup)for(const k of ALL)supv[k]=ceil(sup.value[k]*model.supportRate);else notes.push('支援卡面缺主数据');}
  push('support',sup?`支援 ${m.support.styleId}（其状态值的 ${model.supportRate*100}%）`:'支援（无）','flat',supv);
  const final={};
  for(const k of ALL)final[k]=me.value[k]+gear[k]+bo[k]+la[k]+ms[k]+supv[k];
  if(!m.card)notes.push('缺卡面数据（请重新从游戏编队导入）');
  return {final,parts,rate:me.rate,notes,support:sup};
}
