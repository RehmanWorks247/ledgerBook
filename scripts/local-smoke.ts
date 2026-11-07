import { IncomingMessage, ServerResponse } from 'node:http';
import type { Socket } from 'node:net';
import { Duplex } from 'node:stream';
import type { NestExpressApplication } from '@nestjs/platform-express';

export type LocalAppVerification = {
  checks: string[];
  transport: 'tcp' | 'in-process';
};

type VerificationIdentity = {
  email: string;
  password: string;
  organizationId: string;
  origin: string;
};

type ProbeOptions = {
  method?: 'GET' | 'POST';
  body?: unknown;
  cookie?: string;
  csrf?: boolean;
};

function networkDenied(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const candidate = error as { code?: string; cause?: unknown; errors?: unknown[] };
  return candidate.code === 'EACCES' || candidate.code === 'EPERM' ||
    networkDenied(candidate.cause) || Boolean(candidate.errors?.some(networkDenied));
}

/** Dispatch through the real HTTP middleware without opening an outbound socket. */
function inProcessRequest(
  app: NestExpressApplication,
  path: string,
  method: string,
  headers: Record<string, string>,
  body?: string,
): Promise<Response> {
  const chunks: Buffer[] = [];
  const socket = new Duplex({
    read() { /* IncomingMessage supplies the request body below. */ },
    write(chunk: Buffer, _encoding, callback) {
      chunks.push(Buffer.from(chunk));
      callback();
    },
  });
  Object.defineProperty(socket, 'remoteAddress', { value: '127.0.0.1' });
  const incoming = new IncomingMessage(socket as Socket);
  incoming.method = method;
  incoming.url = path;
  incoming.httpVersion = '1.1';
  incoming.httpVersionMajor = 1;
  incoming.httpVersionMinor = 1;
  incoming.complete = true;
  incoming.headers = Object.fromEntries(Object.entries(headers).map(([key, value]) => [key.toLowerCase(), value]));
  incoming.headers.host = 'localhost';
  incoming.headers.connection = 'close';
  if (body !== undefined) incoming.headers['content-length'] = String(Buffer.byteLength(body));
  const outgoing = new ServerResponse(incoming);
  outgoing.assignSocket(socket as Socket);
  // A real HTTP server forwards socket backpressure relief to ServerResponse.
  // Mirror that event for sendFile streams larger than one writable buffer.
  socket.on('drain', () => outgoing.emit('drain'));
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      socket.destroy();
      reject(new Error(`Local HTTP verification timed out for ${path} (request complete=${incoming.complete}, ended=${incoming.readableEnded}, response finished=${outgoing.writableFinished}, bytes=${chunks.reduce((sum, chunk) => sum + chunk.length, 0)}).`));
    }, 10_000);
    outgoing.once('error', () => {
      clearTimeout(timeout);
      socket.destroy();
      reject(new Error('Local HTTP verification failed while receiving a response.'));
    });
    outgoing.once('finish', () => {
      clearTimeout(timeout);
      try {
        const raw = Buffer.concat(chunks);
        const boundary = raw.indexOf('\r\n\r\n');
        if (boundary < 0 || outgoing.getHeader('transfer-encoding') === 'chunked') {
          throw new Error('Local HTTP verification received an unsupported response.');
        }
        const responseHeaders = new Headers();
        for (const [name, value] of Object.entries(outgoing.getHeaders())) {
          for (const item of Array.isArray(value) ? value : [value]) {
            if (item !== undefined) responseHeaders.append(name, String(item));
          }
        }
        resolve(new Response(
          [204, 304].includes(outgoing.statusCode) ? null : raw.subarray(boundary + 4),
          { status: outgoing.statusCode, headers: responseHeaders },
        ));
      } catch (error) { reject(error); }
      finally { socket.destroy(); }
    });
    if (body !== undefined) incoming.push(Buffer.from(body));
    incoming.push(null);
    app.getHttpAdapter().getInstance()(incoming, outgoing);
  });
}

/**
 * Verify the running local app without modifying customer/ledger data. The only
 * writes are a temporary authenticated session and normal abuse-control counters.
 * Credentials and cookies are held in memory and never included in the result.
 */
export async function verifyLocalApp(
  app: NestExpressApplication,
  identity: VerificationIdentity,
): Promise<LocalAppVerification> {
  const base = await app.getUrl();
  const checks: string[] = [];
  let transport: LocalAppVerification['transport'] = 'tcp';
  let cookie: string | undefined;

  const probe = async (path: string, options: ProbeOptions = {}): Promise<Response> => {
    const method = options.method ?? (options.body === undefined ? 'GET' : 'POST');
    const headers: Record<string, string> = { Origin: identity.origin };
    if (options.csrf !== false) headers['X-CSRF-Protection'] = '1';
    if (options.cookie) headers.Cookie = options.cookie;
    if (options.body !== undefined) headers['Content-Type'] = 'application/json';
    const body = options.body === undefined ? undefined : JSON.stringify(options.body);
    if (transport === 'in-process') return inProcessRequest(app, path, method, headers, body);
    try {
      return await fetch(`${base}${path}`, {
        method, headers, body, redirect: 'manual', signal: AbortSignal.timeout(10_000),
      });
    } catch (error) {
      if (!networkDenied(error)) throw new Error('Local HTTP verification could not reach the running server.', { cause: error });
      transport = 'in-process';
      return inProcessRequest(app, path, method, headers, body);
    }
  };

  const expectStatus = (response: Response, expected: number, label: string): void => {
    if (response.status !== expected) throw new Error(`Local verification failed: ${label} (HTTP ${response.status}).`);
  };
  const expect = (condition: unknown, label: string): void => {
    if (!condition) throw new Error(`Local verification failed: ${label}.`);
  };

  try {
    const loginPage = await probe('/login');
    expectStatus(loginPage, 200, 'sign-in page');
    expect(loginPage.headers.get('content-type')?.includes('text/html'), 'HTML sign-in page');
    const html = await loginPage.text();
    expect(html.includes('id="root"'), 'React application root');
    checks.push('Sign-in page serves the built React application');

    const script = [...html.matchAll(/<script\b[^>]*\bsrc="([^"]+)"/gi)]
      .map(match => match[1]).find(source => source.startsWith('/assets/'));
    expect(script && script.startsWith('/assets/') && !script.includes('..'), 'built JavaScript asset reference');
    const asset = await probe(script!);
    expectStatus(asset, 200, 'built JavaScript asset');
    expect((await asset.text()).length > 0, 'nonempty JavaScript asset');
    checks.push('Production JavaScript asset is served');

    const ready = await probe('/api/ready');
    expectStatus(ready, 200, 'database readiness');
    expect((await ready.json()).status === 'ready', 'database readiness response');
    checks.push('Database is ready');

    expectStatus(await probe('/api/auth/session'), 401, 'anonymous session restriction');
    checks.push('Unauthenticated requests are protected');

    const unprotectedLogin = await probe('/api/auth/login', {
      body: { email: identity.email, password: identity.password }, csrf: false,
    });
    expectStatus(unprotectedLogin, 403, 'CSRF restriction');
    checks.push('Missing CSRF protection is rejected');

    const login = await probe('/api/auth/login', { body: { email: identity.email, password: identity.password } });
    expectStatus(login, 200, 'administrator sign-in');
    const setCookie = login.headers.get('set-cookie');
    expect(setCookie && /HttpOnly/i.test(setCookie) && /SameSite=Lax/i.test(setCookie), 'secure session cookie flags');
    cookie = setCookie!.split(';', 1)[0];
    checks.push('Administrator can sign in with a protected session cookie');

    const sessionResponse = await probe('/api/auth/session', { cookie });
    expectStatus(sessionResponse, 200, 'administrator session');
    const session = await sessionResponse.json();
    expect(session.user?.email === identity.email, 'authenticated identity');
    expect(Array.isArray(session.memberships) && session.memberships.some((member: { organization_id?: string; role?: string }) =>
      member.organization_id === identity.organizationId && member.role === 'admin'), 'administrator organization membership');
    checks.push('Session resolves the intended organization administrator');

    const dashboardResponse = await probe(`/api/organizations/${identity.organizationId}/dashboard`, { cookie });
    expectStatus(dashboardResponse, 200, 'organization dashboard');
    const dashboard = await dashboardResponse.json();
    expect(typeof dashboard.total_debt_minor === 'string' && /^\d+$/.test(dashboard.total_debt_minor) &&
      typeof dashboard.total_credit_minor === 'string' && /^\d+$/.test(dashboard.total_credit_minor), 'exact dashboard balance values');
    checks.push('Organization dashboard returns precise debt and credit totals');

    expectStatus(await probe('/api/auth/logout', { method: 'POST', cookie }), 200, 'administrator sign-out');
    expectStatus(await probe('/api/auth/session', { cookie }), 401, 'signed-out session invalidation');
    cookie = undefined;
    checks.push('Sign-out invalidates the session');
    return { checks, transport };
  } finally {
    if (cookie) await probe('/api/auth/logout', { method: 'POST', cookie }).catch(() => undefined);
  }
}

/** Startup checks do not create provider users, passwords, or sessions. */
export async function verifyClerkLocalApp(app:NestExpressApplication,origin:string):Promise<LocalAppVerification> {
  const base=await app.getUrl();
  let transport:LocalAppVerification['transport']='tcp';
  const checks:string[]=[];
  const probe=async(path:string):Promise<Response>=>{
    if(transport==='in-process') return inProcessRequest(app,path,'GET',{Origin:origin});
    try{return await fetch(`${base}${path}`,{headers:{Origin:origin},signal:AbortSignal.timeout(10_000)});}
    catch(error){
      if(!networkDenied(error)) throw new Error('Clerk local startup verification could not reach the server.',{cause:error});
      transport='in-process';
      return inProcessRequest(app,path,'GET',{Origin:origin});
    }
  };
  const page=await probe('/login');
  if(page.status!==200||!page.headers.get('content-type')?.includes('text/html')||!(await page.text()).includes('id="root"'))
    throw new Error('Clerk local startup verification failed: built sign-in page.');
  checks.push('Sign-in page serves the built React application');
  const ready=await probe('/api/ready');
  if(ready.status!==200||(await ready.json()).status!=='ready') throw new Error('Clerk local startup verification failed: database readiness.');
  checks.push('Database is ready');
  const configuration=await probe('/api/auth/config');
  if(configuration.status!==200) throw new Error('Clerk local startup verification failed: authentication configuration.');
  const auth=await configuration.json();
  if(auth.provider!=='clerk'||typeof auth.publishableKey!=='string'||!auth.publishableKey.startsWith('pk_'))
    throw new Error('Clerk local startup verification failed: Clerk publishable key.');
  checks.push('Clerk authentication is configured');
  if((await probe('/api/auth/session')).status!==401) throw new Error('Clerk local startup verification failed: anonymous session restriction.');
  checks.push('Unauthenticated requests are protected');
  return {checks,transport};
}
