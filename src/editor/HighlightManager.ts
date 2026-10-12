import * as vscode from 'vscode';
import type { FlowSnapshot } from '../flow/FlowTypes';
import { toVsRange } from './EditorNavigator';

const sameFile = (a: string, b: string): boolean =>
  process.platform === 'linux' ? a === b : a.toLowerCase() === b.toLowerCase();

/** Highlights the current step (and the call sites waiting on the stack) with TextEditorDecorationTypes. */
export class HighlightManager implements vscode.Disposable {
  private readonly current = vscode.window.createTextEditorDecorationType({
    backgroundColor: new vscode.ThemeColor('codeFlow.currentStepBackground'),
    border: '1px solid',
    borderColor: new vscode.ThemeColor('codeFlow.currentStepBorder'),
    borderRadius: '3px',
    overviewRulerColor: new vscode.ThemeColor('codeFlow.currentStepBorder'),
    overviewRulerLane: vscode.OverviewRulerLane.Center,
  });
  private readonly caller = vscode.window.createTextEditorDecorationType({
    backgroundColor: new vscode.ThemeColor('codeFlow.callerBackground'),
    isWholeLine: true,
  });
  private snapshot: FlowSnapshot | undefined;
  private readonly subscription: vscode.Disposable;

  constructor() {
    // Editors can be created/reused after navigation; keep their decorations in sync.
    this.subscription = vscode.window.onDidChangeVisibleTextEditors(() => this.apply());
  }

  update(snapshot: FlowSnapshot | undefined): void {
    this.snapshot = snapshot;
    this.apply();
  }

  private apply(): void {
    for (const editor of vscode.window.visibleTextEditors) {
      const file = editor.document.uri.fsPath.replace(/\\/g, '/');
      const snap = this.snapshot;
      const current = snap && sameFile(snap.step.range.file, file) ? [toVsRange(snap.step.range)] : [];
      const callers = snap ? snap.callerRanges.filter((r) => sameFile(r.file, file)).map(toVsRange) : [];
      editor.setDecorations(this.current, current);
      editor.setDecorations(this.caller, callers);
    }
  }

  dispose(): void {
    this.subscription.dispose();
    this.current.dispose();
    this.caller.dispose();
  }
}
