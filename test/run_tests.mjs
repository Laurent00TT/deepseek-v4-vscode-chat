// Runs one family of suites in alphabetical order, fail-fast:
//   node test/run_tests.mjs unit     → test/unit_*.mjs    (plain Node, no vscode)
//   node test/run_tests.mjs adapter  → test/adapter_*.mjs (vscode shim preload)
// Adding a suite is just adding a file — no package.json edit.
import { readdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const family = process.argv[2];
if (family !== "unit" && family !== "adapter") {
	console.error("usage: node test/run_tests.mjs <unit|adapter>");
	process.exit(2);
}
const testDir = path.dirname(fileURLToPath(import.meta.url));
const files = readdirSync(testDir)
	.filter((f) => f.startsWith(`${family}_`) && f.endsWith(".mjs"))
	.sort();
if (files.length === 0) {
	console.error(`run_tests: no test/${family}_*.mjs files found`);
	process.exit(1);
}
const preload = family === "adapter" ? ["--require", path.join(testDir, "vscode_shim", "register.cjs")] : [];
for (const f of files) {
	console.log(`\n### ${f}`);
	const r = spawnSync(process.execPath, [...preload, path.join(testDir, f)], { stdio: "inherit" });
	if (r.status !== 0) {
		console.error(`run_tests: ${f} exited with ${r.status}`);
		process.exit(r.status ?? 1);
	}
}
console.log(`\nrun_tests: ${files.length} ${family} suites passed`);
