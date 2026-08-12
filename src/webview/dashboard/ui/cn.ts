import { type ClassValue, clsx } from "clsx";
import { twMerge } from "tailwind-merge";

/** shadcn's class combiner: clsx for conditionals, tailwind-merge so a caller's utility overrides a variant's. */
export function cn(...inputs: ClassValue[]): string {
	return twMerge(clsx(inputs));
}
