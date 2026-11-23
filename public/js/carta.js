'use strict';
const $=s=>document.querySelector(s);
const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const money=c=>new Intl.NumberFormat('es-ES',{style:'currency',currency:'EUR'}).format(c/100);
let menu=null,revision=-1,group='comida',category='frias';
const photoUrl=key=>'/api/photos/'+encodeURIComponent(key);
function readLocation(){let parts;try{parts=decodeURIComponent(location.hash.slice(1)).split('/');}catch{return;}if(/^[a-zA-Z0-9_-]+$/.test(parts[0]))group=parts[0];if(parts[1])category=parts[1];}
function setLocation(g,c){group=g;if(c)category=c;history.replaceState(null,'','#'+g+(g==='instalaciones'?'':'/'+category));render();}
function render(){
 if(!menu)return;
 if(group!=='instalaciones'&&!menu.sections.some(s=>s.id===group))group=menu.sections[0]?.id||'instalaciones';
 const sections=[...menu.sections,{id:'instalaciones',name:menu.settings.facilitiesLabel}];
 $('.group-nav').innerHTML=sections.map((s,index)=>`<button type="button" data-group="${esc(s.id)}" aria-pressed="${s.id===group}"><span>${String(index+1).padStart(2,'0')}</span>${esc(s.name)}</button>`).join('');
 const facilities=group==='instalaciones';$('#folder-aside').hidden=facilities;$('#menu-layout').classList.toggle('facilities-layout',facilities);
 if(facilities){renderFacilities();return;}
 const cats=menu.categories.filter(c=>c.group===group);if(!cats.some(c=>c.id===category))category=cats[0]?.id;
 $('#folders').innerHTML=cats.map(c=>`<button type="button" data-category="${esc(c.id)}" aria-current="${c.id===category}"><span>${esc(c.name)}</span><small>${menu.items.filter(i=>i.category===c.id).length}</small></button>`).join('');
 const cat=cats.find(c=>c.id===category);if(!cat){$('#contenido').innerHTML='<div class="empty">No hay productos en esta sección.</div>';return;}
 const items=menu.items.filter(i=>i.category===cat.id);
 $('#contenido').innerHTML=`<header class="section-heading"><h2>${esc(cat.name)}</h2><span class="section-number" aria-hidden="true">${String(cats.indexOf(cat)+1).padStart(2,'0')}</span></header>${cat.note?`<p class="section-note ${cat.note.length>280?'long':''}">${esc(cat.note)}</p>`:''}<div class="dishes ${items.some(i=>i.photo)?'has-photos':''}">${items.map(i=>`<article class="dish">${i.photo?`<button class="dish-photo" type="button" data-photo="${esc(i.photo)}" data-caption="${esc(i.name)}" aria-label="Ampliar foto de ${esc(i.name)}"><img src="${photoUrl(i.photo)}" alt="${esc(i.name)}" loading="lazy" width="150" height="130"></button>`:''}<div class="dish-body"><h3>${esc(i.name)}</h3>${i.description?`<p class="dish-description">${esc(i.description)}</p>`:''}<div class="prices">${i.prices.map(p=>`<div class="price">${p.label?`<span class="price-label">${esc(p.label)}</span>`:''}<span class="price-value">${money(p.cents)}</span></div>`).join('')}</div></div></article>`).join('')}</div>${!items.length?'<div class="empty">Todavía no hay productos disponibles en esta carpeta.</div>':''}`;
}
function renderFacilities(){const photos=menu.facilities;$('#contenido').innerHTML=`<header class="section-heading"><h2>${esc(menu.settings.facilitiesTitle)}</h2><span class="section-number" aria-hidden="true">${String(menu.sections.length+1).padStart(2,'0')}</span></header>${photos.length?`<div class="facilities-grid">${photos.map(f=>`<figure class="facility"><button type="button" data-photo="${esc(f.photo)}" data-caption="${esc(f.title)}" aria-label="Ampliar foto de ${esc(f.title)}"><img src="${photoUrl(f.photo)}" alt="${esc(f.title)}" loading="lazy" width="400" height="270"></button><figcaption><h3>${esc(f.title)}</h3>${f.description?`<p>${esc(f.description)}</p>`:''}</figcaption></figure>`).join('')}</div>`:`<div class="empty"><strong>${esc(menu.settings.facilitiesEmptyTitle)}</strong>${esc(menu.settings.facilitiesEmptyText)}</div>`}`;}
function applyPresentation(){
 const s=menu.settings;
 const fields={'#brand-strapline':s.strapline,'#brand-secondary':s.secondaryName,'#menu-eyebrow':s.eyebrow,'#menu-heading':s.heading,'#menu-accent':s.headingAccent,'#menu-intro':s.introNote,'#facilities-link':s.facilitiesTitle};
 for(const [selector,value] of Object.entries(fields)){const el=$(selector);el.textContent=value;el.hidden=!value;}
 document.title=[s.heading+' '+s.headingAccent,s.brandName,s.secondaryName].filter(Boolean).join(' · ');
 $('meta[name="theme-color"]').content=s.accentColor;
 $('.brand').setAttribute('aria-label',s.brandName+', inicio');
 const logo=$('#brand-logo');logo.hidden=!s.showLogo;logo.classList.toggle('custom-logo',!!s.logoPhoto);
 logo.querySelector('img').src=s.logoPhoto?photoUrl(s.logoPhoto):'/img/logo-punto-cero.jpg';logo.querySelector('img').alt=s.brandName;
 $('#footer-brand').textContent=[s.brandName,s.secondaryName].filter(Boolean).join(' × ');
 $('#allergen-notice').textContent=menu.notice;
 document.documentElement.style.setProperty('--red',s.accentColor);
 document.documentElement.style.setProperty('--red-dark','color-mix(in srgb, '+s.accentColor+', black 20%)');
 document.querySelectorAll('.checker').forEach(el=>el.hidden=!s.showChecker);
}
async function load(initial=false){try{const r=await fetch('/api/menu',{cache:'no-store'});const data=await r.json();if(!r.ok)throw new Error(data.error||'No se ha podido cargar la carta.');if(data.revision!==revision||!menu){menu=data.menu;revision=data.revision;applyPresentation();render();}$('#status').hidden=true;$('#menu-layout').hidden=false;}catch(e){if(initial||!menu){$('#status').hidden=false;$('#status').classList.add('error');$('#status').innerHTML=esc(e.message)+'<br><button type="button" id="retry" class="primary">Volver a intentar</button>';}}}
$('.group-nav').addEventListener('click',e=>{const b=e.target.closest('[data-group]');if(b&&menu)setLocation(b.dataset.group,menu.categories.find(c=>c.group===b.dataset.group)?.id);});
$('#folders').addEventListener('click',e=>{const b=e.target.closest('[data-category]');if(b)setLocation(group,b.dataset.category);});
$('#facilities-link').addEventListener('click',e=>{e.preventDefault();setLocation('instalaciones');$('#contenido').scrollIntoView({block:'start'});});
$('#status').addEventListener('click',e=>{if(e.target.closest('#retry'))load(true);});
$('#contenido').addEventListener('click',e=>{const b=e.target.closest('[data-photo]');if(!b)return;const d=$('#photo-dialog');d.querySelector('img').src=photoUrl(b.dataset.photo);d.querySelector('img').alt=b.dataset.caption;d.querySelector('p').textContent=b.dataset.caption;d.showModal();});
$('.close-button').addEventListener('click',()=>$('#photo-dialog').close());
$('#photo-dialog').addEventListener('click',e=>{if(e.target===$('#photo-dialog'))$('#photo-dialog').close();});
window.addEventListener('hashchange',()=>{readLocation();render();});window.addEventListener('focus',()=>load());document.addEventListener('visibilitychange',()=>{if(!document.hidden)load();});setInterval(()=>{if(!document.hidden)load();},60000);
readLocation();load(true);
