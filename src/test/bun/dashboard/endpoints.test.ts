/**
 * The endpoint table's WIRE_LIMITS against the surface that cannot import it:
 * package.json is JSON, so its currency-symbol maxLength mirrors
 * WIRE_LIMITS.currencySymbol by this pin instead of by reference.
 */
import { expect, test } from "bun:test";
import packageJson from "../../../../package.json";
import { WIRE_LIMITS } from "../../../dashboard/endpoints";

test("the manifest's usage.currencySymbol maxLength mirrors WIRE_LIMITS.currencySymbol", () => {
	const sections = packageJson.contributes.configuration as readonly {
		properties: Record<string, { maxLength?: number }>;
	}[];
	const property = sections
		.map((section) => section.properties["litellm-vscode-chat.usage.currencySymbol"])
		.find((candidate) => candidate !== undefined);
	expect(property).toBeDefined();
	expect(property?.maxLength).toBe(WIRE_LIMITS.currencySymbol);
});
