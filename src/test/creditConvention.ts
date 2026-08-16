/**
 * The crediting convention's shared grammar: a commit subject that resolves a
 * community report carries "(#N, thanks @login)", and every credited login must
 * have a row in ACKNOWLEDGMENTS.md. Shared by the history guard and the
 * commit-msg hook so the two enforcement layers cannot disagree about what
 * counts as a credit.
 */

/** The commit that introduced ACKNOWLEDGMENTS.md; subjects before it predate the convention and stay exempt. */
export const ACKNOWLEDGMENTS_BOUNDARY = "f2bc448402ad42f31fca74a5a9ec7d5359448d5e";

export const ACKNOWLEDGMENTS_FILE = "ACKNOWLEDGMENTS.md";

/** A GitHub login: alphanumeric with single interior hyphens. */
const LOGIN_SOURCE = "[A-Za-z0-9]+(?:-[A-Za-z0-9]+)*";

/**
 * A parenthesized credit group: one or more issue/PR refs, then "thanks" and a
 * list of @logins. Only logins inside such a group count - a subject that
 * merely mentions an @login, or thanks someone in prose, is not a credit.
 */
const CREDIT_GROUP = new RegExp(
	String.raw`\(#\d+(?:,\s*#\d+)*,\s*thanks\s+(@${LOGIN_SOURCE}(?:(?:,\s*(?:and\s+)?|\s+and\s+)@${LOGIN_SOURCE})*)\)`,
	"gi"
);

const LOGIN = new RegExp(`@(${LOGIN_SOURCE})`, "g");

export interface SubjectCredit {
	/** The login as written in the subject (GitHub logins are case-insensitive; lowercase before comparing). */
	readonly login: string;
	/** The issue/PR numbers of the credit group the login sits in. */
	readonly issues: readonly number[];
}

/** Every credited login in a commit subject, with its credit group's issue numbers. */
export function extractSubjectCredits(subject: string): SubjectCredit[] {
	const credits: SubjectCredit[] = [];
	for (const group of subject.matchAll(CREDIT_GROUP)) {
		const issues = [...(group[0] as string).matchAll(/#(\d+)/g)].map((ref) => Number(ref[1]));
		for (const login of (group[1] as string).matchAll(LOGIN)) {
			credits.push({ login: login[1] as string, issues });
		}
	}
	return credits;
}

/** The lowercased logins with a table row in ACKNOWLEDGMENTS.md (either table; rows link the GitHub profile). */
export function acknowledgedLogins(markdown: string): Set<string> {
	const logins = new Set<string>();
	for (const row of markdown.matchAll(
		new RegExp(String.raw`^\|\s*\[@(${LOGIN_SOURCE})\]\(https://github\.com/`, "gm")
	)) {
		logins.add((row[1] as string).toLowerCase());
	}
	return logins;
}
