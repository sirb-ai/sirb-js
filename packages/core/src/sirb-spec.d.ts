/**
 * Ambient types for the parts of `@sirb/spec` (plain ESM, no bundled types) that
 * @sirb/core uses. Shapes follow sirb-spec src/loader.mjs at the pinned commit.
 * Internal only: nothing in the public API of @sirb/core re-exports these.
 */
declare module "@sirb/spec" {
  export interface RawIssue {
    code: string;
    severity: "error" | "warning";
    message: string;
    instancePath?: string;
    keyword?: string;
    property?: string;
    document?: number;
    line?: number;
    location?: string;
  }

  export interface RawLoadResult {
    valid: boolean;
    documents: unknown[];
    issues: RawIssue[];
  }

  export interface RawLoadOptions {
    format?: string;
    filename?: string;
  }

  export const API_VERSION: "sirb/v1alpha1";
  export const DEFAULT_LIMITS: Readonly<{
    maxBytes: number;
    maxDocuments: number;
    maxDepth: number;
  }>;

  export function load(input: unknown, options?: RawLoadOptions): RawLoadResult;

  /** The reason a string looks like a literal credential, or undefined. */
  export function secretReason(value: string): string | undefined;
}
