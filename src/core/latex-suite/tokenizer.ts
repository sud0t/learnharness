/**
 * LaTeX tokens, as tabout walks them. Ported from Latex Suite 1.13.3's
 * utils/tokenizer.ts. MIT, Copyright (c) 2022 artisticat1: see THIRD_PARTY_NOTICES.md.
 */
import { parseFilePaths } from "../file-paths.ts";

export type Token = { start: number; end: number; text: string };

/** Text with each file chip blanked out, at the same offsets. A chip is one thing
 *  in the text, and a bracket in its path closes nothing. */
export function withoutChips(source: string) {
	return parseFilePaths(source).map((part) => (part.kind === "path" ? "x".repeat(part.text.length) : part.text)).join("");
}

function tokenEnd(latex: string, start: number) {
	if (latex[start] === "%") {
		const line = latex.indexOf("\n", start);
		return line < 0 ? latex.length : line;
	}
	if (latex[start] !== "\\") return start + 1;
	let current = start + 1;
	if (!/[A-Za-z]/.test(latex[current] ?? "")) return current + 1;
	do current++; while (current < latex.length && /[A-Za-z]/.test(latex[current]!));
	return current;
}

export function tokenize(latex: string): Token[] {
	const tokens: Token[] = [];
	for (let index = 0; index < latex.length;) {
		if (/\s/.test(latex[index]!)) {
			index++;
			continue;
		}
		const end = tokenEnd(latex, index);
		tokens.push({ start: index, end, text: latex.slice(index, end) });
		index = end;
	}
	return tokens;
}
