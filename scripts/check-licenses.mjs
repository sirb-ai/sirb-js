#!/usr/bin/env node
// Fails when any installed dependency (production or development) is GPL/AGPL, or is
// LGPL/unknown without an explicit entry in scripts/license-allowlist.json.
// Policy and rationale: scripts/license-policy.mjs.
//
// Known limitation: `pnpm licenses list` only sees packages installed for the current
// platform, so optional platform-specific binaries for other OSes/CPUs (e.g.
// lightningcss-darwin-arm64 when CI runs on linux-x64) are not checked.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { checkReport } from "./license-policy.mjs";

const allowlist = JSON.parse(
  readFileSync(new URL("./license-allowlist.json", import.meta.url), "utf8"),
);
for (const e of allowlist) {
  if (!e.name || !e.version || !e.reason) {
    console.error(
      `license-allowlist.json: every entry needs name, version and reason`,
    );
    process.exit(2);
  }
}

const raw = execFileSync("pnpm", ["licenses", "list", "--json"], {
  encoding: "utf8",
  maxBuffer: 64 * 1024 * 1024,
});
const report = JSON.parse(raw);
const total = Object.values(report).reduce((n, pkgs) => n + pkgs.length, 0);
const { violations, exceptionsUsed } = checkReport(report, allowlist);

for (const e of exceptionsUsed) {
  console.log(`allowlisted: ${e.key} (${e.license})`);
}
if (violations.length > 0) {
  console.error(`License policy violations (${violations.length}):`);
  for (const v of violations) {
    const note = v.allowlisted
      ? " [allowlist entry ignored: deny cannot be allowlisted]"
      : "";
    console.error(
      `  ${v.verdict.toUpperCase()}: ${v.key} (${v.license})${note}`,
    );
  }
  console.error(
    "GPL/AGPL, SSPL and non-commercial licenses are never allowed. Other non-permissive or unknown licenses need a reviewed entry in scripts/license-allowlist.json.",
  );
  process.exit(1);
}
console.log(
  `License check passed: ${total} packages, ${Object.keys(report).length} license groups.`,
);
