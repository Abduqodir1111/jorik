import {test} from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';
import {createHmac} from 'node:crypto';
import {registerMetaWebhook} from '../server/meta-webhook.js';
test('Meta webhook verifies challenge, exact raw signatures and rejects unsigned or tampered events',async()=>{
 const app=Fastify();const events:any[]=[];
 await registerMetaWebhook(app,{verifyToken:'verify',appSecret:'secret',receive:e=>events.push(e)});
 try {
  assert.equal((await app.inject('/webhooks/instagram?hub.mode=subscribe&hub.verify_token=bad&hub.challenge=123')).statusCode,403);
  const verified=await app.inject('/webhooks/instagram?hub.mode=subscribe&hub.verify_token=verify&hub.challenge=123');assert.equal(verified.body,'123');
  const body=JSON.stringify({object:'instagram',entry:[{id:'one'},{id:'two'}]});const signature='sha256='+createHmac('sha256','secret').update(body).digest('hex');
  const post=(payload:string,sig?:string)=>app.inject({method:'POST',url:'/webhooks/instagram',headers:{'content-type':'application/json',...(sig?{'x-hub-signature-256':sig}:{})},payload});
  assert.equal((await post(body)).statusCode,403);
  assert.equal((await post(body+' ',signature)).statusCode,403);
  assert.equal(events.length,0);
  assert.equal((await post(body,signature)).statusCode,200);assert.deepEqual(events,[{id:'one'},{id:'two'}]);
 }finally{await app.close()}
});

test('Real app receives signed Instagram events without owner cookie and persists to the correct account',async()=>{
 const fs=await import('node:fs');const os=await import('node:os');const path=await import('node:path');const {createApp}=await import('../server/app.js');
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'jorik-hook-app-'));
 const integration=(n:number)=>({token:'fake',receiveMode: n<3?'webhook' as const:'polling' as const,fetcher:(async(url:string)=>new URL(url).pathname.endsWith('/me')?Response.json({id:`page${n}`,instagram_business_account:{id:`ig${n}`,username:`shop${n}`}}):Response.json({data:[]})) as typeof fetch});
 const ctx=await createApp({dataDir:dir,mode:'real',worker:false,instagram:integration(1),instagram2:integration(2),instagram3:integration(3),metaWebhook:{verifyToken:'verify',appSecret:'secret'}});
 try{
  await ctx.app.inject({method:'POST',url:'/api/instagram/sync'}); // Unauthorized externally; startup identity is awaited below.
  for(let i=0;i<50&&ctx.db.prepare('SELECT count(*) n FROM instagram_identity').get().n<3;i++)await new Promise(r=>setTimeout(r,5));
  assert.equal((await ctx.app.inject('/api/state')).statusCode,401);
  for(const n of [1,2,3]){
   const payload=JSON.stringify({object:'instagram',entry:[{id:`ig${n}`,messaging:[{sender:{id:'same-customer'},recipient:{id:`ig${n}`},timestamp:Date.now(),message:{mid:'same-message',text:`incoming ${n}`}}]}]});
   const headers={'content-type':'application/json','x-hub-signature-256':'sha256='+createHmac('sha256','secret').update(payload).digest('hex')};
   for(let attempt=0;attempt<2;attempt++)assert.equal((await ctx.app.inject({method:'POST',url:'/webhooks/instagram',headers,payload})).statusCode,200);
   for(let i=0;i<100&&!ctx.store.conversations().some(c=>c.accountId===`instagram-${n}`);i++)await new Promise(r=>setTimeout(r,5));
   const c=ctx.store.conversations().find(c=>c.accountId===`instagram-${n}`)!;
   assert.equal(ctx.store.messages(c.id).length,1);assert.equal(ctx.store.messages(c.id)[0].text,`incoming ${n}`);assert.equal(c.unread,1);
  }
 }finally{await ctx.app.close();fs.rmSync(dir,{recursive:true,force:true})}
});

test('Durable webhook inbox acknowledges storage, survives restart and clears processed payload',async()=>{
 const fs=await import('node:fs');const os=await import('node:os');const path=await import('node:path');
 const {openDb}=await import('../server/db.js');const {metaWebhookInbox}=await import('../server/meta-webhook-inbox.js');
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'jorik-hook-inbox-'));const db=openDb(dir,'real');
 let received=0;const blocked=metaWebhookInbox(db,()=>{received++;return 1},()=>false);
 const app=Fastify();await registerMetaWebhook(app,{verifyToken:'verify',appSecret:'secret',receive:()=>{throw new Error('must be deferred')},enqueue:blocked.enqueue});
 const payload=JSON.stringify({object:'instagram',entry:[{id:'business'}]});
 const headers={'content-type':'application/json','x-hub-signature-256':'sha256='+createHmac('sha256','secret').update(payload).digest('hex')};
 try{
  const started=Date.now();assert.equal((await app.inject({method:'POST',url:'/webhook',headers,payload})).statusCode,200);assert.ok(Date.now()-started<1000);
  assert.equal(received,0);assert.equal(db.prepare('SELECT count(*) n FROM meta_webhook_inbox WHERE processed_at IS NULL').get().n,1);
  assert.equal((await app.inject({method:'POST',url:'/webhook',headers,payload})).statusCode,200);
  assert.equal(db.prepare('SELECT count(*) n FROM meta_webhook_inbox').get().n,1);blocked.close();
  const resumed=metaWebhookInbox(db,()=>{received++;return 1},()=>true);
  try{await new Promise<void>(r=>setImmediate(r));assert.equal(received,1);assert.equal(db.prepare('SELECT payload FROM meta_webhook_inbox').get().payload,'');}finally{resumed.close()}
 }finally{blocked.close();await app.close();db.close();fs.rmSync(dir,{recursive:true,force:true});}
});
