import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { Script } from 'node:vm';
import http from 'node:http';
import { createHash } from 'node:crypto';
import { resolveTarget, prepareRequest, executeRequest, acquireCliToken, LabError } from './lab.mjs';
import { createLabServer } from './server.mjs';

const responseData = {
  id: 'resp_test', object: 'response', status: 'completed', model: 'test-deployment',
  output: [{ id: 'msg_output', type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Hello from the test.' }] }],
  usage: { input_tokens: 4, output_tokens: 6, total_tokens: 10 }
};
const inputPage = {
  object: 'list', data: [{ id: 'msg_input', type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Test prompt' }] }],
  first_id: 'msg_input', last_id: 'msg_input', has_more: true
};
const conversationData = {
  id: 'conv_test', object: 'conversation', created_at: 1700000000, metadata: { topic: 'Test conversation' }
};
const conversationPage = {
  object: 'list', data: [conversationData], first_id: 'conv_test', last_id: 'conv_test', has_more: true
};
const conversationItems = {
  object: 'list', data: [
    { id: 'msg_user', type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Question' }] },
    { id: 'msg_assistant', type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Answer' }] },
    { id: 'tool_test', type: 'function_call', name: 'lookup', arguments: '{"query":"test"}' }
  ], first_id: 'msg_user', last_id: 'tool_test', has_more: false
};
function payload(overrides = {}) {
  return {
    target: { kind: 'account', account: 'test-account' }, responseId: 'resp_test',
    operation: 'response', auth: { mode: 'key', apiKey: 'test-secret-key' }, ...overrides
  };
}
function conversationPayload(operation = 'conversations', overrides = {}) {
  return payload({
    target: { kind: 'project', account: 'test-account', project: 'demo' },
    auth: { mode: 'cli' }, operation, conversationId: 'conv_test', responseId: undefined, ...overrides
  });
}
function upstream(data = responseData, status = 200, headers = {}) {
  return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json', 'apim-request-id': 'req_test', ...headers } });
}
function rejectsInvalid(fn, pattern) {
  assert.throws(fn, error => error instanceof LabError && error.status === 400 && pattern.test(error.message));
}

test('account and project names resolve to distinct, documented scopes', () => {
  assert.deepEqual(resolveTarget({ kind: 'account', account: 'Test-Account' }), {
    baseUrl: 'https://test-account.openai.azure.com/openai/v1/', projectScoped: false
  });
  assert.deepEqual(resolveTarget({ kind: 'project', account: 'test-account', project: '_project' }), {
    baseUrl: 'https://test-account.services.ai.azure.com/api/projects/_project/openai/v1/', projectScoped: true
  });
});

for (const endpoint of [
  'https://test.openai.azure.com',
  'https://test.openai.azure.com/openai/v1/',
  'https://test.services.ai.azure.com',
  'https://test.cognitiveservices.azure.com/openai/v1'
]) {
  test(`normalize supported account endpoint: ${endpoint}`, () => {
    const result = resolveTarget({ kind: 'endpoint', endpoint });
    assert.equal(result.projectScoped, false);
    assert.ok(result.baseUrl.endsWith('/openai/v1/'));
    assert.equal(result.baseUrl.split('/openai/v1').length, 2);
  });
}
for (const suffix of ['', '/', '/openai/v1', '/openai/v1/']) {
  test(`normalize project endpoint suffix: ${suffix || '(root)'}`, () => {
    assert.deepEqual(resolveTarget({ kind: 'endpoint', endpoint: `https://test.services.ai.azure.com/api/projects/my-project${suffix}` }), {
      baseUrl: 'https://test.services.ai.azure.com/api/projects/my-project/openai/v1/', projectScoped: true
    });
  });
}
for (const endpoint of [
  'http://test.openai.azure.com', 'https://example.com', 'https://127.0.0.1',
  'https://test.openai.azure.com.evil.example', 'https://evil.test.openai.azure.com',
  'https://user:pass@test.openai.azure.com', 'https://test.openai.azure.com:8443',
  'https://test.openai.azure.com?api-version=preview', 'https://test.openai.azure.com/#fragment',
  'https://test.openai.azure.com/responses/resp_test', 'https://test.openai.azure.com/api/projects/test',
  'https://test.services.ai.azure.com/api/projects/a%2Fb', 'not-a-url'
]) {
  test(`reject unsafe or unsupported endpoint: ${endpoint}`, () => {
    rejectsInvalid(() => resolveTarget({ kind: 'endpoint', endpoint }), /Endpoint|Only|Use/);
  });
}

test('validate names, IDs, operation and object input', () => {
  rejectsInvalid(() => prepareRequest(null), /object/);
  rejectsInvalid(() => prepareRequest(payload({ target: { kind: 'account', account: '$(whoami)' } })), /account name/);
  rejectsInvalid(() => prepareRequest(payload({ responseId: '../other' })), /Response ID/);
  rejectsInvalid(() => prepareRequest(payload({ operation: 'delete' })), /Choose/);
  rejectsInvalid(() => resolveTarget({ kind: 'other' }), /Choose/);
  rejectsInvalid(() => resolveTarget({ kind: 'project', account: 'test', project: '../test' }), /Project/);
});

test('GET response sends repeated include[] parameters and explicit account version', () => {
  const request = prepareRequest(payload({ options: { apiVersion: 'v1', include: ['reasoning.encrypted_content', 'message.output_text.logprobs'] } }));
  const url = new URL(request.url);
  assert.equal(url.pathname, '/openai/v1/responses/resp_test');
  assert.equal(url.searchParams.get('api-version'), 'v1');
  assert.deepEqual(url.searchParams.getAll('include[]'), ['reasoning.encrypted_content', 'message.output_text.logprobs']);
});

test('v1 is the default route without a version query', () => {
  assert.equal(prepareRequest(payload()).url, 'https://test-account.openai.azure.com/openai/v1/responses/resp_test');
});

test('input pagination defaults and cursor direction are preserved', () => {
  const defaults = new URL(prepareRequest(payload({ operation: 'input-items' })).url);
  assert.equal(defaults.searchParams.get('limit'), '20');
  assert.equal(defaults.searchParams.get('order'), 'desc');
  for (const cursor of ['after', 'before']) {
    const url = new URL(prepareRequest(payload({ operation: 'input-items', options: { limit: 100, order: 'asc', [cursor]: 'msg_123' } })).url);
    assert.equal(url.pathname, '/openai/v1/responses/resp_test/input_items');
    assert.equal(url.searchParams.get(cursor), 'msg_123');
    assert.equal(url.searchParams.get('limit'), '100');
    assert.equal(url.searchParams.get('order'), 'asc');
  }
});

test('validate exact pagination boundaries, cursors, include and versions', () => {
  for (const limit of [0, 101, 1.5, '20', null]) {
    if (limit === null) continue;
    rejectsInvalid(() => prepareRequest(payload({ operation: 'input-items', options: { limit } })), /1 to 100/);
  }
  assert.ok(prepareRequest(payload({ operation: 'input-items', options: { limit: 1 } })).url.includes('limit=1'));
  rejectsInvalid(() => prepareRequest(payload({ operation: 'input-items', options: { after: 'a', before: 'b' } })), /not both/);
  rejectsInvalid(() => prepareRequest(payload({ operation: 'input-items', options: { order: 'invalid' } })), /Order/);
  rejectsInvalid(() => prepareRequest(payload({ operation: 'input-items', options: { after: 'a/b' } })), /cursor/);
  rejectsInvalid(() => prepareRequest(payload({ options: { include: 'invalid' } })), /array/);
  rejectsInvalid(() => prepareRequest(payload({ options: { include: ['x&stream=true'] } })), /field names/);
  rejectsInvalid(() => prepareRequest(payload({ options: { apiVersion: '2024-01-01' } })), /version/);
});

test('project authentication and version are enforced', () => {
  const target = { kind: 'project', account: 'test', project: 'demo' };
  rejectsInvalid(() => prepareRequest(payload({ target })), /Entra ID/);
  rejectsInvalid(() => prepareRequest(payload({ target, auth: { mode: 'cli', audience: 'https://cognitiveservices.azure.com' } })), /audience/);
  rejectsInvalid(() => prepareRequest(payload({ target, auth: { mode: 'cli' }, options: { apiVersion: 'v1' } })), /without an api-version/);
  const request = prepareRequest(payload({ target, auth: { mode: 'cli' } }));
  assert.equal(request.auth.audience, 'https://ai.azure.com');
  assert.equal(request.url, 'https://test.services.ai.azure.com/api/projects/demo/openai/v1/responses/resp_test');
});

test('reject unsafe tenants and unsupported token audiences', () => {
  for (const tenant of ['x & whoami', 'x;whoami', '"injection"', '-option', '%PATH%']) {
    rejectsInvalid(() => prepareRequest(payload({ auth: { mode: 'cli', tenant } })), /Tenant/);
  }
  rejectsInvalid(() => prepareRequest(payload({ auth: { mode: 'cli', audience: 'https://example.com' } })), /audience/);
});

test('backend only calls GET, keeps credentials out of metadata and blocks redirects', async () => {
  let captured;
  const result = await executeRequest(payload(), {
    fetchImpl: async (url, options) => { captured = { url, options }; return upstream(); }
  });
  assert.equal(captured.options.method, 'GET');
  assert.equal(captured.options.headers['api-key'], 'test-secret-key');
  assert.equal(captured.options.headers.Authorization, undefined);
  assert.equal(captured.options.redirect, 'error');
  assert.ok(captured.options.signal instanceof AbortSignal);
  assert.equal(result.requestId, 'req_test');
  assert.equal(result.data.id, 'resp_test');
  assert.ok(!JSON.stringify(result).includes('test-secret-key'));
});

test('environment key fallback and explicit key precedence', async () => {
  const keys = [];
  const dependencies = {
    env: { AZURE_OPENAI_API_KEY: 'env-test-key' },
    fetchImpl: async (_url, options) => { keys.push(options.headers['api-key']); return upstream(); }
  };
  await executeRequest(payload({ auth: { mode: 'key', apiKey: '' } }), dependencies);
  await executeRequest(payload(), dependencies);
  assert.deepEqual(keys, ['env-test-key', 'test-secret-key']);
  await assert.rejects(executeRequest(payload({ auth: { mode: 'key' } }), { env: {} }), /Enter an API key/);
  await assert.rejects(executeRequest(payload({ auth: { mode: 'key', apiKey: 'line\nbreak' } })), /control characters/);
});

test('Entra token is acquired with selected tenant/audience and is never returned', async () => {
  let tokenArgs;
  const result = await executeRequest(payload({ auth: { mode: 'cli', audience: 'https://cognitiveservices.azure.com' } }), {
    env: { AZURE_TENANT_ID: 'test.onmicrosoft.com' },
    tokenProvider: async args => { tokenArgs = args; return 'fake-cli-token'; },
    fetchImpl: async (_url, options) => {
      assert.equal(options.headers.Authorization, 'Bearer fake-cli-token');
      assert.equal(options.headers['api-key'], undefined);
      return upstream({ ...responseData, metadata: { echo: 'fake-cli-token' } });
    }
  });
  assert.deepEqual(tokenArgs, { audience: 'https://cognitiveservices.azure.com', tenant: 'test.onmicrosoft.com' });
  assert.equal(result.data.metadata.echo, '[REDACTED]');
  assert.ok(!JSON.stringify(result).includes('fake-cli-token'));
});

test('CLI launch is bounded and returns only the token', async () => {
  let invocation;
  assert.equal(await acquireCliToken({ audience: 'https://ai.azure.com', tenant: 'tenant.example' }, async (...args) => {
    invocation = args;
    return { stdout: 'token-for-test\r\n' };
  }), 'token-for-test');
  assert.equal(invocation[2].timeout, 30000);
  assert.ok(invocation[1].join(' ').includes('--tenant tenant.example'));
  await assert.rejects(acquireCliToken({ audience: 'https://ai.azure.com' }, async () => { throw Object.assign(new Error('CLI error'), { stderr: 'Please run az login.' }); }),
    error => error.status === 401 && /az login/.test(error.message));
  await assert.rejects(acquireCliToken({ audience: 'https://ai.azure.com' }, async () => ({ stdout: '' })), /valid access token/);
});

test('Azure errors preserve status, body, request ID, retry header and helpful hint', async () => {
  for (const status of [401, 403, 404, 429, 500]) {
    await assert.rejects(executeRequest(payload(), {
      fetchImpl: async () => upstream({ error: { code: 'test_error', message: 'Failure test-secret-key' } }, status, { 'Retry-After': '12' })
    }), error => {
      assert.equal(error.status, status);
      assert.equal(error.details.status, status);
      assert.equal(error.details.requestId, 'req_test');
      assert.equal(error.details.retryAfter, '12');
      assert.equal(error.details.data.error.message, 'Failure [REDACTED]');
      assert.ok(error.details.hint);
      assert.ok(!JSON.stringify(error).includes('test-secret-key'));
      return true;
    });
  }
});

test('transport, timeout, non-JSON, empty and oversized replies are explicit failures', async () => {
  await assert.rejects(executeRequest(payload(), { fetchImpl: async () => { throw new Error('test network error'); } }), error => error.status === 502 && error.code === 'azure_connection_failed');
  await assert.rejects(executeRequest(payload(), { fetchImpl: async () => { throw Object.assign(new Error('timeout'), { name: 'TimeoutError' }); } }), error => error.status === 504);
  await assert.rejects(executeRequest(payload(), { fetchImpl: async () => new Response('<html>bad gateway</html>', { status: 502 }) }), /non-JSON/);
  await assert.rejects(executeRequest(payload(), { fetchImpl: async () => new Response('') }), /empty response/);
  await assert.rejects(executeRequest(payload(), { fetchImpl: async () => new Response('x'.repeat(16 * 1024 * 1024 + 1)) }), /16 MiB/);
});

test('input-item shape is checked without losing other returned fields', async () => {
  const result = await executeRequest(payload({ operation: 'input-items' }), { fetchImpl: async () => upstream(inputPage) });
  assert.deepEqual(result.data, inputPage);
  await assert.rejects(executeRequest(payload({ operation: 'input-items' }), { fetchImpl: async () => upstream({ data: [], has_more: 'yes' }) }), /does not match/);
  await assert.rejects(executeRequest(payload(), { fetchImpl: async () => upstream({ message: 'not a response' }) }), /does not match/);
});

test('conversation routes use the documented project scope without requiring a response ID', () => {
  const base = 'https://test-account.services.ai.azure.com/api/projects/demo/openai/v1/';
  assert.equal(prepareRequest(conversationPayload('conversations', { conversationId: undefined })).url, `${base}conversations?limit=20&order=desc`);
  assert.equal(prepareRequest(conversationPayload('conversation')).url, `${base}conversations/conv_test`);
  assert.equal(prepareRequest(conversationPayload('conversation-items')).url, `${base}conversations/conv_test/items?limit=20&order=desc`);
});

test('conversation listing requires project scope, but known conversations work at account scope', () => {
  const account = { target: { kind: 'account', account: 'test' }, auth: { mode: 'key', apiKey: 'test-key' } };
  rejectsInvalid(() => prepareRequest(conversationPayload('conversations', account)), /project/i);
  assert.equal(prepareRequest(conversationPayload('conversation', account)).url, 'https://test.openai.azure.com/openai/v1/conversations/conv_test');
  assert.ok(prepareRequest(conversationPayload('conversation-items', account)).url.includes('/conversations/conv_test/items?'));
  const pasted = { kind: 'endpoint', endpoint: 'https://test.services.ai.azure.com/api/projects/demo/openai/v1/' };
  assert.ok(prepareRequest(conversationPayload('conversations', { target: pasted })).url.includes('/projects/demo/openai/v1/conversations?'));
});

test('conversation IDs are validated separately from response IDs', () => {
  for (const operation of ['conversation', 'conversation-items']) {
    for (const conversationId of ['', '../other', 'conv_id?limit=999', undefined]) {
      rejectsInvalid(() => prepareRequest(conversationPayload(operation, { conversationId })), /Conversation ID/);
    }
    assert.ok(prepareRequest(conversationPayload(operation, { responseId: '../ignored' })).url.includes('conv_test'));
  }
});

test('conversation list and item pagination validate exact boundaries and both cursor directions', () => {
  for (const operation of ['conversations', 'conversation-items']) {
    for (const cursor of ['after', 'before']) {
      for (const limit of [1, 100]) {
        const url = new URL(prepareRequest(conversationPayload(operation, { options: { limit, order: 'asc', [cursor]: 'item_previous' } })).url);
        assert.equal(url.searchParams.get('limit'), String(limit));
        assert.equal(url.searchParams.get('order'), 'asc');
        assert.equal(url.searchParams.get(cursor), 'item_previous');
      }
    }
    for (const limit of [0, 101, 2.5, '20']) {
      rejectsInvalid(() => prepareRequest(conversationPayload(operation, { options: { limit } })), /1 to 100/);
    }
    rejectsInvalid(() => prepareRequest(conversationPayload(operation, { options: { after: 'a', before: 'b' } })), /not both/);
    rejectsInvalid(() => prepareRequest(conversationPayload(operation, { options: { apiVersion: 'v1' } })), /without an api-version/);
  }
});

test('conversation operations use GET and Entra with complete metadata and item bodies preserved', async () => {
  const fixtures = { conversations: conversationPage, conversation: conversationData, 'conversation-items': conversationItems };
  for (const [operation, fixture] of Object.entries(fixtures)) {
    const result = await executeRequest(conversationPayload(operation), {
      tokenProvider: async ({ audience }) => { assert.equal(audience, 'https://ai.azure.com'); return 'fake-conversation-token'; },
      fetchImpl: async (_url, options) => {
        assert.equal(options.method, 'GET');
        assert.equal(options.headers.Authorization, 'Bearer fake-conversation-token');
        assert.equal(options.redirect, 'error');
        return upstream(fixture);
      }
    });
    assert.deepEqual(result.data, fixture);
    assert.equal(result.requestId, 'req_test');
    assert.ok(!JSON.stringify(result).includes('fake-conversation-token'));
  }
});

test('conversation schemas reject malformed success bodies and allow empty lists', async () => {
  const dependencies = data => ({ tokenProvider: async () => 'fake-token', fetchImpl: async () => upstream(data) });
  for (const operation of ['conversations', 'conversation-items']) {
    for (const data of [{}, { data: [], has_more: 'true' }, { data: null, has_more: false }]) {
      await assert.rejects(executeRequest(conversationPayload(operation), dependencies(data)), /does not match/);
    }
    const data = { object: 'list', data: [], first_id: null, last_id: null, has_more: false };
    assert.deepEqual((await executeRequest(conversationPayload(operation), dependencies(data))).data, data);
  }
  await assert.rejects(executeRequest(conversationPayload('conversation'), dependencies({ object: 'response', id: 'resp_test' })), /does not match/);
  for (const item of [null, {}, { id: '../invalid' }]) {
    await assert.rejects(executeRequest(conversationPayload(), dependencies({ data: [item], has_more: false })), /does not match/);
  }
});

test('conversation 404 errors identify conversation scope rather than response storage', async () => {
  await assert.rejects(executeRequest(conversationPayload('conversation-items'), {
    tokenProvider: async () => 'fake-token',
    fetchImpl: async () => upstream({ error: { message: 'Conversation not found' } }, 404)
  }), error => {
    assert.equal(error.status, 404);
    assert.equal(error.details.data.error.message, 'Conversation not found');
    assert.match(error.details.hint, /conversation/i);
    assert.doesNotMatch(error.details.hint, /unstored responses/);
    return true;
  });
});

test('all inline browser scripts are syntactically valid', async () => {
  const html = await readFile(new URL('./index.html', import.meta.url), 'utf8');
  const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)];
  assert.equal(scripts.length, 2);
  for (const script of scripts) assert.doesNotThrow(() => new Script(script[1]));
  assert.ok(!/localStorage|sessionStorage|<script\s+src=/.test(html));
});

async function localServer(t, execute = async () => ({ status: 200, data: responseData })) {
  const logs = [];
  const server = await createLabServer({ execute, logger: { warn: line => logs.push(line), error: line => logs.push(line) } });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;
  const headers = { Origin: base, 'Content-Type': 'application/json', 'X-Lab-Request': '1' };
  return { base, headers, logs };
}

test('local HTTP server serves UI and health with no-store and CSP', async t => {
  const { base } = await localServer(t);
  const response = await fetch(`${base}/?clawpilotTheme=light`);
  assert.equal(response.status, 200);
  const html = await response.text();
  assert.ok(html.includes('Responses Lab'));
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.ok(response.headers.get('content-security-policy').includes("'sha256-"));
  for (const script of html.matchAll(/<script>([\s\S]*?)<\/script>/g)) {
    const hash = createHash('sha256').update(script[1].replace(/\r\n?/g, '\n')).digest('base64');
    assert.ok(response.headers.get('content-security-policy').includes(`'sha256-${hash}'`));
  }
  assert.ok(response.headers.get('content-security-policy').includes("frame-ancestors 'none'"));
  assert.deepEqual(await (await fetch(`${base}/api/health`)).json(), { status: 'ok', readOnly: true });
  assert.equal((await fetch(`${base}/.env`)).status, 404);
  assert.equal((await fetch(`${base}/lab.mjs`)).status, 404);
});

test('local HTTP boundary rejects cross-origin requests, bad hosts, bad JSON and unsupported content', async t => {
  let calls = 0;
  const { base, headers } = await localServer(t, async () => { calls++; return {}; });
  const request = (overrides = {}) => fetch(`${base}/api/execute`, { method: 'POST', headers, body: JSON.stringify(payload()), ...overrides });
  assert.equal((await request({ headers: { ...headers, Origin: 'https://example.com' } })).status, 403);
  const badHostStatus = await new Promise((resolve, reject) => {
    http.get(`${base}/api/health`, { headers: { Host: 'attacker.example' } }, response => {
      response.resume();
      resolve(response.statusCode);
    }).on('error', reject);
  });
  assert.equal(badHostStatus, 403);
  assert.equal((await request({ headers: { ...headers, 'X-Lab-Request': '' } })).status, 403);
  assert.equal((await request({ headers: { ...headers, 'Content-Type': 'text/plain' } })).status, 415);
  assert.equal((await request({ body: 'not json' })).status, 400);
  assert.equal(calls, 0);
});

test('oversized local JSON is rejected with HTTP 413, not a disconnected socket', async t => {
  const { base, headers } = await localServer(t);
  for (const size of [33 * 1024, 128 * 1024]) {
    const response = await fetch(`${base}/api/execute`, { method: 'POST', headers, body: JSON.stringify({ text: 'x'.repeat(size) }) });
    assert.equal(response.status, 413);
    assert.equal((await response.json()).error.code, 'request_too_large');
  }
});

test('HTTP integration preserves both operations and surfaces Azure errors', async t => {
  const urls = [];
  const { base, headers, logs } = await localServer(t, body => executeRequest(body, {
    fetchImpl: async url => {
      urls.push(url);
      if (url.includes('resp_missing')) return upstream({ error: { message: 'Not found' } }, 404);
      return upstream(url.includes('input_items') ? inputPage : responseData);
    }
  }));
  for (const operation of ['response', 'input-items']) {
    const response = await fetch(`${base}/api/execute`, { method: 'POST', headers, body: JSON.stringify(payload({ operation })) });
    assert.equal(response.status, 200);
    const result = await response.json();
    assert.deepEqual(result.data, operation === 'response' ? responseData : inputPage);
  }
  const failed = await fetch(`${base}/api/execute`, { method: 'POST', headers, body: JSON.stringify(payload({ responseId: 'resp_missing' })) });
  assert.equal(failed.status, 404);
  const error = await failed.json();
  assert.equal(error.status, 404);
  assert.equal(error.error.code, 'azure_api_error');
  assert.equal(error.data.error.message, 'Not found');
  assert.equal(error.requestId, 'req_test');
  assert.ok(urls[1].endsWith('/input_items?limit=20&order=desc'));
  assert.ok(logs[0].includes('azure_api_error'));
});

test('conversation HTTP workflow lists, selects and pages items without any response ID', async t => {
  const calls = [];
  const { base, headers } = await localServer(t, body => executeRequest(body, {
    tokenProvider: async () => 'fake-token',
    fetchImpl: async (url, options) => {
      calls.push({ url, method: options.method });
      const path = new URL(url).pathname;
      return upstream(path.endsWith('/items') ? conversationItems
        : path.endsWith('/conv_test') ? conversationData : conversationPage);
    }
  }));
  for (const operation of ['conversations', 'conversation', 'conversation-items']) {
    const options = operation === 'conversation-items' ? { limit: 100, order: 'asc', after: 'msg_previous' } : {};
    const response = await fetch(`${base}/api/execute`, { method: 'POST', headers, body: JSON.stringify(conversationPayload(operation, { options })) });
    assert.equal(response.status, 200);
    const result = await response.json();
    assert.deepEqual(result.data, operation === 'conversations' ? conversationPage : operation === 'conversation' ? conversationData : conversationItems);
  }
  assert.ok(calls.every(call => call.method === 'GET'));
  assert.equal(calls[0].url, 'https://test-account.services.ai.azure.com/api/projects/demo/openai/v1/conversations?limit=20&order=desc');
  assert.ok(calls[2].url.endsWith('/conv_test/items?limit=100&order=asc&after=msg_previous'));
});
