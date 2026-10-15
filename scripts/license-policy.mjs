// License policy for sirb-js dependencies (SRS 12: PR stage, license check).
//
// Verdicts for a single SPDX license id:
//   "deny"   - GPL and AGPL (any version, -only/-or-later/+ and WITH exceptions), SSPL and
//              non-commercial Creative Commons licenses. Strong/network copyleft and
//              non-commercial terms are incompatible with shipping Sirb's Apache-2.0
//              packages. A deny can never be allowlisted.
//   "allow"  - the explicit list of permissive licenses in ALLOWED below.
//   "review" - everything else: LGPL, EUPL, OSL, RPL, CC-*-ND, unknown or missing licenses.
//              LGPL is *not* allowed by default: our packages are bundled by downstream apps
//              (e.g. @sirb/react in a browser bundle), which turns "dynamic linking" into
//              static combination and triggers LGPL relinking obligations. Each "review"
//              dependency therefore needs an explicit, versioned entry in
//              scripts/license-allowlist.json with a reason. The policy fails closed: a
//              license that is not known to be permissive needs a human decision.
//
// SPDX expressions are evaluated properly: "(MIT OR GPL-3.0)" is allowed because we can
// choose MIT; "MIT AND GPL-3.0" is denied because both apply. Strings that are not valid
// SPDX expressions (e.g. "GNU GPL v3") are judged as free text: denied if they mention
// GPL/AGPL, otherwise sent to review.

const RANK = { allow: 0, review: 1, deny: 2 };

/** Permissive SPDX ids (compared case-insensitively). Add to this list only after review. */
const ALLOWED = new Set(
  [
    "0BSD",
    "Apache-2.0",
    "BlueOak-1.0.0",
    "BSD-2-Clause",
    "BSD-3-Clause",
    "BSD-3-Clause-Clear",
    "BSL-1.0",
    "CC-BY-3.0",
    "CC-BY-4.0",
    "CC0-1.0",
    "ISC",
    "MIT",
    "MIT-0",
    "MPL-2.0",
    "Python-2.0",
    "Unlicense",
    "Zlib",
  ].map((id) => id.toLowerCase()),
);

const DENY_ID = /^(A?GPL|SSPL)|^CC-.*-NC\b/i;

/** Mentions of GPL/AGPL in free text, after LGPL mentions have been removed. */
const DENY_TEXT =
  /\bA?GPL|affero|general public licen[cs]e|\bSSPL\b|server side public/i;
const LGPL_TEXT =
  /\bLGPL\S*|lesser general public licen[cs]e|library general public licen[cs]e/gi;

/** SPDX license id or LicenseRef, e.g. "GPL-2.0+", "LicenseRef-Foo". */
const ID_TOKEN = /^[A-Za-z0-9][A-Za-z0-9.+-]*$/;

/** Classify one SPDX license id (no operators). */
export function classifyId(rawId) {
  const id = rawId.trim().replace(/^\(+|\)+$/g, "");
  if (DENY_ID.test(id)) return "deny";
  if (ALLOWED.has(id.toLowerCase())) return "allow";
  return "review";
}

/** Classify a license string that is not a valid SPDX expression. */
export function classifyFreeText(text) {
  return DENY_TEXT.test(text.replace(LGPL_TEXT, " ")) ? "deny" : "review";
}

function tokenize(expr) {
  return expr
    .replace(/\(/g, " ( ")
    .replace(/\)/g, " ) ")
    .split(/\s+/)
    .filter(Boolean);
}

class SpdxSyntaxError extends Error {}

/**
 * Evaluate an SPDX expression. OR picks the most permissive option,
 * AND takes the most restrictive, WITH keeps the base license's verdict.
 */
export function classifyExpression(expr) {
  if (typeof expr !== "string" || expr.trim() === "") return "review";
  const tokens = tokenize(expr);
  let pos = 0;
  const worst = (a, b) => (RANK[a] >= RANK[b] ? a : b);
  const best = (a, b) => (RANK[a] <= RANK[b] ? a : b);
  const isOp = (t) => /^(AND|OR|WITH)$/i.test(t ?? "");

  function parseOr() {
    let v = parseAnd();
    while (tokens[pos]?.toUpperCase() === "OR") {
      pos++;
      v = best(v, parseAnd());
    }
    return v;
  }
  function parseAnd() {
    let v = parseWith();
    while (tokens[pos]?.toUpperCase() === "AND") {
      pos++;
      v = worst(v, parseWith());
    }
    return v;
  }
  function parseWith() {
    const v = parseAtom();
    if (tokens[pos]?.toUpperCase() === "WITH") {
      pos++;
      const exception = tokens[pos++];
      // An exception does not relax policy, but it must be present.
      if (
        exception === undefined ||
        isOp(exception) ||
        !ID_TOKEN.test(exception)
      )
        throw new SpdxSyntaxError("bad WITH");
    }
    return v;
  }
  function parseAtom() {
    const t = tokens[pos++];
    if (t === "(") {
      const v = parseOr();
      if (tokens[pos++] !== ")") throw new SpdxSyntaxError("missing )");
      return v;
    }
    if (t === undefined || isOp(t) || !ID_TOKEN.test(t))
      throw new SpdxSyntaxError("missing operand");
    return classifyId(t);
  }

  try {
    const verdict = parseOr();
    if (pos < tokens.length) throw new SpdxSyntaxError("trailing tokens");
    return verdict;
  } catch (err) {
    if (err instanceof SpdxSyntaxError) return classifyFreeText(expr);
    throw err;
  }
}

/**
 * Check `pnpm licenses list --json` output against the policy.
 * Allowlist entries only apply to "review" verdicts; "deny" is always a violation.
 * @param {Record<string, Array<{name: string, versions: string[], license?: string}>>} report
 * @param {Array<{name: string, version: string, reason: string}>} allowlist
 */
export function checkReport(report, allowlist = []) {
  const allowed = new Set(allowlist.map((e) => `${e.name}@${e.version}`));
  const violations = [];
  const exceptionsUsed = [];
  for (const [groupLicense, pkgs] of Object.entries(report)) {
    for (const pkg of pkgs) {
      const license = pkg.license ?? groupLicense;
      const verdict = classifyExpression(license);
      if (verdict === "allow") continue;
      for (const version of pkg.versions) {
        const key = `${pkg.name}@${version}`;
        const allowlisted = allowed.has(key);
        if (verdict === "review" && allowlisted)
          exceptionsUsed.push({ key, license, verdict });
        else violations.push({ key, license, verdict, allowlisted });
      }
    }
  }
  return { violations, exceptionsUsed };
}
