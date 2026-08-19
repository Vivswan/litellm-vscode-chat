/**
 * Request-correlation hooks. useRpc (reads): latest send wins, earlier answers are orphaned;
 * two in-flight reads are two hook instances. useIntentOutcome (acked intents): holds the
 * method's latest ack/fail, seq-tagged so repeats with equal text still re-fire effects.
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
	/** The response to this hook's latest send; undefined while unanswered, after reset, and before the first send. */
	readonly data: ResponseFor<K> | undefined;
	/** Post one request; the previous in-flight request, if any, is orphaned (latest wins). */
	readonly send: (payload: RequestPayload<K>) => void;
	/** Drop the held answer and orphan any in-flight request (a closing form's value must leave webview memory). */
	readonly reset: () => void;
}

export function useRpc<K extends ReadMethod>(method: K): RpcState<K> {
	const [data, setData] = useState<ResponseFor<K> | undefined>(undefined);
	const pendingId = useRef<string | undefined>(undefined);
	useEffect(() => {
		const onMessage = (event: MessageEvent) => {
			const message = asExtensionMessage(event.data);
			if (
				message?.kind === "response" &&
				message.method === method &&
				pendingId.current !== undefined &&
				message.id === pendingId.current
			) {
				setData(message.payload as ResponseFor<K>);
			}
		};
		window.addEventListener("message", onMessage);
		return () => window.removeEventListener("message", onMessage);
	}, [method]);
	const send = useCallback(
		(payload: RequestPayload<K>) => {
			pendingId.current = sendRequest(method, payload);
			setData(undefined);
		},
		[method]
	);
	const reset = useCallback(() => {
		pendingId.current = undefined;
		setData(undefined);
	}, []);
	return { data, send, reset };
}

/** One acked intent's latest outcome; discriminated so a success cannot carry failure fields. */
export type IntentOutcome =
	| {
			readonly seq: number;
			readonly id: string;
			readonly result: "ok";
			/** The extension's optional caveat about the success (see the ack envelope). */
			readonly message?: string | undefined;
			/** A success worth a warning rendering (the ack envelope's tone). */
			readonly tone?: IntentAckTone | undefined;
	  }
	| {
			readonly seq: number;
			readonly id: string;
			readonly result: "fail";
			readonly message: string;
			/** What the failure left behind; see the fail envelope's failureKind. */
			readonly failureKind: "validation" | "operation";
			/** The transport classification behind a failed probe, when the notice carried one; enum ids only, never text. */
			readonly classification?: TransportErrorClassification | undefined;
	  };

export interface IntentOutcomeState<K extends AckedMethod> {
	/** The latest ack or fail envelope for this method, whichever request posted it. */
	readonly outcome: IntentOutcome | undefined;
	/** Post one intent; returns the minted id the outcome will echo. */
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
