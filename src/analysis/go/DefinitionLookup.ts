export interface DefinitionLocation {
  /** Absolute path, forward slashes. */
  file: string;
  /** Zero-based, UTF-16 character offsets, like VS Code positions. */
  line: number;
  character: number;
}

/**
 * "Go to definition" as a service. In the extension it is VS Code's definition provider (gopls via the Go
 * extension); tests use a small gopls client. Keeping it an interface keeps the Go analyzer free of `vscode`.
 */
export interface DefinitionLookup {
  /** Definition locations of the symbol at the position; empty/undefined when none is known. */
  definitions(file: string, line: number, character: number): Promise<DefinitionLocation[] | undefined>;
}
