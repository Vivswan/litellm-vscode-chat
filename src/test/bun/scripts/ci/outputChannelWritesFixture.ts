/**
 * Negative control for scripts/ci/output-channel-writes.ts: every write shape the scanner must refuse beside the
 * look-alikes it must ignore. Never imported; the test hands this path to the scanner and reads one tag per judgment.
 *
 *   refused@2 channel appendLine -> verdict, 1-based column, rule, member, as the scanner reports it
 *   allowed@2 channel show       -> a channel member that writes nothing: judged, accepted
 *   untagged                     -> not a channel member at all
 */
import * as vscode from "vscode";

declare const channel: vscode.OutputChannel;
declare const log: vscode.LogOutputChannel;
declare const maybeLog: vscode.LogOutputChannel | undefined;
declare const holder: { readonly channel: vscode.OutputChannel };
declare const sink: { info(message: string): void };

export function writes(): void {
	vscode.window.createOutputChannel("Second"); // refused@2 channel createOutputChannel
	channel.appendLine("text"); // refused@2 channel appendLine
	channel.append("text"); // refused@2 channel append
	channel.replace("text"); // refused@2 channel replace
	channel.clear(); // refused@2 channel clear
	log.info("text"); // refused@2 channel info
	log.error("text"); // refused@2 channel error
	maybeLog?.warn("text"); // refused@2 channel warn
	holder.channel.appendLine("text"); // refused@2 channel appendLine
	// biome-ignore lint/complexity/useLiteralKeys: the computed-key write shape
	channel["appendLine"]("text"); // refused@2 channel appendLine
	const key = "appendLine";
	channel[key]("text"); // refused@2 channel appendLine
	const { clear } = channel; // refused@10 channel clear
	clear();
	// biome-ignore lint/complexity/useLiteralKeys: the computed-key destructuring shape
	const { ["replace"]: computed } = channel; // refused@10 channel replace
	computed.call(channel, "text");
	// biome-ignore lint/style/useConst: a destructuring assignment target must be a let
	let assigned: vscode.OutputChannel["appendLine"];
	({ appendLine: assigned } = channel); // refused@3 channel appendLine
	assigned.call(channel, "text");
	Reflect.get(channel, "appendLine").call(channel, "text"); // refused@2 channel Reflect.get
	globalThis.Reflect.get(channel, "appendLine").call(channel, "text"); // refused@2 channel Reflect.get
	// biome-ignore lint/complexity/useLiteralKeys: the computed-key reflection shape
	Reflect["get"](channel, "appendLine").call(channel, "text"); // refused@2 channel Reflect.get
	const reflect = Reflect.get;
	reflect(channel, "appendLine").call(channel, "text"); // refused@2 channel Reflect.get
	channel.show(true); // allowed@2 channel show
	sink.info("text");
	new Map<string, string>().clear();
	void "text".replace("t", "T");
}

export function constrainedKey<Key extends "appendLine">(target: vscode.OutputChannel, key: Key): void {
	target[key]("text"); // refused@2 channel appendLine
}
