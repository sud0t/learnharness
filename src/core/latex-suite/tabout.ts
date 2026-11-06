/**
 * Jumping out of brackets and equations. Ported from Latex Suite 1.13.3's
 * features/tabout.ts. MIT, Copyright (c) 2022 artisticat1: see THIRD_PARTY_NOTICES.md.
 */
import { isMultiline, lineEnd, lineStart, type LatexContext } from "./context.ts";
import { inMath } from "./options.ts";
import { tokenize, withoutChips, type Token } from "./tokenizer.ts";

const LEFT_COMMANDS = new Set(["\\left", "\\bigl", "\\Bigl", "\\biggl", "\\Biggl"]);
const RIGHT_COMMANDS = new Set(["\\right", "\\bigr", "\\Bigr", "\\biggr", "\\Biggr"]);
const DELIMITERS = new Set([
	"(", ")",
	"[", "]", "\\lbrack", "\\rbrack",
	"\\{", "\\}", "\\lbrace", "\\rbrace",
	"<", ">", "\\langle", "\\rangle", "\\lt", "\\gt",
	"|", "\\vert", "\\lvert", "\\rvert",
	"\\|", "\\Vert", "\\lVert", "\\rVert",
	"\\lfloor", "\\rfloor",
	"\\lceil", "\\rceil",
	"\\ulcorner", "\\urcorner",
	"/", "\\\\", "\\backslash",
	"\\uparrow", "\\downarrow",
	"\\Uparrow", "\\Downarrow",
	".",
]);
const DELIMITER_PAIRS: Record<string, string> = {
	"(": ")",
	"[": "]",
	"{": "}",
	"\\lbrack": "\\rbrack",
	"\\lbrace": "\\rbrace",
	"\\langle": "\\rangle",
	"\\lvert": "\\rvert",
	"\\lVert": "\\rVert",
	"\\lfloor": "\\rfloor",
	"\\lceil": "\\rceil",
	"\\ulcorner": "\\urcorner",
	"<": ">",
};
/** `taboutClosingSymbols`, unchanged by this user. */
const CLOSING_SYMBOLS = new Set([")", "]", "\\rbrack", "\\}", "\\rbrace", "\\rangle", "\\rvert", "\\rVert", "\\rfloor", "\\rceil", "\\urcorner", "}"]);

/** The bracket pairs of `DELIMITER_PAIRS` a matrix can jump past. */
const CLOSING_BRACKETS = new Set(Object.values(DELIMITER_PAIRS).filter((symbol) => CLOSING_SYMBOLS.has(symbol)));
const OPENING_BRACKETS = new Set(Object.keys(DELIMITER_PAIRS).filter((symbol) => CLOSING_BRACKETS.has(DELIMITER_PAIRS[symbol]!)));

function isClosingDelimiter(tokens: Token[], index: number) {
	const current = tokens[index]!, previous = tokens[index - 1];
	if (previous && RIGHT_COMMANDS.has(previous.text) && DELIMITERS.has(current.text)) return true;
	if (previous && LEFT_COMMANDS.has(previous.text) && DELIMITERS.has(current.text)) return false;
	return CLOSING_SYMBOLS.has(current.text);
}

/** A `\right` with no delimiter: tabout stops there, for it to be typed. */
function isUnmatchedRight(tokens: Token[], index: number) {
	if (!RIGHT_COMMANDS.has(tokens[index]!.text)) return false;
	const next = tokens[index + 1];
	return !next || !DELIMITERS.has(next.text);
}

/** Where the caret lands. The text changes only to make a line to land on. */
export type Tabout = { value: string; caret: number };

/** Past the line an equation ends on, tidying what is left behind. */
function leaveBlock(source: string, caret: number, outerStart: number, outerEnd: number): Tabout {
	const indent = /^\s*/.exec(source.slice(lineStart(source, outerStart), lineEnd(source, outerStart)))![0];
	const from = lineStart(source, caret), to = lineEnd(source, caret);
	const trimmed = source.slice(from, to).trimEnd();
	const removed = to - from - trimmed.length;
	const value = source.slice(0, from) + trimmed + source.slice(to);
	const end = lineEnd(source, outerEnd) - removed;
	if (end >= value.length) return { value: `${value}\n${indent}`, caret: end + 1 + indent.length };
	const after = lineEnd(value, end + 1);
	if (value.slice(end + 1, after).trim()) return { value, caret: end + 1 };
	return { value: value.slice(0, end + 1) + indent + value.slice(after), caret: end + 1 + indent.length };
}

export function tabout(source: string, caret: number, { mode, bounds }: LatexContext): Tabout | null {
	if (!inMath(mode) || !bounds || bounds.outer_end <= caret) return null;
	const { inner_start, inner_end, outer_start, outer_end } = bounds;
	const position = caret - inner_start;
	const tokens = tokenize(withoutChips(source).slice(inner_start, inner_end));
	const first = tokens.findIndex((token) => token.end > position);
	for (let index = first < 0 ? tokens.length : first; index < tokens.length; index++) {
		if (isClosingDelimiter(tokens, index) || isUnmatchedRight(tokens, index)) return { value: source, caret: inner_start + tokens[index]!.end };
	}
	// Only out of the equation from its very end.
	if (source.slice(caret, inner_end).trim()) return null;
	if (isMultiline(source, bounds)) return leaveBlock(source, caret, outer_start, outer_end);
	return { value: source, caret: outer_end };
}

/** How far into some text its first unopened closing bracket ends. */
export function enclosedBracketEnd(latex: string): number | null {
	let depth = 0;
	for (const token of tokenize(latex)) {
		if (CLOSING_BRACKETS.has(token.text)) {
			if (!depth) return token.end;
			depth--;
		} else if (OPENING_BRACKETS.has(token.text)) depth++;
	}
	return null;
}
