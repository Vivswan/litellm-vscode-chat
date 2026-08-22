/**
 * The endpoint table's WIRE_LIMITS against the surface that cannot import it:
 * package.json is JSON, so the manifest maxLength of each honest-input-bounded
 * setting mirrors its WIRE_LIMITS entry by these pins instead of by reference.
 */
import { expect, test } from "bun:test";
import packageJson from "../../../../package.json";
import { WIRE_LIMITS } from "../../../dashboard/endpoints";

function manifestProperty(id: string):
	| {
			maxLength?: number;
			maxItems?: number;
			items?: { maxLength?: number };
			properties?: Record<string, { maxItems?: number; items?: { maxLength?: number } }>;
	  }
	| undefined {
	const sections = packageJson.contributes.configuration as readonly {
		properties: Record<
			string,
			{
				maxLength?: number;
				maxItems?: number;
				items?: { maxLength?: number };
				properties?: Record<string, { maxItems?: number; items?: { maxLength?: number } }>;
			}
		>;
	}[];
	return sections.map((section) => section.properties[id]).find((candidate) => candidate !== undefined);
}

test("the manifest's usage.currencySymbol maxLength mirrors WIRE_LIMITS.currencySymbol", () => {
	const property = manifestProperty("litellm-vscode-chat.usage.currencySymbol");
	expect(property).toBeDefined();
	expect(property?.maxLength).toBe(WIRE_LIMITS.currencySymbol);
});

test("the manifest's commitGeneration.prompt maxLength mirrors WIRE_LIMITS.commitPrompt", () => {
	const property = manifestProperty("litellm-vscode-chat.commitGeneration.prompt");
	expect(property).toBeDefined();
	expect(property?.maxLength).toBe(WIRE_LIMITS.commitPrompt);
});

test("the manifest's languageFilter list bounds mirror WIRE_LIMITS.languageList and languageId", () => {
	const property = manifestProperty("litellm-vscode-chat.inlineCompletions.languageFilter");
	expect(property).toBeDefined();
	const languages = property?.properties?.languages;
	expect(languages).toBeDefined();
	expect(languages?.maxItems).toBe(WIRE_LIMITS.languageList);
	expect(languages?.items?.maxLength).toBe(WIRE_LIMITS.languageId);
});
