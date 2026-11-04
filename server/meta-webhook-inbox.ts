import type { DB } from "./db.js";

// Acknowledge only after durable storage; provider calls never run in the POST handler.
export function metaWebhookInbox(db: DB, receive: (entry: any) => number, ready: () => boolean) {
  let closed = false, scheduled = false;
  const drain = () => {
    scheduled = false;
    if (closed || !ready()) return;
    const row = db.prepare("SELECT digest,payload,attempts FROM meta_webhook_inbox WHERE processed_at IS NULL AND available_at<=? ORDER BY received_at LIMIT 1").get(Date.now()) as {digest:string;payload:string;attempts:number}|undefined;
    if (!row) return;
    try {
      let handled = 0;
      db.transaction(() => {
        for (const entry of JSON.parse(row.payload).entry) handled += receive(entry);
        db.prepare("UPDATE meta_webhook_inbox SET processed_at=?,payload='',error=NULL WHERE digest=?").run(Date.now(),row.digest);
      })();
      console.info("Meta webhook processed messages", handled);
    } catch {
      db.prepare("UPDATE meta_webhook_inbox SET attempts=attempts+1,available_at=?,error=? WHERE digest=?").run(Date.now()+Math.min(60000,1000*2**Math.min(row.attempts,6)),"Не удалось обработать событие Meta",row.digest);
    }
    kick();
  };
  const kick = () => {
    if (!closed && !scheduled) { scheduled = true; setImmediate(drain); }
  };
  const timer = setInterval(kick,1000);
  timer.unref();
  kick();
  return {
    enqueue(payload: unknown,digest:string) {
      db.prepare("INSERT OR IGNORE INTO meta_webhook_inbox(digest,payload,received_at) VALUES(?,?,?)").run(digest,JSON.stringify(payload),Date.now());
      kick();
    },
    close() { closed = true; clearInterval(timer); },
  };
}
