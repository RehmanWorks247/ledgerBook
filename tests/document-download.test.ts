import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { describe, it } from 'node:test';
import type { CallHandler, ExecutionContext } from '@nestjs/common';
import { lastValueFrom, of, Subject, throwError } from 'rxjs';
import { DocumentDownloadInterceptor } from '../apps/api/src/bookings/document-download.interceptor';

class DownloadResponse extends EventEmitter {
  readonly headers = new Map<string, string>();
  setHeader(name: string, value: string) { this.headers.set(name.toLowerCase(), value); }
  destroy() { this.emit('close'); }
}

function context(response: DownloadResponse) {
  return { switchToHttp: () => ({ getResponse: () => response }) } as unknown as ExecutionContext;
}

async function reserve(interceptor: DocumentDownloadInterceptor, response = new DownloadResponse()) {
  await lastValueFrom(interceptor.intercept(context(response), { handle: () => of(undefined) }));
  return response;
}

function rejectsBusy(interceptor: DocumentDownloadInterceptor) {
  const response = new DownloadResponse();
  let reachedHandler = false;
  assert.throws(() => interceptor.intercept(context(response), { handle: () => { reachedHandler = true; return of(undefined); } }), error => {
    assert.equal((error as { getStatus(): number }).getStatus(), 503);
    return true;
  });
  assert.equal(response.headers.get('retry-after'), '5');
  assert.equal(reachedHandler, false);
  assert.equal(response.listenerCount('finish'), 0);
  assert.equal(response.listenerCount('close'), 0);
}

describe('document download concurrency', () => {
  it('holds all eight slots after handlers finish until responses drain, then admits one replacement', async () => {
    const interceptor = new DocumentDownloadInterceptor();
    const active = await Promise.all(Array.from({ length: 8 }, () => reserve(interceptor)));
    rejectsBusy(interceptor);

    active[0].emit('finish');
    assert.equal(active[0].listenerCount('finish'), 0);
    assert.equal(active[0].listenerCount('close'), 0);
    const replacement = await reserve(interceptor);
    rejectsBusy(interceptor);

    // Node commonly emits close after finish; it must not free the slot twice.
    active[0].emit('close');
    rejectsBusy(interceptor);
    for (const response of [...active, replacement]) response.emit('close');
    const nextBatch = await Promise.all(Array.from({ length: 8 }, () => reserve(interceptor)));
    rejectsBusy(interceptor);
    for (const response of nextBatch) response.emit('finish');
  });

  it('releases a prematurely closed response once and removes lifecycle listeners', async () => {
    const interceptor = new DocumentDownloadInterceptor();
    const active = await Promise.all(Array.from({ length: 8 }, () => reserve(interceptor)));
    active[0].emit('close');
    assert.equal(active[0].listenerCount('finish'), 0);
    assert.equal(active[0].listenerCount('close'), 0);
    const replacement = await reserve(interceptor);
    active[0].emit('finish');
    active[0].emit('close');
    rejectsBusy(interceptor);
    for (const response of [...active, replacement]) response.emit('close');
  });

  it('retains a failed handler until its error response drains without swallowing the error', async () => {
    const interceptor = new DocumentDownloadInterceptor();
    const active = await Promise.all(Array.from({ length: 7 }, () => reserve(interceptor)));
    const response = new DownloadResponse();
    const failure = new Error('storage unavailable');
    await assert.rejects(lastValueFrom(interceptor.intercept(context(response), { handle: () => throwError(() => failure) })), error => error === failure);
    rejectsBusy(interceptor);
    response.emit('finish');
    assert.equal(response.listenerCount('finish'), 0);
    assert.equal(response.listenerCount('close'), 0);
    const replacement = await reserve(interceptor);
    response.emit('close');
    rejectsBusy(interceptor);
    for (const item of [...active, replacement]) item.emit('close');
  });

  it('does not free a cancelled download while its storage handler is still running', async () => {
    const interceptor = new DocumentDownloadInterceptor();
    const active = await Promise.all(Array.from({ length: 7 }, () => reserve(interceptor)));
    const response = new DownloadResponse();
    const handler = new Subject<undefined>();
    const pending = lastValueFrom(interceptor.intercept(context(response), { handle: () => handler }));
    response.emit('close');
    rejectsBusy(interceptor);
    handler.next(undefined);
    handler.complete();
    await pending;
    assert.equal(response.listenerCount('finish'), 0);
    assert.equal(response.listenerCount('close'), 0);
    const replacement = await reserve(interceptor);
    response.emit('finish');
    rejectsBusy(interceptor);
    for (const item of [...active, replacement]) item.emit('close');
  });

  it('does not leak capacity when the next handler throws synchronously', async () => {
    const interceptor = new DocumentDownloadInterceptor();
    const active = await Promise.all(Array.from({ length: 7 }, () => reserve(interceptor)));
    const response = new DownloadResponse();
    const failure = new Error('handler could not start');
    const next: CallHandler = { handle: () => { throw failure; } };
    await assert.rejects(async () => lastValueFrom(interceptor.intercept(context(response), next)), error => error === failure);
    rejectsBusy(interceptor);
    response.emit('close');
    assert.equal(response.listenerCount('finish'), 0);
    assert.equal(response.listenerCount('close'), 0);
    const replacement = await reserve(interceptor);
    rejectsBusy(interceptor);
    for (const item of [...active, replacement]) item.emit('close');
  });
});
