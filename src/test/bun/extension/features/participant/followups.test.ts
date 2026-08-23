/**
 * The followups a finished turn offers, and the fail-closed pin that every one
 * of them routes somewhere: a followup naming a command the manifest does not
 * contribute is a button that does nothing when clicked, which no amount of
 * care at the call site prevents.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import { participantFollowups } from "../../../../../extension/features/participant/followups";
import { PARTICIPANT_ID } from "../../../../../shared/config/commandIds";
import { REPO_ROOT } from "../../../../util/repoRoot";

/** The participant command names package.json contributes. */
function contributedCommandNames(): string[] {
	const manifest = JSON.parse(readFileSync(path.join(REPO_ROOT, "package.json"), "utf8")) as {
		contributes: { chatParticipants?: readonly { id: string; commands?: readonly { name: string }[] }[] };
	};
	const participant = (manifest.contributes.chatParticipants ?? []).find((entry) => entry.id === PARTICIPANT_ID);
	expect(participant, `package.json contributes no chat participant with id ${PARTICIPANT_ID}`).toBeDefined();
	return (participant?.commands ?? []).map((command) => command.name);
}

describe("extension/features/participant followups", () => {
	test("every followup routes to a contributed command", () => {
		const contributed = new Set(contributedCommandNames());
		// Over the whole table, not just one call: the filter must never be what
		// hides an uncontributed entry.
		const everyFollowup = [
			...participantFollowups({}),
			...participantFollowups({ command: "tests" }),
			...participantFollowups({ command: "docs" }),
			...participantFollowups({ command: "models" }),
		];
		expect(everyFollowup.length).toBeGreaterThan(0);
		for (const followup of everyFollowup) {
			expect(contributed.has(followup.command), `followup /${followup.command} is not contributed`).toBe(true);
		}
	});

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
