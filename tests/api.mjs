import { Miniflare } from 'miniflare';
import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
const code='LOCAL-TEST-ONLY';
const root=process.cwd();
const mf=new Miniflare({modules:true,scriptPath:'dist/_worker.js',compatibilityDate:'2026-05-01',cf:false,d1Databases:{DB:'test-menu'},bindings:{ADMIN_CODE_HASH:createHash('sha256').update(code).digest('hex')},serviceBindings:{ASSETS:async request=>{
 const pathname=decodeURIComponent(new URL(request.url).pathname),file=path.resolve(root,'dist','.'+pathname);
 if(!file.startsWith(path.resolve(root,'dist')+path.sep))return new Response(null,{status:404});
 try {return new Response(await fs.readFile(file),{headers:{'Content-Type':pathname.endsWith('.jpg')?'image/jpeg':pathname.endsWith('.html')?'text/html':'application/octet-stream'}});}catch{return new Response(null,{status:404});}
}}});
let checks=0,cookie='';
const call=async(route,method='GET',body,headers={})=>mf.dispatchFetch('https://punto-cero-migration-test.pages.dev'+route,{method,headers:{Origin:'https://punto-cero-migration-test.pages.dev','X-Punto-Cero':'editar',Cookie:cookie,'CF-Connecting-IP':'192.0.2.1',...headers},...(body===undefined?{}:{body:typeof body==='string'||body instanceof Uint8Array?body:JSON.stringify(body)})});
const check=(a,b)=>{assert.deepEqual(a,b);checks++;};
try{
 let r=await call('/api/menu'),pub=await r.json();check(r.status,200);check(pub.menu.items.length,177);check(pub.menu.items.some(i=>'reviewNote' in i),false);
 check(pub.menu.items.find(i=>i.name==='Gildas de queso y cecina').prices,[{label:'1 unidad',cents:200},{label:'5 unidades',cents:700}]);
 check(pub.menu.items.find(i=>i.id==='p053').photo,'07782349-8e0b-4327-abf9-1c256634b5bc.jpg');
 check((await call('/api/edit')).status,401);check((await call('/api/menu','PUT',{menu:pub.menu,revision:0})).status,401);
 check((await call('/api/login','POST',{code:'wrong'})).status,403);
 r=await call('/api/login','POST',{code});check(r.status,200);const set=r.headers.get('set-cookie');assert(set.includes('HttpOnly')&&set.includes('Secure')&&set.includes('SameSite=Strict'));checks++;cookie=set.split(';')[0];
 check((await(await call('/api/status')).json()).owner,true);
 let privateData=await(await call('/api/edit')).json();check(privateData.menu.items.length,178);
 check((await call('/api/menu','PUT',{menu:privateData.menu,revision:0},{Origin:'https://attacker.test'})).status,403);
 privateData.menu.settings.heading='Carta de prueba';privateData.menu.sections[2].enabled=false;
 r=await call('/api/menu','PUT',{menu:privateData.menu,revision:0});check(r.status,200);const saved=await r.json();check(saved.revision,1);
 check((await(await call('/api/menu')).json()).menu.items.some(i=>i.category==='refrescos'),false);
 let concurrent=await Promise.all([call('/api/menu','PUT',{menu:privateData.menu,revision:1}),call('/api/menu','PUT',{menu:privateData.menu,revision:1})]);check(concurrent.map(r=>r.status).sort(),[200,409]);
 const invalid=structuredClone(privateData.menu);invalid.items[0].prices=[];check((await call('/api/menu','PUT',{menu:invalid,revision:2})).status,400);
 invalid.items[0].prices=[{label:'',cents:450}];invalid.settings.accentColor='#ffff00';check((await call('/api/menu','PUT',{menu:invalid,revision:2})).status,400);
 const jpg=await fs.readFile('public/img/logo-punto-cero.jpg');r=await call('/api/photos','POST',jpg);check(r.status,201);const {key}=await r.json();r=await call('/api/photos/'+key);check(r.headers.get('content-type'),'image/jpeg');check(Buffer.from(await r.arrayBuffer()),jpg);
 check((await call('/api/photos','POST',new Uint8Array(950001))).status,413);check((await call('/api/photos','POST',new TextEncoder().encode('<svg>not an image</svg>'))).status,400);
 check((await call('/api/photos/07782349-8e0b-4327-abf9-1c256634b5bc.jpg')).status,200);
 r=await call('/qr/carta-qr.svg');check(r.status,200);const svg=await r.text();check(svg.startsWith('<svg'),true);await fs.writeFile('tests/test-qr.svg',svg);
 check((await call('/_worker.js')).status,404);check((await call('/')).status,200);
 check((await call('/api/logout','POST',{})).status,200);check((await call('/api/edit')).status,401);
 for(let i=0;i<10;i++)check((await call('/api/login','POST',{code:'wrong'})).status,403);
 check((await call('/api/login','POST',{code:'wrong'})).status,429);
 console.log(`PASS: ${checks} checks in the Cloudflare runtime: migration data, owner login, private data, CSRF, concurrent updates, settings, photos, QR, logout and attempt limits.`);
}finally{await mf.dispose();}
