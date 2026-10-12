import * as path from 'path';
import * as vscode from 'vscode';
import { ExplanationService } from './ai/ExplanationService';
import { defaultProviderFactory } from './ai/providerFactory';
import { AnalyzerRegistry, LanguageAnalyzer } from './analysis/AnalyzerRegistry';
import { GoAnalyzer } from './analysis/go/GoAnalyzer';
import { TypeScriptAnalyzer } from './analysis/TypeScriptAnalyzer';
import { ConfigurationService } from './config/ConfigurationService';
import { SecretManager } from './config/SecretManager';
import { EditorNavigator } from './editor/EditorNavigator';
import { HighlightManager } from './editor/HighlightManager';
import { VsCodeDefinitionLookup } from './editor/VsCodeDefinitionLookup';
import { FlowEngine } from './flow/FlowEngine';
import { AiCommands } from './ui/AiCommands';
import { FlowController, normalizeFsPath } from './ui/FlowController';
import { FlowSidebarProvider } from './ui/FlowSidebarProvider';
import { QuickPickChooser } from './ui/QuickPickChooser';

const SOURCE_GLOB = '**/*.{ts,tsx,mts,cts,js,jsx,mjs,cjs,go}';
const SOURCE_LANGUAGES = new Set(['typescript', 'typescriptreact', 'javascript', 'javascriptreact', 'go']);

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const config = new ConfigurationService();
  const secrets = new SecretManager(context.secrets);

  // Analysis sees unsaved edits, so what is highlighted matches what is on screen.
  const readOverlay = (file: string): string | undefined => {
    for (const doc of vscode.workspace.textDocuments) {
      if (doc.isDirty && doc.uri.scheme === 'file' && normalizeFsPath(doc.uri.fsPath) === file) return doc.getText();
    }
    return undefined;
  };
  const languages: LanguageAnalyzer[] = [
    {
      extensions: ['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs'],
      analyzer: new TypeScriptAnalyzer({ readOverlay, libDirectory: path.join(context.extensionPath, 'dist', 'typescript-lib') }),
    },
  ];
  try {
    const wasm = path.join(context.extensionPath, 'dist', 'wasm');
    const go = await GoAnalyzer.create({
      runtimeWasm: path.join(wasm, 'tree-sitter.wasm'),
      grammarWasm: path.join(wasm, 'tree-sitter-go.wasm'),
      lookup: new VsCodeDefinitionLookup(),
      readOverlay,
    });
    languages.push({ extensions: ['.go'], analyzer: go });
  } catch (error) {
    // TypeScript/JavaScript keep working; Go is simply unavailable.
    console.error('Code Flow: Go support failed to load', error);
    void vscode.window.showWarningMessage(`Code Flow: Go support could not be loaded (${error instanceof Error ? error.message : String(error)}).`);
  }
  const analyzer = new AnalyzerRegistry(languages);
  const engine = new FlowEngine(analyzer, new QuickPickChooser());
  const explanation = new ExplanationService(config, secrets, defaultProviderFactory);
  const sidebar = new FlowSidebarProvider();
  const highlights = new HighlightManager();
  const controller = new FlowController(engine, new EditorNavigator(), highlights, sidebar, explanation, config, context.globalState);
  const ai = new AiCommands(config, secrets, explanation);

  const register = (id: string, handler: () => unknown): vscode.Disposable => vscode.commands.registerCommand(id, handler);

  context.subscriptions.push(
    controller,
    highlights,
    vscode.window.registerWebviewViewProvider(FlowSidebarProvider.viewType, sidebar),

    register('codeFlow.exploreFromHere', () => controller.start('enclosing')),
    register('codeFlow.exploreFunction', () => controller.start('symbol')),
    register('codeFlow.next', () => controller.run(() => engine.next())),
    // Used by the sidebar (clicking a path or a call); not contributed to the Command Palette.
    vscode.commands.registerCommand('codeFlow.chooseBranch', (id: unknown) => typeof id === 'string' && controller.run(() => engine.next(id))),
    vscode.commands.registerCommand('codeFlow.stepIntoCall', (id: unknown) => typeof id === 'string' && controller.run(() => engine.stepInto({ id }))),
    register('codeFlow.previous', () => controller.run(() => engine.previous())),
    register('codeFlow.stepInto', () => controller.run(() => engine.stepInto())),
    register('codeFlow.stepOut', () => controller.run(() => engine.stepOut())),
    register('codeFlow.stop', () => controller.stop()),
    register('codeFlow.explainStep', () => controller.explainCurrentStep()),

    register('codeFlow.selectProvider', () => ai.selectProvider()),
    register('codeFlow.configureApiKey', () => ai.configureApiKey()),
    register('codeFlow.clearApiKey', () => ai.clearApiKey()),
    register('codeFlow.selectModel', () => ai.selectModel()),
    register('codeFlow.testConnection', () => ai.testConnection()),
    register('codeFlow.toggleAi', () => ai.toggleAi()),

    // Keep analysis in sync with edits (in editors and on disk, e.g. after a git checkout).
    vscode.workspace.onDidChangeTextDocument((e) => {
      if (e.contentChanges.length > 0 && e.document.uri.scheme === 'file' && SOURCE_LANGUAGES.has(e.document.languageId)) {
        engine.notifyFileChanged(normalizeFsPath(e.document.uri.fsPath));
      }
    }),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('codeFlow')) controller.refreshPanel();
    }),
    context.secrets.onDidChange(() => controller.refreshPanel()),
  );

  const watcher = vscode.workspace.createFileSystemWatcher(SOURCE_GLOB);
  const onDisk = (uri: vscode.Uri): void => {
    if (!uri.path.includes('/node_modules/')) engine.notifyFileChanged(normalizeFsPath(uri.fsPath));
  };
  context.subscriptions.push(watcher, watcher.onDidChange(onDisk), watcher.onDidCreate(onDisk), watcher.onDidDelete(onDisk));

  void vscode.commands.executeCommand('setContext', 'codeFlow.active', false);
}

export function deactivate(): void {
  // Disposables are registered on the extension context.
}
