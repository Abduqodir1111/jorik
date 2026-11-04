import http from 'node:http';
const upstreamPort = Number(process.env.WEBHOOK_UPSTREAM_PORT ?? 3001);
http.createServer((req,res)=>{
 const url=new URL(req.url,'http://localhost');
 const allowed = ['/webhooks/instagram','/webhook'].includes(url.pathname) ? ['GET','POST'] : ['/privacy','/data-deletion'].includes(url.pathname) ? ['GET','HEAD'] : [];
 if(!allowed.includes(req.method)){res.writeHead(404);res.end();return;}
 const headers={'content-type':req.headers['content-type']??'application/json'};
 if(req.headers['x-hub-signature-256'])headers['x-hub-signature-256']=req.headers['x-hub-signature-256'];
 const upstream=http.request({host:'127.0.0.1',port:upstreamPort,path:url.pathname+url.search,method:req.method,headers,timeout:15000},r=>{res.writeHead(r.statusCode,{'content-type':r.headers['content-type']??'text/plain','cache-control':'no-store'});r.pipe(res)});
 upstream.on('error',()=>{res.writeHead(502);res.end()});upstream.on('timeout',()=>upstream.destroy());
 let size=0;req.on('data',chunk=>{size+=chunk.length;if(size>65536){upstream.destroy();req.destroy()}});req.pipe(upstream);
}).listen(3004,'127.0.0.1',()=>console.log('Webhook-only proxy listening on 127.0.0.1:3004'));
