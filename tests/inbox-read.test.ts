import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Api } from 'teleproto';
import bigInt from 'big-integer';
import { openDb } from '../server/db.js';
import { Store } from '../server/store.js';
import { TelegramIntegration } from '../server/telegram.js';

test('Telegram remote read: account isolation, partial reads, replay and restart', async () => {
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'jorik-read-'));
  const db=openDb(dir,'real');
  let sounds = 0;
  const store=new Store(db, () => {}, () => { sounds++; });
  const opts={apiId:123,apiHash:'a'.repeat(32),encryptionKey:'b'.repeat(64)};
  const tg=new TelegramIntegration(store,opts);
  const internal=tg as unknown as {markRead(peer:string,max:number):void;markInboxRead(peer:string,max:number):void;importMessage(m:Api.Message,unread:boolean):Promise<void>};
  try {
    for(const account of ['telegram-1','telegram-2']) {
      db.prepare('INSERT INTO telegram_peers VALUES(?,?,?,?,?)').run(account,'123','456','Test','test');
      db.prepare('INSERT INTO conversations(id,account_id,external_id,name,updated_at,unread) VALUES(?,?,?,?,?,?)').run(account,account,'123','Test',new Date().toISOString(),3);
      for(const id of [10,20,30]) db.prepare("INSERT INTO messages(id,conversation_id,external_id,direction,text,status,created_at) VALUES(?,?,?,'in','test','sent',?)").run(account+id,account,String(id),new Date().toISOString());
    }
    const unread=(id='telegram-1')=>(db.prepare('SELECT unread FROM conversations WHERE id=?').get(id) as {unread:number}).unread;
    internal.markRead('123',20);
    internal.markInboxRead('123',20);
    assert.equal(unread(),1);
    assert.equal(unread('telegram-2'),3);
    internal.markInboxRead('123',10); // old event cannot undo newer state
    assert.equal(unread(),1);
    const msg=(id:number)=>new Api.Message({id,peerId:new Api.PeerUser({userId:bigInt(123)}),date:1,message:'test'});
    await internal.importMessage(msg(15),true); // delayed historical arrival
    assert.equal(unread(),1);
    await internal.importMessage(msg(40),true); // arrives after read snapshot
    internal.markInboxRead('123',30);
    assert.equal(unread(),1); // preserve newer incoming message
    internal.markInboxRead('123',40);
    assert.equal(unread(),0);
    const restarted=new TelegramIntegration(store,opts) as unknown as typeof internal;
    await restarted.importMessage(msg(35),true);
    assert.equal(unread(),0);
    await restarted.importMessage(msg(50),true);
    assert.equal(unread(),1);
    db.prepare('UPDATE conversations SET unread=0 WHERE id=?').run('telegram-1');
    restarted.markInboxRead('123',45);
    assert.equal(unread(),0); // do not undo local read
    assert.equal(sounds,0); // imported old history is silent
    const fresh=msg(60); fresh.date=Math.floor(Date.now()/1000);
    await restarted.importMessage(fresh,true);
    await restarted.importMessage(fresh,true);
    assert.equal(sounds,1); // duplicate delivery is silent
    const history=msg(61); history.date=fresh.date;
    await restarted.importMessage(history,false);
    const outgoing=msg(62); outgoing.date=fresh.date; outgoing.out=true;
    await restarted.importMessage(outgoing,true);
    assert.equal(sounds,1); // history fetch and our replies are silent
  } finally {db.close(); fs.rmSync(dir,{recursive:true,force:true});}
});
