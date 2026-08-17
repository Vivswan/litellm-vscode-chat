import type { ComponentProps } from "react";
import { useLayoutEffect, useRef } from "react";
import { Input } from "./input";

interface SecretInputProps extends Omit<ComponentProps<typeof Input>, "value" | "defaultValue" | "onChange" | "ref"> {
	/** The draft's current text; written to the node's value PROPERTY, never handed to React. */
	readonly value: string;
	readonly onValueChange: (next: string) => void;
	/** Omit alone dies under a non-fresh spread (no excess-property check); never keeps the mirror's key unrepresentable. */
	readonly defaultValue?: never;
}

/**
 * The secret-bearing input, UNCONTROLLED by design: React never receives the value, so nothing
 * mirrors the secret into an attribute or serialization - the node's value PROPERTY, written by
 * the effect only when it disagrees with the draft (prefill, remount), is its one residence.
 * Contract: the parent re-renders with the new value on every onValueChange, or node and draft
 * diverge and Save posts the draft.
 */
export function SecretInput({ value, onValueChange, ...props }: SecretInputProps) {
	const ref = useRef<HTMLInputElement>(null);
	useLayoutEffect(() => {
		const node = ref.current;
		if (node !== null && node.value !== value) {
			node.value = value;
		}
	});
	return <Input {...props} ref={ref} onChange={(event) => onValueChange(event.currentTarget.value)} />;
}
