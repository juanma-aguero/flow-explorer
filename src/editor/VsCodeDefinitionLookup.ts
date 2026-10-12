import * as vscode from 'vscode';
import type { DefinitionLocation, DefinitionLookup } from '../analysis/go/DefinitionLookup';

/**
 * Go-to-definition through VS Code's language features, i.e. whatever language server the user has for the
 * file (gopls via the Go extension). We never start or configure a server ourselves.
 */
export class VsCodeDefinitionLookup implements DefinitionLookup {
  async definitions(file: string, line: number, character: number): Promise<DefinitionLocation[] | undefined> {
    const result = await vscode.commands.executeCommand<Array<vscode.Location | vscode.LocationLink> | undefined>(
      'vscode.executeDefinitionProvider',
      vscode.Uri.file(file),
      new vscode.Position(line, character),
    );
    if (!result) return undefined;
    return result.map((r) => {
      if ('targetUri' in r) {
        const start = (r.targetSelectionRange ?? r.targetRange).start;
        return { file: r.targetUri.fsPath.replace(/\\/g, '/'), line: start.line, character: start.character };
      }
      return { file: r.uri.fsPath.replace(/\\/g, '/'), line: r.range.start.line, character: r.range.start.character };
    });
  }
}
