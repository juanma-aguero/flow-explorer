/** Shared helpers for the extension-host suites (these run inside VS Code). */
import * as path from 'path';
import * as vscode from 'vscode';

export const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
export const exec = (id: string): Thenable<unknown> => vscode.commands.executeCommand(id);

export const demoFile = (name: string): string => path.resolve(__dirname, '..', '..', '..', 'examples', 'checkout-demo', 'src', name);

export async function open(file: string, needle: string): Promise<vscode.TextEditor> {
  const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(file));
  const editor = await vscode.window.showTextDocument(doc);
  const pos = doc.positionAt(doc.getText().indexOf(needle));
  editor.selection = new vscode.Selection(pos, pos);
  return editor;
}

/** Waits until the active editor shows `file` with its cursor on the line containing `text`. */
export async function expectAt(file: string, text: string, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let last = '';
  while (Date.now() < deadline) {
    const editor = vscode.window.activeTextEditor;
    if (editor && path.basename(editor.document.fileName) === path.basename(file)) {
      const line = editor.document.lineAt(editor.selection.active.line).text;
      last = `${path.basename(file)}: ${line.trim()}`;
      if (line.includes(text)) return;
    } else {
      last = `active editor is ${editor ? path.basename(editor.document.fileName) : 'none'}`;
    }
    await sleep(50);
  }
  throw new Error(`Expected cursor on a line containing "${text}" in ${path.basename(file)}; got ${last}`);
}

export const goDemo = (...parts: string[]): string => path.resolve(__dirname, '..', '..', '..', 'examples', 'go-demo', ...parts);

/** gopls loads asynchronously; wait until it can answer definition requests for the demo module. */
export async function waitForGopls(file: string, needle: string, timeoutMs = 90000): Promise<boolean> {
  const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(file));
  await vscode.window.showTextDocument(doc);
  const pos = doc.positionAt(doc.getText().indexOf(needle) + 1);
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const found = await vscode.commands.executeCommand<unknown[]>('vscode.executeDefinitionProvider', doc.uri, pos);
    if (found && found.length > 0) return true;
    await sleep(1000);
  }
  return false;
}

export type Suite = Array<[string, () => Promise<void>]>;

export async function runSuite(tests: Suite): Promise<void> {
  let failed = 0;
  for (const [name, fn] of tests) {
    try {
      await fn();
      console.log(`  ok  - ${name}`);
    } catch (error) {
      failed++;
      console.log(`  FAIL - ${name}\n         ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  if (failed > 0) throw new Error(`${failed} extension host test(s) failed`);
}
