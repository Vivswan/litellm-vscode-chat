#!/usr/bin/env bun
// scripts/dev/seed-demo-usage.ts
//
// CLI over seedDemoUsage.ts for callers that cannot await an import directly
// (the same pattern as scripts/stack/seed-usage.ts): the dev launcher runs
// its legs synchronously, so it seeds the demo usage keys by running this
// script after the stack is up. `--out <path>` writes the measured results
// as JSON for the launcher to turn into seed entries; without it the script
// is a standalone re-seeder (more spend, budgets re-pinned to the same
// fractions) against the running stack. One caveat standalone: the warning
// entry's `budget` lives in the dev profile's settings and only a full
// `bun run dev` re-pins it, so that one card drifts above its fraction
// until the next launch.

import { writeFileSync } from "node:fs";
import { composeSetting, readEnvFile, STACK_DEFAULTS } from "../stack/litellmConfig";
import { seedDemoUsage } from "./seedDemoUsage";

async function main(): Promise<void> {
	const envFile = readEnvFile();
	const port = composeSetting("LITELLM_PORT", STACK_DEFAULTS.LITELLM_PORT, envFile);
	const masterKey = composeSetting("LITELLM_MASTER_KEY", STACK_DEFAULTS.LITELLM_MASTER_KEY, envFile);
	const results = await seedDemoUsage(`http://localhost:${port}`, masterKey);
	const outFlag = process.argv.indexOf("--out");
	const outPath = outFlag >= 0 ? process.argv[outFlag + 1] : undefined;
	if (outPath !== undefined) {
		writeFileSync(outPath, `${JSON.stringify(results, null, "\t")}\n`);
	}
}

main().then(
	() => process.exit(0),
	(error) => {
		console.error(`[dev-usage] ${error instanceof Error ? error.message : error}`);
		process.exit(1);
	}
);
