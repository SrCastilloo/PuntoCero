import { z } from 'zod';
const id=z.string().min(1).max(80).regex(/^[a-zA-Z0-9_-]+$/);
const photo=z.string().max(100).regex(/^(|[a-f0-9-]{36}\.(jpg|png|webp))$/);
const color=z.string().regex(/^#[0-9a-fA-F]{6}$/,'Usa un color hexadecimal válido.').refine(value=>{
 const c=[1,3,5].map(i=>parseInt(value.slice(i,i+2),16)/255).map(v=>v<=0.04045?v/12.92:Math.pow((v+0.055)/1.055,2.4));
 return 1.05/(0.2126*c[0]+0.7152*c[1]+0.0722*c[2]+0.05)>=4.5;
},'Elige un color destacado más oscuro para que los textos blancos se lean bien.');
const settingsSchema=z.object({
 brandName:z.string().trim().min(1).max(100).default('Punto Cero'),
 secondaryName:z.string().max(100).default('La Glotona'),
 strapline:z.string().max(150).default('COCINA · CAFÉ · COPAS'),
 eyebrow:z.string().max(150).default('PUNTO CERO & LA GLOTONA'),
 heading:z.string().trim().min(1).max(100).default('Nuestra'),
 headingAccent:z.string().max(100).default('carta.'),
 introNote:z.string().max(350).default('Tapas, meriendas\ny algo para brindar.'),
 facilitiesTitle:z.string().trim().min(1).max(100).default('Nuestras instalaciones'),
 facilitiesLabel:z.string().trim().min(1).max(40).default('Instalaciones'),
 facilitiesEmptyTitle:z.string().max(150).default('Nos vemos en Punto Cero.'),
 facilitiesEmptyText:z.string().max(600).default('Muy pronto podrás ver aquí las fotos de nuestro local.'),
 accentColor:color.default('#b51e2d'),
 logoPhoto:photo.default(''),showLogo:z.boolean().default(true),showChecker:z.boolean().default(true)
}).strict();
const schema=z.object({
 settings:settingsSchema.default({}),
 sections:z.array(z.object({id:id.refine(v=>v!=='instalaciones','Ese identificador está reservado.'),name:z.string().trim().min(1).max(40),enabled:z.boolean().default(true)}).strict()).min(1).max(12).default([{id:'comida',name:'Para comer',enabled:true},{id:'meriendas',name:'Meriendas',enabled:true},{id:'bebidas',name:'Para beber',enabled:true}]),
 categories:z.array(z.object({id,name:z.string().trim().min(1).max(100),group:id,note:z.string().max(2500),enabled:z.boolean().default(true)}).strict()).min(1).max(80),
 items:z.array(z.object({id,category:id,name:z.string().trim().min(1).max(200),description:z.string().max(3000),prices:z.array(z.object({label:z.string().max(80),cents:z.number().int().min(0).max(1000000)}).strict()).max(8),photo,enabled:z.boolean(),reviewNote:z.string().max(2000)}).strict()).max(1000),
 facilities:z.array(z.object({id,title:z.string().trim().min(1).max(150),description:z.string().max(1000),photo:photo.refine(v=>!!v),enabled:z.boolean()}).strict()).max(100),
 notice:z.string().max(1200)
}).strict().superRefine((menu,ctx)=>{
 for(const field of ['sections','categories','items','facilities'] as const) if(new Set(menu[field].map(i=>i.id)).size!==menu[field].length)ctx.addIssue({code:'custom',message:'Hay identificadores repetidos.'});
 const groups=new Set(menu.sections.map(s=>s.id));
 if(menu.categories.some(c=>!groups.has(c.group)))ctx.addIssue({code:'custom',message:'Hay carpetas sin sección válida.'});
 if(!menu.sections.some(s=>s.enabled))ctx.addIssue({code:'custom',message:'Mantén al menos una sección visible.'});
 const ids=new Set(menu.categories.map(c=>c.id));
 if(menu.items.some(p=>!ids.has(p.category)))ctx.addIssue({code:'custom',message:'Hay platos sin carpeta válida.'});
 if(menu.items.some(p=>p.enabled&&!p.prices.length))ctx.addIssue({code:'custom',message:'Cada producto visible necesita al menos un precio.'});
});
export type Menu=z.infer<typeof schema>;
export function validateMenu(value:unknown) {return schema.parse(value);}
export function publicMenu(menu:Menu){
 const sections=menu.sections.filter(s=>s.enabled),groups=new Set(sections.map(s=>s.id));
 const categories=menu.categories.filter(c=>c.enabled&&groups.has(c.group)),categoryIds=new Set(categories.map(c=>c.id));
 return {...menu,sections,categories,items:menu.items.filter(i=>i.enabled&&categoryIds.has(i.category)).map(({reviewNote,enabled,...i})=>i),facilities:menu.facilities.filter(i=>i.enabled).map(({enabled,...i})=>i)};
}
