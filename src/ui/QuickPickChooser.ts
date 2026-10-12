import * as path from 'path';
import * as vscode from 'vscode';
import type { Branch, FlowStep, FunctionRef } from '../flow/FlowTypes';
import type { CallOption, UserChooser } from '../flow/FlowNavigator';

interface Item<T> extends vscode.QuickPickItem {
  value: T;
}

/** The "what happens next?" decisions, asked with native Quick Picks. Escape cancels. */
export class QuickPickChooser implements UserChooser {
  async chooseBranch(step: FlowStep, branches: readonly Branch[], previousChoice?: string): Promise<Branch | undefined> {
    const items: Item<Branch>[] = branches.map((b) => ({
      label: b.label,
      description: b.id === previousChoice ? 'last choice' : undefined,
      value: b,
    }));
    const picked = await vscode.window.showQuickPick(items, {
      title: `Code Flow: choose a path — ${step.label}`,
      placeHolder: 'Static analysis cannot know which path runs. Pick the one to explore.',
      ignoreFocusOut: true,
    });
    return picked?.value;
  }

  async chooseCall(step: FlowStep, options: readonly CallOption[]): Promise<CallOption | undefined> {
    const items: Item<CallOption>[] = options.map((o) => ({
      label: `${o.resolution.kind === 'resolved' ? '$(arrow-right)' : '$(circle-slash)'} ${o.call.text}${o.call.isNew ? ' (new)' : ''}`,
      description:
        o.resolution.kind === 'resolved'
          ? o.resolution.targets.map((t) => `${t.name} — ${path.basename(t.file)}`).join(', ')
          : 'cannot step into',
      detail: o.resolution.kind === 'unresolved' ? o.resolution.message : undefined,
      value: o,
    }));
    const picked = await vscode.window.showQuickPick(items, {
      title: `Code Flow: step into which call? — ${step.label}`,
      placeHolder: 'This step contains several calls',
      ignoreFocusOut: true,
    });
    return picked?.value;
  }

  async chooseTarget(label: string, targets: readonly FunctionRef[]): Promise<FunctionRef | undefined> {
    const items: Item<FunctionRef>[] = targets.map((t) => ({
      label: t.name,
      description: `${path.basename(t.file)}:${t.range.start.line + 1}`,
      value: t,
    }));
    const picked = await vscode.window.showQuickPick(items, {
      title: `Code Flow: \`${label}\` has several possible implementations`,
      placeHolder: 'Pick the implementation to explore',
      ignoreFocusOut: true,
    });
    return picked?.value;
  }
}
