#!/usr/bin/env bash
set -euo pipefail

# Session 6 AI Design Assistant Smoke & Rate-Limit Test
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR"
exec node --input-type=module - <<'NODE_EOF'
import assert from 'node:assert/strict';

const API_URL = process.env.API_URL || 'http://localhost:3000/api/v1';
const AI_TEST_KEY = (process.env.AI_TEST_KEY || '').trim();

async function apiJson(path, options = {}) {
  const res = await fetch(`${API_URL}${path}`, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...(options.headers || {}),
    },
  });
  const body = await res.json().catch(() => ({}));
  return { status: res.status, body, headers: res.headers };
}

async function loginAdmin() {
  const login = await apiJson('/auth/login', {
    method: 'POST',
    body: JSON.stringify({
      email: 'admin@demo.local',
      password: 'Password123!',
    }),
  });
  assert.equal(login.status, 200, `Admin login failed: ${JSON.stringify(login.body)}`);
  return login.body.data.tokens.accessToken;
}

async function registerFreshUser(tag) {
  const email = `ai_${tag}_${Date.now()}_${Math.floor(Math.random() * 10000)}@demo.local`;
  const reg = await apiJson('/auth/register', {
    method: 'POST',
    body: JSON.stringify({
      email,
      password: 'Password123!',
      name: `AI Tester ${tag}`,
    }),
  });
  assert.equal(reg.status, 201, `Register failed: ${JSON.stringify(reg.body)}`);
  return reg.body.data.tokens.accessToken;
}

async function main() {
  console.log(`[test-ai] API=${API_URL} AI_TEST_KEY=${AI_TEST_KEY ? 'set' : 'unset'}`);

  // 1. Unauthenticated request must return 401
  const unauth = await apiJson('/ai/chat', {
    method: 'POST',
    body: JSON.stringify({ fileId: 'fil_demo_housing', message: 'hello' }),
  });
  assert.equal(unauth.status, 401, `Expected 401 unauthenticated, got ${unauth.status}`);
  console.log('[test-ai] PASS 1: Unauthenticated POST /ai/chat rejected with 401');

  // 2. Authenticate as admin and find seeded STEP file
  const token = await loginAdmin();
  const authHeaders = { Authorization: `Bearer ${token}` };

  const projectsRes = await apiJson('/projects', { headers: authHeaders });
  assert.equal(projectsRes.status, 200);
  const project = projectsRes.body.data.items[0];
  assert.ok(project?.id, 'Expected at least one seeded project');

  const filesRes = await apiJson(`/files?projectId=${encodeURIComponent(project.id)}`, {
    headers: authHeaders,
  });
  assert.equal(filesRes.status, 200);
  const files = filesRes.body.data.items;
  const stepFile =
    files.find((f) => ['step', 'stp'].includes(String(f.extension || '').toLowerCase())) ||
    files[0];
  assert.ok(stepFile?.id, 'Expected at least one seeded CAD file');

  // 3. GET /ai/insights should succeed for authorized user
  const insightsBefore = await apiJson(`/ai/insights?fileId=${encodeURIComponent(stepFile.id)}`, {
    headers: authHeaders,
  });
  assert.equal(insightsBefore.status, 200, `GET /ai/insights failed: ${JSON.stringify(insightsBefore.body)}`);
  assert.ok(Array.isArray(insightsBefore.body.data), 'GET /ai/insights data must be an array');
  console.log(`[test-ai] PASS 2: GET /ai/insights returned ${insightsBefore.body.data.length} stored insight(s)`);

  // 4. Probe POST /ai/chat to determine whether server has GEMINI_API_KEY configured
  const chatProbe = await apiJson('/ai/chat', {
    method: 'POST',
    headers: authHeaders,
    body: JSON.stringify({
      fileId: stepFile.id,
      message: 'How many annotations are on this file?',
    }),
  });

  if (chatProbe.status === 503) {
    // Default CI path: server has no GEMINI_API_KEY configured
    const code = chatProbe.body?.code || chatProbe.body?.error?.code;
    assert.equal(code, 'AI_NOT_CONFIGURED', `Expected AI_NOT_CONFIGURED, got ${JSON.stringify(chatProbe.body)}`);

    for (const ep of [
      { path: '/ai/summary', body: { fileId: stepFile.id } },
      { path: '/ai/bom', body: { fileId: stepFile.id } },
      { path: '/ai/dfm', body: { fileId: stepFile.id } },
    ]) {
      const res = await apiJson(ep.path, {
        method: 'POST',
        headers: authHeaders,
        body: JSON.stringify(ep.body),
      });
      assert.equal(res.status, 503, `Expected 503 on ${ep.path}, got ${res.status}`);
      const epCode = res.body?.code || res.body?.error?.code;
      assert.equal(epCode, 'AI_NOT_CONFIGURED', `Expected AI_NOT_CONFIGURED on ${ep.path}`);
    }
    console.log('[test-ai] PASS 3: All 4 AI endpoints cleanly return 503 AI_NOT_CONFIGURED when GEMINI_API_KEY is unset');
    if (AI_TEST_KEY) {
      console.log('[test-ai] NOTE: AI_TEST_KEY was set in test shell, but target server does not have GEMINI_API_KEY configured. Start server with GEMINI_API_KEY="$AI_TEST_KEY" to run live model checks.');
    }
  } else {
    // Live Gemini path (server has GEMINI_API_KEY configured)
    assert.equal(chatProbe.status, 200, `Live /ai/chat failed: ${JSON.stringify(chatProbe.body)}`);
    assert.equal(typeof chatProbe.body.data?.reply, 'string');
    assert.ok(chatProbe.body.data.reply.length > 0, 'Live /ai/chat reply should be non-empty');
    assert.ok(Array.isArray(chatProbe.body.data.referencedAnnotationIds), 'referencedAnnotationIds must be an array');
    console.log(`[test-ai] PASS 3a (live): POST /ai/chat replied (${chatProbe.body.data.reply.length} chars)`);

    const summaryRes = await apiJson('/ai/summary', {
      method: 'POST',
      headers: authHeaders,
      body: JSON.stringify({ fileId: stepFile.id }),
    });
    assert.equal(summaryRes.status, 200, `Live /ai/summary failed: ${JSON.stringify(summaryRes.body)}`);
    assert.equal(typeof summaryRes.body.data?.summary, 'string');
    assert.ok(Array.isArray(summaryRes.body.data?.openIssues));
    assert.equal(typeof summaryRes.body.data?.openCount, 'number');
    assert.equal(typeof summaryRes.body.data?.resolvedCount, 'number');
    assert.ok(Array.isArray(summaryRes.body.data?.recommendedNextSteps));
    console.log('[test-ai] PASS 3b (live): POST /ai/summary validated against schema');

    const bomRes = await apiJson('/ai/bom', {
      method: 'POST',
      headers: authHeaders,
      body: JSON.stringify({ fileId: stepFile.id }),
    });
    assert.equal(bomRes.status, 200, `Live /ai/bom failed: ${JSON.stringify(bomRes.body)}`);
    assert.ok(Array.isArray(bomRes.body.data?.items) && bomRes.body.data.items.length >= 1, 'Expected >= 1 BOM item on seeded STEP file');
    assert.ok(['high', 'medium', 'low'].includes(bomRes.body.data?.sourceConfidence));
    console.log(`[test-ai] PASS 3c (live): POST /ai/bom extracted ${bomRes.body.data.items.length} item(s)`);

    const dfmRes = await apiJson('/ai/dfm', {
      method: 'POST',
      headers: authHeaders,
      body: JSON.stringify({ fileId: stepFile.id }),
    });
    assert.equal(dfmRes.status, 200, `Live /ai/dfm failed: ${JSON.stringify(dfmRes.body)}`);
    assert.ok(Array.isArray(dfmRes.body.data?.findings));
    console.log(`[test-ai] PASS 3d (live): POST /ai/dfm returned ${dfmRes.body.data.findings.length} finding(s)`);
  }

  // 5. Rate-limit test (C2): send 31 rapid /ai/chat requests from an isolated fresh user -> 31st MUST return 429
  const rlToken = await registerFreshUser('ratelimit');
  const rlHeaders = { Authorization: `Bearer ${rlToken}` };

  // Create a temp project so the fresh user is isolated and does not affect admin quota
  let last30Statuses = [];
  for (let i = 1; i <= 30; i += 1) {
    const res = await apiJson('/ai/chat', {
      method: 'POST',
      headers: rlHeaders,
      body: JSON.stringify({
        fileId: stepFile.id,
        message: `Rate limit probe #${i}`,
      }),
    });
    assert.notEqual(res.status, 429, `Request #${i} was unexpectedly rate-limited early`);
    last30Statuses.push(res.status);
  }

  const req31 = await apiJson('/ai/chat', {
    method: 'POST',
    headers: rlHeaders,
    body: JSON.stringify({
      fileId: stepFile.id,
      message: 'Rate limit probe #31 (should be 429)',
    }),
  });
  assert.equal(req31.status, 429, `Expected 429 on 31st rapid /ai/chat request, got ${req31.status}: ${JSON.stringify(req31.body)}`);
  const rlCode = req31.body?.code || req31.body?.error?.code;
  assert.equal(rlCode, 'AI_RATE_LIMIT', `Expected AI_RATE_LIMIT code, got ${JSON.stringify(req31.body)}`);
  const retryAfter = req31.body?.retryAfterSeconds ?? req31.body?.error?.retryAfterSeconds;
  assert.ok(typeof retryAfter === 'number' && retryAfter > 0, `Expected positive retryAfterSeconds, got ${retryAfter}`);
  console.log(`[test-ai] PASS 4: 31st rapid /ai/chat returned 429 AI_RATE_LIMIT (retryAfterSeconds=${retryAfter}, first 30 statuses=${[...new Set(last30Statuses)].join(',')})`);

  console.log('[test-ai] ALL CHECKS PASSED');
}

main().catch((err) => {
  console.error('[test-ai] FAILED:', err);
  process.exit(1);
});
NODE_EOF
