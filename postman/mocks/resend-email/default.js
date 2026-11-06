// Contract subset from resend-email.openapi.json. _control routes are test-only.
const http = require('node:http');
const records = new Map();
let failNext = false;
let calls = 0;
http.createServer((req, res) => {
  const path = new URL(req.url, 'http://localhost').pathname;
  const reply = (status, body) => { res.writeHead(status, {'Content-Type':'application/json'}); res.end(JSON.stringify(body)); };
  if (path === '/_control/reset' && req.method === 'POST') {
    records.clear(); calls = 0; failNext = true; return reply(200, {reset:true});
  }
  if (path === '/_control/state' && req.method === 'GET') return reply(200, {calls,accepted:records.size,keys:[...records.keys()]});
  if (path !== '/emails' || req.method !== 'POST') return reply(501, {message:'Not modeled by this contract subset'});
  calls++;
  const body = req.body;
  if (req.headers.authorization !== 'Bearer simulation-only' || !body || !body.from || !Array.isArray(body.to) || !body.subject || !body.text) {
    return reply(400, {message:'Invalid modeled send request'});
  }
  if (failNext) { failNext=false; return reply(500, {message:'Simulated provider outage'}); }
  const key=req.headers['idempotency-key'];
  if (!key) return reply(400, {message:'This retry test requires an idempotency key'});
  const prior=records.get(key);
  if (prior && prior!==JSON.stringify(body)) return reply(409, {message:'Same key with different body'});
  records.set(key,JSON.stringify(body));
  reply(200,{id:'simulated-email-id'});
}).listen(process.env.PORT || 4500);
