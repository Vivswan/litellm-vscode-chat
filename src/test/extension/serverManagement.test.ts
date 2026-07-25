import * as assert from "node:assert";
import * as vscode from "vscode";
import { warnAboutOrphanedModelParameters } from "../../extension/serverManagement";

suite("extension/serverManagement", () => {
	suite("warnAboutOrphanedModelParameters", () => {
		let toasts: { message: string; buttons: string[] }[];
		let restore: () => void;

		setup(() => {
			toasts = [];
			const origWarn = vscode.window.showWarningMessage;
			(vscode.window as Record<string, unknown>).showWarningMessage = async (message: string, ...buttons: string[]) => {
				toasts.push({ message, buttons });
				return undefined;
			};
			restore = () => {
				(vscode.window as Record<string, unknown>).showWarningMessage = origWarn;
			};
		});

		teardown(() => restore());

		test("warns when modelParameters keys are scoped to the old label", () => {
			warnAboutOrphanedModelParameters("Production", "Prod", ["Production/gpt-4", "Production/claude", "gpt-4"]);
			assert.strictEqual(toasts.length, 1);
			assert.ok(toasts[0].message.includes('"Production/"'), toasts[0].message);
			assert.ok(toasts[0].message.includes('"Prod/"'), toasts[0].message);
			assert.ok(toasts[0].message.includes("2 modelParameters entries"), toasts[0].message);
			assert.ok(toasts[0].message.includes('"Production/gpt-4"'), toasts[0].message);
			assert.deepStrictEqual(toasts[0].buttons, ["Open Settings", "Dismiss"]);
		});

		test("uses singular phrasing for a single orphaned entry", () => {
			warnAboutOrphanedModelParameters("Production", "Prod", ["Production/gpt-4"]);
			assert.strictEqual(toasts.length, 1);
			assert.ok(toasts[0].message.includes("1 modelParameters entry "), toasts[0].message);
		});

		test("does not warn when no keys use the old label prefix", () => {
			warnAboutOrphanedModelParameters("Production", "Prod", ["Staging/gpt-4", "gpt-4", "ProductionX/gpt-4"]);
			assert.strictEqual(toasts.length, 0);
		});

		test("does not warn when there are no modelParameters at all", () => {
			warnAboutOrphanedModelParameters("Production", "Prod", []);
			assert.strictEqual(toasts.length, 0);
		});

		test("matches only full label segments, not label substrings", () => {
			warnAboutOrphanedModelParameters("Prod", "Production", ["Prod-East/gpt-4"]);
			assert.strictEqual(toasts.length, 0);
		});
	});
});
