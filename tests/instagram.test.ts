import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { openDb } from "../server/db.js";
import { Store } from "../server/store.js";
import { InstagramIntegration } from "../server/instagram.js";

test("Explicit archive import loads 50 chats in webhook mode, deduplicates, and preserves unread", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "jorik-ig-recent-"));
  const db = openDb(dir, "real"), store = new Store(db);
  let detailCalls = 0;
  const integration = new InstagramIntegration(store, { token: "test", accountId: "instagram-2", receiveMode: "webhook", fetcher: (async (url: string) => {
    const u = new URL(url);
    if (u.pathname.endsWith("/me")) return Response.json({ id: "page", instagram_business_account: { id: "shop", username: "shop" } });
    if (u.pathname.endsWith("/conversations")) {
      assert.equal(u.searchParams.get("fields"), "id,updated_time");
      const offset = Number(u.searchParams.get("after") || 0);
      return Response.json({ data: Array.from({ length: 10 }, (_, i) => ({ id: `thread-${offset + i}` })), paging: { next: "more", cursors: { after: String(offset + 10) } } });
    }
    detailCalls++;
    const id = u.pathname.split("/").pop()!;
    const timestamp = new Date().toISOString();
    return Response.json({ id, updated_time: timestamp, participants: { data: [{ id: "shop" }, { id: `peer-${id}`, username: id }] }, messages: { data: [{ id: `message-${id}`, created_time: timestamp, from: { id: `peer-${id}` }, message: "saved archive" }] } });
  }) as typeof fetch });
  try {
    await integration.sync();
    assert.equal(detailCalls, 0);
    assert.deepEqual(await integration.importRecent(), { imported: 50 });
    assert.equal(detailCalls, 50);
    assert.equal(store.conversations().length, 50);
    assert.ok(store.conversations().every((c) => c.accountId === "instagram-2" && c.unread === 0));
    db.prepare("UPDATE conversations SET unread=3").run();
    await integration.importRecent();
    assert.equal(db.prepare("SELECT count(*) n FROM messages").get()!.n, 50);
    assert.ok(store.conversations().every((c) => c.unread === 3));
    await integration.sync();
    assert.equal(detailCalls, 100); // Normal refresh remains webhook-only.
  } finally { await integration.close(); db.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test("Instagram: sync, deduplication, account routing, 24h and ambiguous send", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "jorik-ig-"));
  const db = openDb(dir, "real"),
    store = new Store(db);
  let seen = 0;
  let sends = 0,
    fail = false,
    mismatch = false;
  const fetcher = (async (url: string, options: RequestInit) => {
    const u = new URL(url);
    assert.equal(u.origin, "https://graph.facebook.com");
    if (options.method === "POST" && JSON.parse(String(options.body)).sender_action === "mark_seen") {
      seen++;
      assert.equal(u.pathname, "/v25.0/page/messages");
      assert.equal((options.headers as Record<string, string>).Authorization, "Bearer private");
      assert.deepEqual(JSON.parse(String(options.body)), {
        recipient: { id: "customer" }, sender_action: "mark_seen",
      });
      return Response.json({ success: true });
    }
    if (options.method === "POST") {
      sends++;
      assert.equal(u.pathname, "/v25.0/page/messages");
      assert.deepEqual(JSON.parse(String(options.body)), {
        recipient: { id: "customer" },
        messaging_type: "RESPONSE",
        message: { text: "Ответ" },
      });
      if (fail) throw new Error("do not disclose secret");
      return Response.json({ message_id: "out-1" });
    }
    if (u.pathname === "/v25.0/me")
      return Response.json({
        id: "page",
        instagram_business_account: {
          id: mismatch ? "other" : "business",
          username: "storebooks",
        },
      });
    return Response.json({
      data: [
        {
          id: "thread",
          updated_time: new Date().toISOString(),
          participants: {
            data: [{ id: "business" }, { id: "customer", username: "client" }],
          },
          messages: {
            data: [
              {
                id: "in-1",
                created_time: new Date().toISOString(),
                from: { id: "customer" },
                message: "Вопрос",
              },
            ],
          },
        },
      ],
    });
  }) as typeof fetch;
  let integration = new InstagramIntegration(store, {
    token: "private",
    fetcher,
  });
  try {
    await integration.sync();
    await integration.sync();
    const c = store.conversations()[0];
    assert.equal(c.accountId, "instagram-1");
    assert.equal(store.messages(c.id).length, 1);
    assert.equal(c.unread, 0);
    assert.equal(seen, 0, "sync must never mark Instagram messages seen");
    await Promise.all([integration.markSeen(c.id), integration.markSeen(c.id)]);
    assert.equal(seen, 1, "overlapping reads share one Meta request");
    const other = new InstagramIntegration(store, { accountId: "instagram-2", token: "other", fetcher });
    await assert.rejects(other.markSeen(c.id), /Неверный аккаунт/);
    await other.close();
    assert.equal(seen, 1);
    assert.equal(store.account("telegram-1").state, "unconfigured");
    store.enqueue(c.id, "Ответ", randomUUID());
    await store.tick();
    assert.equal(sends, 1);
    assert.equal(store.messages(c.id).at(-1)?.status, "sent");
    fail = true;
    store.enqueue(c.id, "Ответ", randomUUID());
    await store.tick();
    await store.tick();
    assert.equal(sends, 2);
    assert.equal(store.messages(c.id).at(-1)?.status, "unknown");
    db.prepare("UPDATE messages SET created_at=? WHERE direction='in'").run(
      new Date(Date.now() - 25 * 3600000).toISOString(),
    );
    store.enqueue(c.id, "Ответ", randomUUID());
    await store.tick();
    assert.equal(sends, 2);
    assert.equal(store.messages(c.id).at(-1)?.status, "error");
    const message = store.messages(c.id)[0];
    assert.throws(() =>
      integration.adapter.validateReply(store.account("telegram-1"), message),
    );
    await integration.close();
    mismatch = true;
    integration = new InstagramIntegration(store, {
      token: "private",
      fetcher,
    });
    await assert.rejects(integration.sync(), /другому аккаунту/);
    assert.equal(store.messages(c.id).length, 4);
  } finally {
    await integration.close();
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("Instagram fast polling skips unchanged history and imports a new burst", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "jorik-ig-fast-"));
  const db = openDb(dir, "real"),
    store = new Store(db);
  let changed = false,
    details = 0;
  const oldDate = new Date(Date.now() - 60000).toISOString();
  const thread = () => ({
    id: "thread",
    updated_time: changed ? new Date().toISOString() : oldDate,
    participants: {
      data: [{ id: "business" }, { id: "customer", username: "client" }],
    },
    messages: {
      data: (changed ? ["new-2", "new-1", "old"] : ["old"]).map((id) => ({
        id,
        created_time: id === "old" ? oldDate : new Date().toISOString(),
        from: { id: "customer" },
        message: id,
      })),
    },
  });
  const fetcher = (async (url: string) => {
    const u = new URL(url);
    if (u.pathname.endsWith("/me"))
      return Response.json({
        id: "page",
        instagram_business_account: { id: "business", username: "shop" },
      });
    if (u.pathname.endsWith("/thread")) {
      details++;
      return Response.json(thread());
    }
    const full = u.searchParams.get("fields")?.includes("messages");
    return Response.json({
      data: [
        full ? thread() : { id: "thread", updated_time: thread().updated_time },
      ],
    });
  }) as typeof fetch;
  const integration = new InstagramIntegration(store, {
    token: "test",
    fetcher,
  });
  try {
    await integration.sync();
    await integration.sync();
    assert.equal(details, 0);
    changed = true;
    await integration.sync();
    assert.equal(details, 1);
    const c = store.conversations()[0];
    assert.equal(store.messages(c.id).length, 3);
    assert.equal(c.unread, 2);
    await integration.sync();
    assert.equal(store.messages(c.id).length, 3);
    assert.equal(store.conversation(c.id).unread, 2);
  } finally {
    await integration.close();
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('Three Instagram accounts isolate identical thread IDs, history and send tokens', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jorik-two-ig-'));
  const db = openDb(dir, 'real'), store = new Store(db);
  const calls: string[] = [];
  const integrations = [1,2,3].map(n => {
    const thread = {id:'same-thread',updated_time:new Date().toISOString(),participants:{data:[{id:`ig-${n}`},{id:'customer',username:'client'}]},messages:{data:[{id:'same-message',created_time:new Date().toISOString(),from:{id:'customer'},message:`Inbox ${n}`}]}};
    const fetcher = (async (url: string, options: RequestInit) => {
      assert.equal((options.headers as Record<string,string>).Authorization, `Bearer token-${n}`);
      const u = new URL(url);
      if (options.method === 'POST') {
        assert.equal(u.pathname, `/v25.0/page-${n}/messages`);
        calls.push(String(n));
        return Response.json({message_id:`sent-${n}`});
      }
      if (u.pathname.endsWith('/me')) return Response.json({id:`page-${n}`,instagram_business_account:{id:`ig-${n}`,username:`shop${n}`}});
      if (u.pathname.endsWith('/same-thread')) return Response.json(thread);
      return Response.json({data:[thread]});
    }) as typeof fetch;
    return new InstagramIntegration(store,{accountId:`instagram-${n}` as 'instagram-1'|'instagram-2'|'instagram-3',token:`token-${n}`,fetcher});
  });
  try {
    await Promise.all(integrations.map(i=>i.sync()));
    const convs = store.conversations();
    assert.equal(convs.length,3);
    for (let n=1;n<=3;n++) {
      const c=convs.find(c=>c.accountId===`instagram-${n}`)!;
      assert.equal(store.messages(c.id)[0].text,`Inbox ${n}`);
      await integrations[n-1].history(c.id);
      await assert.rejects(integrations[n % 3].history(c.id));
      const a=store.account(c.accountId);
      const message={id:randomUUID(),conversationId:c.id,text:'Test',direction:'out',status:'queued',createdAt:new Date().toISOString(),attachments:[]} as const;
      await store.resolveAdapter(a).send(a,{...message,attachments:[]},randomUUID());
    }
    assert.deepEqual(calls,['1','2','3']);
  } finally {await Promise.all(integrations.map(i=>i.close()));db.close();fs.rmSync(dir,{recursive:true,force:true});}
});

test('Instagram retries oversized listings one thread at a time and follows cursors', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jorik-ig-compact-'));
  const db = openDb(dir, 'real'), store = new Store(db);
  let rejected = 0, failOlderPage = false;
  const fetcher = (async (url: string) => {
    const u = new URL(url);
    if (u.pathname.endsWith('/me')) return Response.json({id:'page', instagram_business_account:{id:'business',username:'shop'}});
    if (u.pathname.endsWith('/conversations')) {
      if (u.searchParams.get('limit') !== '1') {
        rejected++;
        return Response.json({error:{code:1}}, {status:500});
      }
      assert.equal(u.searchParams.get('fields'), 'id,updated_time');
      const second = u.searchParams.get('after') === 'next';
      if (second && failOlderPage) return Response.json({error:{code:-2}}, {status:500});
      return Response.json({data:[{id:second?'two':'one',updated_time:new Date().toISOString()}], ...(!second?{paging:{next:'unused',cursors:{after:'next'}}}:{})});
    }
    const id = u.pathname.split('/').at(-1);
    return Response.json({id,updated_time:new Date().toISOString(),participants:{data:[{id:'business'},{id:'customer-'+id}]},messages:{data:[{id:'message-'+id,created_time:new Date().toISOString(),from:{id:'customer-'+id},message:'Test'}]}});
  }) as typeof fetch;
  const integration = new InstagramIntegration(store, {token:'test',fetcher});
  try {
    await integration.sync();
    assert.equal(store.conversations().length, 2);
    assert.equal(store.account('instagram-1').state, 'connected');
    await integration.sync();
    assert.equal(rejected, 1);
    assert.equal(store.conversations().length, 2);
    db.prepare("UPDATE accounts SET last_sync=NULL WHERE id='instagram-1'").run();
    failOlderPage = true;
    await assert.rejects(integration.sync());
    assert.equal(store.account('instagram-1').state, 'connected');
    assert.match(store.account('instagram-1').error ?? '', /часть истории/);
    assert.equal(store.account('instagram-1').lastSync, null);
    assert.equal(store.conversations().length, 2);
  } finally {
    await integration.close(); db.close(); fs.rmSync(dir,{recursive:true,force:true});
  }
});

test('Instagram reports Meta response-window rejection separately from permissions', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jorik-ig-window-'));
  const db = openDb(dir, 'real');
  const integration = new InstagramIntegration(new Store(db), {
    token:'test',
    fetcher:(async () => Response.json({error:{code:10,error_subcode:2534022}}, {status:400})) as typeof fetch,
  });
  try {
    await assert.rejects(integration.sync(), /не открыла окно ответа.*2534022/);
  } finally { await integration.close(); db.close(); fs.rmSync(dir,{recursive:true,force:true}); }
});

 test('Instagram explains conversation access limit instead of generic timeout', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jorik-ig-access-'));
  const db = openDb(dir, 'real');
  const integration = new InstagramIntegration(new Store(db), {token:'test',fetcher:(async () => Response.json({error:{code:-2,error_subcode:2534084}}, {status:400})) as typeof fetch});
  try { await assert.rejects(integration.sync(), /расширенный доступ instagram_manage_messages/); }
  finally { await integration.close(); db.close(); fs.rmSync(dir,{recursive:true,force:true}); }
});

test('Instagram webhook imports both accounts, deduplicates deliveries and merges later history',async()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'jorik-hook-'));const db=openDb(dir,'real'),store=new Store(db);
 const integrations=[1,2].map(n=>new InstagramIntegration(store,{accountId:`instagram-${n}` as 'instagram-1'|'instagram-2',token:'test',fetcher:(async()=>Response.json({id:`page${n}`,instagram_business_account:{id:`ig${n}`,username:`shop${n}`},data:[]})) as typeof fetch}));
 try{
  await Promise.all(integrations.map(i=>i.sync()));
  let updates=0;store.changed=()=>{updates++};
  const entry={id:'ig1',messaging:[{sender:{id:'customer'},recipient:{id:'ig1'},timestamp:Date.now(),message:{mid:'shared',text:'hello'}}]};
  integrations[1].receiveWebhook(entry);assert.equal(updates,0);
  integrations.forEach(i=>i.receiveWebhook(entry));integrations[0].receiveWebhook(entry);
  assert.equal(updates,2);
  assert.equal(store.conversations().length,1);assert.equal(store.conversations()[0].unread,1);
  integrations[1].receiveWebhook({...entry,id:'ig2',messaging:[{...entry.messaging[0],recipient:{id:'ig2'}}]});
  assert.equal(store.conversations().length,2);
  const changedEvent={...entry.messaging[0],message:{mid:'changes-message',text:'new format'},timestamp:Math.floor(Date.now()/1000)};
  integrations[0].receiveWebhook({id:'page1',changes:[{field:'messages',value:changedEvent}]});
  integrations[0].receiveWebhook({id:'page1',changes:[{field:'messages',value:changedEvent}]});
  const first=store.conversations().find(c=>c.accountId==='instagram-1')!;
  assert.equal(store.messages(first.id).length,2);
  assert.equal(first.unread,2);
  const changed=store.messages(first.id).find(m=>m.text==='new format')!;
  assert.ok(Math.abs(Date.parse(changed.createdAt)-Date.now())<5000);
  assert.equal(store.messages(store.conversations().find(c=>c.accountId==='instagram-2')!.id).length,1);
 }finally{await Promise.all(integrations.map(i=>i.close()));db.close();fs.rmSync(dir,{recursive:true,force:true})}
});

test('Webhook mode never lists the archive at startup or refresh and loads only the selected peer', async()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'jorik-ig-webhook-mode-'));
 const db=openDb(dir,'real'),store=new Store(db);const routes:string[]=[];
 const encode=(prefix:string)=>Buffer.from(`${prefix}:1:IGMessageID:123:456:789`).toString('base64').replace(/[Z+/=]/g,c=>({Z:'ZA','+':'ZB','/':'ZC','=':'ZD'})[c]!);
 const now=new Date().toISOString();
 const integration=new InstagramIntegration(store,{token:'test',receiveMode:'webhook',fetcher:(async(url:string)=>{
  const u=new URL(url);routes.push(u.pathname+u.search);
  if(u.pathname.endsWith('/me'))return Response.json({id:'page',instagram_business_account:{id:'business',username:'shop'}});
  assert.equal(u.searchParams.get('user_id'),'customer');assert.equal(u.searchParams.get('limit'),'1');
  assert.match(u.searchParams.get('fields')??'',/messages.limit\(10\)/);assert.equal(u.searchParams.has('after'),false);
  return Response.json({data:[{id:'real-thread',updated_time:now,participants:{data:[{id:'business'},{id:'customer',username:'client'}]},messages:{data:[{id:encode('ig_dm_item'),created_time:now,from:{id:'customer'},message:'hello'}]}}],paging:{next:'must-not-follow',cursors:{after:'older'}}});
 }) as typeof fetch});
 try {
  integration.start();await integration.sync();await integration.sync();
  assert.ok(routes.length>0);assert.ok(routes.every(r=>r.startsWith('/v25.0/me?')));
  const before=routes.length;
  integration.receiveWebhook({id:'business',messaging:[{sender:{id:'customer'},recipient:{id:'business'},timestamp:Date.now(),message:{mid:encode('new_ig_dm_item'),text:'hello'}}]});
  assert.equal(routes.length,before);
  const c=store.conversations()[0];await integration.history(c.id);
  assert.equal(routes.length,before+1);assert.equal(store.conversation(c.id).externalId,'real-thread');
  assert.equal(store.messages(c.id).length,1);assert.equal(store.conversation(c.id).unread,1);
 } finally {await integration.close();db.close();fs.rmSync(dir,{recursive:true,force:true});}
});

test('Instagram standby messages are visible and deduplicated but cannot be answered without control',async()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'jorik-ig-standby-'));const db=openDb(dir,'real'),store=new Store(db);
 const integration=new InstagramIntegration(store,{token:'test',receiveMode:'webhook',fetcher:(async()=>Response.json({id:'page',instagram_business_account:{id:'business',username:'shop'}})) as typeof fetch});
 try {
  await integration.sync();const timestamp=Date.now();
  const event={sender:{id:'customer'},recipient:{id:'business'},timestamp,message:{mid:'standby-message',text:'Visible standby'}};
  integration.receiveWebhook({id:'business',standby:[event]});integration.receiveWebhook({id:'business',standby:[event]});
  const c=store.conversations()[0];assert.equal(store.messages(c.id).length,1);assert.equal(c.unread,1);
  const reply={id:randomUUID(),conversationId:c.id,text:'reply',direction:'out',status:'queued',createdAt:new Date().toISOString(),attachments:[]} as const;
  assert.throws(()=>integration.adapter.validateReply(store.account('instagram-1'),{...reply,attachments:[]}),/управляет другое приложение/);
  integration.receiveWebhook({id:'business',messaging:[{...event,timestamp:timestamp+1000,message:{mid:'normal-message',text:'Normal channel'}}]});
  integration.receiveWebhook({id:'business',standby:[event]}); // Out-of-order delivery cannot revoke newer control.
  assert.doesNotThrow(()=>integration.adapter.validateReply(store.account('instagram-1'),{...reply,attachments:[]}));
 }finally{await integration.close();db.close();fs.rmSync(dir,{recursive:true,force:true});}
});
