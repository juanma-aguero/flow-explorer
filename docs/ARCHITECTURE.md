# Architecture

Goal: a debugger-like reading experience for code you did not write, without executing it. The design keeps **deterministic navigation** (static analysis) strictly separate from **AI explanation** and from the **VS Code UI**.

```
          ┌────────────────────────── VS Code layer (imports `vscode`) ──────────────────────────┐
          │ extension.ts   ui/FlowController   ui/FlowSidebarProvider   ui/QuickPickChooser        │
          │ editor/EditorNavigator  editor/HighlightManager  config/ConfigurationService,SecretMgr │
          └───────────────▲──────────────────────────────▲─────────────────────────────▲──────────┘
                          │ snapshots / events           │ UserChooser                 │ StepContext
          ┌───────────────┴───────────┐    ┌─────────────┴───────────┐      ┌──────────┴────────────┐
          │ flow/  (pure TypeScript)  │───▶│ analysis/ (TS Compiler  │      │ ai/ (Vercel AI SDK)    │
          │ FlowEngine, FlowNavigator │    │ API) CodeAnalyzer iface │      │ ExplanationService     │
          │ FlowSession, FlowTypes    │    │ TypeScriptAnalyzer,     │      │ OpenAI/Anthropic       │
          └───────────────────────────┘    │ StepExtractor,          │      └────────────────────────┘
                                           │ SymbolResolver          │
                                           └─────────────────────────┘
```

Rules that keep it modular:

- `analysis/`, `flow/` and `ai/` never import `vscode`; they are tested in plain Node. `config/types.ts` holds the interfaces (`SettingsSource`, `ApiKeyStore`) so the AI layer can be tested without VS Code.
- The flow engine depends on the `CodeAnalyzer` interface, not on TypeScript or Go. The interface is **async** because some languages resolve symbols through a language server. `AnalyzerRegistry` routes each request by file extension (`fn.file` / the call's file), so a session can only ever mix files whose analyzers agree on the model, and adding a language is one more registry entry, and on a `UserChooser` interface for decisions only a human can make (which branch, which call, which implementation). The VS Code implementation is Quick Picks; tests use a scripted chooser.
- The AI layer receives a `StepContext` value (minimum code context) and returns a value; it cannot affect navigation. Every failure (disabled, no key, network error, cancelled) is a result, not an exception.

## Static analysis

**Program management** (`TypeScriptAnalyzer`). One lazily-built `ts.Program` per nearest `tsconfig.json`/`jsconfig.json`; `allowJs` is forced on so JS files imported from TS are understood, and emit options are neutralised. Files outside a config get an ad-hoc program. The compiler host serves **unsaved editor text** (so highlights match what is on screen) and reuses unchanged parsed `SourceFile`s across rebuilds. `invalidate()` drops caches; the program is rebuilt only on the next request. When bundled, TypeScript's `lib.*.d.ts` files are shipped in `dist/typescript-lib`.

**Steps** (`StepExtractor`). A function body becomes a graph of `FlowStep`s in two passes: (1) create one step per executable statement in source order, (2) wire `next` pointers and branches by walking statements back to front with a continuation. This keeps ids in source order while letting `if`/loops/`switch`/`try` know where they rejoin.

- Steps: assignments, calls, conditions, loops, switch, try/catch/finally, return, throw, break/continue. Compound statements are a *header* step (highlight is `if (cond)`, not the whole block).
- Anything unknowable becomes `branches` with human labels: then/else/skip, loop body/skip, each `case`/`default`, and for `try` "no exception" vs "exception → catch". The engine never picks one.
- Nested functions/classes are skipped when collecting steps and calls ("do not treat nested bodies as executing immediately"); declarations (functions, classes, types, imports) are not steps. Calls are listed in evaluation order (arguments before the call), `await` is flagged.
- Loops have no back edge: one pass, then continue, which keeps navigation finite and predictable.
- Step id = `<file>#<qualifiedName>@<startOffset>/s<index>`; call id = `<stepId>/c<n>`. Deterministic for unchanged source.

**Resolution** (`SymbolResolver`). Uses the type checker: symbol at the callee name → follow import aliases → map declarations to function-likes with bodies (function/method/constructor/accessor, `const f = () => …`, property initializers, `export default`, IIFEs, `super()`, `new`). The result is `resolved(targets)` or `unresolved(reason, message)` with reasons `external-library`, `declaration-only`, `dynamic`, `no-implementation`, `no-symbol`, `not-a-function`. External means declaration files or `node_modules`; those are never entered. Multiple implementations are offered to the user, not guessed.

**Laziness.** Only the functions the user visits are analyzed (`getFlow` is cached per function); there is no project call graph.

## Go support

`analysis/go/` implements `CodeAnalyzer` for Go and shows how a second language fits:

- **Structure from tree-sitter** (`web-tree-sitter` + the Go grammar as WASM, shipped in `dist/wasm`). `GoStepExtractor` is the Go counterpart of `StepExtractor` and emits the *same* `FlowStep` graph (two passes: create steps in source order, then wire `next`/branches with continuations), so the engine, navigator, session, UI and AI need no Go-specific code. Go semantics encoded there: header steps include `if`/`for`/`switch` initializers; switches do not fall through unless `fallthrough` (the clause's next is the following clause only then); `select` has no "no case matches" branch; `defer`/`go` are distinct step kinds (`StepKind` gained `defer` and `go`); `panic(...)` ends the flow; builtins and type conversions are not calls; function literals are not executed unless immediately invoked (an IIFE resolves to itself).
- **Meaning from the language server.** A `DefinitionLookup` interface ("go to definition as a service") is implemented by `VsCodeDefinitionLookup` (`vscode.executeDefinitionProvider`, i.e. gopls via the Go extension, so we never start or configure a server and unsaved edits are seen as the editor sees them). `GoAnalyzer` maps the returned location back to a function by parsing the target file: a declaration with a body is a target; an interface method (`method_spec`/`method_elem`) or bodyless function is `declaration-only`; anything under GOROOT, `pkg/mod` or `vendor` is `external-library`; function values are `dynamic`. The same "never guess" contract as TypeScript. Empty answers (server still loading) are not cached, so a later action retries.
- **Why not our own Go type checker or a bundled gopls?** Resolution that is correct for Go (method sets, embedding, generics, modules) is exactly what gopls already does; reusing the user's server gives identical answers to their Go to Definition and avoids a second gopls process. The price is a runtime dependency on the Go extension, reported clearly when absent.
- **Testing.** Extraction is tested with no server. Resolution tests drive a real `gopls` through a ~100-line LSP client (`test/goHelpers.ts`) and skip cleanly when it is not installed; the extension-host suite loads the real Go extension. One lesson from that suite is baked into the messages: gopls only resolves cross-package calls when the module folder is the workspace.

## Flow session model

`FlowSession` = entry function + a **history of immutable `FlowState`s** (`frames: {functionId, stepId}[]`; the last frame is active, the array is the call stack) + the latest branch choice per step + a `stale` flag.

- Next/Step Into/Step Out *push* a new state; **Previous pops** it. Previous is therefore the exact inverse of the last action (including a Step Out or a branch choice) and costs no re-analysis. Branch choices are recorded in the session but Next always asks again, so exploring the other side is just Previous → Next.
- Step Out keeps the caller on its call-site step (the highlighted statement that contained the call). Next at the end of a callee steps out automatically; at the root it reports the end of the flow.
- Recursion: a function already in `frames` is not re-entered (explained to the user); depth cap 64.
- Staleness: when a visited file changes, the session is marked stale rather than silently showing shifted ranges.

`FlowNavigator` holds the stepping rules (stateless); `FlowEngine` owns the single active session, serialises actions (a Quick Pick in flight blocks re-entrancy), emits change events and produces read models: `FlowSnapshot` (sidebar/highlights/context keys) and `StepContext` (AI).

## UI

- **Editor** stays the main interface: `EditorNavigator` opens/reveals through the normal editor APIs (preview tabs, so deep Step Intos do not litter tabs); `HighlightManager` uses `TextEditorDecorationType` with contributed theme colors, for the current step and the waiting call sites.
- **Sidebar**: a webview view with a strict CSP and nonce, text rendered with `textContent` only, and a whitelist of commands the webview may trigger. It is a thin view over `PanelState`.
- `FlowController` is the only place that knows both worlds: engine event → reveal + highlight + panel + context key; plus AI consent, cancellation of in-flight requests when the step changes, and per-step explanation caching.

## AI

- `AIProvider` is a one-method contract. `LanguageModelProvider` wraps any Vercel AI SDK `LanguageModel` with `generateText`; `OpenAIProvider`/`AnthropicProvider` only choose the SDK package. Model IDs come from settings.
- Privacy by construction: `ExplanationService.explain` checks the master switch and key *before* building anything; `buildPrompt` assembles the smallest useful context (windowed function source, base file name, static facts); consent is per provider and explicit; auto-explain is off by default; keys live only in SecretStorage and are redacted from any error surfaced.
- The system prompt forbids inventing runtime values and tells the model to say when behavior is not visible, which keeps explanations grounded in the supplied source.

## Toward PR review (not implemented)

The seams exist without building anything speculative:

- `CodeAnalyzer` is the only door to source facts. A diff-aware analyzer could produce flows for *before* and *after* revisions of a function (the `readOverlay`/`ts.CompilerHost` mechanism already lets a program be built from arbitrary text, e.g. `git show` output) and the engine could run two sessions side by side.
- "Changed functions" = a list of `FunctionRef`s fed to `startFromFunction`; "affected paths" = existing Step Into/branch machinery restricted to steps whose ranges intersect the diff.
- Step ids are position-based and stable for unchanged code, so steps can be matched across revisions.
- `StepContext` can grow a `diff` field; the prompt builder is a pure function.

## Testing strategy

- Unit tests per module over tiny fixtures (`test/fixtures`), the example project as an integration fixture (`test/integration`), AI mocked with a fake provider and the AI SDK's `MockLanguageModelV2`, real provider packages exercised over a stubbed `fetch`.
- `test/vscode` runs real commands in an actual extension host (activation, command registration, cross-file Step Into/Out, Quick Pick branches). Verified with VS Code and Cursor.
