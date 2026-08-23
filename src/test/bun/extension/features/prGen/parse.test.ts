import { describe, expect, test } from "bun:test";
import { parseTitleAndDescription } from "../../../../../extension/features/prGen/parse";

describe("extension/features/prGen parseTitleAndDescription", () => {
	test("the canonical two-part answer parses", () => {
		expect(parseTitleAndDescription("Title: Add MCP publishing\nDescription:\nAdds an MCP entry field.")).toEqual({
			kind: "parsed",
			title: "Add MCP publishing",
			description: "Adds an MCP entry field.",
		});
	});

	test("labels are case-insensitive and survive markdown emphasis, headings, and list bullets", () => {
		for (const reply of [
			"title: Add MCP publishing\ndescription: Adds an MCP entry field.",
			"**Title:** Add MCP publishing\n**Description:** Adds an MCP entry field.",
			"**Title**: Add MCP publishing\n**Description**: Adds an MCP entry field.",
			"## Title: Add MCP publishing\n## Description: Adds an MCP entry field.",
			"- Title: Add MCP publishing\n- Description: Adds an MCP entry field.",
		]) {
			expect(parseTitleAndDescription(reply)).toEqual({
				kind: "parsed",
				title: "Add MCP publishing",
				description: "Adds an MCP entry field.",
			});
		}
	});

	test("labels on their own lines take the following content", () => {
		expect(parseTitleAndDescription("Title:\nAdd MCP publishing\n\nDescription:\nAdds an MCP entry field.")).toEqual({
			kind: "parsed",
			title: "Add MCP publishing",
			description: "Adds an MCP entry field.",
		});
	});

	test("a missing Description label turns the remainder into the description", () => {
		expect(parseTitleAndDescription("Title: Add MCP publishing\n\nAdds an MCP entry field.\nSecond line.")).toEqual({
			kind: "parsed",
			title: "Add MCP publishing",
			description: "Adds an MCP entry field.\nSecond line.",
		});
	});

	test("no labels at all: first non-empty line is the title, the rest the description", () => {
		expect(parseTitleAndDescription("\nAdd MCP publishing\n\nAdds an MCP entry field.")).toEqual({
			kind: "parsed",
			title: "Add MCP publishing",
			description: "Adds an MCP entry field.",
		});
	});

	test("a title-only answer leaves the description undefined", () => {
		for (const reply of [
			"Title: Add MCP publishing",
			"Title: Add MCP publishing\nDescription:",
			"Add MCP publishing",
		]) {
			expect(parseTitleAndDescription(reply)).toEqual({
				kind: "parsed",
				title: "Add MCP publishing",
				description: undefined,
			});
		}
	});

	test("a fence around the whole reply is stripped; interior fences survive", () => {
		expect(
			parseTitleAndDescription("```markdown\nTitle: Add MCP publishing\nDescription: Adds a ```code``` sample.\n```")
		).toEqual({
			kind: "parsed",
			title: "Add MCP publishing",
			description: "Adds a ```code``` sample.",
		});
	});

	test("a lone opening fence costs its own line only - no block ever loses its closer", () => {
		// The prompt asks for markdown, so a description may legitimately carry a
		// code block. When the model drops the OUTER closer, removing the opener
		// as a pair would take the inner block's closer with it and the rest of
		// the PR body would render as code. The fixture must therefore NOT end
		// with a fence, or the whole-reply rule applies and proves nothing.
		const parsed = parseTitleAndDescription(
			"```text\nTitle: Add retry\nDescription:\nUse:\n```ts\nretry(3)\n```\nThat is all."
		);
		expect(parsed.kind).toBe("parsed");
		// The opener line is gone, so it cannot become the title...
		expect(parsed.kind === "parsed" && parsed.title).toBe("Add retry");
		const description = parsed.kind === "parsed" ? (parsed.description ?? "") : "";
		// ...and the inner block keeps BOTH of its own fences.
		expect(description).toContain("```ts");
		expect(description).toContain("retry(3)");
		expect(description.match(/^```/gm)?.length).toBe(2);
		expect(description).toContain("That is all.");
	});

	test("a description ENDING in a code block keeps that block's closer", () => {
		// Three fence lines, first and last among them: judging by first-and-last
		// alone calls this a single fenced block and hands it to the stripper,
		// which then removes the description's own closing fence and leaves the
		// rest of the PR body rendering as code.
		const parsed = parseTitleAndDescription("```markdown\nTitle: Add retry\nDescription:\nUse:\n```ts\nretry(3)\n```");
		expect(parsed.kind).toBe("parsed");
		expect(parsed.kind === "parsed" && parsed.title).toBe("Add retry");
		const description = parsed.kind === "parsed" ? (parsed.description ?? "") : "";
		// Both of the inner block's fences survive.
		expect(description.match(/^```/gm)?.length).toBe(2);
		expect(description.endsWith("```")).toBe(true);
	});

	test("a bare-fenced title plus a description ending in a code block loses neither fence", () => {
		// No outer wrapper at all, yet the reply both starts and ends with a
		// fence: the shape that first-and-last judging gets most wrong.
		const parsed = parseTitleAndDescription("```\nfeat: add retry\n```\n\nBody text.\n\n```ts\nretry(3)\n```");
		expect(parsed.kind).toBe("parsed");
		expect(parsed.kind === "parsed" && parsed.title).toBe("feat: add retry");
		const description = parsed.kind === "parsed" ? (parsed.description ?? "") : "";
		// The title block's closer is furniture and goes; the description's own
		// block keeps both of its fences.
		expect(description.startsWith("```")).toBe(false);
		expect(description).toContain("Body text.");
		expect(description.match(/^```/gm)?.length).toBe(2);
		expect(description.endsWith("```")).toBe(true);
	});

	test("a description's OWN language-less code block is never mistaken for the title's closer", () => {
		// The furniture rule only takes a fence sitting immediately after the
		// title. Here a Description: label stands between, so the fence is the
		// description's own opener and must stay.
		const parsed = parseTitleAndDescription(
			"```markdown\nTitle: Add retry\nDescription:\n```\nplain code\n```\nMore body."
		);
		expect(parsed.kind).toBe("parsed");
		expect(parsed.kind === "parsed" && parsed.title).toBe("Add retry");
		const description = parsed.kind === "parsed" ? (parsed.description ?? "") : "";
		expect(description.startsWith("```")).toBe(true);
		expect(description).toContain("plain code");
		expect(description).toContain("More body.");
		expect(description.match(/^```/gm)?.length).toBe(2);
	});

	test("a TAGGED lone opener does not become the title", () => {
		// The regression the line-only rule exists to prevent: leaving the opener
		// in made "```markdown" the title and pushed the real answer, labels and
		// all, into the description.
		const parsed = parseTitleAndDescription("```markdown\nTitle: Add retry\nDescription:\nBody.");
		expect(parsed).toEqual({ kind: "parsed", title: "Add retry", description: "Body." });
	});

	test("a fenced reply with no label parses without leaving an orphan closer", () => {
		const parsed = parseTitleAndDescription("```\nfeat: add retry\n```\n\nThis PR retries uploads.");
		expect(parsed.kind).toBe("parsed");
		// Not stripped (the fence does not wrap the WHOLE reply), so no orphan
		// closer can end up at the head of the description.
		expect(parsed.kind === "parsed" && (parsed.description ?? "")).not.toMatch(/^```/);
	});

	test("markdown noise wrapping the title itself is cleaned", () => {
		for (const reply of ['Title: "Add MCP publishing"', "Title: **Add MCP publishing**", "# Add MCP publishing"]) {
			const parsed = parseTitleAndDescription(reply);
			expect(parsed.kind).toBe("parsed");
			expect(parsed.kind === "parsed" && parsed.title).toBe("Add MCP publishing");
		}
	});

	test("a description-only answer promotes the description's first line to the title", () => {
		expect(parseTitleAndDescription("Description: Adds an MCP entry field.\nSecond line.")).toEqual({
			kind: "parsed",
			title: "Adds an MCP entry field.",
			description: "Second line.",
		});
		expect(parseTitleAndDescription("Title:\nDescription: Adds an MCP entry field.")).toEqual({
			kind: "parsed",
			title: "Adds an MCP entry field.",
			description: undefined,
		});
	});

	test("blank and unusable replies are the empty variant, carrying nothing", () => {
		for (const reply of ["", "   \n\t", "```\n\n```", "Title:", "Title:\nDescription:"]) {
			expect(parseTitleAndDescription(reply)).toEqual({ kind: "empty" });
		}
	});

	test("CRLF replies parse the same as LF", () => {
		expect(
			parseTitleAndDescription("Title: Add MCP publishing\r\nDescription:\r\nAdds an MCP entry field.\r\n")
		).toEqual({
			kind: "parsed",
			title: "Add MCP publishing",
			description: "Adds an MCP entry field.",
		});
	});

	test("a one-line preamble before the labels is dropped", () => {
		expect(
			parseTitleAndDescription(
				"Sure! Here is a suggestion:\n\nTitle: Add MCP publishing\nDescription: Adds an MCP entry field."
			)
		).toEqual({
			kind: "parsed",
			title: "Add MCP publishing",
			description: "Adds an MCP entry field.",
		});
	});

	test("a noise-only first line does not block the title label behind it", () => {
		for (const noise of ["#", "---", "***", ">", "___", "- -"]) {
			expect(
				parseTitleAndDescription(`${noise}\nTitle: Add MCP publishing\nDescription: Adds an MCP entry field.`)
			).toEqual({
				kind: "parsed",
				title: "Add MCP publishing",
				description: "Adds an MCP entry field.",
			});
		}
	});

	test("noise-only lines never become the title", () => {
		expect(parseTitleAndDescription("---\nAdd MCP publishing\n\nBody.")).toEqual({
			kind: "parsed",
			title: "Add MCP publishing",
			description: "Body.",
		});
		expect(parseTitleAndDescription("Title:\n---\nAdd MCP publishing")).toEqual({
			kind: "parsed",
			title: "Add MCP publishing",
			description: undefined,
		});
		expect(parseTitleAndDescription("---\n#")).toEqual({ kind: "empty" });
	});

	test("a description answered before the title is kept, not dropped", () => {
		expect(parseTitleAndDescription("Description: Adds an MCP entry field.\nTitle: Add MCP publishing")).toEqual({
			kind: "parsed",
			title: "Add MCP publishing",
			description: "Adds an MCP entry field.",
		});
	});

	test("content between the title and a later Description label is preserved", () => {
		expect(parseTitleAndDescription("Title: Add MCP publishing\nOpening summary\nDescription: details")).toEqual({
			kind: "parsed",
			title: "Add MCP publishing",
			description: "Opening summary\nDescription: details",
		});
	});

	test("a noise separator before the Description label does not leak the label into the body", () => {
		expect(
			parseTitleAndDescription("Title: Add MCP publishing\n\n---\n\nDescription: Adds an MCP entry field.")
		).toEqual({
			kind: "parsed",
			title: "Add MCP publishing",
			description: "Adds an MCP entry field.",
		});
	});

	test("a label-looking line deep in the body cannot hijack the title", () => {
		expect(parseTitleAndDescription("Add MCP publishing\n\nBody line.\n- title: renamed field\nmore body")).toEqual({
			kind: "parsed",
			title: "Add MCP publishing",
			description: "Body line.\n- title: renamed field\nmore body",
		});
	});

	test("a label-looking second line cannot hijack when the first line is the title", () => {
		expect(
			parseTitleAndDescription("Update the settings labels\n- Title: renamed to Model\n- Description: reworded")
		).toEqual({
			kind: "parsed",
			title: "Update the settings labels",
			description: "- Title: renamed to Model\n- Description: reworded",
		});
		expect(parseTitleAndDescription("Add MCP publishing\n> Title: field added\nrest of body")).toEqual({
			kind: "parsed",
			title: "Add MCP publishing",
			description: "> Title: field added\nrest of body",
		});
	});

	test("delimiters that recur inside the title are not stripped", () => {
		for (const title of ["`--only` accepts `labels`", "**Fix** the **thing**", '"a" and "b"']) {
			expect(parseTitleAndDescription(`Title: ${title}`)).toEqual({ kind: "parsed", title, description: undefined });
		}
	});
});
