// License policy for sirb-js dependencies (SRS 12: PR stage, license check).
//
// Verdicts for a single SPDX license id:
//   "deny"   - GPL and AGPL (any version, -only/-or-later/+ and WITH exceptions).
//              Strong copyleft is incompatible with shipping Sirb's Apache-2.0 packages.
//   "review" - LGPL (any version) and unknown/missing licenses. LGPL is *not* allowed by
//              default: our packages are bundled by downstream apps (e.g. @sirb/react in a
//              browser bundle), which turns "dynamic linking" into static combination and
//              triggers LGPL relinking obligations. Each LGPL dependency therefore needs an
//              explicit, versioned entry in scripts/license-allowlist.json with a reason.
//              Unknown licenses fail closed for the same reason.
//   "allow"  - everything else (MIT, Apache-2.0, BSD, ISC, MPL-2.0, BlueOak, ...).
//
// SPDX expressions are evaluated properly: "(MIT OR GPL-3.0)" is allowed because we can
// choose MIT; "MIT AND GPL-3.0" is denied because both apply.

const RANK = { allow: 0, review: 1, deny: 2 };

/** Classify one SPDX license id (no operators). */
export function classifyId(rawId) {
  const id = rawId.trim().replace(/^\(+|\)+$/g, "");
  if (
    !id ||
    /^(unknown|unlicensed)$/i.test(id) ||
    /^see licen[cs]e in/i.test(id)
  ) {
    return "review";
  }
  // Order matters: LGPL contains "GPL".
  if (/^LGPL|\bLGPL|lesser general public/i.test(id)) return "review";
  if (/^A?GPL|\bA?GPL(v?\d)?\b|general public license/i.test(id)) return "deny";
  return "allow";
}

function tokenize(expr) {
  return expr
    .replace(/\(/g, " ( ")
    .replace(/\)/g, " ) ")
    .split(/\s+/)
    .filter(Boolean);
}

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
    if (tokens[pos]?.toUpperCase() === "WITH") pos += 2; // exception does not relax policy
    return v;
  }
  function parseAtom() {
    const t = tokens[pos++];
    if (t === undefined) return "review";
    if (t === "(") {
      const v = parseOr();
      if (tokens[pos] === ")") pos++;
      return v;
    }
    return classifyId(t);
  }

  const verdict = parseOr();
  return pos < tokens.length ? worst(verdict, "review") : verdict;
}

/**
 * Check `pnpm licenses list --json` output against the policy.
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
        if (allowed.has(key)) exceptionsUsed.push({ key, license, verdict });
        else violations.push({ key, license, verdict });
      }
    }
  }
  return { violations, exceptionsUsed };
}
