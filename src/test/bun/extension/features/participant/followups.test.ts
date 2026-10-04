/**
 * The followups a finished turn offers. That every one of them routes to a registered command is a compile-time fact
 * (ParticipantFollowup.command is SlashCommandName); what remains to pin is the offer rule itself.
 */
import { describe, expect, test } from "bun:test";
import { participantFollowups } from "../../../../../extension/features/participant/followups";

describe("extension/features/participant followups", () => {
	test("a plain turn offers the first two of the table", () => {
		expect(participantFollowups({}).map((followup) => followup.command)).toEqual(["tests", "docs"]);
	});

	test("the command that just ran is never offered again", () => {
		for (const command of ["tests", "docs", "models"]) {
			expect(participantFollowups({ command }).map((followup) => followup.command)).not.toContain(command);
		}
	});

	test("filtering the head still yields two, so the cap is not paid twice", () => {
		expect(participantFollowups({ command: "tests" }).map((followup) => followup.command)).toEqual(["docs", "models"]);
	});

	test("a failed turn offers none", () => {
		expect(participantFollowups({ failed: true })).toEqual([]);
		expect(participantFollowups({ command: "tests", failed: true })).toEqual([]);
	});

	test("never more than two, and every entry carries a label and a prompt", () => {
		for (const command of [undefined, "tests", "docs", "models", "unknown-command"]) {
			const followups = participantFollowups({ command });
			expect(followups.length).toBeLessThanOrEqual(2);
			for (const followup of followups) {
				expect(followup.label.trim()).not.toBe("");
				expect(followup.prompt.trim()).not.toBe("");
			}
		}
	});
});
