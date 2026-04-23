#!/usr/bin/env node
/**
 * Reads a Vitest JSON report and emits a GitHub Actions job summary
 * showing a provider × model × mode matrix. One row per test; ✓ / ✗ / ⏭
 * per column.
 *
 * Usage: node scripts/summarize-integration.mjs <report.json>
 */

import { readFileSync } from "node:fs";

const path = process.argv[2];
if (!path) {
  console.error("Usage: summarize-integration.mjs <report.json>");
  process.exit(2);
}

let report;
try {
  report = JSON.parse(readFileSync(path, "utf8"));
} catch (err) {
  console.error(`Could not read ${path}: ${err.message}`);
  process.exit(2);
}

// Vitest JSON reporter shape: { testResults: [{ assertionResults: [{ ancestorTitles, title, status }] }] }
const rows = [];
for (const file of report.testResults ?? []) {
  for (const tc of file.assertionResults ?? []) {
    rows.push({
      suite: tc.ancestorTitles?.[0] ?? "",
      title: tc.title ?? "",
      status: tc.status, // passed | failed | pending | skipped
    });
  }
}

// Group by suite (== "<provider> live API")
const bySuite = new Map();
for (const r of rows) {
  if (!bySuite.has(r.suite)) bySuite.set(r.suite, []);
  bySuite.get(r.suite).push(r);
}

const mark = (s) => (s === "passed" ? "✓" : s === "failed" ? "✗" : "⏭");

const lines = [];
lines.push("## Integration matrix");
lines.push("");
lines.push("| Provider | Model | /models | Non-stream | Stream |");
lines.push("|----------|-------|---------|------------|--------|");

const providers = [...bySuite.keys()].sort();
for (const suite of providers) {
  const provider = suite.replace(/ live API$/, "");
  const tests = bySuite.get(suite);
  const modelsTest = tests.find((t) => t.title.startsWith("GET /models"));
  const nonStream = tests.filter((t) => t.title.startsWith("non-streaming "));
  const stream = tests.filter((t) => t.title.startsWith("streaming "));

  if (nonStream.length === 0 && stream.length === 0) {
    lines.push(`| ${provider} | — | ${mark(modelsTest?.status ?? "skipped")} | — | — |`);
    continue;
  }
  // Row per model (pair non-stream/stream by title suffix "<verb> <model>:")
  const models = new Set();
  for (const t of [...nonStream, ...stream]) {
    const m = t.title.match(/^(?:non-streaming|streaming) (.+?): /);
    if (m) models.add(m[1]);
  }
  let first = true;
  for (const model of [...models].sort()) {
    const ns = nonStream.find((t) => t.title.includes(` ${model}:`));
    const st = stream.find((t) => t.title.includes(` ${model}:`));
    lines.push(
      `| ${provider} | ${model} | ${first ? mark(modelsTest?.status ?? "skipped") : "·"} | ${mark(ns?.status ?? "skipped")} | ${mark(st?.status ?? "skipped")} |`,
    );
    first = false;
  }
}

lines.push("");
lines.push(`Legend: ✓ passed · ✗ failed · ⏭ skipped (secret missing)`);

console.log(lines.join("\n"));
