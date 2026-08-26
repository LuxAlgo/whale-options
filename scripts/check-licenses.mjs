/*
  CI gate: every dependency in the lockfile must carry an allowlisted license.
  Allowlist: MIT, Apache-2.0, BSD family, ISC, MPL-2.0, CC0, Unlicense.
  Copyleft (GPL/AGPL/LGPL), SSPL, BUSL, Commons-Clause, and unknown licenses fail the build.
*/
import { execSync } from "node:child_process";

const ALLOWED = [
  /^MIT\b/i,
  /^Apache-2\.0\b/i,
  /^BSD\b/i,
  /^0BSD\b/i,
  /^BSD-[0-9]-Clause/i,
  /^ISC\b/i,
  /^MPL-2\.0\b/i,
  /^CC0/i,
  /^Unlicense\b/i,
];

/*
  Explicit exceptions, each awaiting or carrying LuxAlgo approval. Do not add
  entries silently; every addition needs review.
  - caniuse-lite (CC-BY-4.0): browser-support DATA consumed by browserslist at
    build time in the dashboard toolchain only; nothing from it ships in the
    published packages. Flagged for LuxAlgo review.
*/
const EXCEPTIONS = new Set(["caniuse-lite"]);

const raw = execSync("pnpm licenses list --json", {
  encoding: "utf8",
  maxBuffer: 64 * 1024 * 1024,
});
const report = JSON.parse(raw);

const bad = [];
let distinct = 0;
for (const [license, pkgs] of Object.entries(report)) {
  distinct += 1;
  // SPDX OR-expressions pass when any alternative is allowlisted.
  const alternatives = license.replace(/^\(|\)$/g, "").split(/\s+OR\s+/i);
  const ok = alternatives.some((alt) => ALLOWED.some((re) => re.test(alt.trim())));
  if (!ok) {
    for (const p of pkgs) {
      if (EXCEPTIONS.has(p.name)) continue;
      bad.push(`  ${p.name} ${(p.versions ?? []).join(", ")}  license: ${license}`);
    }
  }
}

if (bad.length > 0) {
  console.error("Disallowed or unknown dependency licenses:");
  console.error(bad.join("\n"));
  console.error("Replace the dependency or get explicit LuxAlgo approval before merging.");
  process.exit(1);
}
console.log(`dependency licenses ok: ${distinct} distinct license strings, all allowlisted`);
