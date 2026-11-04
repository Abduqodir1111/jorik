import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import bigInt from 'big-integer';
import { Api } from 'teleproto';
import { openDb } from '../server/db.js';
import { Store } from '../server/store.js';
import { InstagramIntegration } from '../server/instagram.js';
import { TelegramIntegration } from '../server/telegram.js';

async function fixture(run: (s: Store, ig: InstagramIntegration, t: number) => Promise<void>) {
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'jorik-read-sync-'));
  const db=openDb(dir,'real'); const store=new Store(db);
  const ig=new InstagramIntegration(store,{token:'test',receiveMode:'webhook',fetcher:(async()=>Response.json({id:'page',instagram_business_account:{id:'shop',username:'shop'}})) as typeof fetch});
  try{await ig.sync(); await run(store,ig,Date.now()-20_000);}
  finally{await ig.close();db.close();fs.rmSync(dir,{recursive:true,force:true});}
}
function msg(ig: InstagramIntegration,t:number,id:string,out=false,echo=out){
 return ig.receiveWebhook({id:'shop',messaging:[{sender:{id:out?'shop':'customer'},recipient:{id:out?'customer':'shop'},timestamp:t,message:{mid:id,text:id,is_echo:echo}}]});
}
function read(ig: InstagramIntegration,t:number,inbox:boolean,mid?:string){
 return ig.receiveWebhook({id:'shop',changes:[{field:'messaging_seen',value:{sender:{id:inbox?'shop':'customer'},recipient:{id:inbox?'customer':'shop'},timestamp:Date.now(),read:mid?{mid}:{watermark:t}}}]});
}
test('Instagram native reply handles older messages, preserves newer arrivals and persists its read boundary',async()=>fixture(async(s,ig,t)=>{
 let updates=0;s.changed=()=>updates++;
 msg(ig,t,'in-1');msg(ig,t+2000,'newer');
 const c=s.conversations()[0];assert.equal(c.unread,2);assert.equal(c.needsReply,true);
 msg(ig,t+1000,'phone-reply',true);
 assert.equal(s.conversation(c.id).unread,1);
 msg(ig,t+1000,'phone-reply',true);
 assert.equal(s.messages(c.id).length,3);
 assert.equal(s.conversation(c.id).unread,1);
 msg(ig,t+3000,'phone-reply-2',true);
 assert.equal(s.conversation(c.id).unread,0);assert.equal(s.conversation(c.id).needsReply,false);
 msg(ig,t+500,'late-in');assert.equal(s.conversation(c.id).unread,0);
 msg(ig,t+4000,'fresh');assert.equal(s.conversation(c.id).unread,1);
 read(ig,t+1000,true);assert.equal(s.conversation(c.id).unread,1);
 assert.ok(updates>=7);
 // Stored read boundary is durable, unlike an in-memory flag.
 assert.ok(s.db.prepare('SELECT read_through FROM instagram_inbox_reads WHERE conversation_id=?').get(c.id));
}));
test('Instagram read directions are isolated: customer seen changes sent receipts only',async()=>fixture(async(s,ig,t)=>{
 msg(ig,t,'out-1',true);msg(ig,t+2000,'out-2',true);msg(ig,t+3000,'in-1');
 const c=s.conversations()[0];read(ig,t,false,'out-1');
 assert.equal(s.conversation(c.id).unread,1);assert.equal(s.conversation(c.id).needsReply,true);
 assert.ok(s.messages(c.id).find(m=>m.externalId==='out-1')!.readAt);
 assert.equal(s.messages(c.id).find(m=>m.externalId==='out-2')!.readAt,null);
 read(ig,t+3000,true,'in-1');assert.equal(s.conversation(c.id).unread,0);
 msg(ig,t+4000,'fresh');read(ig,t+3000,true,'unknown');
 assert.equal(s.conversation(c.id).unread,1);
 // Spoofed echo flag from a customer and mismatched shop cannot clear anything.
 assert.equal(msg(ig,t+5000,'bad-echo',false,true),0);
 ig.receiveWebhook({id:'other-shop',messaging:[{sender:{id:'shop'},recipient:{id:'customer'},read:{watermark:t+5000}}]});
 assert.equal(s.conversation(c.id).unread,1);
}));
test('Instagram fallback requires explicit provider unread zero and bounds it to the snapshot',async()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'jorik-read-fallback-'));const db=openDb(dir,'real'),s=new Store(db);const t=Date.now()-20_000;
 let zero:number|undefined=undefined;
 const ig=new InstagramIntegration(s,{token:'test',receiveMode:'webhook',fetcher:(async(url:string)=>new URL(url).pathname.endsWith('/me')?Response.json({id:'page',instagram_business_account:{id:'shop',username:'shop'}}):Response.json({data:[{id:'thread',unread_count:zero,updated_time:new Date(t).toISOString(),participants:{data:[{id:'shop'},{id:'customer'}]},messages:{data:[]}}]})) as typeof fetch});
 try{await ig.sync();msg(ig,t,'first');msg(ig,t+1000,'newer');const c=s.conversations()[0];await ig.history(c.id);assert.equal(s.conversation(c.id).unread,2);
 // Canonical thread fetch returns a bare object instead of a listing.
 (ig as any).opts.fetcher=(async()=>Response.json({id:'thread',unread_count:zero,updated_time:new Date(t).toISOString(),participants:{data:[{id:'shop'},{id:'customer'}]},messages:{data:[]}})) as typeof fetch;
 zero=0;await ig.history(c.id);assert.equal(s.conversation(c.id).unread,1);
 msg(ig,t-1000,'late');assert.equal(s.conversation(c.id).unread,1);
 }finally{await ig.close();db.close();fs.rmSync(dir,{recursive:true,force:true});}
});
test('Telegram phone reads and outgoing replies use IDs, survive history replay, and isolate accounts',async()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'jorik-tg-read-'));const db=openDb(dir,'real'),s=new Store(db);
 const tg=new TelegramIntegration(s,{apiId:123,apiHash:'a'.repeat(32),encryptionKey:'b'.repeat(64)});
 db.prepare('INSERT INTO telegram_peers VALUES(?,?,?,?,?)').run('telegram-1','42','123','Client','client');
 const incoming=async(id:number,out=false)=> (tg as any).importMessage(new Api.Message({id,peerId:new Api.PeerUser({userId:bigInt(42)}),date:1700000000,message:String(id),out}),true);
 try{
 await incoming(10);await incoming(12);const c=s.conversations()[0];assert.equal(c.unread,2);
 await incoming(11,true);assert.equal(s.conversation(c.id).unread,1);
 (tg as any).markInboxRead('42',12);assert.equal(s.conversation(c.id).unread,0);assert.equal(s.conversation(c.id).needsReply,false);
 await incoming(9);await incoming(13);assert.equal(s.conversation(c.id).unread,1);
 (tg as any).markInboxRead('42',10);assert.equal(s.conversation(c.id).unread,1);
 await incoming(14,true);assert.equal(s.conversation(c.id).unread,0);
 await incoming(15);assert.equal(s.conversation(c.id).unread,1);
 assert.equal(s.messages(c.id).length,7);
 }finally{await tg.close();db.close();fs.rmSync(dir,{recursive:true,force:true});}
});

test('Read migration reconciles old confirmed replies without clearing newer incoming messages',()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'jorik-read-migrate-'));
 let db=openDb(dir,'real');
 try{
  db.prepare("INSERT INTO conversations(id,account_id,external_id,name,username,updated_at,unread) VALUES('ig','instagram-1','thread','C','',?,3)").run('2026-01-01T00:00:03.000Z');
  const insert=db.prepare("INSERT INTO messages(id,conversation_id,external_id,direction,text,status,created_at) VALUES(?,'ig',?,?,'text',?,?)");
  insert.run('old','old','in','sent','2026-01-01T00:00:00.000Z');
  insert.run('reply','reply','out','sent','2026-01-01T00:00:01.000Z');
  insert.run('new','new','in','sent','2026-01-01T00:00:02.000Z');
  insert.run('failed',null,'out','error','2026-01-01T00:00:03.000Z');
  db.exec('DROP TABLE instagram_inbox_reads');db.prepare("DELETE FROM migrations WHERE name='014_instagram_inbox_read.sql'").run();
  db.close();db=openDb(dir,'real');
  const s=new Store(db);assert.equal(s.conversation('ig').unread,1);assert.equal(s.conversation('ig').needsReply,true);
  assert.equal(s.messages('ig').length,4);
 }finally{db.close();fs.rmSync(dir,{recursive:true,force:true});}
});
