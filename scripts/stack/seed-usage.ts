#!/usr/bin/env bun
// scripts/stack/seed-usage.ts
//
// CLI over seedUsage.ts for callers that cannot await an import directly:
// scripts/docker-test.ts runs its legs synchronously, so it seeds the
// usage/budget fixture key by running this script after `up --wait`.

import { seedStackUsageBudgetKey } from "./seedUsage";

seedStackUsageBudgetKey().then(
	() => process.exit(0),
	(error) => {
		console.error(error);
		process.exit(1);
	}
);
