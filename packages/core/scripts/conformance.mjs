#!/usr/bin/env node
// Runs every sirb-spec conformance fixture through the built @sirb/core API and
// prints a pass/fail summary. Exits 1 on any failure (including unknown levels).
// Usage: pnpm --filter @sirb/core conformance  (builds first)
import { formatSummary, runConformance } from "../dist/conformance.js";

try {
  const summary = runConformance();
  console.log(formatSummary(summary));
  process.exitCode = summary.passed === summary.total ? 0 : 1;
} catch (error) {
  console.error(
    `conformance: ${error instanceof Error ? error.message : error}`,
  );
  process.exitCode = 1;
}
