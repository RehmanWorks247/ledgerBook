import assert from 'node:assert/strict';
import { generateKeyPairSync, sign } from 'node:crypto';
import { it } from 'node:test';
import { ClerkService } from '../apps/api/src/auth/clerk.service';
import { config } from '../apps/api/src/config';

it('requests real invitation delivery with the configured localhost port and encoded invitation token', async (test) => {
  const previousKey = config.clerkSecretKey;
  const previousUrl = config.appUrl;
  config.clerkSecretKey = 'sk_test_unit-test-placeholder';
  const token = 'local+invitation/token=with&symbols';
  const bodies: Record<string, unknown>[] = [];
  const fetchMock = test.mock.method(globalThis, 'fetch', async (input: string | URL | Request, init?: RequestInit) => {
    const request = new Request(input, init);
    assert.equal(request.method, 'POST');
    assert.equal(new URL(request.url).pathname, '/v1/invitations');
    bodies.push(await request.json() as Record<string, unknown>);
    return Response.json({object:'invitation', id:'inv_localhost', email_address:'person@example.test', status:'pending', public_metadata:{}});
  });
  try {
    const gateway = new ClerkService();
    for (const origin of ['http://localhost:3001', 'http://localhost:5173']) {
      config.appUrl = origin;
      const invitation = await gateway.invite({email:'person@example.test', name:'Local Test', organizationName:'Local Workspace', invitationId:'inv_app_local', token});
      assert.equal(invitation.id, 'inv_localhost');
      const body = bodies.at(-1)!;
      const redirect = new URL(String(body.redirect_url));
      assert.equal(redirect.origin, origin);
      assert.equal(redirect.pathname, '/invite');
      assert.equal(redirect.searchParams.get('token'), token);
      assert.equal([...redirect.searchParams].length, 1);
      assert.equal(body.email_address, 'person@example.test');
      assert.equal(body.notify, true);
      assert.deepEqual(body.public_metadata, {invitationId:'inv_app_local', name:'Local Test', organizationName:'Local Workspace'});
    }
    assert.equal(bodies.length, 2);
  } finally {
    fetchMock.mock.restore(); config.clerkSecretKey = previousKey; config.appUrl = previousUrl;
  }
});

it('verifies signed Clerk sessions, origin, live revocation and verified primary email without trusting browser claims', async (test) => {
  const previousKey = config.clerkSecretKey;
  const previousPublishableKey = config.clerkPublishableKey;
  config.clerkSecretKey = 'sk_test_unit-test-placeholder';
  config.clerkPublishableKey = `pk_test_${Buffer.from('test-gateway.clerk.accounts.dev$').toString('base64')}`;
  const { privateKey,publicKey } = generateKeyPairSync('rsa',{modulusLength:2048});
  const jwk = {...publicKey.export({format:'jwk'}),kid:'ledger-gateway-test',alg:'RS256',use:'sig'};
  let sessionStatus = 'active';
  let userBanned = false;
  let verificationStatus = 'verified';
  let sessionUserId = 'user_gateway';
  let providerUnavailable = false;
  let liveRequests=0;
  const fetchMock = test.mock.method(globalThis,'fetch',async (input: string | URL | Request) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (url.endsWith('/jwks')) return Response.json({keys:[jwk]});
    liveRequests++;
    await new Promise(resolve=>setTimeout(resolve,5));
    if (providerUnavailable) throw new Error('Provider unavailable');
    if (url.endsWith('/sessions/sess_gateway')) return Response.json({object:'session',id:'sess_gateway',user_id:sessionUserId,status:sessionStatus,client_id:'client_gateway'});
    if (url.endsWith('/users/user_gateway')) return Response.json({
      object:'user',id:'user_gateway',banned:userBanned,locked:false,first_name:'Gateway',last_name:'Test',primary_email_address_id:'email_primary',
      email_addresses:[{object:'email_address',id:'email_primary',email_address:'person@example.test',linked_to:[],verification:{status:verificationStatus,strategy:'email_code'}}],
    });
    throw new Error(`Unexpected test request ${new URL(url).pathname}`);
  });
  const signed = (override: Record<string,unknown> = {}) => {
    const now = Math.floor(Date.now()/1000);
    const header = Buffer.from(JSON.stringify({alg:'RS256',typ:'JWT',kid:jwk.kid})).toString('base64url');
    const payload = Buffer.from(JSON.stringify({sub:'user_gateway',sid:'sess_gateway',iss:'https://test-gateway.clerk.accounts.dev',azp:config.appUrl,iat:now,nbf:now-5,exp:now+60,...override})).toString('base64url');
    return `${header}.${payload}.${sign('RSA-SHA256',Buffer.from(`${header}.${payload}`),privateKey).toString('base64url')}`;
  };
  try {
    const gateway = new ClerkService();
    const token = signed();
    assert.deepEqual(await gateway.verify(token),{id:'user_gateway',email:'person@example.test',name:'Gateway Test'});
    liveRequests=0;
    const parallel=await Promise.all(Array.from({length:10},()=>gateway.verify(token)));
    assert.equal(liveRequests,2,'one session and one user check for a simultaneous burst');
    assert.ok(parallel.every(identity=>identity?.id==='user_gateway'));
    parallel[0]!.name='Changed locally';assert.equal(parallel[1]!.name,'Gateway Test');
    assert.equal(await gateway.verify(`${token.slice(0,-10)}forged`),null);
    assert.equal(await gateway.verify(signed({azp:'https://attacker.example'})),null);
    assert.equal(await gateway.verify(signed({exp:1})),null);
    assert.equal(await gateway.verify(signed({sts:'pending'})),null);
    liveRequests=0;
    sessionStatus = 'revoked'; assert.equal(await gateway.verify(token),null); sessionStatus = 'active';
    assert.equal(liveRequests,2,'completed checks cannot hide subsequent revocation');
    userBanned = true; assert.equal(await gateway.verify(token),null); userBanned = false;
    verificationStatus = 'unverified'; assert.equal(await gateway.verify(token),null); verificationStatus = 'verified';
    sessionUserId = 'user_other'; assert.equal(await gateway.verify(token),null); sessionUserId = 'user_gateway';
    providerUnavailable = true; assert.equal(await gateway.verify(token),null);
  } finally {
    fetchMock.mock.restore(); config.clerkSecretKey = previousKey; config.clerkPublishableKey = previousPublishableKey;
  }
});

it('closes pending Clerk tickets idempotently and distinguishes terminal invitation errors from provider failures', async (test) => {
  const previousKey = config.clerkSecretKey;
  config.clerkSecretKey = 'sk_test_unit-test-placeholder';
  let state: 'pending' | 'accepted' | 'revoked' | 'missing' | 'failed' = 'pending';
  const fetchMock = test.mock.method(globalThis,'fetch',async (input: string | URL | Request) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    assert.ok(url.endsWith('/invitations/inv_gateway/revoke'));
    if (state === 'pending') return Response.json({object:'invitation',id:'inv_gateway',email_address:'person@example.test',status:'revoked',revoked:true,public_metadata:{}});
    const code = state === 'accepted' ? 'invitation_already_accepted' : state === 'revoked' ? 'invitation_already_revoked' : state === 'missing' ? 'resource_not_found' : 'operation_not_allowed';
    return Response.json({errors:[{code,message:'Provider test response'}]},{status:state === 'missing' ? 404 : 400});
  });
  try {
    const gateway = new ClerkService();
    await gateway.revokeInvitation('inv_gateway');
    state = 'accepted'; await gateway.revokeInvitation('inv_gateway');
    state = 'revoked'; await gateway.revokeInvitation('inv_gateway');
    state = 'missing'; await gateway.revokeInvitation('inv_gateway');
    state = 'failed'; await assert.rejects(gateway.revokeInvitation('inv_gateway'));
  } finally { fetchMock.mock.restore(); config.clerkSecretKey = previousKey; }
});
