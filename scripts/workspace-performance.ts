import 'reflect-metadata';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { performance } from 'node:perf_hooks';
import { AccessService } from '../apps/api/src/access/access.service';
import { AuthService } from '../apps/api/src/auth/auth.service';
import { NotificationsService } from '../apps/api/src/notifications/notifications.service';
import { OrganizationsService } from '../apps/api/src/organizations/organizations.service';
import { setupTestDatabase } from '../tests/helpers';

// Opt-in isolated SQL/service benchmark. This script never loads .env, and
// setupTestDatabase creates/drops a unique schema, preserving all other schemas.
// TEST_DATABASE_URL=postgresql://.../ledger_test node --require ./tests/test-environment.cjs --import tsx scripts/workspace-performance.ts
type Plan = {
  'Node Type': string;
  'Relation Name'?: string;
  'Index Name'?: string;
  'Actual Rows'?: number;
  'Actual Loops'?: number;
  'Rows Removed by Filter'?: number;
  Plans?: Plan[];
};
function measurements(times: number[]) {
  const sorted = [...times].sort((a, b) => a - b);
  const rounded = (value: number) => Number(value.toFixed(2));
  return { samples: times.length, median_ms: rounded(sorted[Math.floor(sorted.length / 2)]),
    p95_ms: rounded(sorted[Math.ceil(sorted.length * 0.95) - 1]), max_ms: rounded(sorted.at(-1)!) };
}
function summarizePlan(plan: Plan): Record<string, unknown>[] {
  return [{ node: plan['Node Type'], relation: plan['Relation Name'], index: plan['Index Name'],
    rows: plan['Actual Rows'], loops: plan['Actual Loops'], removed_by_filter: plan['Rows Removed by Filter'] },
  ...(plan.Plans ?? []).flatMap(summarizePlan)];
}
async function main() {
  let target: URL;
  try { target = new URL(process.env.TEST_DATABASE_URL ?? 'postgresql://invalid/'); }
  catch { throw new Error('TEST_DATABASE_URL must be a valid PostgreSQL URL.'); }
  if (process.env.NODE_ENV !== 'test' || !['localhost', '127.0.0.1', '[::1]'].includes(target.hostname)
    || !['postgres:', 'postgresql:'].includes(target.protocol)
    || !/(?:^|[_-])(?:test|audit)(?:[_-]|$)/i.test(target.pathname.slice(1))) {
    throw new Error('Use the test environment and a disposable loopback PostgreSQL database named with test or audit.');
  }
  const samples = Number(process.env.WORKSPACE_BENCHMARK_SAMPLES ?? 20);
  if (!Number.isInteger(samples) || samples < 20 || samples > 100) throw new Error('WORKSPACE_BENCHMARK_SAMPLES must be an integer from 20 to 100.');
  const fixture = await setupTestDatabase();
  try {
    const seed = await fixture.seed();
    const access = new AccessService(fixture.db);
    const service = new OrganizationsService(fixture.db, access);
    const auth = new AuthService(fixture.db, new NotificationsService());
    const actors = [50, 100].map(count => ({ id: randomUUID(), email: `workspace-benchmark-${count}@example.test`, count }));
    const started = performance.now();
    await fixture.db.transaction(async client => {
      await client.query("SET LOCAL statement_timeout='2min'");
      await client.query(`INSERT INTO organizations(id,name,currency,currency_exponent)
        SELECT gen_random_uuid(),'Benchmark workspace '||lpad(n::text,5,'0'),'GBP',2 FROM generate_series(1,10000) n`);
      await client.query(`INSERT INTO memberships(id,organization_id,user_id,role)
        SELECT gen_random_uuid(),id,$1,'admin' FROM organizations WHERE name LIKE 'Benchmark workspace %'`, [seed.otherAdminId]);
      for (const actor of actors) {
        await client.query("INSERT INTO users(id,email,password_hash) VALUES($1,$2,'benchmark-only')", [actor.id, actor.email]);
        await client.query(`INSERT INTO memberships(id,organization_id,user_id,role)
          SELECT gen_random_uuid(),id,$1,'admin' FROM organizations WHERE name LIKE 'Benchmark workspace %' ORDER BY name LIMIT $2`, [actor.id, actor.count]);
      }
    });
    for (const table of ['organizations', 'memberships', 'users']) await fixture.db.query(`ANALYZE ${table}`);
    const report: Record<string, unknown> = {
      environment: 'Disposable loopback PostgreSQL; isolated schema; service and SQL timings. Excludes HTTP, browser rendering, provider services, storage, and WAN latency.',
      postgres: (await fixture.db.query('SHOW server_version')).rows[0].server_version,
      recorded_at: new Date().toISOString(),
      fixture: { benchmark_workspaces: 10000, initial_workspaces: 10002, initial_memberships: 10153, seed_ms: Math.round(performance.now() - started) },
      phases: [],
    };
    const phases = report.phases as Record<string, unknown>[];
    const planErrors: string[] = [];
    for (const actor of actors) {
      const member = (await fixture.db.query('SELECT organization_id FROM memberships WHERE user_id=$1 ORDER BY organization_id LIMIT 1', [actor.id])).rows[0];
      const orgId = member.organization_id as string;
      let version = (await service.get(actor.id, orgId)).version;
      assert.equal((await auth.session(actor)).memberships.length, actor.count);
      const phase: Record<string, unknown> = { accessible_workspaces_before_writes: actor.count, measurements: {}, query_plans: {} };
      phases.push(phase);
      const cases: Record<string, () => Promise<unknown>> = {
        session: () => auth.session(actor),
        profile_read: () => service.get(actor.id, orgId),
        profile_update: async () => {
          const updated = await service.update(actor.id, orgId, { description: `Benchmark change ${version}`, expected_version: version });
          version = updated.version;
          return updated;
        },
      };
      for (const [name, run] of Object.entries(cases)) {
        for (let index = 0; index < 3; index++) await run();
        const times: number[] = [];
        for (let index = 0; index < samples; index++) { const start = performance.now(); await run(); times.push(performance.now() - start); }
        (phase.measurements as Record<string, unknown>)[name] = measurements(times);
      }
      const concurrentStart = performance.now();
      const concurrent = await Promise.allSettled(Array.from({ length: 20 }, async (_, index) => {
        const start = performance.now();
        if (index % 2) await service.get(actor.id, orgId); else await auth.session(actor);
        return performance.now() - start;
      }));
      const fulfilled = concurrent.filter(result => result.status === 'fulfilled');
      const failures = concurrent.filter(result => result.status === 'rejected');
      phase.concurrent_reads = { concurrency: 20, session_requests: 10, profile_requests: 10,
        failures: failures.length, elapsed_ms: Number((performance.now() - concurrentStart).toFixed(2)),
        ...(fulfilled.length ? measurements(fulfilled.map(result => result.value)) : { samples: 0 }) };
      assert.equal(failures.length, 0, 'Concurrent benchmark reads must all succeed.');
      const queries: Record<string, { sql: string; values: unknown[] }> = {
        session_memberships: { sql: `SELECT m.id,m.organization_id,m.role,m.is_active,m.customer_id,o.name AS organization_name,o.currency,o.currency_exponent,
          o.description AS organization_description,o.color AS organization_color,o.version AS organization_version
          FROM memberships m JOIN LATERAL (
            SELECT name,currency,currency_exponent,description,color,version FROM organizations
            WHERE id=m.organization_id AND deleted_at IS NULL LIMIT 1
          ) o ON true
          WHERE m.user_id=$1 AND m.is_active=true AND m.deleted_at IS NULL ORDER BY o.name,m.id`, values: [actor.id] },
        access_lookup: { sql: `SELECT m.*,o.name,o.currency,o.currency_exponent FROM memberships m JOIN organizations o ON o.id=m.organization_id
          WHERE m.user_id=$1 AND m.organization_id=$2 AND m.is_active AND m.deleted_at IS NULL AND o.deleted_at IS NULL`, values: [actor.id, orgId] },
        creator_lookup: { sql: `SELECT o.id FROM organizations o WHERE o.deleted_at IS NULL AND EXISTS(SELECT 1 FROM memberships m WHERE m.organization_id=o.id
          AND m.user_id=$1 AND m.role='admin' AND m.is_active AND m.deleted_at IS NULL) ORDER BY o.id LIMIT 1 FOR SHARE OF o`, values: [actor.id] },
      };
      for (const [name, query] of Object.entries(queries)) {
        const result = (await fixture.db.query(`EXPLAIN (ANALYZE,BUFFERS,FORMAT JSON) ${query.sql}`, query.values)).rows[0]['QUERY PLAN'][0];
        const nodes = summarizePlan(result.Plan);
        (phase.query_plans as Record<string, unknown>)[name] = { planning_ms: result['Planning Time'], execution_ms: result['Execution Time'], nodes };
        if (!nodes.some(node => typeof node.index === 'string')) planErrors.push(`${actor.count} workspaces: ${name} did not use a lookup index.`);
        if (nodes.some(node => node.node === 'Seq Scan' && ['organizations', 'memberships'].includes(String(node.relation)))) {
          planErrors.push(`${actor.count} workspaces: ${name} scanned all tenant rows despite bounded membership access.`);
        }
      }
      const creationTimes: number[] = [];
      for (let index = 0; index < samples + 3; index++) {
        const start = performance.now();
        await service.create(actor.id, { name: 'Benchmark creation', idempotency_key: randomUUID() });
        if (index >= 3) creationTimes.push(performance.now() - start);
      }
      (phase.measurements as Record<string, unknown>).create = measurements(creationTimes);
      console.log(JSON.stringify({ workspaces: actor.count, measurements: phase.measurements, concurrent_reads: phase.concurrent_reads }));
    }
    report.index_validation = { passed: planErrors.length === 0, failures: planErrors };
    await mkdir('.local', { recursive: true });
    await writeFile('.local/workspace-performance.json', `${JSON.stringify(report, null, 2)}\n`);
    console.log('Saved .local/workspace-performance.json; isolated benchmark schema will be removed.');
    assert.deepEqual(planErrors, [], 'Workspace queries must use bounded membership and organization lookups.');
  } finally { await fixture.close(); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
