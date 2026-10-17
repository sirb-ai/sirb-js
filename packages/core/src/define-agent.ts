import { API_VERSION } from "@sirb/spec";
import { SirbSpecError, isError, type SpecIssue } from "./issues.js";
import { validateSpec } from "./load.js";
import { cloneAsJson, deepFreeze } from "./plain-data.js";
import type {
  AgentDocument,
  AgentSpec,
  ApiVersion,
  Metadata,
} from "./types.js";

/**
 * Input to `defineAgent`: the `metadata` and `spec` of an Agent document.
 * `apiVersion` and `kind` are filled in; they may be given, but only with the
 * values `defineAgent` would fill in, so a loaded document is also valid input.
 */
export interface AgentInput {
  readonly apiVersion?: ApiVersion;
  readonly kind?: "Agent";
  readonly metadata: Metadata;
  readonly spec: AgentSpec;
}

export interface DefineAgentOptions {
  /**
   * Called once with the warnings (such as `possible-secret` in free text) of a
   * valid definition. Warnings never make a definition fail.
   */
  readonly onWarning?: (warnings: readonly SpecIssue[]) => void;
}

/** What the Agent schema reports when `kind` is not "Agent". */
const KIND_ISSUE: SpecIssue = {
  code: "schema",
  severity: "error",
  instancePath: "/kind",
  keyword: "const",
  message: "must be equal to constant",
};

function fail(issues: readonly SpecIssue[]): never {
  throw new SirbSpecError(issues);
}

/**
 * Code-first Agent definition. Returns the same plain, deeply frozen object
 * that loading the equivalent YAML or JSON produces:
 * `{ apiVersion: "sirb/v1alpha1", kind: "Agent", metadata, spec }`.
 *
 * The document goes through the same checks as the loader (Agent schema,
 * literal-secret scan; SR-SPEC-01, SR-SPEC-04), so code-first is not a way
 * around them. On failure it throws `SirbSpecError` with the loader's locators.
 */
export function defineAgent(
  input: AgentInput,
  options?: DefineAgentOptions,
): AgentDocument {
  const cloned = cloneAsJson(input);
  if (!cloned.ok) fail(cloned.issues);
  const value = cloned.value;
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    fail([
      {
        code: "invalid-input",
        severity: "error",
        instancePath: "",
        message: "defineAgent expects an object with metadata and spec",
      },
    ]);
  }

  // Spread keeps apiVersion and kind first; given values stay in their slot so
  // that a wrong value is reported rather than silently replaced.
  const document: Record<string, unknown> = {
    apiVersion: API_VERSION,
    kind: "Agent",
    ...value,
  };

  const result = validateSpec(document);
  // validateSpec dispatches on `kind`; an Agent definition must be an Agent.
  const issues =
    document.kind === "Agent" ? result.issues : [KIND_ISSUE, ...result.issues];
  if (!result.valid || issues.some(isError)) fail(issues);

  if (issues.length > 0) options?.onWarning?.(issues);
  return deepFreeze(result.document as AgentDocument);
}
