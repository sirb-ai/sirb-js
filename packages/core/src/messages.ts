import { DEFAULT_LIMITS, type RawIssue } from "@sirb/spec";

const { maxBytes, maxDocuments, maxDepth } = DEFAULT_LIMITS;

/**
 * Fixed messages for reference-loader issue codes. Parser and loader messages
 * can quote the source (JSON excerpts, YAML block-scalar headers, directives,
 * tags, anchors, duplicate keys, regex fragments, exception text), and a
 * document may hold a secret, so a raw message is never passed through except
 * for the codes in PASS_THROUGH, whose wording comes only from the schemas and
 * the loader's own vocabulary.
 */
const FIXED: Readonly<Record<string, string>> = {
  syntax: "the text is not well-formed YAML 1.2 or JSON",
  "duplicate-key": "duplicate mapping key",
  "yaml-alias": "anchors and aliases are not allowed",
  "yaml-merge-key": "merge keys (<<) are not allowed",
  "yaml-tag": "explicit tags are not allowed",
  "non-string-key": "mapping keys must be strings",
  "not-an-object": "each document must be a mapping",
  "forbidden-key": '"__proto__" is not allowed as a key',
  empty: "no documents found",
  "too-large": `input exceeds ${maxBytes} bytes`,
  "too-many-documents": `stream has more than ${maxDocuments} documents`,
  "too-deep": `nesting exceeds ${maxDepth} levels`,
  "invalid-input": "input must be UTF-8 text or bytes",
  "invalid-format": "format must be yaml or json",
  io: "cannot read the file",
  "invalid-regex":
    "pattern exceeds the complexity cap or does not compile in the linear-time engine (ADR-0010)",
  "literal-secret":
    "this field holds a secret; use a secretRef instead of a literal value",
  internal: "unexpected loader failure",
};

/**
 * `schema` messages are Ajv's, built from schema keywords (patterns, allowed
 * names) and never from instance data. `possible-secret` messages name a
 * location kind and a fixed reason (`known credential prefix`, ...).
 */
const PASS_THROUGH = new Set(["schema", "possible-secret"]);

// Positions only: digits, never text. JSON: "at position 7 (line 1 column 8)";
// YAML: "at line 1, column 8".
const LINE_COLUMN = /\bline (\d{1,9}),? column (\d{1,9})/;
const POSITION = /\bat position (\d{1,9})/;

function position(message: string): string {
  const lc = LINE_COLUMN.exec(message);
  if (lc) return ` at line ${lc[1]}, column ${lc[2]}`;
  const pos = POSITION.exec(message);
  return pos ? ` at position ${pos[1]}` : "";
}

/** A message for a reference issue that carries no source text. */
export function safeMessage(raw: RawIssue): string {
  if (PASS_THROUGH.has(raw.code)) return raw.message;
  const fixed = Object.hasOwn(FIXED, raw.code)
    ? (FIXED[raw.code] as string)
    : "invalid document";
  return raw.code === "syntax" ? fixed + position(raw.message) : fixed;
}
