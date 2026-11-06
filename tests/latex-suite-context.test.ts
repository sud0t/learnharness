/** The Markdown math parser and the context read from it. The trees and the Backspace
 *  cases are Latex Suite 1.13.3's own tests. */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { LatexReader } from "../src/core/latex-suite/context.ts";
import { markdownMathParser } from "../src/core/latex-suite/markdown-math.ts";
import { inMath, type Mode } from "../src/core/latex-suite/options.ts";

const INLINE = "DollarInlineMath(Dollar,LaTeX(Math(MathChar,MathSpecialChar,Number)),Dollar)";

describe("Markdown math parser", () => {
	const trees: [string, string, string][] = [
		["basic", "This is a test with $x^2$ and $$y^2$$.", `Document(Paragraph(${INLINE},DollarDisplayMath(Dollar,LaTeX(Math(MathChar,MathSpecialChar,Number)),Dollar)))`],
		["callouts", ">[!note] This is a callout with math\n> $$\n> y^2\n>\n> $$\n", "Document(Blockquote(QuoteMark,Paragraph(Link(LinkMark,LinkMark)),QuoteMark,DollarDisplayBlockMath(Dollar,QuoteMark,DisplayMath,QuoteMark,QuoteMark,Dollar)))"],
		["Obsidian comments", "\n%%obsidian comment%%\n$y^2$\n%%\nobsidian display comment\n%% $x^2$\n", `Document(Paragraph(ObsidianComment,${INLINE}),ObsidianComment,${INLINE})`],
		["HTML comments", "\n<!-- html comment -->\n*a*\n<!--\ndisplay html comment\n--> *a*\n", "Document(CommentBlock,Paragraph(Emphasis(EmphasisMark,EmphasisMark)),CommentBlock)"],
		["tables", "\n|$x^2$|$y^2$|\n|---|---|\n|$x^2$|$y^2$|\n", `Document(Table(TableHeader(TableDelimiter,TableCell(${INLINE}),TableDelimiter,TableCell(${INLINE}),TableDelimiter),TableDelimiter,TableRow(TableDelimiter,TableCell(${INLINE}),TableDelimiter,TableCell(${INLINE}),TableDelimiter)))`],
		["after a multi-line comment", "\n$\frac{a}{b}$\n%%\nmulti-line comment\n%%\n$a/b$\n", "Document(Paragraph(DollarInlineMath(Dollar,LaTeX(Math(MathChar,Group(OpenBrace,Math(MathChar),CloseBrace),Group(OpenBrace,Math(MathChar),CloseBrace))),Dollar)),ObsidianComment,Paragraph(DollarInlineMath(Dollar,LaTeX(Math(MathChar,MathSpecialChar,MathChar)),Dollar)))"],
	];
	for (const [name, source, tree] of trees) it(name, () => assert.equal(markdownMathParser.parse(source).toString(), tree));
});

function spot(marked: string) {
	const position = marked.indexOf("|");
	return { source: marked.replace("|", ""), position };
}
function kind(mode: Mode) {
	if (mode.snippetlessEnv) return "snippetless";
	if (mode.textEnv) return "text-area";
	if (mode.inlineMath) return "inline";
	if (mode.blockMath) return "block";
	if (mode.codeMath) return "math-fence";
	if (mode.codeBlock !== false) return "fence";
	return mode.text ? "text" : "other";
}
const at = (marked: string) => {
	const { source, position } = spot(marked);
	return new LatexReader().context(source, position);
};

describe("math mode", () => {
	const cases: [string, string][] = [
		["price $x + y|", "text"], ["$x|", "text"], ["$x + y|$", "inline"], ["$|$", "inline"], ["$x$|", "text"],
		["$x|\nnext line", "text"], ["$x|\ny$", "text"], ["$ x|$", "text"], ["$x |$", "text"], ["$x|$5", "text"],
		["costs $5 or $10| today", "text"], ["${} x | y {}$", "inline"], ["${}|{}$", "inline"], ["see $$x|", "text"], ["see $|$", "inline"],
		["$$x|", "block"], ["$$\nx|", "block"], ["$$\nx\ny|\nz", "block"], ["$$\nx|\n$$", "block"], ["$$\nx\n$$\nz|", "text"],
		["$$x|$$", "block"], ["a $$x|$$ b", "block"], ["\\(x|\\)", "text"], ["\\[x|\\]", "text"], ["\\$x|$", "text"],
		["`$x|$`", "other"], ["```\n$x|$\n```", "fence"], ["```math\nx|\n```", "math-fence"], ["```\nx|", "other"], ["> $$\n> x|\n\nz", "block"], ["- $x|$", "inline"],
		["$\\text{abc|}$", "text-area"], ["$\\text{abc|$", "inline"], ["$$\\tag{a|}$$", "snippetless"], ["$$\n\\begin{pm|}\n$$", "snippetless"], ["$\\textcolor{red}{x|}$", "inline"],
	];
	for (const [marked, want] of cases) it(JSON.stringify(marked), () => assert.equal(kind(at(marked).mode), want));

	it("reads \\colorbox as upstream does, which takes the first entry of each name", () => {
		// Its lists say the color is snippetless and the text is text, but lookup by
		// name finds the text entry for argument 0 and the snippetless one for 1.
		assert.equal(kind(at("$\\colorbox{re|}{x}$").mode), "inline");
		assert.equal(kind(at("$\\colorbox{red}{x|}$").mode), "snippetless");
	});
	it("counts a math fence as math", () => assert.equal(inMath(at("```math\nx|\n```").mode), true));
	it("does not stop at 5,000 characters", () => {
		const before = "word ".repeat(1500);
		assert.equal(kind(at(`${before}$x|$`).mode), "inline");
		assert.equal(kind(at(`${before}\n\n$$\nx|\n$$\n\n${before}`).mode), "block");
	});
});

describe("scopes", () => {
	it("names the innermost closed environment", () => {
		assert.equal(at("$$\n\\begin{pmatrix}\na|\n\\end{pmatrix}\n$$").environment, "pmatrix");
		assert.equal(at("$$\\begin{cases}\\begin{aligned}x|\\end{aligned}\\end{cases}$$").environment, "aligned");
		assert.equal(at("$\\begin{pmatrix} \\frac{a|}{b} \\end{pmatrix}$").environment, "pmatrix");
	});
	it("has none without an \\end", () => assert.equal(at("$\\begin{pmatrix} a|$").environment, null));
	it("stacks scopes inner to outer", () => {
		const names = at("$\\begin{pmatrix} \\frac{a|}{b} \\end{pmatrix}$").stack.map((entry) => (entry.kind === "math" ? "math" : entry.name));
		assert.deepEqual(names, ["frac", "pmatrix", "math"]);
	});
});

describe("Backspace in an empty pair", () => {
	const cases: [string, [number, number] | null][] = [
		["$|$", [0, 2]], ["${}|{}$", [0, 6]], ["some *text* $|$", [12, 14]], ["$|$  some text", [0, 2]],
		["$|{}{}$", null], ["${}{|}$", null], ["$x|$", null], ["$$|", null], ["$$\n|\n$$", null], ["$|", null],
	];
	for (const [marked, want] of cases) it(JSON.stringify(marked), () => {
		const { source, position } = spot(marked);
		const pair = new LatexReader().emptyPair(source, position);
		assert.deepEqual(pair && [pair.from, pair.to], want);
	});
});

describe("incremental parsing", () => {
	const atoms = ["$", "$$", "\n", "\n\n", " ", "x", "\\text{", "}", "{", "\\frac", "\\begin{pmatrix}", "\\end{pmatrix}", "`", "```", "> ", "- ", "\\", "1", "|"];
	const key = (reader: LatexReader, source: string, position: number) => {
		const { mode, environment, stack } = reader.context(source, position);
		return JSON.stringify([mode, environment, stack.map((entry) => [entry.kind, entry.inner_start, entry.inner_end])]);
	};
	it("reads every spot as a fresh parse does, through random edits", () => {
		for (let seed = 1; seed <= 25; seed++) {
			let state = seed * 2654435761 >>> 0;
			const next = (limit: number) => {
				state = (state * 1664525 + 1013904223) >>> 0;
				return Math.floor(state / 2 ** 32 * limit);
			};
			const reader = new LatexReader();
			let source = "";
			for (let step = 0; step < 40; step++) {
				const at = next(source.length + 1);
				source = next(10) < 7 ? source.slice(0, at) + atoms[next(atoms.length)] + source.slice(at) : source.slice(0, at) + source.slice(at + 1 + next(3));
				const fresh = new LatexReader();
				for (let position = 0; position <= Math.min(source.length, 30); position++) assert.equal(key(reader, source, position), key(fresh, source, position), JSON.stringify(source));
			}
		}
	});
});

describe("code, for snippets that run in text", () => {
	const text = (marked: string) => at(marked).mode.text;
	const inside = ["`a|", "`a|b`", "``a`b|", "`a\nb|", "- `a|", "# `a|", "```\n|", "```\nx|\n```", "~~~\n|", "```js\n|", "> ```\n> |"];
	const outside = ["|", "`a` |", "`a`|", "\\`|", "`a\n\n|", "```\nx\n```\n|", "$`$ |", "    x|"];
	for (const marked of inside) it(`counts ${JSON.stringify(marked)} as code`, () => assert.equal(text(marked), false));
	for (const marked of outside) it(`counts ${JSON.stringify(marked)} as text`, () => assert.equal(text(marked), true));
});
