import { secretReason } from "@sirb/spec";

/**
 * Issue codes reported by the reference loader (sirb-spec conformance/README.md,
 * "Loader issue codes"). Every code is an error except `possible-secret`.
 */
export type SpecIssueCode =
  | "syntax"
  | "duplicate-key"
  | "yaml-alias"
  | "yaml-merge-key"
  | "yaml-tag"
  | "non-string-key"
  | "not-an-object"
  | "forbidden-key"
  | "empty"
  | "too-large"
  | "too-many-documents"
  | "too-deep"
  | "invalid-input"
  | "invalid-format"
  | "io"
  | "schema"
  | "invalid-regex"
  | "literal-secret"
  | "possible-secret"
  | "internal";

export type SpecIssueSeverity = "error" | "warning";

/**
 * One problem found while loading or validating a document. The locator fields
 * use the vocabulary of the sirb-spec conformance suite (ADR-0006).
 *
 * `message` is human-readable and is not part of the contract. It never
 * contains document text: for every loader code it is a fixed sentence (a
 * `syntax` message may add a line/column or position), and `schema` messages
 * come from the schemas. Locator fields (`instancePath`, `property`) do name
 * the document's keys, which can be credential-shaped; `SirbSpecError.message`
 * masks those.
 */
export interface SpecIssue {
  readonly code: SpecIssueCode;
  readonly severity: SpecIssueSeverity;
  readonly message: string;
  /** JSON Pointer into the document; `""` is the root. */
  readonly instancePath?: string;
  /** The JSON Schema keyword that failed (`code: "schema"`); a false subschema is `"false"`. */
  readonly keyword?: string;
  /** Informative: the property named by `required`, `additionalProperties` or `propertyNames`. */
  readonly property?: string;
  /** Index of the document within a multi-document stream. */
  readonly document?: number;
  /** 1-based source line, for findings in YAML comments. */
  readonly line?: number;
  /** `"comment"` for findings in YAML comments. */
  readonly location?: "comment";
}

export const isError = (issue: SpecIssue): boolean =>
  issue.severity === "error";

const SAFE_SEGMENT = /^[A-Za-z0-9_.$-]{1,64}$/;

/**
 * A JSON Pointer for display: every segment that is not a short plain name, or
 * that looks like a credential (a pasted key used as a property name), becomes
 * `*`. Only for messages; issues keep the raw `instancePath`.
 */
export function redactPointer(pointer: string): string {
  if (pointer === "") return "(root)";
  return pointer
    .split("/")
    .slice(1)
    .map((s) => (SAFE_SEGMENT.test(s) && !secretReason(s) ? s : "*"))
    .map((s) => `/${s}`)
    .join("");
}

/** Describes an issue by its locator only, so no document content is echoed. */
export function describeIssue(issue: SpecIssue): string {
  const parts: string[] = [`[${issue.code}]`];
  if (issue.document !== undefined) parts.push(`document ${issue.document}`);
  if (issue.line !== undefined) parts.push(`line ${issue.line}`);
  if (issue.instancePath !== undefined)
    parts.push(redactPointer(issue.instancePath));
  if (issue.keyword !== undefined) parts.push(issue.keyword);
  // `property` is left out on purpose: an unknown key can itself be a pasted credential.
  return parts.join(" ");
}

/**
 * Thrown by `defineAgent` and `loadSpecOrThrow`. `issues` holds every issue
 * found (errors and warnings), in the order the loader reported them. The
 * message names only locators, never document content.
 */
export class SirbSpecError extends Error {
  override readonly name = "SirbSpecError";
  readonly issues: readonly SpecIssue[];

  constructor(issues: readonly SpecIssue[], filename?: string) {
    const errors = issues.filter(isError);
    const first = errors[0] ?? issues[0];
    const where = filename ? `${filename}: ` : "";
    super(
      `${where}invalid Sirb spec: ${errors.length} error(s)` +
        (first ? `; first: ${describeIssue(first)}` : ""),
    );
    this.issues = Object.freeze([...issues]);
  }

  /** The issues with severity `error`. */
  get errors(): readonly SpecIssue[] {
    return this.issues.filter(isError);
  }
}
