import * as assert from "node:assert";
import * as vscode from "vscode";
import { CONFIG_SECTION, NUMBER_SETTING_SPECS, type NumberSettingId } from "../../../shared/config/settingSpec";

suite("Timeout Configuration", () => {
	// The extension host registered package.json's contributed configuration;
	// this pins the registered defaults to the shared setting spec
	// (settingSpec.test.ts pins the same numbers against the file on disk).
	test("the registered timeout defaults match the setting spec", () => {
		const config = vscode.workspace.getConfiguration(CONFIG_SECTION);
		const keys: readonly NumberSettingId[] = ["chat.timeout", "discovery.timeout"];
		for (const key of keys) {
			const defaultValue = config.inspect<number>(key)?.defaultValue;
			assert.strictEqual(defaultValue, NUMBER_SETTING_SPECS[key].default, `${key} registered default`);
		}
	});
});
