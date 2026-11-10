export function createCatalogImages(catalog,escape){
  const styles=new Map(catalog.styles.map(s=>[s.id,s]));
  const characters=new Map(catalog.characters.map(c=>[c.id,c]));
  const media=(asset,alt,className='',lazy=true)=>`<span class="catalog-media ${escape(className)}">${asset?.path?`<img src="${escape(asset.path)}" alt="${escape(alt)}" loading="${lazy?'lazy':'eager'}" decoding="async">`:''}<span class="image-fallback" ${asset?.path?'hidden':''}>图片待更新</span></span>`;
  const artwork=(style,className='')=>`<button type="button" class="artwork-button ${escape(className)}" data-artwork="${escape(style.id)}" aria-label="查看 ${escape(style.name)} 大图">${media(style.artwork,style.name+' 卡图','style-art')}<span class="artwork-hint">查看大图 ↗</span></button>`;
  document.addEventListener('error',event=>{
    const img=event.target;
    if(img instanceof HTMLImageElement&&img.parentElement?.classList.contains('catalog-media')){
      img.hidden=true;img.parentElement.querySelector('.image-fallback').hidden=false;
    }
  },true);
  document.addEventListener('click',event=>{
    const button=event.target.closest?.('[data-artwork]');
    if(!button)return;
    const style=styles.get(button.dataset.artwork);if(!style)return;
    const character=characters.get(style.characterId),viewer=document.createElement('dialog');
    viewer.className='artwork-viewer';viewer.setAttribute('aria-label',character.name+' · '+style.name+' 卡图');
    viewer.innerHTML=`<div class="image-viewer-heading"><div><strong>${escape(character.name)}</strong><span>${escape(style.name)}</span></div><button type="button" aria-label="关闭大图">×</button></div>${media(style.artwork,character.name+' · '+style.name,'full-art',false)}`;
    viewer.querySelector('button').onclick=()=>viewer.close();
    viewer.addEventListener('click',e=>{if(e.target===viewer){const r=viewer.getBoundingClientRect();if(e.clientX<r.left||e.clientX>r.right||e.clientY<r.top||e.clientY>r.bottom)viewer.close();}});
    viewer.addEventListener('close',()=>{viewer.remove();button.focus();},{once:true});
    document.body.append(viewer);viewer.showModal();
  });
  return {media,artwork};
}
