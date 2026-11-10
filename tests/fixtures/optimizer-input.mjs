// Entirely synthetic fixture. No account, cache, or user archive is required.
import {buildEnemy} from '../../public/sim/hbr/battle.mjs';
import {membersFromDeck} from '../../public/sim/hbr/deck.mjs';
export function optimizerInput({count=12,opts={}}={}){
  const elements=['Ice','Fire','Thunder','Light','Dark',null];
  const catalog={styles:[],characters:[]},skills={styles:{},statusTypes:{}},equipment={entries:[]};
  const stats={styles:{},characters:{},latents:{},extraSkills:{}};
  const cache={cards:[],decks:[],accessories:[]},archive={styles:{},characters:{}};
  for(let i=0;i<count;i++){
    const styleId='S'+i,characterId='C'+i,el=elements[i%6],power=1200+i*45;
    const style={id:styleId,characterId,name:'Style '+i,tier:'SS',team:'T',role:i%3?'Healer':'Buffer',attackType:'Slash',elements:el?[el]:[],baseParameters:{}};
    catalog.styles.push(style);catalog.characters.push({id:characterId,name:'Character '+i,styleIds:[styleId]});
    const attack={id:100+i,label:'Skill'+i,name:'Attack '+i,sp:2,consume:'Sp',uses:-1,hitCount:2,maxLevel:1,
      parts:[{skillType:'AttackSkill',targetType:'Single',elements:el?[el]:[],power:[power,power],attackType:'Slash',diffForMax:100,parameters:{str:1},multipliers:{dp:1,hp:1,dr:1}}]};
    const buff={id:200+i,label:'Buff'+i,name:'Buff '+i,sp:2,consume:'Sp',uses:-1,hitCount:0,maxLevel:1,
      parts:[{skillType:'AttackUp',targetType:'AllyFront',power:[0.5,0],exit:{cond:'Count',value:[1,0]}}]};
    skills.styles[styleId]={skills:[attack,buff],passives:[]};
    stats.styles[styleId]={base:{},tree:[]};
    stats.characters[characterId]={level:[1,200],...Object.fromEntries(['str','dex','con','spr','wis','luk'].map(k=>[k,[500,500]])),dp:[10000,10000],hp:[2000,2000]};
    const raw={styleId,characterId,limitBreak:0,tearLevel:0,card:{level:20},character:{level:100,reincarnation:1},characterCards:[],skillIds:[],latentIds:[],accessories:{}};
    cache.cards.push(raw);archive.styles[styleId]={owned:true};
  }
  for(let i=0;i<=count-6;i++)cache.decks.push({index:i,name:'Synthetic '+i,current:i===0,members:cache.cards.slice(i,i+6)});
  const event={enemies:{E:{flags:{is_boss:true},resist:{element:{}},pattern:{},skills:[]}}};
  const stage={enemies:[{label:'E',name:'Synthetic enemy',dp:0,hp:15000,paramBorder:400,destruction:[10,300]}]};
  const enemy=buildEnemy(event,stage);
  return {data:{catalog,skills,stats,equipment},archive,cache,base:membersFromDeck(cache.decks[0],{catalog,equipment,stats}),
    target:{kind:'wave',ev:{elements:[]},rules:[],phases:[{enemies:[enemy]}],cards:[],difficulty:40,international:true},
    opts:{goal:'score',beam:3,screenBeam:2,maxTurns:3,mcJudge:2,mcRuns:8,searchMs:0,broad:false,optimizeCards:false,top:10,...opts}};
}
