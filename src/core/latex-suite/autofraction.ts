/**
 * `/` as a fraction of what comes before it. Ported from Latex Suite 1.13.3's
 * features/autofraction.ts and the bracket helpers of utils/editor_utils.ts.
 * MIT, Copyright (c) 2022 artisticat1: see THIRD_PARTY_NOTICES.md.
 */
import type { Bounds, LatexContext } from "./context.ts";
import { strictlyInMath } from "./options.ts";
import { keepIndentAndCallout, type Insertion } from "./snippets.ts";

/** `autofractionExcludedEnvs`, unchanged by this user. */
const EXCLUDED: readonly [string, string][] = [["^{", "}"], ["\\pu{", "}"]];
/** `autofractionBreakingChars`, after the ones that always break. */
const BREAKING = " $([{\n+-=\t";
const GREEK = "alpha|beta|gamma|Gamma|delta|Delta|epsilon|varepsilon|zeta|eta|theta|Theta|iota|kappa|lambda|Lambda|mu|nu|omicron|xi|Xi|pi|Pi|rho|sigma|Sigma|tau|upsilon|Upsilon|varphi|phi|Phi|chi|psi|Psi|omega|Omega";
const SPACE_AFTER_GREEK = new RegExp(`(${GREEK}) ([^ ])`, "g");
const OPENERS: Record<string, string> = { ")": "(", "]": "[", "}": "{" };
const CLOSERS: Record<string, string> = { "(": ")", "[": "]", "{": "}" };

const reversed = (text: string) => text.split("").reverse().join("");

function closingFrom(text: string, start: number, open: string, close: string): number | null {
	let depth = 0;
	for (let at = start; at < text.length; at++) {
		if (text.startsWith(open, at)) depth++;
		else if (text.startsWith(close, at) && --depth === 0) return at;
	}
	return null;
}

function openingBefore(text: string, start: number, open: string, close: string): number | null {
	const found = closingFrom(reversed(text), text.length - (start + close.length), reversed(close), reversed(open));
	return found === null ? null : text.length - (found + open.length);
}

/** Whether a spot is between an opening like `^{` and the brace that closes it. */
function isWithin(source: string, { inner_start, inner_end }: Bounds, position: number, open: string, close: string) {
	const text = source.slice(inner_start, inner_end), at = position - inner_start;
	const bracket = open.at(-1)!;
	const shared = "{[(".includes(bracket) && close === CLOSERS[bracket];
	for (let left = text.lastIndexOf(open, at - 1); left !== -1; left = text.lastIndexOf(open, left - 1)) {
		const right = closingFrom(text, left + (shared ? open.length - 1 : 0), shared ? bracket : open, close);
		if (right === null) return false;
		if (right >= at && at >= left + open.length) return true;
		if (left <= 0) return false;
	}
	return false;
}

/** Where a numerator starts, scanning back. Null on a bracket with no match. */
function numeratorStart(source: string, eqnStart: number, to: number): number | null {
	const line = source.slice(eqnStart, to).replace(SPACE_AFTER_GREEK, "$1#$2");
	for (let at = line.length - 1; at >= 0; at--) {
		const char = line[at]!;
		const opener = OPENERS[char];
		if (opener) {
			const match = openingBefore(line, at, opener, char);
			if (match === null) return null;
			at = match;
		}
		if (BREAKING.includes(char)) return at + 1 + eqnStart;
	}
	return eqnStart;
}

/** Null leaves the `/` to be typed, which is how `//` gets to its snippet. */
export function autoFraction(source: string, from: number, to: number, { mode, bounds }: LatexContext): Insertion | null {
	if (!strictlyInMath(mode) || !bounds) return null;
	if (EXCLUDED.some(([open, close]) => isWithin(source, bounds, to, open, close))) return null;
	const start = from !== to ? from : numeratorStart(source, bounds.inner_start, to);
	if (start === null || start === to) return null;
	let numerator = source.slice(start, to);
	if (numerator[0] === "(" && numerator.at(-1) === ")" && closingFrom(numerator, 0, "(", ")") === numerator.length - 1) numerator = numerator.slice(1, -1);
	const insert = `\\frac{${numerator}}{}`;
	const tabstops = [
		...numerator ? [] : [{ index: [0], from: "\\frac{".length, to: "\\frac{".length }],
		{ index: [1], from: insert.length - 1, to: insert.length - 1 },
		{ index: [2], from: insert.length, to: insert.length },
	];
	const replacement = { insert, tabstops };
	keepIndentAndCallout(source, to, replacement);
	// With a selection, undo has no typed key to give back.
	return { from: start, to, ...replacement, key: from !== to ? null : "/", enlarge: true };
}
