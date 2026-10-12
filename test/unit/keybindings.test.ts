import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { ROOT } from '../helpers';

interface Keybinding { command: string; key: string; mac?: string; when?: string }
const manifest = require(`${ROOT}/package.json`) as { contributes: { keybindings: Keybinding[]; commands: Array<{ command: string }> } };
const bindings = manifest.contributes.keybindings;

describe('keybindings', () => {
  it('offers the debugger keys, scoped to an exploration and never during a debug session', () => {
    const expected: Record<string, string> = {
      f10: 'codeFlow.next',
      f11: 'codeFlow.stepInto',
      'shift+f11': 'codeFlow.stepOut',
      'shift+f5': 'codeFlow.stop',
      'alt+f10': 'codeFlow.previous',
    };
    for (const [key, command] of Object.entries(expected)) {
      const b = bindings.find((x) => x.key === key);
      assert.ok(b, `${key} is bound`);
      assert.equal(b.command, command);
      assert.match(b.when ?? '', /codeFlow\.active/, `${key} only applies during an exploration`);
      assert.match(b.when ?? '', /!inDebugMode/, `${key} never overrides the real debugger`);
    }
  });

  it('every binding is scoped to an active exploration and targets a contributed command', () => {
    const commands = new Set(manifest.contributes.commands.map((c) => c.command));
    for (const b of bindings) {
      assert.match(b.when ?? '', /codeFlow\.active/, `${b.key} must not apply outside an exploration`);
      assert.ok(commands.has(b.command), `${b.command} exists`);
    }
  });

  it('does not bind the same key twice in the same context', () => {
    const seen = new Set<string>();
    for (const b of bindings) {
      for (const k of [b.key, b.mac].filter(Boolean) as string[]) {
        const id = `${k}|${b.when}`;
        assert.ok(!seen.has(id), `duplicate ${id}`);
        seen.add(id);
      }
    }
  });
});
