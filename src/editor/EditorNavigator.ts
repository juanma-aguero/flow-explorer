import * as vscode from 'vscode';
import type { SourceRange } from '../flow/FlowTypes';

export function toVsRange(range: SourceRange): vscode.Range {
  return new vscode.Range(range.start.line, range.start.character, range.end.line, range.end.character);
}

/** Opens files and reveals ranges using the regular editor. Never replaces or wraps the editor. */
export class EditorNavigator {
  async reveal(range: SourceRange): Promise<vscode.TextEditor | undefined> {
    try {
      const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(range.file));
      const vsRange = toVsRange(range);
      const editor = await vscode.window.showTextDocument(doc, {
        preview: true,
        preserveFocus: false,
        selection: new vscode.Range(vsRange.start, vsRange.start),
      });
      editor.revealRange(vsRange, vscode.TextEditorRevealType.InCenterIfOutsideViewport);
      return editor;
    } catch (error) {
      void vscode.window.showWarningMessage(`Code Flow: could not open ${range.file}: ${error instanceof Error ? error.message : String(error)}`);
      return undefined;
    }
  }
}
