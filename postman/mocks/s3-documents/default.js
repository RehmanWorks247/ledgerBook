// Local, unversioned general-purpose S3 subset. _control routes are test-only.
// Request signing syntax is checked; this does not verify AWS IAM or signatures.
const http = require('node:http');
const {createHash} = require('node:crypto');
const stateKey = 's3-documents.state';
const initial = (provider='s3') => ({provider,objects:{},puts:0,gets:0,deletes:0,failNextPuts:0,outage:false,failDeletes:false,corruptGets:false});
// Serialize modeled state mutations: SDK backup GETs run concurrently.
let serialized = Promise.resolve();
http.createServer((req,res) => {
  serialized = serialized.then(async () => {
  const path = new URL(req.url,'http://localhost').pathname;
  const state = await pm.state.get(stateKey) || initial();
  const save = () => pm.state.set(stateKey,state);
  const json = (code,body) => { res.writeHead(code,{'Content-Type':'application/json'}); res.end(JSON.stringify(body)); };
  const error = (status,code) => { res.writeHead(status,{'Content-Type':'application/xml'}); res.end(`<Error><Code>${code}</Code><Message>Modeled S3 response</Message></Error>`); };
  if (path === '/_control/reset' && req.method === 'POST') { await pm.state.set(stateKey,initial()); return json(200,{reset:true}); }
  if (path === '/_control/r2' && req.method === 'POST') { await pm.state.set(stateKey,initial('r2')); return json(200,{configured:true}); }
  if (path === '/_control/state' && req.method === 'GET') return json(200,{puts:state.puts,gets:state.gets,deletes:state.deletes,objects:Object.keys(state.objects).length});
  if (path === '/_control/fail-two' && req.method === 'POST') { state.failNextPuts=2; await save(); return json(200,{configured:true}); }
  if (path === '/_control/outage' && req.method === 'POST') { state.outage=true; await save(); return json(200,{configured:true}); }
  if (path === '/_control/fail-deletes' && req.method === 'POST') { state.failDeletes=true; await save(); return json(200,{configured:true}); }
  if (path === '/_control/recover' && req.method === 'POST') { state.failDeletes=false; state.outage=false; state.corruptGets=false; await save(); return json(200,{configured:true}); }
  if (path === '/_control/corrupt-gets' && req.method === 'POST') { state.corruptGets=true; await save(); return json(200,{configured:true}); }
  if (!/^\/ledgerbook-simulation\/documents\/(?:[A-Za-z0-9._-]+\/)*[A-Za-z0-9._-]+$/.test(path) || !['PUT','GET','DELETE'].includes(req.method)) return error(501,'NotImplemented');
  if (!req.headers.authorization?.startsWith('AWS4-HMAC-SHA256 ')) return error(403,'AccessDenied');
  if (req.method === 'PUT') {
    state.puts++;
    if (state.outage || state.failNextPuts > 0) { state.failNextPuts=Math.max(0,state.failNextPuts-1); await save(); return error(503,'SlowDown'); }
    // Keep checksum verification strict: CLI UTF-8 conversion must never be
    // mistaken for successful arbitrary binary transport.
    const body = Buffer.isBuffer(req.body) ? req.body : Buffer.from(req.body || '','utf8');
    if (!req.headers['content-type'] ||
      req.headers['cache-control'] !== 'private, no-store' || Number(req.headers['content-length']) !== body.length) { await save(); return error(400,'InvalidRequest'); }
    const checksum = createHash('sha256').update(body).digest('base64');
    if (state.provider === 'r2') {
      // R2 encrypts automatically; the AWS SSE request header is unsupported.
      if (req.headers['x-amz-server-side-encryption']) { await save(); return error(400,'InvalidRequest'); }
      if (req.headers['content-md5'] !== createHash('md5').update(body).digest('base64')) { await save(); return error(400,'BadDigest'); }
    } else {
      if (req.headers['x-amz-server-side-encryption'] !== 'AES256') { await save(); return error(400,'InvalidRequest'); }
      if (req.headers['x-amz-checksum-sha256'] !== checksum) { await save(); return error(400,'BadDigest'); }
    }
    if (req.headers['if-none-match']==='*' && path in state.objects) { await save(); return error(412,'PreconditionFailed'); }
    state.objects[path]={body:body.toString('base64'),type:req.headers['content-type']}; await save();
    res.writeHead(200,{'ETag':'"simulation"','x-amz-checksum-sha256':checksum}); return res.end();
  }
  if (req.method === 'GET') {
    state.gets++; await save();
    if (!(path in state.objects)) return error(404,'NoSuchKey');
    const bytes = Buffer.from(state.objects[path].body,'base64');
    if (state.corruptGets && bytes.length) bytes[0] ^= 1;
    res.writeHead(200,{'Content-Type':state.objects[path].type,'Content-Length':bytes.length}); return res.end(bytes);
  }
  state.deletes++;
  if (state.failDeletes) { await save(); return error(503,'SlowDown'); }
  delete state.objects[path]; await save(); res.writeHead(204); res.end();
  }).catch(() => {
    if (!res.headersSent) res.writeHead(500,{'Content-Type':'application/xml'});
    res.end('<Error><Code>InternalError</Code><Message>Mock handler failure</Message></Error>');
  });
}).listen(process.env.PORT || 4501);
