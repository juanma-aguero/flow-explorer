import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';
import { ExplanationService } from '../../src/ai/ExplanationService';
import { AnthropicProvider } from '../../src/ai/AnthropicProvider';
import { OpenAIProvider } from '../../src/ai/OpenAIProvider';
import { defaultProviderFactory } from '../../src/ai/providerFactory';
import type { StepContext } from '../../src/flow/FlowTypes';

/** Exercises the real provider packages against a stubbed `fetch`: no network, no real keys. */
const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

interface Captured {
  url: string;
  headers: Record<string, string>;
  body: string;
}

function stubFetch(status: number, payload: unknown): Captured[] {
  const calls: Captured[] = [];
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    calls.push({
      url: String(input),
      headers: Object.fromEntries(new Headers(init?.headers).entries()),
      body: String(init?.body ?? ''),
    });
    return new Response(JSON.stringify(payload), { status, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
  return calls;
}

const anthropicOk = {
  id: 'msg_1', type: 'message', role: 'assistant', model: 'claude-test', stop_reason: 'end_turn', stop_sequence: null,
  content: [{ type: 'text', text: 'Anthropic says hi.' }],
  usage: { input_tokens: 3, output_tokens: 4 },
};
const openaiOk = {
  id: 'resp_1', object: 'response', created_at: 1, status: 'completed', model: 'gpt-test',
  output: [{ type: 'message', id: 'm1', status: 'completed', role: 'assistant', content: [{ type: 'output_text', text: 'OpenAI says hi.', annotations: [] }] }],
  usage: { input_tokens: 3, output_tokens: 4, total_tokens: 7 },
};

describe('real providers over a stubbed fetch', () => {
  it('Anthropic: calls the Messages API with the key and the configured model', async () => {
    const calls = stubFetch(200, anthropicOk);
    const text = await new AnthropicProvider('ak-test-123', 'claude-test').generate({ system: 'SYS', prompt: 'USER' });
    assert.equal(text, 'Anthropic says hi.');
    assert.match(calls[0].url, /^https:\/\/api\.anthropic\.com\/v1\/messages/);
    assert.equal(calls[0].headers['x-api-key'], 'ak-test-123');
    const body = JSON.parse(calls[0].body);
    assert.equal(body.model, 'claude-test');
    assert.match(JSON.stringify(body), /SYS/);
    assert.match(JSON.stringify(body), /USER/);
  });

  it('OpenAI: calls the API with the bearer key and the configured model', async () => {
    const calls = stubFetch(200, openaiOk);
    const text = await new OpenAIProvider('sk-test-123456789', 'gpt-test').generate({ system: 'SYS', prompt: 'USER' });
    assert.equal(text, 'OpenAI says hi.');
    assert.match(calls[0].url, /^https:\/\/api\.openai\.com\/v1\//);
    assert.equal(calls[0].headers['authorization'], 'Bearer sk-test-123456789');
    assert.equal(JSON.parse(calls[0].body).model, 'gpt-test');
  });

  it('turns an auth failure into an error outcome that never contains the key', async () => {
    const key = 'sk-live-ABCDEFGHIJKLMNOP';
    stubFetch(401, { error: { message: `Incorrect API key provided: ${key}`, type: 'invalid_request_error' } });
    const ctx: StepContext = {
      flowName: 'f', functionName: 'f', file: '/x/f.ts', callStack: ['f'], stepKind: 'call', stepText: 'g();',
      functionSource: 'function f() {\n  g();\n}', stepLineInFunction: 1, branches: [], calls: [],
    };
    const service = new ExplanationService(
      { read: () => ({ enabled: true, provider: 'openai', models: { openai: 'gpt-test', anthropic: 'c' }, autoExplain: false, maxContextChars: 6000 }) },
      { get: async () => key, set: async () => undefined, delete: async () => undefined },
      defaultProviderFactory,
    );
    const outcome = await service.explain(ctx);
    assert.equal(outcome.status, 'error');
    assert.ok(outcome.status === 'error' && !outcome.message.includes(key));
  });
});
