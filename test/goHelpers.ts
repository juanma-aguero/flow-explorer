import { ChildProcess, spawn } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import { GoAnalyzer } from '../src/analysis/go/GoAnalyzer';
import type { DefinitionLocation, DefinitionLookup } from '../src/analysis/go/DefinitionLookup';
import { FIXTURES, ROOT } from './helpers';

export const GO_FIXTURES = `${FIXTURES}/go`;
export const GO_DEMO = path.join(ROOT, 'examples', 'go-demo').replace(/\\/g, '/');

export const grammarPaths = {
  runtimeWasm: require.resolve('web-tree-sitter/tree-sitter.wasm'),
  grammarWasm: path.join(ROOT, 'node_modules', 'tree-sitter-wasms', 'out', 'tree-sitter-go.wasm'),
};

/** A lookup that knows nothing: enough for tests that only look at structure. */
export const noDefinitions: DefinitionLookup = { definitions: async () => undefined };

export const newGoAnalyzer = (lookup: DefinitionLookup = noDefinitions): Promise<GoAnalyzer> =>
  GoAnalyzer.create({ ...grammarPaths, lookup });

export function findGopls(): string | undefined {
  const candidates = [process.env.GOPLS, path.join(os.homedir(), 'go', 'bin', 'gopls'), '/usr/local/bin/gopls', '/opt/homebrew/bin/gopls'];
  for (const dir of (process.env.PATH ?? '').split(path.delimiter)) candidates.push(path.join(dir, 'gopls'));
  return candidates.find((c): c is string => !!c && fs.existsSync(c));
}

/** Minimal LSP client: just enough of the protocol to ask real gopls for definitions. */
export class GoplsLookup implements DefinitionLookup {
  private proc: ChildProcess | undefined;
  private buffer = Buffer.alloc(0);
  private nextId = 1;
  private readonly pending = new Map<number, (message: { result?: unknown; error?: { message: string } }) => void>();
  private readonly opened = new Set<string>();
  private ready: Promise<void> | undefined;

  constructor(
    private readonly bin: string,
    private readonly rootDir: string,
  ) {}

  definitions(file: string, line: number, character: number): Promise<DefinitionLocation[] | undefined> {
    return this.request(file, line, character);
  }

  async dispose(): Promise<void> {
    if (!this.proc) return;
    try {
      await this.send('shutdown', null, 5000);
      this.notify('exit', null);
    } catch {
      // fall through to kill
    }
    this.proc.kill();
    this.proc = undefined;
  }

  private async request(file: string, line: number, character: number): Promise<DefinitionLocation[] | undefined> {
    await (this.ready ??= this.start());
    const uri = pathToFileURL(file).toString();
    if (!this.opened.has(file)) {
      this.notify('textDocument/didOpen', { textDocument: { uri, languageId: 'go', version: 1, text: fs.readFileSync(file, 'utf8') } });
      this.opened.add(file);
    }
    const result = (await this.send('textDocument/definition', { textDocument: { uri }, position: { line, character } }, 120000)) as
      | Array<{ uri?: string; range?: { start: { line: number; character: number } }; targetUri?: string; targetSelectionRange?: { start: { line: number; character: number } } }>
      | { uri: string; range: { start: { line: number; character: number } } }
      | null;
    if (!result) return undefined;
    const list = Array.isArray(result) ? result : [result];
    return list.map((r) => {
      const l = r as { uri?: string; range?: { start: { line: number; character: number } }; targetUri?: string; targetSelectionRange?: { start: { line: number; character: number } } };
      const uriOut = l.targetUri ?? l.uri!;
      const start = (l.targetSelectionRange ?? l.range)!.start;
      return { file: fileURLToPath(uriOut).replace(/\\/g, '/'), line: start.line, character: start.character };
    });
  }

  private async start(): Promise<void> {
    this.proc = spawn(this.bin, ['serve'], { cwd: this.rootDir, stdio: ['pipe', 'pipe', 'ignore'] });
    this.proc.stdout!.on('data', (chunk: Buffer) => this.onData(chunk));
    const rootUri = pathToFileURL(this.rootDir).toString();
    await this.send('initialize', {
      processId: process.pid,
      rootUri,
      workspaceFolders: [{ uri: rootUri, name: 'fixture' }],
      capabilities: {},
    }, 120000);
    this.notify('initialized', {});
  }

  private send(method: string, params: unknown, timeoutMs: number): Promise<unknown> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`gopls ${method} timed out`)), timeoutMs);
      this.pending.set(id, (message) => {
        clearTimeout(timer);
        if (message.error) reject(new Error(message.error.message));
        else resolve(message.result);
      });
      this.write({ jsonrpc: '2.0', id, method, params });
    });
  }

  private notify(method: string, params: unknown): void {
    this.write({ jsonrpc: '2.0', method, params });
  }

  private write(message: unknown): void {
    const body = Buffer.from(JSON.stringify(message), 'utf8');
    this.proc?.stdin!.write(Buffer.concat([Buffer.from(`Content-Length: ${body.length}\r\n\r\n`), body]));
  }

  private onData(chunk: Buffer): void {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    for (;;) {
      const headerEnd = this.buffer.indexOf('\r\n\r\n');
      if (headerEnd < 0) return;
      const match = /Content-Length: (\d+)/i.exec(this.buffer.subarray(0, headerEnd).toString('ascii'));
      if (!match) return;
      const length = Number(match[1]);
      const start = headerEnd + 4;
      if (this.buffer.length < start + length) return;
      const message = JSON.parse(this.buffer.subarray(start, start + length).toString('utf8')) as {
        id?: number;
        method?: string;
        result?: unknown;
        error?: { message: string };
      };
      this.buffer = this.buffer.subarray(start + length);

      if (message.method && message.id !== undefined) {
        this.write({ jsonrpc: '2.0', id: message.id, result: null }); // server -> client request: acknowledge
      } else if (message.id !== undefined) {
        this.pending.get(message.id)?.(message);
        this.pending.delete(message.id);
      }
    }
  }
}
