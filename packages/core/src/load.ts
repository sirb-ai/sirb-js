import {
  load as referenceLoad,
  type RawIssue,
  type RawLoadOptions,
  type RawLoadResult,
} from "@sirb/spec";
import { SirbSpecError, isError, type SpecIssue } from "./issues.js";
import { safeMessage } from "./messages.js";
import { cloneAsJson, deepFreeze } from "./plain-data.js";
import { readSpecFile } from "./read-file.js";
import type { SirbDocument } from "./types.js";

const LOCATOR_FIELDS = [
  "instancePath",
  "keyword",
  "property",
  "document",
  "line",
] as const;

/**
 * Copies the documented fields of a reference-loader issue into a SpecIssue.
 * The message is replaced by one that carries no source text (messages.ts).
 */
function toSpecIssue(raw: RawIssue): SpecIssue {
  const issue: Record<string, unknown> = {
    code: raw.code,
    severity: raw.severity,
    message: safeMessage(raw),
  };
  for (const field of LOCATOR_FIELDS) {
    if (raw[field] !== undefined) issue[field] = raw[field];
  }
  if (raw.location === "comment") issue.location = "comment";
  return issue as unknown as SpecIssue;
}

export type SpecFormat = "yaml" | "json";

export interface LoadSpecOptions {
  /** Defaults to the format implied by `filename` (`.json`, `.yaml`, `.yml`), else `yaml`. */
  readonly format?: SpecFormat;
  /** Used to infer `format` and to name the source in errors. Never read. */
  readonly filename?: string;
}

export interface LoadSpecFileOptions {
  /** Overrides the format implied by the file extension. */
  readonly format?: SpecFormat;
  /**
   * Follow a symbolic link at the last path component. Defaults to false: a
   * symlink is reported as an `io` issue. Links in parent directories are
   * always followed.
   */
  readonly followSymlinks?: boolean;
}

/**
 * Result of loading a YAML or JSON stream. `valid` is false when any issue is an
 * error, and then `documents` is empty. Warnings (`possible-secret`) never make
 * a result invalid. Documents are deeply frozen.
 */
export type LoadSpecResult =
  | {
      readonly valid: true;
      readonly documents: readonly SirbDocument[];
      readonly issues: readonly SpecIssue[];
    }
  | {
      readonly valid: false;
      readonly documents: readonly [];
      readonly issues: readonly SpecIssue[];
    };

/** Result of validating one parsed document. */
export type ValidateSpecResult =
  | {
      readonly valid: true;
      /** A plain, deeply frozen JSON copy of the input, as validated. */
      readonly document: SirbDocument;
      readonly issues: readonly SpecIssue[];
    }
  | { readonly valid: false; readonly issues: readonly SpecIssue[] };

function referenceOptions(
  options: LoadSpecOptions | undefined,
): RawLoadOptions {
  // Forward only the documented options: limits stay at the reference defaults.
  const out: { format?: string; filename?: string } = {};
  if (options?.format !== undefined) out.format = options.format;
  if (options?.filename !== undefined) out.filename = options.filename;
  return out;
}

function toResult(raw: RawLoadResult): LoadSpecResult {
  const issues = raw.issues.map(toSpecIssue);
  // The reference loader returns no documents unless every one of them passed
  // validation, so the documents conform to their kind schema.
  return raw.valid && !issues.some(isError)
    ? {
        valid: true,
        documents: deepFreeze(raw.documents as SirbDocument[]),
        issues,
      }
    : { valid: false, documents: [], issues };
}

/**
 * Parses YAML 1.2 or JSON text (or UTF-8 bytes), validates every document
 * against its kind schema and scans for literal secrets, using the reference
 * loader of `@sirb/spec`. Never throws: every problem is an issue.
 */
export function loadSpec(
  input: string | Uint8Array,
  options?: LoadSpecOptions,
): LoadSpecResult {
  return toResult(referenceLoad(input, referenceOptions(options)));
}

/** Like `loadSpec` but throws `SirbSpecError` when invalid, and returns the documents. */
export function loadSpecOrThrow(
  input: string | Uint8Array,
  options?: LoadSpecOptions,
): readonly SirbDocument[] {
  const result = loadSpec(input, options);
  if (!result.valid) throw new SirbSpecError(result.issues, options?.filename);
  return result.documents;
}

/**
 * Like `loadSpec`, for a file path. Never rejects. Only a regular file of at
 * most 1 MiB is read; anything else (missing, a directory, FIFO, socket or
 * device, or a symlink unless `followSymlinks`) is an `io` issue, and a larger
 * file is `too-large`. The bytes then go through the reference loader as
 * `loadSpec` does, with the format taken from the extension unless `format`
 * is given.
 */
export async function loadSpecFile(
  path: string,
  options?: LoadSpecFileOptions,
): Promise<LoadSpecResult> {
  const read = await readSpecFile(path, options?.followSymlinks === true);
  if (!read.ok) return { valid: false, documents: [], issues: [read.issue] };
  const raw = referenceLoad(read.bytes, {
    filename: path,
    ...(options?.format !== undefined && { format: options.format }),
  });
  return toResult(raw);
}

/**
 * Validates one parsed document (for example a code-first object) exactly as
 * the loader validates a document read from text: kind schema, literal-secret
 * scan and policy-pattern checks, with the same issue locators.
 *
 * The value is first copied into plain JSON data; values that JSON cannot
 * represent are reported as `invalid-input` issues. The copy is then handed to
 * the reference loader as JSON text, so there is a single validation pipeline.
 * Issues carry no `document` index.
 */
export function validateSpec(document: unknown): ValidateSpecResult {
  const cloned = cloneAsJson(document);
  if (!cloned.ok) return { valid: false, issues: cloned.issues };
  const raw = referenceLoad(JSON.stringify(cloned.value), { format: "json" });
  const issues = raw.issues.map((i) => {
    const { document: _index, ...rest } = toSpecIssue(i);
    return rest;
  });
  return raw.valid && !issues.some(isError)
    ? {
        valid: true,
        document: deepFreeze(cloned.value as SirbDocument),
        issues,
      }
    : { valid: false, issues };
}
