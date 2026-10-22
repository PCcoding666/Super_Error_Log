import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { StudentRegistry } from '../../src/studentHost/registry.js';
import { recordAiUsage, type AiUsageRecord } from '../../src/observability/aiUsage.js';
import { parseAdminFilters, readAdminReport } from '../../src/admin/report.js';
import { AdminDashboard } from '../../src/admin/views.js';
import { ChatClient } from '../../src/ai/chatClient.js';

let root: string;
let registry: StudentRegistry;
beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), 'sel-admin-provider-')); registry = StudentRegistry.open(root); });
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); vi.unstubAllGlobals(); registry.close(); fs.rmSync(root, { recursive: true, force: true }); });
const event = (fields: Partial<AiUsageRecord> = {}): AiUsageRecord => ({ id: crypto.randomUUID(), startedAt: '2026-10-20T02:00:00.000Z',
  operation: 'material_extract', model: 'vision', provider: 'bailian-token-plan', source: 'live', status: 'succeeded', inputTokens: 100, outputTokens: 20,
  durationMs: 60_000, httpStatus: 200, errorCode: null, ...fields });

describe('/admin/ per-provider columns', () => {
  it('splits call count, failure rate and latency by provider across accounts', async () => {
    const a = registry.createStudent(); const b = registry.createStudent();
    recordAiUsage(event(), a.studentDir);
    recordAiUsage(event({ status: 'failed', errorCode: 'timeout', httpStatus: null, durationMs: 90_000 }), a.studentDir);
    recordAiUsage(event({ provider: 'bailian', durationMs: 30_000 }), a.studentDir);
    recordAiUsage(event({ durationMs: 50_000 }), b.studentDir);
    const report = await readAdminReport(registry, parseAdminFilters({}));
    const plan = report.byProvider.find(row => row.name === 'bailian-token-plan')!;
    const payg = report.byProvider.find(row => row.name === 'bailian')!;
    expect(plan.usage).toMatchObject({ calls: 3, succeeded: 2, failed: 1, p95Ms: 90_000 });
    expect(plan.usage.averageMs).toBeCloseTo((60_000 + 90_000 + 50_000) / 3);
    expect(payg.usage).toMatchObject({ calls: 1, failed: 0, averageMs: 30_000 });
    const html = renderToStaticMarkup(AdminDashboard(report) as React.ReactElement);
    expect(html).toContain('按调用线路');
    expect(html).toContain('Token Plan（主用）');
    expect(html).toContain('百炼按量付费（配了 Token Plan 时为备用）');
    expect(html).toMatch(/<th scope="col">线路<\/th>/);
    expect(html).toContain('今天（北京时间）Token Plan 失败后改走按量付费');
  });

  it('shows today’s fallback count against the cap, read from the shared ledger in the host dir', async () => {
    vi.stubEnv('SEL_TOKEN_PLAN_API_KEY', 'plan-fake');
    vi.stubEnv('SEL_AI_FALLBACK_LEDGER_DIR', root);
    vi.stubEnv('SEL_AI_FALLBACK_DAILY_CALLS', '1');
    vi.spyOn(process.stderr, 'write').mockImplementation((() => true) as typeof process.stderr.write);
    vi.stubGlobal('fetch', vi.fn().mockImplementation(async (url: string) => String(url).includes('token-plan')
      ? new Response('{}', { status: 429 })
      : new Response(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: '{}' } }] }))));
    const client = new ChatClient({ baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1', apiKey: 'payg-fake', models: { followup: 'm' }, timeoutMs: 1000, bailianOnly: true });
    await client.call('followup', [{ role: 'user', content: 'x' }]);
    await expect(client.call('followup', [{ role: 'user', content: 'x' }])).rejects.toThrow();
    const report = await readAdminReport(registry, parseAdminFilters({}));
    expect(report.fallback.today).toMatchObject({ calls: 1, blocked: 1 });
    const html = renderToStaticMarkup(AdminDashboard(report) as React.ReactElement);
    expect(html).toContain('已因到达上限拒绝 1 次');
    expect(html).toContain('今天的备用额度已用完');
  });
});
