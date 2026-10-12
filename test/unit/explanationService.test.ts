import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { MockLanguageModelV2 } from 'ai/test';
import { LanguageModelProvider, type AIProvider, type GenerateRequest, type ProviderFactory } from '../../src/ai/AIProvider';
import { ExplanationService, redact } from '../../src/ai/ExplanationService';
import { buildPrompt, languageOf, windowSource } from '../../src/ai/prompt';
import type { AISettings, ApiKeyStore, ProviderId } from '../../src/config/types';
import type { StepContext } from '../../src/flow/FlowTypes';

const baseSettings: AISettings = {
  enabled: true,
  provider: 'openai',
  models: { openai: 'test-openai-model', anthropic: 'test-anthropic-model' },
  autoExplain: false,
  maxContextChars: 6000,
};

class MemoryKeys implements ApiKeyStore {
  constructor(private readonly keys: Partial<Record<ProviderId, string>> = {}) {}
  async get(p: ProviderId) { return this.keys[p]; }
  async set(p: ProviderId, k: string) { this.keys[p] = k; }
  async delete(p: ProviderId) { delete this.keys[p]; }
}

class FakeProviders implements ProviderFactory {
  readonly created: Array<{ id: ProviderId; apiKey: string; model: string }> = [];
  readonly requests: GenerateRequest[] = [];
  constructor(private readonly behaviour: (req: GenerateRequest) => Promise<string> = async () => 'Mocked explanation.') {}
  create(id: ProviderId, apiKey: string, model: string): AIProvider {
    this.created.push({ id, apiKey, model });
    return { id, model, generate: (req) => { this.requests.push(req); return this.behaviour(req); } };
  }
}

const ctx: StepContext = {
  flowName: 'processCheckout',
  functionName: 'processCheckout',
  file: '/proj/src/checkout.service.ts',
  callStack: ['processCheckout'],
  stepKind: 'assignment',
  stepText: 'const discount = await applyDiscount(total, cart.customer);',
  functionSource: 'async function processCheckout() {\n  const total = 1;\n  const discount = await applyDiscount(total, cart.customer);\n}',
  stepLineInFunction: 2,
  branches: [],
  calls: [{ text: 'applyDiscount', resolvedTo: 'applyDiscount' }],
};

const service = (settings: Partial<AISettings>, keys: MemoryKeys, providers: ProviderFactory) =>
  new ExplanationService({ read: () => ({ ...baseSettings, ...settings }) }, keys, providers);

describe('ExplanationService', () => {
  it('reports missing configuration without calling any provider', async () => {
    const providers = new FakeProviders();
    const svc = service({}, new MemoryKeys(), providers);
    assert.deepEqual(await svc.explain(ctx), { status: 'missing-key', provider: 'openai' });
    assert.deepEqual(await svc.status(), { state: 'missing-key', provider: 'openai', model: 'test-openai-model' });
    assert.equal(providers.created.length, 0, 'nothing was constructed or sent');
  });

  it('never sends code when AI is disabled, even with a key', async () => {
    const providers = new FakeProviders();
    const svc = service({ enabled: false }, new MemoryKeys({ openai: 'sk-secret-key-123' }), providers);
    assert.deepEqual(await svc.explain(ctx), { status: 'disabled' });
    assert.deepEqual(await svc.status(), { state: 'disabled' });
    assert.equal(providers.created.length, 0);
  });

  it('returns the provider text and uses the configured provider, key and model', async () => {
    const providers = new FakeProviders();
    const svc = service({ provider: 'anthropic' }, new MemoryKeys({ anthropic: 'ak-1', openai: 'ok-1' }), providers);
    const result = await svc.explain(ctx);
    assert.equal(result.status, 'ok');
    if (result.status === 'ok') {
      assert.equal(result.text, 'Mocked explanation.');
      assert.equal(result.provider, 'anthropic');
      assert.equal(result.model, 'test-anthropic-model');
    }
    assert.deepEqual(providers.created, [{ id: 'anthropic', apiKey: 'ak-1', model: 'test-anthropic-model' }]);
  });

  it('caches identical requests', async () => {
    const providers = new FakeProviders();
    const svc = service({}, new MemoryKeys({ openai: 'k' }), providers);
    await svc.explain(ctx);
    const second = await svc.explain(ctx);
    assert.equal(providers.requests.length, 1);
    assert.equal(second.status === 'ok' && second.fromCache, true);
  });

  it('redacts the API key from provider errors', async () => {
    const key = 'sk-proj-ABCDEF1234567890';
    const providers = new FakeProviders(async () => { throw new Error(`401 Incorrect API key provided: ${key}`); });
    const result = await service({}, new MemoryKeys({ openai: key }), providers).explain(ctx);
    assert.equal(result.status, 'error');
    assert.ok(result.status === 'error' && !result.message.includes(key) && result.message.includes('***'));
  });

  it('reports cancellation instead of an error', async () => {
    const controller = new AbortController();
    const providers = new FakeProviders(async () => { controller.abort(); throw new Error('aborted'); });
    const result = await service({}, new MemoryKeys({ openai: 'k' }), providers).explain(ctx, controller.signal);
    assert.deepEqual(result, { status: 'cancelled' });
  });

  it('tests the connection with a fixed prompt that contains no user code', async () => {
    const providers = new FakeProviders();
    const svc = service({}, new MemoryKeys({ openai: 'k' }), providers);
    assert.deepEqual(await svc.testConnection(), { ok: true, provider: 'openai', model: 'test-openai-model' });
    assert.ok(!providers.requests[0].prompt.includes('applyDiscount'));

    const none = await service({}, new MemoryKeys(), new FakeProviders()).testConnection();
    assert.equal(none.ok, false);
  });
});

describe('prompt building', () => {
  it('sends only the step, the enclosing function and static facts', async () => {
    const built = buildPrompt(ctx, 6000);
    assert.match(built.prompt, /CURRENT STEP:\nconst discount = await applyDiscount/);
    assert.match(built.prompt, /File: checkout\.service\.ts/);
    assert.ok(!built.prompt.includes('/proj/src'), 'absolute paths are not sent');
    assert.match(built.system, /Never invent runtime values/);
  });

  it('lists the possible paths for branching steps instead of picking one', async () => {
    const built = buildPrompt({ ...ctx, branches: ['if branch', 'else branch'] }, 6000);
    assert.match(built.prompt, /cannot know which path is taken/);
  });

  it('windows long functions around the step and respects the budget', async () => {
    const lines = Array.from({ length: 200 }, (_, i) => `  const v${i} = ${i};`);
    const source = ['function big() {', ...lines, '}'].join('\n');
    const out = windowSource(source, 100, 600);
    assert.ok(out.length <= 700, `window ${out.length}`);
    assert.ok(out.startsWith('function big() {'));
    assert.ok(out.includes('const v99 = 99;'), 'keeps the lines around the step (line index 100 = v99)');
    assert.ok(out.includes('lines omitted'));
    assert.ok(!out.includes('const v10 ='));
  });

  it('returns short functions untouched', async () => {
    assert.equal(windowSource('a\nb', 0, 100), 'a\nb');
  });

  it('names the language of the file in the system prompt', () => {
    assert.equal(languageOf('/a/b.go'), 'Go');
    assert.equal(languageOf('/a/b.tsx'), 'TypeScript');
    assert.equal(languageOf('/a/b.mjs'), 'JavaScript');
    assert.match(buildPrompt({ ...ctx, file: '/proj/pricing.go' }, 6000).system, /explain Go code/);
    assert.match(buildPrompt(ctx, 6000).system, /explain TypeScript code/);
  });

  it('redacts key-shaped tokens', async () => {
    assert.equal(redact('bad key sk-ant-abcdefgh1234 here'), 'bad key *** here');
  });
});

describe('Vercel AI SDK provider wrapper', () => {
  it('returns trimmed model text and forwards system + prompt', async () => {
    let seen: unknown;
    const model = new MockLanguageModelV2({
      doGenerate: async (options) => {
        seen = options.prompt;
        return {
          content: [{ type: 'text', text: '  It computes the discount.  ' }],
          finishReason: 'stop',
          usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
          warnings: [],
        };
      },
    });
    const provider = new LanguageModelProvider('openai', 'mock', model);
    const text = await provider.generate({ system: 'SYS', prompt: 'USER' });
    assert.equal(text, 'It computes the discount.');
    assert.match(JSON.stringify(seen), /SYS/);
    assert.match(JSON.stringify(seen), /USER/);
  });
});
