/**
 * What a spot in a draft is, by Latex Suite 1.13.3's rules: its Markdown math
 * parser finds the math and its LaTeX grammar finds the scopes inside. Ported from
 * editor_context/context.ts, mathbounds.ts and autoDelete$.ts without CodeMirror.
 * MIT, Copyright (c) 2022 artisticat1: see THIRD_PARTY_NOTICES.md.
 *
 * Latex Suite only ever looks at what is on screen. A draft has no such limit, so
 * parsing is incremental: an edit reparses the blocks it touched, not the draft.
 */
import { TreeFragment, type SyntaxNode, type SyntaxNodeRef, type Tree } from "@lezer/common";
import { MATH_LANGUAGES, markdownMathParser, Type } from "./markdown-math.ts";
import { allTextAreas, noMode, snippetLessArea, type MacroArea, type Mode } from "./options.ts";

export type Bounds = { inner_start: number; inner_end: number; outer_start: number; outer_end: number };
export type MathBoundMode = "inline" | "block" | "code";
/** `overlay` is what of the source the LaTeX tree covers. */
export type MathBounds = Bounds & { mode: MathBoundMode; tree: SyntaxNode | null; overlay: Span[] };

export type ScopeEntry = Bounds & { node: SyntaxNode } & ({ kind: "command"; name: string } | { kind: "environment"; name: string } | { kind: "math" });

export type LatexContext = {
	mode: Mode;
	/** Inner to outer, from the caret out through the equation. */
	stack: ScopeEntry[];
	bounds: MathBounds | null;
	/** The innermost \begin...\end around the caret, closed on both sides. */
	environment: string | null;
};

type Span = { from: number; to: number };

export const lineStart = (source: string, offset: number) => (offset ? source.lastIndexOf("\n", offset - 1) + 1 : 0);
export function lineEnd(source: string, offset: number) {
	const end = source.indexOf("\n", offset);
	return end < 0 ? source.length : end;
}
export const isMultiline = (source: string, { outer_start, outer_end }: Bounds) => source.slice(outer_start, outer_end).includes("\n");

function dollarBounds(node: SyntaxNode): { open: SyntaxNode; close: Span } {
	const open = node.firstChild!;
	const last = node.lastChild!;
	return { open, close: last.name === Type.Dollar && open.nextSibling ? last : { from: node.to, to: node.to } };
}

function mathBoundsOf(tree: Tree, source: string): MathBounds[] {
	const ranges: MathBounds[] = [];
	const bound = (open: Span, close: Span, mode: MathBoundMode, inner: SyntaxNode | null, overlay: Span[]) => {
		ranges.push({ inner_start: open.to, inner_end: close.from, outer_start: open.from, outer_end: close.to, mode, tree: inner, overlay });
	};
	tree.iterate({
		enter(ref: SyntaxNodeRef) {
			if (ref.name === Type.DollarDisplayBlockMath) {
				const { open, close } = dollarBounds(ref.node);
				const children = ref.node.getChildren(Type.DisplayMath);
				if (children.length === 0) bound(open, close, "block", null, []);
				else {
					const inner = ref.node.enter(children[children.length - 1]!.to, -1);
					if (inner) bound(open, close, "block", inner, children);
				}
				return false;
			}
			if (ref.name === Type.DollarInlineMath || ref.name === Type.DollarDisplayMath) {
				const { open, close } = dollarBounds(ref.node);
				const inner = ref.node.getChild("LaTeX");
				if (inner) bound(open, close, ref.name === Type.DollarInlineMath ? "inline" : "block", inner, [inner]);
				return false;
			}
			if (ref.name === "FencedCode") {
				const info = ref.node.getChild("CodeInfo");
				if (!info || !MATH_LANGUAGES.includes(source.slice(info.from, info.to))) return undefined;
				const lines = ref.node.getChildren("CodeText");
				const last = lines[lines.length - 1];
				if (!last) return undefined;
				const inner = ref.node.enter(last.to, -1);
				if (inner?.name !== "LaTeX") return undefined;
				ranges.push({ inner_start: lines[0]!.from, inner_end: last.to, outer_start: ref.from, outer_end: ref.to, mode: "code", tree: inner, overlay: lines });
			}
			return undefined;
		},
	});
	return ranges;
}

/** Binary search, as upstream: its stops are part of what counts as inside. */
function inMathBound(bounds: MathBounds[], pos: number): MathBounds | null {
	const first = bounds[0], last = bounds[bounds.length - 1];
	if (!first || !last || pos < first.outer_start || pos > last.outer_end) return null;
	let left = 0, right = bounds.length - 1;
	while (left <= right) {
		const middle = (left + right) >> 1;
		const bound = bounds[middle]!;
		if (pos < bound.outer_start) right = middle - 1;
		else if (pos >= bound.outer_end && bound.outer_end !== bound.inner_end) left = middle + 1;
		else if (pos < bound.inner_start && bound.mode === "block" && bound.inner_start - bound.outer_start === 2) {
			// Between the two dollars of an opening `$$`.
			return { outer_start: bound.outer_start, inner_start: bound.outer_start + 1, inner_end: bound.outer_start + 1, outer_end: bound.outer_start + 2, mode: "inline", tree: null, overlay: [] };
		} else if (pos < bound.inner_start || pos > bound.inner_end) break;
		else return bound;
	}
	return null;
}

function* ancestors(node: SyntaxNode, pos: number, side: -1 | 0 | 1) {
	const cursor = node.cursor();
	cursor.moveTo(pos, side);
	for (let parent: SyntaxNode | null = cursor.node; parent; parent = parent.parent) yield parent;
}

function scopeOf(node: SyntaxNode, source: string): ScopeEntry | null {
	const value = node.name;
	const environment = (envNode: SyntaxNode | null): ScopeEntry | null => {
		const nameNode = envNode?.getChild("BeginEnv")?.getChild("EnvNameGroup");
		const contentNode = envNode?.getChild("Content");
		if (!envNode || !nameNode || !contentNode) return null;
		return { kind: "environment", name: source.slice(nameNode.from + 1, nameNode.to - 1), inner_start: contentNode.from, inner_end: contentNode.to, outer_start: envNode.from, outer_end: envNode.to, node };
	};
	if (value === "Environment") return environment(node);
	if (value === "KnownEnvironment") return environment(node.firstChild);
	if (value.endsWith("Argument") || value === "EnvNameGroup") {
		const command = node.parent?.firstChild, open = node.firstChild, close = node.lastChild;
		if (!command || !open || !close) return null;
		return { kind: "command", name: source.slice(command.from + 1, command.to), inner_start: open.to, inner_end: close.from, outer_start: node.from, outer_end: close.to, node };
	}
	if (value === "ParenMath" || value === Type.DollarInlineMath) {
		let open: SyntaxNode | null = null, close: SyntaxNode | null = null;
		if (value === "ParenMath") {
			open = node.getChild("OpenParenMath");
			close = node.getChild("CloseParenMath");
		} else {
			const dollars = node.getChildren(Type.Dollar);
			open = dollars[0] ?? null;
			close = dollars[1] ?? null;
		}
		if (!open || !close) return null;
		return { kind: "math", inner_start: open.to, inner_end: close.from, outer_start: node.from, outer_end: node.to, node };
	}
	return null;
}

/** Whether a macro's scope matches a list, counting which argument the caret is in. */
export function macroScopeIn(entry: ScopeEntry & { kind: "command" }, macros: readonly MacroArea[]): boolean {
	const macro = macros.find(({ name }) => name === entry.name);
	if (!macro) return false;
	if (!macro.arguments) return true;
	let siblings = 0;
	for (let sibling = entry.node.prevSibling; sibling; sibling = sibling.prevSibling) if (sibling.name.endsWith("Argument")) siblings++;
	return macro.arguments.includes(siblings);
}

function textAreaAt(stack: ScopeEntry[]): "text" | "none" | null {
	for (const entry of stack) {
		if (entry.kind === "environment") continue;
		if (entry.kind === "math") return null;
		if (macroScopeIn(entry, allTextAreas)) return snippetLessArea.some(({ name }) => name === entry.name) ? "none" : "text";
	}
	return null;
}

type Fence = { language: string };

/** A fence as Latex Suite reads it from Obsidian's own line tokens: the lines between
 *  the fences, and only once the block has its closing fence. */
function fenceAt(tree: Tree, source: string, pos: number): Fence | null {
	let node: SyntaxNode | null = tree.resolveInner(pos, 0);
	while (node && node.name !== "FencedCode") node = node.parent;
	if (!node) return null;
	const open = node.firstChild, close = node.lastChild;
	if (!open || !close || close.name !== "CodeMark" || open.from === close.from) return null;
	const lineEnd = source.indexOf("\n", open.to);
	if (lineEnd < 0 || pos <= lineEnd || pos > close.from) return null;
	const info = node.getChild("CodeInfo");
	return { language: info ? source.slice(info.from, info.to).split(" ")[0]! : "" };
}

function inInlineCode(tree: Tree, pos: number) {
	for (let node: SyntaxNode | null = tree.resolveInner(pos, -1); node; node = node.parent) if (node.name === "InlineCode") return true;
	return false;
}

/** Blocks that hold inline text, which is as far as an open backtick reaches. */
const INLINE_BLOCK = /^(?:Paragraph|ATXHeading\d|SetextHeading\d|TableHeader|TableRow)$/;
/** What keeps a backtick from opening a span. */
const NO_SPAN = /^(?:InlineCode|Escape|DollarInlineMath|DollarDisplayMath)$/;

/** A backtick still waiting for its closer, as one is while the span is being typed. */
function inOpenSpan(tree: Tree, source: string, pos: number) {
	let block: SyntaxNode | null = tree.resolveInner(pos, -1);
	while (block && !INLINE_BLOCK.test(block.name)) block = block.parent;
	if (!block) return false;
	const { from } = block;
	return [...source.slice(from, pos).matchAll(/`+/g)].some((run) => {
		for (let node: SyntaxNode | null = tree.resolveInner(from + run.index, 1); node; node = node.parent) if (NO_SPAN.test(node.name)) return false;
		return true;
	});
}

/**
 * Whether a spot is in code, closed or still being typed, the fences' own lines
 * included. This is the app's rule and not Latex Suite's, which treats inline code
 * and an unclosed fence as text, so that `mk` would expand in `mkdir`.
 */
function inCode(tree: Tree, source: string, pos: number) {
	for (let node: SyntaxNode | null = tree.resolveInner(pos, -1); node; node = node.parent) {
		if (node.name === "FencedCode" || (node.name === "InlineCode" && pos < node.to)) return true;
	}
	return inOpenSpan(tree, source, pos);
}

function commonEnds(a: string, b: string) {
	const shortest = Math.min(a.length, b.length);
	let start = 0;
	while (start < shortest && a.charCodeAt(start) === b.charCodeAt(start)) start++;
	let end = 0;
	while (end < shortest - start && a.charCodeAt(a.length - 1 - end) === b.charCodeAt(b.length - 1 - end)) end++;
	return { start, end };
}

/** Reads one draft as it changes. Asking about the same text twice parses once. */
export class LatexReader {
	private source: string | null = null;
	private tree: Tree | null = null;
	private fragments: readonly TreeFragment[] = [];
	private bounds: MathBounds[] = [];

	private load(source: string): Tree {
		if (this.tree && source === this.source) return this.tree;
		let fragments = this.fragments;
		if (this.source !== null) {
			const { start, end } = commonEnds(this.source, source);
			fragments = TreeFragment.applyChanges(fragments, [{ fromA: start, toA: this.source.length - end, fromB: start, toB: source.length - end }]);
		}
		const tree = markdownMathParser.parse(source, fragments);
		this.fragments = TreeFragment.addTree(tree, fragments);
		this.tree = tree;
		this.source = source;
		this.bounds = mathBoundsOf(tree, source);
		return tree;
	}

	/** Scopes around a spot, inner to outer, ending at the equation's edge. */
	stackAt(source: string, pos: number): ScopeEntry[] {
		this.load(source);
		const bound = inMathBound(this.bounds, pos);
		if (!bound?.tree) return [];
		const stack: ScopeEntry[] = [];
		for (const node of ancestors(bound.tree, pos, -1)) {
			if (node.to <= pos) continue;
			const entry = scopeOf(node, source);
			if (entry) stack.push(entry);
		}
		return stack;
	}

	context(source: string, pos: number): LatexContext {
		const tree = this.load(source);
		const mode = noMode();
		const fence = fenceAt(tree, source, pos);
		const forced = !!fence && MATH_LANGUAGES.includes(fence.language);
		mode.code = !fence && inInlineCode(tree, pos);
		mode.codeMath = forced;
		mode.codeBlock = fence && !forced ? fence.language : false;

		const bound = inMathBound(this.bounds, pos);
		let stack: ScopeEntry[] = [];
		if (bound) {
			mode.blockMath = bound.mode === "block";
			mode.inlineMath = bound.mode === "inline";
			stack = this.stackAt(source, pos);
			const area = textAreaAt(stack);
			mode.textEnv = area === "text";
			mode.snippetlessEnv = area === "none";
		}
		mode.text = !fence && !bound && !inCode(tree, source, pos);
		const environment = stack.find((entry) => entry.kind === "environment");
		return { mode, stack, bounds: bound, environment: environment?.kind === "environment" ? environment.name : null };
	}

	/** The equation a spot is in, if it has any LaTeX to walk. */
	equationAt(source: string, pos: number): MathBounds | null {
		this.load(source);
		return this.bounds.find((bound) => bound.tree && bound.overlay.length && bound.inner_start <= pos && bound.inner_end >= pos) ?? null;
	}

	/** What Backspace takes with it from inside an empty math pair, or null. */
	emptyPair(source: string, pos: number): Span | null {
		const node = this.load(source).resolveInner(pos, -1);
		if (node.name !== Type.Dollar) return null;
		if (node.from < pos && node.to > pos && node.to - node.from === 2) return { from: node.from, to: node.to };
		const next = node.nextSibling?.nextSibling;
		if (node.prevSibling || !next || !node.parent || next.name !== Type.Dollar || node.parent.name !== Type.DollarInlineMath || node.to !== next.from || pos !== node.to) return null;
		return { from: node.from, to: next.to };
	}
}
