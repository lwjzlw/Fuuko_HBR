// 配置详情只读取已采用成员的数据；未识别词条与模型回退值分开显示。
import {describeEffect,statNames} from './equipment.mjs';
import {accessoryEffects} from './sim/hbr/deck.mjs';
import {EXPANSION,styleStatus,STAT_MODEL} from './sim/hbr/stats.mjs';

const SLOTS={earring:'耳环',necklace:'项链',ring:'戒指',bracelet:'手镯',soul:'灵魂书',jewel:'宝玉',powerCharm:'力量吊饰',dexterityCharm:'灵巧吊饰',toughnessCharm:'体力吊饰',spiritCharm:'精神吊饰',wisdomCharm:'智慧吊饰',luckCharm:'幸运吊饰'};
const CONDITION={IsAttacker:'ATK',IsBreaker:'BRK',IsBlaster:'BLA',IsHealer:'HEAL',IsBuffer:'BUFF',IsDebuffer:'DEBUFF',IsDefender:'DEF',IsAdmiral:'ADMIRAL'};
const effectText=f=>describeEffect(f)+(f.condition?`（条件：${f.condition.replace(/(Is\w+)\(\)/g,(s,k)=>CONDITION[k]||s)}）`:'');

export function equipmentDetails(member,equipment){
  const raw=member?.raw;
  if(!raw?.accessories)return null;
  const byId=new Map((equipment?.entries||[]).map(x=>[Number(x.sourceId),x])),out=[];
  const one=(slot,a,label)=>{
    const item=a&&byId.get(Number(a.masterId));
    const row={slot,label:label||SLOTS[slot]||slot,name:a?(item?.name||`未识别装备 #${a.masterId}`):'未装备',plus:a?.plus??null,lines:[]};
    if(a){
      const groups=item?.rollGroups||[],flat=groups.flatMap((g,gi)=>g.map(f=>({f,gi}))),ids=a.main||[];
      row.lines.push(...(item?.effects||[]).map(f=>'固定：'+effectText(f)));
      const picks=ids.map(id=>flat[Number(id)%100-1]);
      const exact=ids.length===groups.length&&picks.every(Boolean)&&new Set(picks.map(p=>p.gi)).size===groups.length;
      if(exact&&item)row.lines.push(...picks.map(p=>'主词条：'+effectText(p.f)));
      else if(groups.length||ids.length){
        row.lines.push(ids.length?'主词条未识别：'+ids.map(id=>'#'+id).join('、'):'主词条：未记录');
        const fallback=accessoryEffects(item,ids).slice(item?.effects?.length||0);
        if(fallback.length)row.lines.push('模拟暂按：'+fallback.map(effectText).join('；'));
      }
      if(slot!=='booster'&&slot!=='chip'){
        if(a.expansion?.length)row.lines.push('孔位：'+a.expansion.map((id,i)=>{const v=EXPANSION[id];return `${i+1}. ${v?statNames[v[0]]+' +'+v[1]:'未识别 #'+id}`;}).join('；'));
        else row.lines.push('孔位：'+(Array.isArray(a.expansion)?'无附加词条':'未记录'));
      }
      if(slot==='soul')row.lines.push(row.plus==null?'全能力强化加成：未记录':`全能力 +${STAT_MODEL.soulBase+STAT_MODEL.soulPerPlus*row.plus}（面板模型推算）`);
      if(item?.skills?.length)row.lines.push('附带技能：'+item.skills.map(s=>s.name||s.label).join('、'));
      if(item&&!item.effects?.length&&!groups.length&&slot!=='soul'&&!item.skills?.length&&item.description)row.lines.push(item.description);
    }
    out.push(row);
  };
  for(const slot of Object.keys(SLOTS))if(!slot.endsWith('Charm')||raw.accessories[slot])one(slot,raw.accessories[slot]);
  if(!Object.keys(raw.accessories).some(k=>k.endsWith('Charm')))out.push({slot:'charm',label:'吊饰',name:'未装备',lines:[]});
  for(const slot of Object.keys(raw.accessories))if(!(slot in SLOTS))one(slot,raw.accessories[slot]);
  if('boosterId' in raw)one('booster',raw.boosterId?{masterId:raw.boosterId}:null,'增幅器');
  if(Array.isArray(raw.sphereIds)){
    raw.sphereIds.forEach((id,i)=>one('chip',{masterId:id},'芯片 '+(i+1)));
    if(!raw.sphereIds.length)out.push({slot:'chip',label:'芯片',name:'未装备',lines:[]});
  }
  return out;
}

export function supportDetails(member,{catalog,stats}){
  const raw=member?.raw,sid=member?.supportStyleId!==undefined?member.supportStyleId:raw?.supportStyleId;
  if(!sid)return {name:sid===null?'未装备':'未记录',lines:[]};
  const style=catalog?.styles?.find(s=>s.id===sid),char=catalog?.characters?.find(c=>c.id===style?.characterId);
  const lb=member?.supportLimitBreak??raw?.supportLimitBreak??(raw?.support?.styleId===sid?raw.support.limitBreak:null);
  const lines=['突破：'+(lb==null?'未记录':lb)];
  const group=stats?.styles?.[sid]?.resonance,list=stats?.supportSkills?.[group];
  if(lb==null)lines.push('共鸣特性：突破未记录，无法确认档位');
  else if(list?.length){
    const hit=list.filter(x=>x.lb<=lb).sort((a,b)=>b.lb-a.lb)[0];
    if(hit){const p=hit.passive;lines.push(`共鸣特性：${p.name||p.label}（突破 ${hit.lb} 档）`);
      const desc=p.desc||p.description;if(desc&&!desc.includes('\uFFFD'))lines.push(desc);
      else lines.push('共鸣效果说明：未记录可读文本');}
    else lines.push('共鸣特性：当前突破没有可用档位');
  }else lines.push('共鸣特性：'+(group===null?'无':'未记录'));
  if(raw?.support?.styleId===sid&&stats&&catalog){
    const panel=styleStatus(raw.support,stats,catalog);
    if(panel)lines.push('面板加成（推算）：'+Object.entries(panel.value).filter(([,v])=>Number.isFinite(v)&&v!==0).map(([k,v])=>`${statNames[k]||k.toUpperCase()} +${Math.ceil(v*STAT_MODEL.supportRate-1e-9)}`).join(' · '));
    else lines.push('面板加成：支援数据不完整');
  }else lines.push('面板加成：支援养成未记录');
  return {name:style?`${char?.name||style.characterId}〈${style.name}〉`:`未识别卡面 ${sid}`,lines};
}

export function loadoutDetailsHtml(member,data,e){
  const rows=equipmentDetails(member,data.equipment),support=supportDetails(member,data);
  const row=(label,item)=>`<div class="pl-gear-row"><dt>${e(label)}</dt><dd><b>${e(item.name)}${item.plus!=null?' +'+e(String(item.plus)):''}</b>${item.lines.map(t=>`<span>${e(t)}</span>`).join('')}</dd></div>`;
  return `<dl class="pl-gear">${row('支援卡',support)}${rows?rows.map(r=>row(r.label,r)).join(''):'<div class="pl-gear-row"><dt>饰品</dt><dd>具体装备未记录，仅有计算参数</dd></div>'}</dl>`;
}
