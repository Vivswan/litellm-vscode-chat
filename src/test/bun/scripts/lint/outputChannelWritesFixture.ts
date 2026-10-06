/**
 * Negative control for scripts/lint/outputChannelWrites.ts: every write shape the rule must refuse beside the
 * look-alikes it must ignore. Never imported; the test replays this file through RuleTester and reads the tags.
 *
 *   // refused -> the rule reports this line
 *   // allowed -> a channel member that writes nothing: seen, not reported
 *   untagged  -> not a channel member at all
 */
import * as vscode from "vscode";

declare const channel: vscode.OutputChannel;
declare const log: vscode.LogOutputChannel;
declare const maybeLog: vscode.LogOutputChannel | undefined;
declare const holder: { readonly channel: vscode.OutputChannel };
declare const sink: { info(message: string): void };

export function writes(): void {
	vscode.window.createOutputChannel("Second"); // refused
	channel.appendLine("text"); // refused
	channel.append("text"); // refused
	channel.replace("text"); // refused
	channel.clear(); // allowed
	log.info("text"); // refused
	log.error("text"); // refused
	maybeLog?.warn("text"); // refused
	holder.channel.appendLine("text"); // refused
	// biome-ignore lint/complexity/useLiteralKeys: the computed-key write shape
	channel["appendLine"]("text"); // refused
	const key = "appendLine";
	channel[key]("text"); // refused
	const { clear } = channel; // allowed
	clear();
	// biome-ignore lint/complexity/useLiteralKeys: the computed-key destructuring shape
	const { ["replace"]: computed } = channel; // refused
	computed.call(channel, "text");
	// biome-ignore lint/style/useConst: a destructuring assignment target must be a let
	let assigned: vscode.OutputChannel["appendLine"];
	({ appendLine: assigned } = channel); // refused
	assigned.call(channel, "text");
	Reflect.get(channel, "appendLine").call(channel, "text"); // refused
	globalThis.Reflect.get(channel, "appendLine").call(channel, "text"); // refused
	// biome-ignore lint/complexity/useLiteralKeys: the computed-key reflection shape
	Reflect["get"](channel, "appendLine").call(channel, "text"); // refused
	const reflect = Reflect.get;
	reflect(channel, "appendLine").call(channel, "text"); // refused
	channel.show(true); // allowed
	sink.info("text");
	new Map<string, string>().clear();
	void "text".replace("t", "T");
}

export function constrainedKey<Key extends "appendLine">(target: vscode.OutputChannel, key: Key): void {
	target[key]("text"); // refused
}
