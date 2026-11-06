/**
 * Times a learner's snippet regex away from the page. A running regex cannot be
 * stopped, so this one runs where it can be ended whole: it sends a beat before each
 * text, and components/snippet-vetting.ts ends the worker when a beat is late.
 *
 * Backtracking goes bad on a long run of what a repeat takes, followed by something
 * that makes the match fail. So the texts come from the pattern itself: for each
 * repeat, the text that gets to it, then what it takes over and over up to the most a
 * trigger ever sees, then an ending. Plain text is timed as well, for a pattern this
 * reading gets wrong. A regex that only goes bad on some other shape of text is not
 * found here: see "Your snippets" in docs/keyboard.md.
 */
"use strict";

/** The most text a trigger ever sees: WINDOW in src/core/latex-suite/snippets.ts. */
const WINDOW = 1024;
/** One text taking this long, twice over, is too long for one key press. */
const TOO_SLOW_MS = 50;
const MOST_TEXTS = 300;
/** How many of a repeat's units get a text each. All of them share one more. */
const MOST_UNITS = 8;
const MOST_FORMS = 64;
const ENDINGS = ["", "§", "\n"];
const PLAIN_UNITS = ["a", "1", " ", "a b ", "\\a", "{a}"];
/** Tried on each part of a pattern, with the pattern's own characters. */
const CANDIDATES = "ab1 0.,_-\\{}()[]$^*+?|/!xAZ\n\té";
const NOTHING = { kind: "nothing" };

const unique = (list) => [...new Set(list)];

/** Up to three characters a part of the pattern takes, from across what fits. */
function characters(part, flags, source) {
	let regex;
	try { regex = new RegExp(`^(?:${part})$`, flags); }
	catch { return []; }
	const fits = unique([...CANDIDATES, ...source]).filter((ch) => regex.test(ch));
	return unique([fits[0], fits[fits.length >> 1], fits[fits.length - 1]]).filter((ch) => ch !== undefined);
}

/** The pattern's structure. Anything it does not follow throws, or reads as a character. */
function readPattern(source, flags) {
	let at = 0;
	const letter = (part) => ({ kind: "letter", samples: characters(part, flags, source) });
	function escape() {
		const next = source[at + 1];
		if (next === "b" || next === "B") { at += 2; return NOTHING; }
		const back = /^\\(?:[1-9]\d*|k<[^>]*>)/.exec(source.slice(at));
		if (back) { at += back[0].length; return NOTHING; }
		const whole = /^\\(?:c[A-Za-z]|x[\da-fA-F]{2}|u[\da-fA-F]{4}|u\{[\da-fA-F]+\}|[pP]\{[^}]*\}|[^])/u.exec(source.slice(at))[0];
		at += whole.length;
		return letter(whole);
	}
	function charClass() {
		const start = at++;
		let depth = 1;
		while (at < source.length && depth) {
			if (source[at] === "\\") at++;
			else if (source[at] === "]") depth--;
			else if (source[at] === "[" && flags.includes("v")) depth++;
			at++;
		}
		return letter(source.slice(start, at));
	}
	function group() {
		const head = /^\((?:\?(?:[:=!]|<[=!]|<[^>]*>|[ims-]+:))?/.exec(source.slice(at))[0];
		at += head.length;
		const inner = alternatives();
		at++;
		return /[=!]$/.test(head) ? { kind: "look", inner } : inner;
	}
	function atom() {
		const ch = source[at];
		if (ch === "\\") return escape();
		if (ch === "[") return charClass();
		if (ch === "(") return group();
		at += String.fromCodePoint(source.codePointAt(at)).length;
		return ch === "^" || ch === "$" ? NOTHING : letter(ch === "." ? "." : ch.replace(/[.*+?^${}()|[\]\\/]/, "\\$&"));
	}
	function quantified(body) {
		const found = /^(?:([*+?])|\{(\d+)(?:(,)(\d*))?\})[?+]?/.exec(source.slice(at));
		if (!found) return body;
		at += found[0].length;
		const [, sign, least, comma, most] = found;
		if (sign) return { kind: "repeat", body, least: sign === "+" ? 1 : 0, most: sign === "?" ? 1 : Infinity };
		return { kind: "repeat", body, least: Number(least), most: !comma ? Number(least) : most ? Number(most) : Infinity };
	}
	function sequence() {
		const items = [];
		while (at < source.length && source[at] !== "|" && source[at] !== ")") items.push(quantified(atom()));
		return { kind: "sequence", items };
	}
	function alternatives() {
		const options = [sequence()];
		while (source[at] === "|") { at++; options.push(sequence()); }
		return options.length > 1 ? { kind: "either", options } : options[0];
	}
	return alternatives();
}

/** The least text that gets through a part. */
function shortest(node) {
	switch (node.kind) {
		case "letter": return node.samples[0] ?? "";
		case "sequence": return node.items.map(shortest).join("");
		case "either": return node.options.map(shortest).reduce((best, text) => (text.length < best.length ? text : best));
		case "repeat": return shortest(node.body).repeat(Math.min(node.least, WINDOW));
		default: return "";
	}
}

/** Non-empty texts one pass through a part can take. */
function forms(node) {
	switch (node.kind) {
		case "letter": return node.samples;
		case "either": return unique(node.options.flatMap(forms)).slice(0, MOST_FORMS);
		case "sequence": {
			const joined = node.items.reduce((heads, item) => {
				const tails = unique([shortest(item), ...forms(item)]);
				return heads.flatMap((head) => tails.map((tail) => head + tail)).slice(0, MOST_FORMS);
			}, [""]);
			return unique(joined).filter(Boolean);
		}
		case "repeat": return unique(forms(node.body).map((form) => form.repeat(Math.max(1, Math.min(node.least, WINDOW)))));
		default: return [];
	}
}

/** Each repeat, with the text that gets to it. */
function repeatsIn(node, before, found) {
	if (node.kind === "either") for (const option of node.options) repeatsIn(option, before, found);
	else if (node.kind === "look") repeatsIn(node.inner, before, found);
	else if (node.kind === "sequence") {
		let reached = before;
		for (const item of node.items) {
			repeatsIn(item, reached, found);
			reached += shortest(item);
		}
	} else if (node.kind === "repeat") {
		if (node.most > 1) found.push({ before, units: forms(node.body) });
		repeatsIn(node.body, before, found);
	}
}

function textsFor(source, flags) {
	const texts = new Set();
	const add = (before, unit) => {
		const run = (before + unit.repeat(Math.ceil(WINDOW / unit.length))).slice(0, WINDOW);
		for (const ending of ENDINGS) texts.add(run + ending);
	};
	for (const unit of PLAIN_UNITS) add("", unit);
	const found = [];
	try { repeatsIn(readPattern(source, flags), "", found); }
	catch { /* The plain texts still run. */ }
	for (const { before, units } of found) {
		for (const unit of units.slice(0, MOST_UNITS)) add(before, unit);
		if (units.length > 1) add(before, units.join(""));
	}
	return [...texts].slice(0, MOST_TEXTS);
}

function timed(regex, text) {
	const started = performance.now();
	regex.exec(text);
	return performance.now() - started;
}

function verdict(source, flags) {
	const regex = new RegExp(source, flags);
	for (const text of textsFor(source, flags)) {
		self.postMessage({ beat: true });
		if (timed(regex, text) >= TOO_SLOW_MS && timed(regex, text) >= TOO_SLOW_MS) return "slow";
	}
	return "passed";
}

self.onmessage = ({ data }) => self.postMessage({ verdict: verdict(data.source, data.flags) });
self.postMessage({ ready: true });
