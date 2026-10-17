import { DEFAULT_LIMITS } from "@sirb/spec";
import type { SpecIssue } from "./issues.js";

export type CloneResult =
  | { readonly ok: true; readonly value: unknown }
  | { readonly ok: false; readonly issues: SpecIssue[] };

const escapePointer = (key: string): string =>
  key.replaceAll("~", "~0").replaceAll("/", "~1");

function describeValue(value: unknown): string {
  if (value === undefined) return "undefined";
  if (typeof value === "number") return String(value); // NaN, Infinity, -Infinity
  if (typeof value !== "object" || value === null) return typeof value;
  const name = Object.getPrototypeOf(value)?.constructor?.name;
  return typeof name === "string" && name !== ""
    ? `a ${name} instance`
    : "an exotic object";
}

const issue = (
  code: "invalid-input" | "too-deep" | "too-large",
  instancePath: string,
  message: string,
): SpecIssue => ({ code, severity: "error", instancePath, message });

function isPlainObject(value: object): boolean {
  const proto: unknown = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/**
 * Copies a code-first value into fresh plain JSON data in a single pass, so the
 * object that is validated is exactly the object that is returned (getters are
 * read once; later mutation of the input cannot change the result).
 *
 * JSON semantics: own enumerable string keys only, and object properties whose
 * value is `undefined` are omitted. Anything JSON cannot represent faithfully is
 * an `invalid-input` issue: functions, symbols, bigints, non-finite numbers,
 * `undefined` or holes in arrays, and non-plain objects (Date, Map, class
 * instances), and values whose getter or Proxy trap throws (the walk never
 * throws). Nesting and size use the reference loader's limits, so the walk
 * (iterative) also stops cycles and shared-reference blow-ups.
 */
export function cloneAsJson(input: unknown): CloneResult {
  const { maxDepth, maxBytes } = DEFAULT_LIMITS;
  const issues: SpecIssue[] = [];
  let budget = maxBytes;
  const tooLarge: CloneResult = {
    ok: false,
    issues: [issue("too-large", "", `input exceeds ${maxBytes} bytes`)],
  };
  const root: { value?: unknown } = {};
  type Frame = {
    value: unknown;
    path: string;
    depth: number;
    assign: (v: unknown) => void;
  };
  const stack: Frame[] = [
    { value: input, path: "", depth: 0, assign: (v) => (root.value = v) },
  ];

  let at = "";
  try {
    return walk();
  } catch {
    // A throwing getter, a revoked Proxy or a Proxy trap. The error text is not
    // copied: it is caller-controlled and may repeat document content.
    return {
      ok: false,
      issues: [
        issue("invalid-input", at, "value could not be read as JSON data"),
      ],
    };
  }

  function walk(): CloneResult {
    while (stack.length > 0) {
      const { value, path, depth, assign } = stack.pop() as Frame;
      at = path;
      // Every value costs at least one byte of JSON; a string costs its length.
      budget -= 1 + (typeof value === "string" ? value.length : 0);
      if (budget < 0) return tooLarge;
      if (
        value === null ||
        typeof value === "boolean" ||
        typeof value === "string"
      ) {
        assign(value);
      } else if (typeof value === "number" && Number.isFinite(value)) {
        assign(value);
      } else if (
        typeof value === "object" &&
        (Array.isArray(value) || isPlainObject(value))
      ) {
        if (depth >= maxDepth) {
          return {
            ok: false,
            issues: [
              issue("too-deep", path, `nesting exceeds ${maxDepth} levels`),
            ],
          };
        }
        const size = Array.isArray(value)
          ? value.length
          : Object.keys(value).length;
        if (size > budget) return tooLarge;
        if (Array.isArray(value)) {
          const out: unknown[] = new Array<unknown>(value.length);
          assign(out);
          for (let i = value.length - 1; i >= 0; i--) {
            const itemPath = `${path}/${i}`;
            if (!(i in value)) {
              issues.push(
                issue(
                  "invalid-input",
                  itemPath,
                  "array holes are not JSON data",
                ),
              );
              continue;
            }
            stack.push({
              value: value[i],
              path: itemPath,
              depth: depth + 1,
              assign: (v) => (out[i] = v),
            });
          }
        } else {
          const out: Record<string, unknown> = {};
          assign(out);
          const entries = Object.entries(value).filter(
            ([, v]) => v !== undefined,
          );
          // Keys are defined up front, in source order; values are filled in as the
          // walk reaches them. defineProperty keeps an own "__proto__" key a plain
          // key (the loader then rejects it as forbidden-key).
          for (const [key] of entries) {
            Object.defineProperty(out, key, {
              value: null,
              enumerable: true,
              writable: true,
              configurable: true,
            });
          }
          for (let i = entries.length - 1; i >= 0; i--) {
            const [key, child] = entries[i] as [string, unknown];
            stack.push({
              value: child,
              path: `${path}/${escapePointer(key)}`,
              depth: depth + 1,
              assign: (v) => Object.defineProperty(out, key, { value: v }),
            });
          }
        }
      } else {
        issues.push(
          issue(
            "invalid-input",
            path,
            `${describeValue(value)} is not JSON data`,
          ),
        );
      }
    }
    return issues.length > 0
      ? { ok: false, issues }
      : { ok: true, value: root.value };
  }
}

/** Freezes a JSON value and everything inside it (iteratively). */
export function deepFreeze<T>(value: T): T {
  const stack: unknown[] = [value];
  while (stack.length > 0) {
    const node = stack.pop();
    if (node !== null && typeof node === "object" && !Object.isFrozen(node)) {
      Object.freeze(node);
      for (const child of Object.values(node)) stack.push(child);
    }
  }
  return value;
}
