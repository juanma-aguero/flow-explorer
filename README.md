# Code Flow Explorer

Step through the logic of TypeScript, JavaScript and Go code **without running it**, directly in the VS Code (or Cursor) editor.

Put the cursor in a function, start an exploration, and move through its statements like in a debugger: **Next**, **Previous**, **Step Into** (even into other files), **Step Out**, and choose which side of an `if`/`switch`/`try` to follow. The editor opens the right file, highlights the current statement and a sidebar shows where you are. Optionally, an AI model (OpenAI or Anthropic, with *your* key) explains the current step.

It is static analysis, not a debugger: nothing is executed, no runtime values are assumed. See [Known limitations](#known-limitations).

## Quick start (Extension Development Host)

Requirements: Node.js 20+, VS Code 1.90+ (or Cursor). For **Go**, also the [Go extension](https://marketplace.visualstudio.com/items?itemName=golang.Go) (it provides `gopls`).

```bash
npm install
npm run build
```

Then either:

- **VS Code:** open this folder, press **F5** and choose *Run Extension (open demo project)* (TypeScript) or *Run Extension (open Go demo)*. A second window opens with the demo loaded.
- **Cursor / command line:**
  ```bash
  cursor --extensionDevelopmentPath="$PWD" examples/checkout-demo     # or: code ...
  ```
- **Install as a VSIX:** `npm run package`, then *Extensions → … → Install from VSIX…*.

### Go

Open a Go **module folder** (the one containing `go.mod`) as the workspace, put the cursor in a function and run **Code Flow: Explore from Here**. Everything below works the same, plus Go specifics:

- `if`/`for`/`switch`/type switch/`select` are choices; `if`/`switch` initializers (`if err := f(); err != nil`) are part of the step. Go's switches do **not** fall through unless the clause says `fallthrough`.
- `defer` and `go` are their own step kinds: shown where they are registered/started, and you can step into the call. `panic(...)` ends the flow.
- Calls are resolved by **gopls** through VS Code's definition provider, so same-package, cross-package and concrete-method calls work. Interface method calls are reported as "only declared here" (the implementation depends on the runtime value), and standard library / dependency code is not entered. Function values (parameters, map entries, fields) are reported as dynamic.
- Try it on `examples/go-demo` (`checkout/checkout.go` → `ProcessCheckout`). Without the Go extension (or if the folder is not in a module) navigation still works; stepping into other functions explains that no definition was found.

### Try the demo (no AI needed)

1. In the new window open `src/checkout.service.ts` and click inside `processCheckout`.
2. Run **Code Flow: Explore from Here** (right-click menu or Command Palette). The first statement is highlighted and the *Code Flow Explorer* sidebar opens.
3. **Next** (`F10`) to move on. On `const total = calculateTotal(...)` press **Step Into** (`F11`): `pricing.ts` opens. **Step Out** (`Shift+F11`) returns to the call site.
4. Step into `applyDiscount` and press **Next** on its `if`: a Quick Pick asks which path to explore.
5. Reach `console.error(...)` or `gateway.charge(...)` and try Step Into: you get a clear message that it cannot be explored (library / interface) instead of a guess.
6. **Previous** (`Alt+F10`) undoes the last action exactly, including Step Into/Out and branch choices.

## Commands

| Command | What it does |
| --- | --- |
| **Code Flow: Explore from Here** | Starts a flow at the function containing the cursor (works with the cursor on `const f = () => {}` names too). |
| **Code Flow: Explore Function** | Starts at the function the identifier under the cursor refers to (e.g. a call). If a flow is active and the cursor is on a call of the current step, it steps into it instead. Standard Go to Definition is untouched. |
| Next Step / Previous Step | Forward / exact undo. Next at the last step of a callee returns to the caller. |
| Step Into / Step Out | Enter the call of the current step / return to the call site. |
| Stop Exploration | Ends the session and clears highlights. |
| Explain Current Step (AI) | Requests an explanation (see below). |
| Select AI Provider · Configure API Key · Remove API Key · Select AI Model · Test AI Connection · Enable/Disable AI Explanations | AI configuration. |

Navigation commands are also in the editor title bar and context menu while a flow is active.

**Keyboard** (only active during an exploration, and never while a real debug session is running; remappable):

| Key | Action | Also |
| --- | --- | --- |
| `F10` | Next | `Ctrl/Cmd+Alt+J` |
| `F11` | Step Into | `Ctrl/Cmd+Alt+L` |
| `Shift+F11` | Step Out | `Ctrl/Cmd+Alt+H` |
| `Alt+F10` | Previous | `Ctrl/Cmd+Alt+K` |
| `Shift+F5` | Stop | |

There is no `F9` equivalent (there are no breakpoints) and no `F5` "continue". During an exploration `F11` replaces the full-screen toggle. On a Mac, function keys may need `Fn` unless you enabled "Use F1, F2, etc. keys as standard function keys".

The highlighted statement uses the theme colors `codeFlow.currentStepBackground`, `codeFlow.currentStepBorder` and (for call sites waiting on the stack) `codeFlow.callerBackground`.

## AI explanations

AI is optional and **never drives navigation**; everything above works with no key.

1. **Select AI Provider** (OpenAI or Anthropic) and **Configure API Key**. The key is stored in VS Code SecretStorage (OS keychain), never in settings, workspace files or logs.
2. Optionally **Select AI Model** (any model ID; defaults are `gpt-5-mini` and `claude-haiku-5-5`, change them if your account uses other models). **Test AI Connection** sends a fixed prompt with no code.
3. Press **Explain Step** in the sidebar (or run *Explain Current Step*). The first time per provider you must confirm that code will be sent.

**What is sent:** the current step, the source of its enclosing function (windowed around the step and capped at `codeFlow.ai.maxContextChars`, default 6000), the file *base name*, the call stack function names, and facts from the analysis (possible branches, whether calls resolved). No other files, no absolute paths, no project metadata. The sidebar always says which provider would receive code, and **Disable AI** (`codeFlow.ai.enabled`) guarantees nothing is sent. Explanations are not requested automatically unless you turn on `codeFlow.ai.autoExplain`.

The prompt instructs the model to stay grounded in the shown code, say when behavior is not visible, and not invent runtime values. Models can still be wrong; treat explanations as reading aids.

### Settings

| Setting | Default | |
| --- | --- | --- |
| `codeFlow.ai.enabled` | `true` | Master switch for sending code to an AI provider. |
| `codeFlow.ai.provider` | `openai` | `openai` or `anthropic`. |
| `codeFlow.ai.openaiModel` | `gpt-5-mini` | |
| `codeFlow.ai.anthropicModel` | `claude-haiku-5-5` | |
| `codeFlow.ai.autoExplain` | `false` | Explain on every step (sends code each time). |
| `codeFlow.ai.maxContextChars` | `6000` | Cap on source characters per request. |

## Development

```bash
npm run build        # bundle to dist/ (esbuild); `npm run watch` to rebuild on change
npm run typecheck    # strict tsc
npm test             # unit + integration tests; no API keys or network (Go resolution tests use a local gopls if found, else are skipped)
npm run test:vscode  # smoke tests inside a real VS Code extension host (needs VS Code installed)
```

- `npm test` covers step extraction (TypeScript and Go), symbol/cross-file resolution, Next/Previous, Step Into/Out, branch choice, recursion, unresolved symbols, missing/disabled AI, and the real OpenAI/Anthropic provider packages against a stubbed `fetch`. AI responses are mocked.
- `npm run test:vscode` launches the locally installed VS Code with a throw-away profile and drives the real commands: a TypeScript suite on `examples/checkout-demo`, and a Go suite on `examples/go-demo` with the installed Go extension (skipped if it is not installed). Set `VSCODE_EXECUTABLE` to test another build, e.g. `/Applications/Cursor.app/Contents/MacOS/Cursor`.

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for the design.

## Known limitations

- **Static, not executed.** The sequence shown is a *possible* logical flow, not what runs. Anything that depends on runtime values is surfaced as a choice, never assumed.
- Loop bodies are visited once (no back edge); `do … while` conditions, labeled `break`/`continue` (approximated by the nearest loop/switch) and `finally` on early `return`/`throw` are simplified. The sidebar lists such notes per function.
- Callbacks and nested functions (`items.map(x => f(x))`) are not part of the enclosing function's steps; step into the function you pass instead.
- Calls are resolved with the TypeScript type checker. Interface/abstract members, dynamic calls (`handlers[key]()`), values from `wrap(fn)` and anything in `node_modules`/`.d.ts` are reported as **unresolved with a reason**; polymorphism is not guessed. A function already on the call stack is not re-entered (recursion), and depth is capped at 64.
- Class `new Foo()` steps into an explicit constructor only; field initializers and decorators are not modelled.
- **Go:** `defer`red calls are shown where registered, not at function exit; goroutines are shown at the `go` statement; `panic`/`recover` unwinding, `goto` and labeled `break`/`continue` are simplified (listed in the sidebar notes); builtins and type conversions (`len`, `append`, `int(x)`) are not offered as calls; build tags and cgo are whatever gopls sees. Cross-package resolution needs gopls and the module folder open as the workspace; unsaved edits are seen by gopls only for files open in the editor.
- Editing a visited file marks the session stale (navigation is disabled until you start again), because stored locations may have moved.
- Analysis honors the nearest `tsconfig.json`/`jsconfig.json`; files outside it are analyzed in an ad-hoc program. Very large projects pay one program build on first use (lazy, then cached).
- Only `file:` documents are supported (not untitled buffers or remote virtual file systems).
- The AI path has been verified with mocked responses and a stubbed HTTP layer, not against live provider accounts.
- `npm audit` reports advisories in `undici` (via `@ai-sdk/provider-utils`, multipart parsing). The extension does not use that code path; the fix requires the AI SDK major that needs Node 22, which older VS Code/Cursor extension hosts do not provide.
- Not in the MVP: PR/diff analysis (the design leaves room, see the architecture doc), call graphs, runtime debugging.
