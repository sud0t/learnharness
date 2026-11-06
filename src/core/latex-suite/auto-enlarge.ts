/**
 * `\left` and `\right` for brackets around big operators. Ported from Latex Suite
 * 1.13.3's features/auto_enlarge_brackets.ts and the pairing half of
 * editor_extensions/highlight_brackets.ts. MIT, Copyright (c) 2022 artisticat1:
 * see THIRD_PARTY_NOTICES.md.
 */
import type { SyntaxNode, TreeCursor } from "@lezer/common";
import type { LatexReader } from "./context.ts";
import { ENLARGE_TRIGGERS } from "./snippets.ts";
import type { TextChange } from "./tabstops.ts";

type Span = { from: number; to: number };
/** The part of a source a walk stays inside. */
type Equation = { source: string; from: number; to: number };

type BracketPair = { kind: "bracket"; open: Span; close: Span; children: BracketResult[] };
type BracketOpen = { kind: "error_open"; bracket: string; open: Span };
type BracketClose = { kind: "error_close"; bracket: string; close: Span };
type BracketResult = BracketPair | BracketOpen | BracketClose;
type Paired = { kind: BracketResult["kind"]; open?: Span; close?: Span; bracket?: string; parent: Paired | null; children: Paired[] };

const SIZE_CONTROLS = ["\\big", "\\Big", "\\bigg", "\\Bigg", "\\bigl", "\\Bigl", "\\biggl", "\\Biggl", "\\bigr", "\\Bigr", "\\biggr", "\\Biggr", "\\left", "\\right"];

/** Upstream's table as it stands. Its `[` closing with `}` is no matter to `[` and `]`,
 *  which the grammar pairs before this is read. */
const BRACKETS: Record<string, string> = {
	"{": "}",
	"[": "}",
	"(": ")",
	"\\{": "\\}",
	"\\left<": "\\right>",
	"\\langle ": "\\rangle",
	"\\lvert": "\\rvert",
	"\\lVert": "\\rVert",
	"\\right\\lt": "\\right\\gt",
	"\\lbrace": "\\rbrace",
	"\\lbrack": "\\rbrack",
	"\\lceil": "\\rceil",
	"\\lfloor": "\\rfloor",
	"\\lgroup": "\\rgroup",
	"\\llcorner": "\\lrcorner",
	"\\lmoustache": "\\rmoustache",
	"\\lparen": "\\rparen",
};
const OPENING_OF = Object.fromEntries(Object.entries(BRACKETS).map(([open, close]) => [close, open]));
const OPEN_TO_CLOSE: Record<string, string> = { OpenBrace: "CloseBrace", OpenBracket: "CloseBracket", OpenParenMath: "CloseParenMath" };

function* treeCursor(top: SyntaxNode, equation: Equation) {
	const cursor = top.cursor();
	cursor.moveTo(equation.from, 1);
	if (cursor.node.from < equation.from) return;
	const isTop = (node: SyntaxNode) => node.from === top.from && node.to === top.to && node.name === top.name;
	while (cursor.node.parent && cursor.node.parent.from >= equation.from && cursor.parent() && !isTop(cursor.node)) { /* Up to the top of the equation. */ }
	do {
		if (cursor.to > equation.to) continue;
		yield cursor;
	} while (cursor.next() && cursor.from <= equation.to && cursor.node !== top);
}

function delimitedGroup(cursor: TreeCursor, equation: Equation): BracketResult[] {
	const { node } = cursor;
	const open = node.getChild("MathOpening"), close = node.getChild("MathClosing"), math = node.getChild("Math");
	const children = math ? walk(math, { source: equation.source, from: math.from, to: math.to }) : [];
	if (!open || !close) return [];
	cursor.moveTo(close.to, -1);
	return [{ kind: "bracket", open, close, children }];
}

function controlSequence(cursor: TreeCursor, { source }: Equation): BracketResult[] {
	const { node } = cursor, macro = source.slice(node.from, node.to);
	if (macro in BRACKETS) return [{ kind: "error_open", open: node, bracket: macro }];
	if (macro in OPENING_OF) return [{ kind: "error_close", close: node, bracket: macro }];
	return [];
}

function openBrace(cursor: TreeCursor, equation: Equation): BracketResult[] {
	const open = cursor.node, closeName = OPEN_TO_CLOSE[open.name];
	const inside: BracketResult[] = [];
	while (cursor.nextSibling()) {
		const sibling = cursor.node;
		if (sibling.name === closeName) return [{ kind: "bracket", open, close: sibling, children: inside }];
		inside.push(...walk(sibling, { source: equation.source, from: sibling.from, to: sibling.to }));
	}
	return [{ kind: "error_open", open, bracket: equation.source.slice(open.from, open.to) }, ...inside];
}

function specialCharacters(cursor: TreeCursor, { source }: Equation) {
	const brackets: BracketResult[] = [];
	for (let at = cursor.from; at < cursor.to; at++) {
		const char = source[at]!, bound = { from: at, to: at + 1 };
		if (char in BRACKETS) brackets.push({ kind: "error_open", open: bound, bracket: char });
		else if (char in OPENING_OF) brackets.push({ kind: "error_close", close: bound, bracket: char });
	}
	return brackets;
}

function walk(top: SyntaxNode, equation: Equation): BracketResult[] {
	const found: BracketResult[] = [];
	for (const cursor of treeCursor(top, equation)) {
		const { name } = cursor;
		if (name === "MathDelimitedGroup") found.push(...delimitedGroup(cursor, equation));
		else if (name.endsWith("CtrlSeq") || name === "CtrlSym") found.push(...controlSequence(cursor, equation));
		else if (name === "MathSpecialChar") found.push(...specialCharacters(cursor, equation));
		else if (name in OPEN_TO_CLOSE) found.push(...openBrace(cursor, equation));
		else if (name === "CloseBrace" || name === "CloseBracket") {
			const { node } = cursor;
			found.push({ kind: "error_close", close: node, bracket: equation.source.slice(node.from, node.to) });
		}
	}
	return found;
}

/** Syntax brackets such as `\left...\right` and `{}` come paired. The rest pair up here. */
function pairBrackets(specs: BracketResult[]): Paired[] {
	const paired: Paired[] = [];
	const opened: Paired[] = [];
	let parent: Paired | null = null;
	for (const spec of specs) {
		const children: Paired[] = parent?.children ?? paired;
		const item: Paired = { ...spec, parent, children: [] };
		if (spec.kind === "error_open") {
			opened.push(item);
			children.push(item);
			parent = item;
		} else if (spec.kind === "error_close") {
			const index = opened.findLastIndex((open) => open.bracket === OPENING_OF[spec.bracket]);
			if (index < 0) children.push(item);
			else {
				const open = opened[index]!;
				opened.length = index;
				open.kind = "bracket";
				open.close = spec.close;
				parent = open.parent;
			}
		} else {
			children.push(item);
			for (const child of pairBrackets(spec.children)) {
				child.parent = item;
				item.children.push(child);
			}
		}
	}
	return paired;
}

function* everyBracket(items: Paired[]): Generator<Paired> {
	for (const item of items) {
		yield item;
		yield* everyBracket(item.children);
	}
}

function hasSizeControl(tree: SyntaxNode, from: number, source: string) {
	const node = tree.resolveInner(from, -1);
	return node.name === "CtrlSeq" && SIZE_CONTROLS.includes(source.slice(node.from, node.to));
}

/** The edits that enlarge an equation's brackets, in order, each one on the text the last left. */
export function enlargedBrackets(reader: LatexReader, source: string, head: number): (TextChange & { text: string })[] {
	const bound = reader.equationAt(source, head);
	if (!bound?.tree) return [];
	const equation = { source, from: bound.overlay[0]!.from, to: bound.overlay.at(-1)!.to };
	const replacements: (Span & { text: string })[] = [];
	for (const bracket of everyBracket(pairBrackets(walk(bound.tree, equation)))) {
		if (bracket.kind !== "bracket") continue;
		const { open, close } = bracket as { open: Span; close: Span };
		const opening = source.slice(open.from, open.to), closing = source.slice(close.from, close.to);
		if (opening === "{" || opening === "\\(" || opening.startsWith("\\left") || closing.startsWith("\\right")) continue;
		if (hasSizeControl(bound.tree, open.from, source)) continue;
		const content = source.slice(open.to, close.from);
		if (!ENLARGE_TRIGGERS.some((trigger) => content.includes(trigger))) continue;
		replacements.push({ from: open.from, to: open.to, text: `\\left${opening} ` }, { from: close.from, to: close.to, text: ` \\right${closing}` });
	}
	replacements.sort((a, b) => a.from - b.from);
	let shift = 0;
	return replacements.map(({ from, to, text }) => {
		const edit = { from: from + shift, to: to + shift, length: text.length, text };
		shift += text.length - (to - from);
		return edit;
	});
}
