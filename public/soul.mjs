export const SOUL_ENHANCEMENT_CAP=5;
export function validateSoulEnhancement(value){
  if(value!=null&&(!Number.isInteger(value)||value<0||value>SOUL_ENHANCEMENT_CAP))throw Error('灵魂书强化应为 +0～+5，未知请留空');
}
