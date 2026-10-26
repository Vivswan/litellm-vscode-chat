/**
 * useRpc (reads): latest send wins, earlier answers are orphaned; two in-flight reads are two hook instances.
 * useIntentOutcome (acked intents): holds the method's latest ack/fail, seq-tagged so repeats with equal text still
 * re-fire effects.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import type {
	AckedMethod,
	ExtensionToWebviewMessage,
	IntentAckTone,
	ReadMethod,
	RequestPayload,
	ResponseFor,
} from "../../dashboard/endpoints";
import { isExtensionMessage } from "../../dashboard/endpoints";
import type { TransportErrorClassification } from "../../shared/errorClassification";
import { sendRequest } from "./vscodeApi";

export function asExtensionMessage(data: unknown): ExtensionToWebviewMessage | undefined {
	return isExtensionMessage(data) ? data : undefined;
}

export interface RpcState<K extends ReadMethod> {
	/** The newest request's answer; a different question clears it until the new answer lands. */
	readonly data: ResponseFor<K> | undefined;

	/** Post the request; an identical question is a refresh (pushes re-ask the open views) and keeps the held answer. */
	readonly send: (payload: RequestPayload<K>) => void;

	/** Drop the held answer and orphan any in-flight request (a closing form's value must leave webview memory). */
	readonly reset: () => void;
}

export function useRpc<K extends ReadMethod>(method: K): RpcState<K> {
	const [data, setData] = useState<ResponseFor<K> | undefined>(undefined);
	// The newest request's id and the question it asked, serialized: payloads are plain wire data built at one call
	// site each, so equal questions serialize equal.
	const pending = useRef<{ readonly id: string; readonly question: string } | undefined>(undefined);
	useEffect(() => {
		const onMessage = (event: MessageEvent) => {
			const message = asExtensionMessage(event.data);
			if (message?.kind === "response" && message.method === method && message.id === pending.current?.id) {
				setData(message.payload as ResponseFor<K>);
			}
		};
		window.addEventListener("message", onMessage);
		return () => window.removeEventListener("message", onMessage);
	}, [method]);
	const send = useCallback(
		(payload: RequestPayload<K>) => {
			const question = JSON.stringify(payload);
			if (pending.current?.question !== question) {
				setData(undefined);
			}
			pending.current = { id: sendRequest(method, payload), question };
		},
		[method]
	);
	const reset = useCallback(() => {
		pending.current = undefined;
		setData(undefined);
	}, []);
	return { data, send, reset };
}

export type IntentOutcome =
	| {
			readonly seq: number;
			readonly id: string;
			readonly result: "ok";
			readonly message?: string | undefined;
			readonly tone?: IntentAckTone | undefined;
	  }
	| {
			readonly seq: number;
			readonly id: string;
			readonly result: "fail";
			readonly message: string;
			readonly failureKind: "validation" | "operation";
			readonly classification?: TransportErrorClassification | undefined;
	  };

export interface IntentOutcomeState<K extends AckedMethod> {
	/** The latest ack or fail envelope for this method, whichever request posted it. */
	readonly outcome: IntentOutcome | undefined;

	/** Post the intent and return its request id, so the caller can match the envelope that answers it. */
	readonly send: (payload: RequestPayload<K>) => string;

	/** Forget the held outcome (a dismissed notice must not resurface). */
	readonly reset: () => void;
}

export function useIntentOutcome<K extends AckedMethod>(method: K): IntentOutcomeState<K> {
	const [outcome, setOutcome] = useState<IntentOutcome | undefined>(undefined);
	const seq = useRef(0);
	useEffect(() => {
		const onMessage = (event: MessageEvent) => {
			const message = asExtensionMessage(event.data);
			if (message === undefined || (message.kind !== "ack" && message.kind !== "fail") || message.method !== method) {
				return;
			}
			seq.current += 1;
			setOutcome(
				message.kind === "ack"
					? { seq: seq.current, id: message.id, result: "ok", message: message.message, tone: message.tone }
					: {
							seq: seq.current,
							id: message.id,
							result: "fail",
							message: message.message,
							failureKind: message.failureKind,
							classification: message.classification,
						}
			);
		};
		window.addEventListener("message", onMessage);
		return () => window.removeEventListener("message", onMessage);
	}, [method]);
	const send = useCallback((payload: RequestPayload<K>) => sendRequest(method, payload), [method]);
	const reset = useCallback(() => setOutcome(undefined), []);
	return { outcome, send, reset };
}
