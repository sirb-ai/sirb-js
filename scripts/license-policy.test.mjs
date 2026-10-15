import assert from "node:assert/strict";
import { test } from "node:test";
import {
  checkReport,
  classifyExpression,
  classifyId,
} from "./license-policy.mjs";

test("permissive licenses are allowed", () => {
  for (const id of [
    "MIT",
    "Apache-2.0",
    "BSD-3-Clause",
    "ISC",
    "MPL-2.0",
    "BlueOak-1.0.0",
  ]) {
    assert.equal(classifyId(id), "allow", id);
  }
});

test("GPL and AGPL are denied in every spelling", () => {
  for (const id of [
    "GPL-2.0",
    "GPL-2.0-only",
    "GPL-3.0-or-later",
    "GPL-2.0+",
    "GPLv3",
    "AGPL-3.0-only",
    "AGPL-1.0",
  ]) {
    assert.equal(classifyId(id), "deny", id);
  }
});

test("LGPL and unknown need review, never silently allowed", () => {
  for (const id of [
    "LGPL-2.1-only",
    "LGPL-3.0-or-later",
    "LGPL-2.0+",
    "Unknown",
    "UNLICENSED",
    "SEE LICENSE IN LICENSE.md",
    "",
  ]) {
    assert.equal(classifyExpression(id), "review", id);
  }
});

test("SPDX expressions: OR picks the permissive option, AND the restrictive one", () => {
  assert.equal(classifyExpression("(MIT OR GPL-3.0-or-later)"), "allow");
  assert.equal(classifyExpression("(AFL-2.1 OR BSD-3-Clause)"), "allow");
  assert.equal(classifyExpression("MIT AND GPL-3.0-only"), "deny");
  assert.equal(
    classifyExpression("(MIT AND LGPL-2.1-only) OR Apache-2.0"),
    "allow",
  );
  assert.equal(
    classifyExpression("MIT AND (LGPL-2.1-only OR GPL-2.0-only)"),
    "review",
  );
  assert.equal(
    classifyExpression("GPL-2.0-only WITH Classpath-exception-2.0"),
    "deny",
  );
});

test("checkReport flags violations and honours exact name@version allowlist entries", () => {
  const report = {
    MIT: [{ name: "a", versions: ["1.0.0"], license: "MIT" }],
    "GPL-3.0": [{ name: "b", versions: ["2.0.0"], license: "GPL-3.0" }],
    "LGPL-3.0": [
      { name: "c", versions: ["3.0.0", "3.1.0"], license: "LGPL-3.0" },
    ],
  };
  const allowlist = [{ name: "c", version: "3.0.0", reason: "reviewed" }];
  const { violations, exceptionsUsed } = checkReport(report, allowlist);
  assert.deepEqual(violations.map((v) => `${v.verdict}:${v.key}`).sort(), [
    "deny:b@2.0.0",
    "review:c@3.1.0",
  ]);
  assert.deepEqual(
    exceptionsUsed.map((e) => e.key),
    ["c@3.0.0"],
  );
});
