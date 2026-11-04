import type { FastifyInstance } from 'fastify';
import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
export async function registerMetaWebhook(app: FastifyInstance, options: {
  verifyToken: string; appSecret: string; receive: (entry: any) => number | void;
  enqueue?: (payload: unknown, digest: string) => void;
}) {
  await app.register(async scope => {
    scope.addHook('onResponse', async (request, reply) => {
      console.info('Meta webhook', request.method, reply.statusCode);
    });
    scope.removeContentTypeParser('application/json');
    scope.addContentTypeParser('application/json', {parseAs:'buffer'}, (_req, body, done) => done(null, body));
    for (const endpoint of ['/webhooks/instagram','/webhook']) {
    scope.get(endpoint, {config:{rateLimit:false}}, async (req, reply) => {
      const q = req.query as Record<string,string>;
      if (!options.verifyToken || !options.appSecret) return reply.code(503).send('Webhook is not configured');
      if(q['hub.mode'] !== 'subscribe' || q['hub.verify_token'] !== options.verifyToken || !q['hub.challenge']) return reply.code(403).send('Forbidden');
      return reply.type('text/plain').send(q['hub.challenge']);
    });
    scope.post(endpoint, {config:{rateLimit:false}}, async (req, reply) => {
      if (!options.appSecret) return reply.code(503).send('Webhook is not configured');
      const signature = req.headers['x-hub-signature-256'];
      if(typeof signature !== 'string' || !/^sha256=[a-f0-9]{64}$/.test(signature) || !Buffer.isBuffer(req.body)) return reply.code(403).send('Invalid signature');
      const expected=createHmac('sha256',options.appSecret).update(req.body).digest();
      if(!timingSafeEqual(expected,Buffer.from(signature.slice(7),'hex'))) return reply.code(403).send('Invalid signature');
      let payload;try {payload=JSON.parse(req.body.toString('utf8'));}catch{return reply.code(400).send('Invalid JSON');}
      if(payload?.object !== 'instagram' || !Array.isArray(payload.entry)) return reply.code(400).send('Invalid event');
      if (options.enqueue) {
        options.enqueue(payload,createHash('sha256').update(req.body).digest('hex'));
        return {received:true};
      }
      console.info('Meta webhook entries', payload.entry.length, 'events', payload.entry.reduce((n:number,e:any) => n + (Array.isArray(e.messaging) ? e.messaging.length : Array.isArray(e.changes) ? e.changes.length : 0),0));
      let handled = 0;
      for(const entry of payload.entry) handled += options.receive(entry) ?? 0;
      console.info('Meta webhook handled messages', handled);
      return {received:true};
    });
    }
  });
}
