/** Auto-fraction, tabout, matrix keys, auto-enlarge and visual snippets. The tabout,
 *  matrix and enlarge goldens are Latex Suite 1.13.3's own, which it runs inside
 *  Obsidian, moved onto the functions they end up in. */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { enlargedBrackets } from "../src/core/latex-suite/auto-enlarge.ts";
import { autoFraction } from "../src/core/latex-suite/autofraction.ts";
import { LatexReader } from "../src/core/latex-suite/context.ts";
import { matrixBracketJump, matrixCell, matrixExit, matrixRow } from "../src/core/latex-suite/matrix.ts";
import { compileSnippets, defaultSnippets, findExpansion, findVisual, type Insertion, type RawSnippet } from "../src/core/latex-suite/snippets.ts";
import { tabout } from "../src/core/latex-suite/tabout.ts";

const reader = new LatexReader();
/** Text with a bar for the caret, or two for a selection. */
function parse(marked: string) {
	const from = marked.indexOf("|"), last = marked.lastIndexOf("|");
	const source = marked.replaceAll("|", "");
	const to = last === from ? from : last - 1;
	return { source, from, to, context: reader.context(source, to) };
}
function applied(source: string, found: Insertion | null) {
	assert.ok(found);
	return source.slice(0, found.from) + found.insert + source.slice(found.to);
}

describe("a file chip's characters", () => {
	const chip = "`/tmp/a}b c.txt`";
	it("are no brace to Tab", () => {
		const source = `$\\frac{x ${chip}}{y}$`, to = 8;
		const { context } = parse(`${source.slice(0, to)}|${source.slice(to)}`);
		assert.equal(tabout(source, to, context)?.caret, source.indexOf("}{y") + 1);
	});
	it("are no closing bracket to a matrix row", () => {
		const source = `$\\begin{pmatrix} ${chip} } \\end{pmatrix}$`, to = source.indexOf("`");
		const { context } = parse(`${source.slice(0, to)}|${source.slice(to)}`);
		assert.equal(matrixBracketJump(source, to, context), source.lastIndexOf(" } ") + 2);
	});
});

describe("tabout", () => {
	const go = (marked: string) => {
		const { source, to, context } = parse(marked);
		const out = tabout(source, to, context);
		return out && out.value.slice(0, out.caret) + "|" + out.value.slice(out.caret);
	};
	it("leaves brackets", () => assert.equal(go("$(|)$"), "$()|$"));
	it("leaves an equation from its end", () => {
		assert.equal(go("$E_{filler}=mc^2|$"), "$E_{filler}=mc^2$|");
		assert.equal(go("$$E_{filler}=mc^2|$$"), "$$E_{filler}=mc^2$$|");
	});
	it("does nothing in the middle of one", () => assert.equal(go("$E_{filler}|=mc^2$"), null));
	it("skips unbalanced brackets", () => {
		const source = "$$1_{[0,1)}$$";
		const out = tabout(source, 10, reader.context(source, 10));
		assert.equal(out?.caret, 11);
	});
	it("stops after a right command with no delimiter, for it to be typed", () => {
		const left = "$$\\left| \\right.$$";
		const inner = "$$\\left| ".length;
		assert.equal(tabout(left, inner, reader.context(left, inner))?.caret, "$$\\left| \\right.".length);
		assert.equal(go("$$ |\\right.$$"), "$$ \\right.|$$");
		assert.equal(go("$$|\\right$$"), "$$\\right|$$");
	});
	it("goes after a right command's delimiter", () => assert.equal(go("$$\\left( a| \\right) b$$"), "$$\\left( a \\right)| b$$"));
	it("reads a left command's delimiter as an opening one", () => assert.equal(go("$$|\\left) a \\right)$$"), "$$\\left) a \\right)|$$"));
	it("works inside a matrix", () => assert.equal(go("$$\\begin{matrix}\n\\text{test|}\n\\end{matrix}$$"), "$$\\begin{matrix}\n\\text{test}|\n\\end{matrix}$$"));
	it("is off outside math", () => assert.equal(go("a|b"), null));
	it("has nothing to do just after a closing $$", () => assert.equal(go("$$x$$|"), null));
	it("ignores comments", () => assert.equal(go("$$a| % )\n b)$$"), "$$a % )\n b)|$$"));
	describe("a block over several lines", () => {
		it("makes a line after it at the end of a text", () => assert.equal(go("$$\nx|\n$$"), "$$\nx\n$$\n|"));
		it("takes the opening line's indent", () => assert.equal(go("  $$\n  x|\n  $$"), "  $$\n  x\n  $$\n  |"));
		it("reuses a blank line, giving it that indent", () => assert.equal(go("  $$\n  x|\n  $$\n   \nb"), "  $$\n  x\n  $$\n  |\nb"));
		it("goes to the start of a line with text", () => assert.equal(go("$$\nx|\n$$\nb"), "$$\nx\n$$\n|b"));
		it("trims what the caret leaves behind", () => assert.equal(go("$$\nx|   \n$$\nb"), "$$\nx\n$$\n|b"));
		it("does nothing short of the end", () => assert.equal(go("$$\nx|\ny\n$$"), null));
	});
	it("has nowhere to go in an unclosed block at the end of the text", () => assert.equal(go("$$\nx|"), null));
});

describe("matrix keys", () => {
	const row = (marked: string) => {
		const { source, from, to, context } = parse(marked);
		const found = matrixRow(source, from, to, context);
		return found && applied(source, found);
	};
	const cell = (marked: string) => {
		const { source, to, context } = parse(marked);
		const found = matrixCell(to, context);
		return found && applied(source, found);
	};
	const exit = (marked: string) => {
		const { source, to, context } = parse(marked);
		return matrixExit(source, to, context);
	};
	it("adds a cell", () => {
		assert.equal(cell("$$\\begin{align} |\\end{align}$$"), "$$\\begin{align}  & \\end{align}$$");
		assert.equal(cell("$$\\begin{align}\n1|\n\\end{align}$$"), "$$\\begin{align}\n1 & \n\\end{align}$$");
	});
	it("adds a row in place on one line", () => assert.equal(row("$$\\begin{align}1|\\end{align}$$"), "$$\\begin{align}1 \\\\  \\end{align}$$"));
	it("adds a row on a line of its own", () => assert.equal(row("$$\\begin{align}\n1|\n\\end{align}$$"), "$$\\begin{align}\n1 \\\\\n\n\\end{align}$$"));
	it("brings the row's leading cells", () => assert.equal(row("$$\\begin{align}\n&=20|\n\\end{align}$$"), "$$\\begin{align}\n&=20 \\\\\n&\n\\end{align}$$"));
	it("keeps the line's indent", () => assert.equal(row("  $$\\begin{align}\n  a|\n  \\end{align}$$"), "  $$\\begin{align}\n  a \\\\\n  \n  \\end{align}$$"));
	it("puts its stop at the end", () => {
		const { source, from, to, context } = parse("  $$\\begin{align}\n  a|\n  \\end{align}$$");
		const found = matrixRow(source, from, to, context)!;
		assert.deepEqual(found.tabstops, [{ index: [0], from: found.insert.length, to: found.insert.length }]);
	});
	it("leaves a matrix from its last row", () => {
		const source = "$$\\begin{align}\n&=20\n\\end{align}$$";
		assert.equal(exit("$$\\begin{align}\n&=20|\n\\end{align}$$"), source.length - 2);
	});
	it("goes to the end of the next row", () => {
		assert.equal(exit("$$\\begin{align}\n&=20|\\\\\n&=10+10\n\\end{align}$$"), "$$\\begin{align}\n&=20\\\\\n&=10+10".length);
	});
	it("leaves a matrix of one line from anywhere", () => assert.equal(exit("$$\\begin{matrix}a|b\\end{matrix}c$$"), "$$\\begin{matrix}ab\\end{matrix}".length));
	it("has nowhere to go with no next line", () => assert.equal(exit("$$\\begin{align}\n&=20|"), null));
	it("covers every environment on the list", () => {
		for (const name of ["pmatrix", "cases", "align", "gather", "bmatrix", "Bmatrix", "vmatrix", "Vmatrix", "array", "matrix"]) {
			assert.ok(cell(`$$\\begin{${name}}|\\end{${name}}$$`), name);
		}
	});
	it("leaves other environments and plain math alone", () => {
		assert.equal(cell("$$\\begin{equation}|\\end{equation}$$"), null);
		assert.equal(cell("$$a|$$"), null);
		assert.equal(row("$$a|$$"), null);
	});
	it("is off in a macro inside a matrix", () => assert.equal(cell("$$\\begin{matrix}\\frac{a|}{b}\\end{matrix}$$"), null));
	it("is off in a matrix's text", () => assert.equal(cell("$$\\begin{matrix}\\text{a|}\\end{matrix}$$"), null));
	it("works in a math fence, which is strict math too", () => assert.equal(cell("```math\n\\begin{matrix}\na|\n\\end{matrix}\n```"), "```math\n\\begin{matrix}\na & \n\\end{matrix}\n```"));
	it("is off outside $$", () => assert.equal(cell("\\begin{matrix}\na|\n\\end{matrix}"), null));
	it("jumps past a bracket closing on this line", () => {
		const { source, to, context } = parse("$$\\begin{pmatrix}(a|) & b\\end{pmatrix}$$");
		assert.equal(matrixBracketJump(source, to, context), to + 1);
	});
	it("does not jump past a pair that opens after the caret", () => {
		const { source, to, context } = parse("$$\\begin{pmatrix}|(a) & b\\end{pmatrix}$$");
		assert.equal(matrixBracketJump(source, to, context), null);
	});
	it("does not jump outside a matrix", () => {
		const { source, to, context } = parse("$$(a|)$$");
		assert.equal(matrixBracketJump(source, to, context), null);
	});
});

describe("auto-fraction", () => {
	const fraction = (marked: string) => {
		const { source, from, to, context } = parse(marked);
		const found = autoFraction(source, from, to, context);
		return found && applied(source, found);
	};
	it("takes what is before the caret", () => assert.equal(fraction("$$x|$$"), "$$\\frac{x}{}$$"));
	it("stops at a breaking character", () => {
		for (const stop of [" ", "+", "-", "=", "\t", "\n"]) assert.equal(fraction(`$$a${stop}x|$$`), `$$a${stop}\\frac{x}{}$$`, JSON.stringify(stop));
	});
	it("stops at an opening bracket", () => {
		assert.equal(fraction("$$(x|)$$"), "$$(\\frac{x}{})$$");
		assert.equal(fraction("$$\\sqrt{x|}$$"), "$$\\sqrt{\\frac{x}{}}$$");
	});
	it("keeps a closed bracket whole", () => assert.equal(fraction("$$a+f(b+c)|$$"), "$$a+\\frac{f(b+c)}{}$$"));
	it("drops parentheses around the whole numerator", () => assert.equal(fraction("$$(a+b)|$$"), "$$\\frac{a+b}{}$$"));
	it("keeps them around only a part", () => assert.equal(fraction("$$(a)(b)|$$"), "$$\\frac{(a)(b)}{}$$"));
	it("keeps spaces after a greek letter", () => assert.equal(fraction("$$\\alpha x|$$"), "$$\\frac{\\alpha x}{}$$"));
	it("uses a selection as it stands", () => assert.equal(fraction("$$|a+b|$$"), "$$\\frac{a+b}{}$$"));
	it("gives an empty numerator a stop of its own", () => {
		const { source, from, to, context } = parse("$$()|$$");
		const found = autoFraction(source, from, to, context)!;
		assert.equal(found.insert, "\\frac{}{}");
		assert.deepEqual(found.tabstops.map(({ index, from }) => [index[0], from]), [[0, 6], [1, 8], [2, 9]]);
	});
	it("gives a numerator stops after it", () => {
		const { source, from, to, context } = parse("$$x|$$");
		const found = autoFraction(source, from, to, context)!;
		assert.deepEqual(found.tabstops.map(({ index, from }) => [index[0], from]), [[1, 9], [2, 10]]);
	});
	it("leaves `/` alone with nothing before it, for `//`", () => {
		assert.equal(fraction("$$|$$"), null);
		assert.equal(fraction("$$a+|$$"), null);
	});
	it("gives up on a bracket with no match", () => assert.equal(fraction("$$a)|$$"), null));
	it("keeps out of exponents and \\pu", () => {
		assert.equal(fraction("$$a^{b|}$$"), null);
		assert.equal(fraction("$$\\pu{b|}$$"), null);
	});
	it("runs again after an exponent", () => assert.equal(fraction("$$a^{b}|$$"), "$$\\frac{a^{b}}{}$$"));
	it("needs strict math", () => {
		assert.equal(fraction("x|"), null);
		assert.equal(fraction("$$\\text{x|}$$"), null);
	});
	it("works in a math fence", () => assert.equal(fraction("```math\nx|\n```"), "```math\n\\frac{x}{}\n```"));
	it("gives the key back on undo only without a selection", () => {
		const typed = parse("$$x|$$"), selected = parse("$$|x|$$");
		assert.equal(autoFraction(typed.source, typed.from, typed.to, typed.context)?.key, "/");
		assert.equal(autoFraction(selected.source, selected.from, selected.to, selected.context)?.key, null);
	});
});

describe("auto-enlarge", () => {
	const entries: RawSnippet[] = [
		{ trigger: "sum", replacement: "\\sum", options: "mA" },
		{ trigger: "int", replacement: "\\int", options: "mA" },
		{ trigger: "rum", replacement: "\\rum", options: "mA" },
	];
	/** Press the key as a box would: the snippet, then the brackets. */
	function press(marked: string, key: string) {
		const { source, to } = parse(marked);
		const { snippets, errors } = compileSnippets(entries, {});
		assert.deepEqual(errors, []);
		const found = findExpansion(snippets.automatic, snippets.macros, source, to, key, (offset) => reader.context(source, offset));
		let next = applied(source, found);
		if (!found!.enlarge) return next;
		for (const edit of enlargedBrackets(reader, next, found!.from + found!.insert.length)) next = next.slice(0, edit.from) + edit.text + next.slice(edit.to);
		return next;
	}
	const enlarged = (marked: string) => {
		const { source, to } = parse(marked);
		let next = source;
		for (const edit of enlargedBrackets(reader, source, to)) next = next.slice(0, edit.from) + edit.text + next.slice(edit.to);
		return next;
	};
	it("enlarges brackets for sum", () => assert.equal(press("$$(su|)$$", "m"), "$$\\left( \\sum \\right)$$"));
	it("does not for a snippet with no trigger in it", () => assert.equal(press("$$(\\sum ru|)$$", "m"), "$$(\\sum \\rum)$$"));
	it("only enlarges brackets with the trigger inside", () => assert.equal(press("$$((a+b)su|)$$", "m"), "$$\\left( (a+b)\\sum \\right)$$"));
	it("enlarges brackets for int", () => assert.equal(press("$$(in|)$$", "t"), "$$\\left( \\int \\right)$$"));
	it("leaves brackets with a size control", () => assert.equal(press("$$\\left( \\big(in|) ) \\right.$$", "t"), "$$\\left( \\big(\\int) ) \\right.$$"));
	it("enlarges nested brackets, outermost first in the text", () => assert.equal(enlarged("$$((\\sum|))$$"), "$$\\left( \\left( \\sum \\right) \\right)$$"));
	it("leaves braces", () => assert.equal(enlarged("$${\\sum|}$$"), "$${\\sum}$$"));
	it("leaves \\left already there", () => assert.equal(enlarged("$$\\left(\\sum|\\right)$$"), "$$\\left(\\sum\\right)$$"));
	it("leaves a bracket with no partner", () => assert.equal(enlarged("$$(\\sum|$$"), "$$(\\sum$$"));
	it("enlarges square brackets", () => assert.equal(enlarged("$$[\\sum|]$$"), "$$\\left[ \\sum \\right]$$"));
	it("takes in \\lvert pairs", () => assert.equal(enlarged("$$\\lvert \\sum| \\rvert$$"), "$$\\left\\lvert  \\sum  \\right\\rvert$$"));
	it("does not need the caret inside the brackets", () => assert.equal(enlarged("$$(\\sum) x|$$"), "$$\\left( \\sum \\right) x$$"));
	it("stays in the caret's equation", () => assert.equal(enlarged("$(\\sum)$ $(\\sum|)$"), "$(\\sum)$ $\\left( \\sum \\right)$"));
	it("works over several lines", () => assert.equal(enlarged("$$\n(\\sum|)\n$$"), "$$\n\\left( \\sum \\right)\n$$"));
	it("works in a math fence", () => assert.equal(enlarged("```math\n(\\sum|)\n```"), "```math\n\\left( \\sum \\right)\n```"));
	it("does nothing outside math", () => assert.equal(enlarged("(\\sum|)"), "(\\sum)"));
});

describe("visual snippets", () => {
	const { visual } = defaultSnippets();
	const wrap = (marked: string, key: string) => {
		const { source, from, to } = parse(marked);
		const found = findVisual(visual, source, from, to, key, (offset) => reader.context(source, offset));
		return found && applied(source, found);
	};
	it("wraps a selection", () => {
		assert.equal(wrap("$$|x|$$", "S"), "$$\\sqrt{ x }$$");
		assert.equal(wrap("$$|x|$$", "C"), "$$\\cancel{ x }$$");
		assert.equal(wrap("$$|x|$$", "("), "$$(x)$$");
		assert.equal(wrap("$$|x|$$", "["), "$$[x]$$");
		assert.equal(wrap("$$|x|$$", "{"), "$${x}$$");
	});
	it("trims the trailing space in inline math", () => assert.equal(wrap("$|x| y$", "U"), "$\\underbrace{ x }_{  } y$".replace("_{  }", "_{  }")));
	it("takes a selection made backwards", () => {
		const source = "$$x$$";
		const found = findVisual(visual, source, 2, 3, "S", (offset) => reader.context(source, offset));
		assert.equal(found?.from, 2);
	});
	it("needs a selection", () => assert.equal(wrap("$$x|$$", "S"), null));
	it("needs math", () => assert.equal(wrap("|x|", "S"), null));
	it("ignores keys it has no snippet for", () => assert.equal(wrap("$$|x|$$", "q"), null));
	it("leaves $0 for the caret", () => {
		const { source, from, to } = parse("$$|x|$$");
		const found = findVisual(visual, source, from, to, "U", (offset) => reader.context(source, offset))!;
		assert.equal(found.tabstops.length, 1);
		assert.equal(found.insert.slice(found.tabstops[0]!.from), " }");
	});
	it("selects a result that has no stops, so that wraps chain", () => {
		const { source, from, to } = parse("$$|x|$$");
		const found = findVisual(visual, source, from, to, "S", (offset) => reader.context(source, offset))!;
		assert.deepEqual(found.tabstops, [{ index: [0], from: 0, to: found.insert.length }]);
	});
	it("takes text as it is, with no `$` patterns", () => assert.equal(wrap("$$|a$&b|$$", "S"), "$$\\sqrt{ a$&b }$$"));
	it("does not run for a key that lands on the undo", () => {
		const { source, from, to } = parse("$$|x|$$");
		assert.equal(findVisual(visual, source, from, to, "S", (offset) => reader.context(source, offset))?.key, null);
	});
	it("drops quote markers and indent inside the selection", () => {
		assert.equal(wrap("> $$\n> |a\n> b|\n> $$", "S"), "> $$\n> \\sqrt{ a\n> b }\n> $$");
		assert.equal(wrap("  $$\n  |a\n  b|\n  $$", "S"), "  $$\n  \\sqrt{ a\n  b }\n  $$");
	});
	it("keeps a selection whose lines are uneven", () => assert.equal(wrap("$$\n  |a\nb|\n$$", "(")?.includes("(a\nb)"), true));
});
