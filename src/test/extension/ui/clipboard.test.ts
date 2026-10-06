import * as assert from "node:assert";
import { copyToClipboard } from "../../../extension/ui/clipboard";
import { Logger } from "../../../shared/logger";

suite("extension/ui/clipboard", () => {
	function recorder(): { written: string[]; clipboard: { writeText(text: string): Thenable<void> } } {
		const written: string[] = [];
		return {
			written,
			clipboard: {
				writeText: async (text: string) => {
					written.push(text);
				},
			},
		};
	}

	// The door is the one place clipboard text is masked, so it must change nothing in text that carries no value:
	// a byte lost here would be a byte lost from every Copy diagnostics, PR draft, and compacted report.
	test("secret-free text reaches the clipboard byte for byte", async () => {
		const { written, clipboard } = recorder();
		const text = "Prod (http://localhost:4000/v1): 401 at /home/alice\n\tTab, trailing space \n";
		await copyToClipboard(text, clipboard);
		assert.deepStrictEqual(written, [text]);
	});

	test("a registered value and a URL's userinfo are masked before the write", async () => {
		const { written, clipboard } = recorder();
		Logger.registerSecrets(["copy-key-Q7-marker"]);
		await copyToClipboard(
			"Prod (http://user:sekret@localhost:4000): 401 for copy-key-Q7-marker at /home/alice",
			clipboard
		);
		assert.deepStrictEqual(written, ["Prod (http://[redacted]@localhost:4000): 401 for [redacted] at /home/alice"]);
	});
});
