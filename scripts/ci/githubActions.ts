import { appendFileSync } from "node:fs";

/** A step output; outside Actions there is no file to write to, so a CI-only script fails here rather than later. */
export function setOutput(name: string, value: string): void {
	const file = process.env.GITHUB_OUTPUT;
	if (!file) {
		throw new Error(`GITHUB_OUTPUT is unset; cannot record ${name}=${value}`);
	}
	appendFileSync(file, `${name}=${value}\n`);
}
