import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { deletePair, insertPair, PairClosers, type PairKinds } from "../src/core/auto-pairs.ts";

/** `|` is the caret, and `[...]` a selection whose focus is its right edge. */
function parse(text: string) {
	const caret = text.indexOf("|");
	if (caret >= 0) return { value: text.replace("|", ""), cursor: { anchor: caret, focus: caret } };
	const from = text.indexOf("["), to = text.indexOf("]") - 1;
	return { value: text.replace("[", "").replace("]", ""), cursor: { anchor: from, focus: to } };
}
function show(value: string, { anchor, focus }: { anchor: number; focus: number }) {
	if (anchor === focus) return `${value.slice(0, focus)}|${value.slice(focus)}`;
	const from = Math.min(anchor, focus), to = Math.max(anchor, focus);
	return `${value.slice(0, from)}[${value.slice(from, to)}]${value.slice(to)}`;
}
const applied = (value: string, edits: { from: number; to: number; text: string }[]) => edits.reduce((text, { from, to, text: added }) => text.slice(0, from) + added + text.slice(to), value);

/** The text after `key`, or null when the key is plain typing. */
function press(text: string, key: string, closers: number[] = [], kinds?: PairKinds) {
	const { value, cursor } = parse(text);
	const change = insertPair(value, [cursor], key, closers, kinds);
	return change && show(applied(value, change.edits), change.cursors[0]!);
}
function backspace(text: string, kinds?: PairKinds) {
	const { value, cursor } = parse(text);
	const change = deletePair(value, [cursor], kinds);
	return change && show(applied(value, change.edits), change.cursors[0]!);
}
/** A run of keys through the closers, the way a box drives them. Typing that nothing
 *  takes lands as a plain character. */
function typeKeys(start: string, keys: string) {
	let { value, cursor } = parse(start);
	const closers = new PairClosers();
	closers.arrived(value, cursor.focus);
	for (const key of keys) {
		const change = insertPair(value, [cursor], key, closers.list);
		if (change) {
			value = applied(value, change.edits);
			cursor = change.cursors[0]!;
			closers.took(change, value, cursor.focus);
		} else {
			const from = Math.min(cursor.anchor, cursor.focus), to = Math.max(cursor.anchor, cursor.focus);
			value = value.slice(0, from) + key + value.slice(to);
			cursor = { anchor: from + 1, focus: from + 1 };
			closers.edited([{ from, to, length: 1 }], value, cursor.focus);
		}
	}
	return show(value, cursor);
}

describe("brackets", () => {
	for (const [open, close] of [["(", ")"], ["[", "]"], ["{", "}"]] as const) {
		it(`${open} pairs at the end of the text`, () => assert.equal(press("|", open), `${open}|${close}`));
		it(`${open} pairs before white space`, () => {
			assert.equal(press("| x", open), `${open}|${close} x`);
			assert.equal(press("|\nx", open), `${open}|${close}\nx`);
			assert.equal(press("|\tx", open), `${open}|${close}\tx`);
		});
	}
	it("pair before the closing characters Obsidian lists", () => {
		for (const next of [")", "]", "}", "'", '"', ":", ";", ">"]) assert.equal(press(`|${next}`, "("), `(|)${next}`);
	});
	it("do not pair before anything else", () => {
		for (const next of ["a", "1", "(", "[", ".", ",", "$", "*", "_", "`", "é"]) assert.equal(press(`|${next}`, "("), null);
	});
	it("nest", () => assert.equal(typeKeys("|", "(("), "((|))"));
	it("wrap a selection and keep it selected", () => {
		assert.equal(press("a [word] b", "("), "a ([word]) b");
		assert.equal(press("a [word] b", "["), "a [[word]] b");
		assert.equal(press("a [word] b", "{"), "a {[word]} b");
	});
	it("keep a backward selection backward", () => {
		const change = insertPair("word", [{ anchor: 4, focus: 0 }], "(", [])!;
		assert.deepEqual(change.cursors, [{ anchor: 5, focus: 1 }]);
		assert.equal(applied("word", change.edits), "(word)");
	});
	it("replace a selection over several lines", () => {
		assert.equal(press("a [b\nc] d", "("), "a (|) d");
	});
});

describe("stepping over closers", () => {
	it("only an inserted closer", () => {
		assert.equal(typeKeys("|", "(x)"), "(x)|");
		assert.equal(press("(x|)", ")"), null);
		assert.equal(typeKeys("(x|)", ")"), "(x)|)");
	});
	it("all three kinds", () => {
		assert.equal(typeKeys("|", "[x]"), "[x]|");
		assert.equal(typeKeys("|", "{x}"), "{x}|");
	});
	it("a closer around a wrapped selection", () => {
		const { value, cursor } = parse("[word]");
		const closers = new PairClosers();
		const change = insertPair(value, [cursor], "(", [])!;
		const text = applied(value, change.edits);
		closers.took(change, text, change.cursors[0]!.focus);
		assert.deepEqual(closers.list, [5]);
	});
	it("nested closers one by one", () => assert.equal(typeKeys("|", "((x))"), "((x))|"));
	it("the wrong closer is plain typing", () => assert.equal(typeKeys("|", "(]"), "(]|)"));
	it("needs a closer right at the caret", () => assert.equal(press("(| )", ")", [2]), null));
	it("reports the closer it passed", () => {
		const change = insertPair("()", [{ anchor: 1, focus: 1 }], ")", [1])!;
		assert.deepEqual(change, { edits: [], cursors: [{ anchor: 2, focus: 2 }], closers: [], passed: [1] });
	});
});

describe("quotes and Markdown symbols", () => {
	for (const token of ["'", '"', "*", "_", "`"]) {
		it(`${token} pairs at the empty start`, () => assert.equal(press("|", token), `${token}|${token}`));
		it(`${token} pairs between white space`, () => assert.equal(press("a | b", token), `a ${token}|${token} b`));
		it(`${token} pairs at a line's start`, () => assert.equal(press("a\n|", token), `a\n${token}|${token}`));
		it(`${token} is plain after a word`, () => assert.equal(press("word|", token), null));
		it(`${token} is plain before a word`, () => assert.equal(press("| word", token), `${token}|${token} word`));
		it(`${token} is plain right before text`, () => assert.equal(press("|word", token), null));
		it(`${token} is plain after punctuation`, () => assert.equal(press("(|", token), null));
		it(`${token} is plain before punctuation`, () => assert.equal(press(" |)", token), null));
		it(`${token} steps over its own closer`, () => assert.equal(typeKeys("|", `${token}x${token}`), `${token}x${token}|`));
		it(`${token} wraps a selection and keeps it`, () => assert.equal(press("a [word] b", token), `a ${token}[word]${token} b`));
		it(`${token} right away steps over`, () => assert.equal(typeKeys("|", `${token}${token}`), `${token}${token}|`));
		it(`${token} is plain before one that is not a closer`, () => assert.equal(press(`|${token}`, token), null));
	}
	it("an apostrophe stays one", () => assert.equal(typeKeys("|", "don't"), "don't|"));
	it("a product stays one", () => assert.equal(typeKeys("|", "2*3"), "2*3|"));
	it("a snake's name stays one", () => assert.equal(typeKeys("|", "a_b"), "a_b|"));
	it("the second symbol wraps again", () => {
		const first = press("[x]", "*")!;
		assert.equal(first, "*[x]*");
		assert.equal(press(first, "*"), "**[x]**");
	});
	it("replace a selection over several lines", () => assert.equal(press("[a\nb]", '"'), '"|"'));
	it("no triple for anything but a backtick", () => assert.equal(typeKeys("|", "'''"), "'''|"));
});

describe("backticks", () => {
	it("three open a fence", () => assert.equal(typeKeys("|", "```"), "```|\n```"));
	it("in a list, the fence stays in the item", () => assert.equal(typeKeys("- |", "```"), "- ```|\n  ```"));
	it("in a quote, the fence stays in the quote", () => assert.equal(typeKeys("> |", "```"), "> ```|\n> ```"));
	it("an indented fence keeps its indent", () => assert.equal(typeKeys("  |", "```"), "  ```|\n  ```"));
	it("a fourth is plain", () => assert.equal(press("```|", "`"), null));
	it("a selection over lines wraps, as a code span", () => assert.equal(press("[a\nb]", "`"), "`[a\nb]`"));
	it("a third wrap makes a fence", () => assert.equal(press("``[x]``", "`"), "```\n[x]\n```"));
	it("no second line break where one is there", () => assert.equal(press("``[\nx\n]``", "`"), "```[\nx\n]```"));
	it("in a list, that fence stays in the item", () => assert.equal(press("- ``[x]``", "`"), "- ```\n  [x]\n  ```"));
	it("steps over a whole fence closer on one line", () => {
		const change = insertPair("``````", [{ anchor: 3, focus: 3 }], "`", [3])!;
		assert.equal(change.cursors[0]!.focus, 6);
	});
});

describe("symbols that only wrap", () => {
	for (const token of ["$", "=", "~", "%"]) {
		it(`${token} wraps a selection`, () => assert.equal(press("a [word] b", token), `a ${token}[word]${token} b`));
		it(`${token} leaves no closer`, () => {
			const change = insertPair("x", [{ anchor: 0, focus: 1 }], token, [])!;
			assert.deepEqual(change.closers, []);
		});
		it(`${token} does not pair`, () => {
			assert.equal(press("|", token), null);
			assert.equal(press("a | b", token), null);
		});
		it(`${token} wraps a selection over several lines`, () => assert.equal(press("[a\nb]", token), `${token}[a\nb]${token}`));
		it(`${token} does not step over`, () => assert.equal(press(`x|${token}`, token, [1]), null));
		it(`${token} does not delete as a pair`, () => assert.equal(backspace(`${token}|${token}`), null));
	}
});

describe("Backspace", () => {
	for (const [open, close] of [["(", ")"], ["[", "]"], ["{", "}"], ["'", "'"], ['"', '"'], ["*", "*"], ["_", "_"], ["`", "`"]] as const) {
		it(`takes out an empty ${open}${close}`, () => assert.equal(backspace(`a ${open}|${close} b`), "a | b"));
	}
	it("whoever typed the closer", () => assert.equal(backspace("(|)"), "|"));
	it("leaves anything else", () => {
		assert.equal(backspace("(x|)"), null);
		assert.equal(backspace("(|x)"), null);
		assert.equal(backspace("(|]"), null);
		assert.equal(backspace("|"), null);
		assert.equal(backspace("x|"), null);
	});
	it("leaves a selection", () => assert.equal(deletePair("()", [{ anchor: 0, focus: 2 }]), null));
});

describe("several cursors", () => {
	it("each takes the pair", () => {
		const change = insertPair("\n\n", [{ anchor: 0, focus: 0 }, { anchor: 1, focus: 1 }], "(", [])!;
		assert.equal(applied("\n\n", change.edits), "()\n()\n");
		assert.deepEqual(change.cursors, [{ anchor: 1, focus: 1 }, { anchor: 4, focus: 4 }]);
		assert.deepEqual(change.closers, [1, 4]);
	});
	it("all or none", () => assert.equal(insertPair("\nx", [{ anchor: 0, focus: 0 }, { anchor: 1, focus: 1 }], "(", []), null));
	it("edits run one after another", () => {
		const change = insertPair("ab cd", [{ anchor: 0, focus: 2 }, { anchor: 3, focus: 5 }], "*", [])!;
		assert.equal(applied("ab cd", change.edits), "*ab* *cd*");
		assert.deepEqual(change.cursors, [{ anchor: 1, focus: 3 }, { anchor: 6, focus: 8 }]);
		assert.deepEqual(change.closers, [3, 8]);
	});
	it("step over together", () => {
		const change = insertPair("()\n()", [{ anchor: 1, focus: 1 }, { anchor: 4, focus: 4 }], ")", [1, 4])!;
		assert.deepEqual(change.cursors, [{ anchor: 2, focus: 2 }, { anchor: 5, focus: 5 }]);
		assert.deepEqual(change.passed, [1, 4]);
	});
	it("unless a closer is missing", () => assert.equal(insertPair("()\n()", [{ anchor: 1, focus: 1 }, { anchor: 4, focus: 4 }], ")", [1]), null));
	it("Backspace at each", () => {
		const change = deletePair("()\n()", [{ anchor: 1, focus: 1 }, { anchor: 4, focus: 4 }])!;
		assert.equal(applied("()\n()", change.edits), "\n");
		assert.deepEqual(change.cursors, [{ anchor: 0, focus: 0 }, { anchor: 1, focus: 1 }]);
	});
});

describe("closers over time", () => {
	const tracked = (value: string, ...offsets: number[]) => {
		const closers = new PairClosers();
		closers.arrived(value, 0);
		closers.took({ edits: [], cursors: [], closers: offsets, passed: [] }, value, 0);
		return closers;
	};
	it("text before a closer moves it", () => {
		const closers = tracked("()", 1);
		closers.edited([{ from: 1, to: 1, length: 2 }], "(ab)", 3);
		assert.deepEqual(closers.list, [3]);
	});
	it("text right after a closer leaves it", () => {
		const closers = tracked("()", 1);
		closers.edited([{ from: 2, to: 2, length: 1 }], "()x", 3);
		assert.deepEqual(closers.list, [1]);
	});
	it("deleting a closer ends it", () => {
		const closers = tracked("()", 1);
		closers.edited([{ from: 1, to: 2, length: 0 }], "(", 1);
		assert.deepEqual(closers.list, []);
	});
	it("moving along the line keeps it", () => {
		const closers = tracked("ab ()", 4);
		closers.arrived("ab ()", 1);
		assert.deepEqual(closers.list, [4]);
	});
	it("moving to another line forgets every closer", () => {
		const closers = tracked("()\n()", 1);
		closers.arrived("()\n()", 4);
		assert.deepEqual(closers.list, []);
		closers.arrived("()\n()", 1);
		assert.deepEqual(closers.list, []);
	});
	it("a new line between the pair forgets them too", () => {
		const closers = tracked("()", 1);
		closers.edited([{ from: 1, to: 1, length: 1 }], "(\n)", 2);
		assert.deepEqual(closers.list, []);
	});
	it("a new line above keeps them, and the line follows", () => {
		const closers = tracked("()", 1);
		closers.mapped([{ from: 0, to: 0, length: 3 }], "ab\n()", 4);
		assert.deepEqual(closers.list, [4]);
		closers.arrived("ab\n()", 4);
		assert.deepEqual(closers.list, [4]);
	});
	it("stepping over one leaves the other", () => {
		const closers = tracked("(())", 2, 3);
		closers.took({ edits: [], cursors: [], closers: [], passed: [2] }, "(())", 3);
		assert.deepEqual(closers.list, [3]);
	});
	it("clears", () => {
		const closers = tracked("()", 1);
		closers.clear();
		assert.deepEqual(closers.list, []);
	});
	it("a wrap's two edits map a closer inside it", () => {
		const closers = tracked("(x)", 2);
		closers.edited([{ from: 0, to: 0, length: 1 }, { from: 4, to: 4, length: 1 }], "[(x)]", 3);
		assert.deepEqual(closers.list, [3]);
	});
});

describe("the two settings", () => {
	const brackets: PairKinds = { brackets: true, markdown: false }, markdown: PairKinds = { brackets: false, markdown: true };
	it("gives brackets and quotes to one", () => {
		for (const key of ["(", "[", "{", "'", '"']) {
			assert.notEqual(press("|", key, [], brackets), null, key);
			assert.equal(press("|", key, [], markdown), null, key);
		}
		assert.equal(press("(|)", ")", [1], markdown), null);
		assert.equal(press("(|)", ")", [1], brackets), "()|");
	});
	it("gives Markdown symbols and fences to the other", () => {
		for (const key of ["*", "_", "`"]) {
			assert.notEqual(press("|", key, [], markdown), null, key);
			assert.equal(press("|", key, [], brackets), null, key);
		}
		assert.equal(press("``|", "`", [], brackets), null);
		assert.notEqual(press("``|", "`", [], markdown), null);
	});
	it("wraps with `$ = ~ %` under either", () => {
		for (const kinds of [brackets, markdown]) for (const key of ["$", "=", "~", "%"]) assert.equal(press("[a]", key, [], kinds), `${key}[a]${key}`);
	});
	it("takes an empty pair back only under its own setting", () => {
		assert.equal(backspace("(|)", markdown), null);
		assert.equal(backspace("(|)", brackets), "|");
		assert.equal(backspace("'|'", markdown), null);
		assert.equal(backspace("*|*", brackets), null);
		assert.equal(backspace("*|*", markdown), "|");
	});
});

describe("a path typed in backticks", () => {
	for (const text of ["`~/b.pdf`", "`/tmp/a.txt`", "`/tmp/a b.txt`", "see `~/b.pdf` here", "`C:/x/a.txt`"]) {
		it(`stays as typed: ${text}`, () => assert.equal(typeKeys("|", text), `${text}|`));
	}
	it("leaves other code alone", () => {
		assert.equal(typeKeys("|", "`a/b"), "`a/b|`");
		assert.equal(typeKeys("|", "`x`"), "`x`|");
	});
	it("keeps its closer with Markdown pairs off, having none", () => {
		assert.equal(press("`|`", "/", [1], { brackets: true, markdown: false }), null);
	});
});
