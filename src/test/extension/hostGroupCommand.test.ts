import * as assert from "node:assert";
import * as vscode from "vscode";
import { createCaptureServer } from "../capture-server";

/**
 * Pins the host-side semantics of lm.addLanguageModelsProviderGroup, which
 * serverSync's reconciliation model and the dashboard's adopt flow depend on.
 * Probed empirically (VS Code 1.130.0): the command is strictly additive and
 * REJECTS a second add under an existing name instead of upserting, and the
 * provider-group command family holds only add-shaped commands (no update or
 * removal; those live in the native UI alone). serverSync therefore treats a
 * duplicate rejection for an unchanged entry as in-sync and surfaces an
 * actionable error for a changed one; if either test here starts failing,
 * the host grew new semantics and that tolerance should be revisited.
 */
suite("host provider-group command semantics", () => {
	test("the host registers no update or removal command in the provider-group family", async () => {
		const commands = await vscode.commands.getCommands(true);
		const groupCommands = commands.filter((id) => /languagemodelsprovidergroup/i.test(id));
		// Non-exhaustive on purpose: the pinned property is the ABSENCE of a
		// mutation path, not the exact family roster - an exhaustive list would
		// turn the required CI gate red the day the host ships an unrelated
		// group command. Both known members are add-shaped: `add` creates a
		// group from its arguments, `migrate` creates one from a legacy
		// registry server (driven by extension/migrations/registryToProviderGroups.ts).
		assert.ok(groupCommands.includes("lm.addLanguageModelsProviderGroup"), groupCommands.join(", "));
		assert.ok(groupCommands.includes("lm.migrateLanguageModelsProviderGroup"), groupCommands.join(", "));
		const mutators = groupCommands.filter((id) => /remove|delete|update/i.test(id));
		assert.deepStrictEqual(
			mutators,
			[],
			"the host grew a provider-group update/removal command; revisit serverSync's add-only tolerance"
		);
	});

	test("lm.addLanguageModelsProviderGroup rejects an existing name instead of upserting", async function () {
		this.timeout(30000);
		const server = createCaptureServer();
		await server.start();
		try {
			const name = `litellm-upsert-probe-${process.pid}`;
			const args = {
				name,
				vendor: "litellm",
				baseUrl: `http://127.0.0.1:${server.port}`,
				apiKey: "probe-key-1",
			};
			await vscode.commands.executeCommand("lm.addLanguageModelsProviderGroup", args);
			await assert.rejects(
				async () => {
					await vscode.commands.executeCommand("lm.addLanguageModelsProviderGroup", { ...args, apiKey: "probe-key-2" });
				},
				/already exists/i,
				"the host used to upsert by name; sync and adopt tolerance is built on the rejection"
			);
			// Still strictly additive, not globally broken: a fresh name lands.
			await vscode.commands.executeCommand("lm.addLanguageModelsProviderGroup", {
				...args,
				name: `${name}-b`,
			});
		} finally {
			await server.close();
		}
	});
});
