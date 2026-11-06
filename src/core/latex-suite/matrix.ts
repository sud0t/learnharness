/**
 * Keys inside a matrix. Ported from Latex Suite 1.13.3's features/matrix_shortcuts.ts.
 * MIT, Copyright (c) 2022 artisticat1: see THIRD_PARTY_NOTICES.md.
 */
import { isMultiline, lineEnd, lineStart, type LatexContext, type ScopeEntry } from "./context.ts";
import { strictlyInMath } from "./options.ts";
import { keepIndentAndCallout, type Insertion } from "./snippets.ts";
import { enclosedBracketEnd } from "./tabout.ts";
import { withoutChips } from "./tokenizer.ts";

/** `matrixShortcutsEnvNames` and `matrixShortcutsMacroNames`, unchanged by this user. */
const ENVIRONMENTS = ["pmatrix", "cases", "align", "gather", "bmatrix", "Bmatrix", "vmatrix", "Vmatrix", "array", "matrix"];
const MACROS = ["eqalign"];
/** As upstream wrote it. In JavaScript `[^]` is any one character. */
const LEADING_CELLS = /(\\begin{[^]]*}|\\\\|^)((?:\s|&)+)/;

/** The matrix the caret is directly in. A macro inside one, such as `\frac`, is not. */
export function matrixScope({ mode, bounds, stack }: LatexContext): ScopeEntry | null {
	if (!strictlyInMath(mode) || !bounds) return null;
	const scope = stack[0];
	if (!scope || scope.kind === "math") return null;
	return (scope.kind === "environment" ? ENVIRONMENTS : MACROS).includes(scope.name) ? scope : null;
}

/** Tab, past a closing bracket left open on this line. Ahead of a matrix's new cell. */
export function matrixBracketJump(source: string, caret: number, context: LatexContext): number | null {
	if (!matrixScope(context)) return null;
	const end = enclosedBracketEnd(withoutChips(source).slice(caret, lineEnd(source, caret)));
	return end === null ? null : caret + end;
}

/** Tab, with nothing selected. */
export function matrixCell(caret: number, context: LatexContext): Insertion | null {
	if (!matrixScope(context)) return null;
	return { from: caret, to: caret, insert: " & ", tabstops: [], key: null, enlarge: false };
}

/** Enter. A row in a matrix of one line stays on that line. */
export function matrixRow(source: string, from: number, to: number, context: LatexContext): Insertion | null {
	const scope = matrixScope(context);
	if (!scope) return null;
	const line = source.slice(lineStart(source, to), lineEnd(source, to));
	const cells = LEADING_CELLS.exec(line)?.[2]!.trimStart() ?? "";
	if (!isMultiline(source, scope)) return { from, to, insert: ` \\\\  ${cells}`, tabstops: [], key: null, enlarge: false };
	const insert = ` \\\\\n${cells}`;
	const replacement = { insert, tabstops: [{ index: [0], from: insert.length, to: insert.length }] };
	keepIndentAndCallout(source, to, replacement);
	return { from: to, to, ...replacement, key: null, enlarge: false };
}

/** Shift+Enter: the end of the next line, or of the matrix. Null with no line to go to. */
export function matrixExit(source: string, caret: number, context: LatexContext): number | null {
	const scope = matrixScope(context);
	if (!scope) return null;
	if (!isMultiline(source, scope)) return scope.outer_end;
	const lineBreak = source.indexOf("\n", caret);
	if (lineBreak < 0) return null;
	const next = lineBreak + 1, end = lineEnd(source, next);
	const closing = /\\end{([^}]*)}/.exec(source.slice(next, end));
	return closing && ENVIRONMENTS.includes(closing[1]!) ? next + closing.index + closing[0].length : end;
}
