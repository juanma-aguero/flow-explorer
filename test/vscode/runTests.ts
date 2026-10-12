/**
 * Launches a real VS Code extension host (the locally installed one) with this extension loaded and runs
 * test/vscode/smoke.ts inside it. Uses throw-away user-data/extensions dirs so your profile is untouched.
 *
 *   npm run test:vscode
 *   VSCODE_EXECUTABLE=/path/to/Electron npm run test:vscode   # pick a specific build (e.g. Cursor)
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { runTests } from '@vscode/test-electron';

function findInstalledVsCode(): string | undefined {
  const candidates = [
    process.env.VSCODE_EXECUTABLE,
    '/Applications/Visual Studio Code.app/Contents/MacOS/Electron',
    '/Applications/Visual Studio Code.app/Contents/MacOS/Code',
    '/usr/share/code/code',
    'C:\\Program Files\\Microsoft VS Code\\Code.exe',
  ];
  return candidates.find((c) => c && fs.existsSync(c));
}

/** The Go extension (golang.go), if installed, so Go scenarios can use the real gopls. Loaded as a dev extension. */
function findGoExtension(): string | undefined {
  const roots = [process.env.GO_EXTENSION_DIR, path.join(os.homedir(), '.vscode', 'extensions'), path.join(os.homedir(), '.cursor', 'extensions')];
  for (const root of roots) {
    if (!root || !fs.existsSync(root)) continue;
    if (fs.existsSync(path.join(root, 'package.json'))) return root; // GO_EXTENSION_DIR points at the extension itself
    const match = fs.readdirSync(root).filter((d) => d.startsWith('golang.go-')).sort().pop();
    if (match) return path.join(root, match);
  }
  return undefined;
}

async function main(): Promise<void> {
  const root = path.resolve(__dirname, '..', '..', '..');
  const goExtension = findGoExtension();
  console.log(goExtension ? `Go extension: ${goExtension}` : 'Go extension not found: Go scenarios will be skipped');
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'codeflow-vscode-'));
  try {
    const suites: Array<{ name: string; workspace: string; tests: string; extensions: string[] }> = [
      { name: 'TypeScript', workspace: 'examples/checkout-demo', tests: 'smoke', extensions: [] },
      // gopls only resolves cross-package calls when the Go module is the workspace, like in real use.
      ...(goExtension ? [{ name: 'Go', workspace: 'examples/go-demo', tests: 'smokeGo', extensions: [goExtension] }] : []),
    ];
    for (const suite of suites) {
      console.log(`\n== ${suite.name} suite (${suite.workspace}) ==`);
      await runTests({
        vscodeExecutablePath: findInstalledVsCode(), // undefined => downloads the latest stable VS Code
        extensionDevelopmentPath: [root, ...suite.extensions],
        extensionTestsPath: path.join(root, 'out', 'test', 'vscode', suite.tests),
        launchArgs: [
          path.join(root, suite.workspace),
          '--disable-extensions',
          '--disable-workspace-trust',
          `--user-data-dir=${path.join(scratch, `user-${suite.tests}`)}`,
          `--extensions-dir=${path.join(scratch, 'ext')}`,
        ],
      });
    }
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
