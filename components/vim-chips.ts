import { parseFilePaths } from "@/src/core";

/** A file path chip is one cell on screen and its path must never change, but
 *  the vim engine sees only the source string. These rules keep the two apart. */

export type Span = { start: number; end: number };
export type VimEdit = { from: number; to: number; text: string };

export function chipSpans(value: string): Span[] {
	const spans: Span[] = [];
	for (const part of parseFilePaths(value)) if (part.kind === "path") spans.push({ start: part.start, end: part.end });
	return spans;
}

const swapCase = (text: string) => Array.from(text, (ch) => (/^\p{Lu}$/u.test(ch) ? ch.toLowerCase() : ch.toUpperCase())).join("");
const rot13 = (text: string) => text.replace(/[a-z]/gi, (ch) => {
	const base = ch <= "Z" ? 65 : 97;
	return String.fromCharCode(base + ((ch.charCodeAt(0) - base + 13) % 26));
});

/** The commands that rewrite text in place: gU, gu, g~ and ~, g?, and r. */
function findRewrite(old: string, next: string): ((text: string) => string) | null {
	const fill = next.replace(/\n/g, "").charAt(0);
	const rewrites = [
		(text: string) => text.toUpperCase(),
		(text: string) => text.toLowerCase(),
		swapCase,
		rot13,
		(text: string) => text.replace(/[^\n]/g, () => fill),
	];
	return rewrites.find((rewrite) => rewrite(old) === next) ?? null;
}

/** What to do with an engine edit that touches a chip. Deleting takes the whole
 *  chip, as does replacing past its edge. A rewrite goes around it. Text put down
 *  inside one lands after it. Null refuses the edit: it would change the path. */
export function guardChipEdit(value: string, from: number, to: number, text: string): VimEdit | null {
	const chips = chipSpans(value).filter((chip) => from < chip.end && to > chip.start);
	const first = chips[0], last = chips.at(-1);
	if (!first || !last) return { from, to, text };
	if (from === to) return { from: last.end, to: last.end, text };
	const whole = { from: Math.min(from, first.start), to: Math.max(to, last.end), text };
	if (!text) return whole;
	const rewrite = findRewrite(value.slice(from, to), text);
	if (rewrite) {
		let rewritten = "", at = from;
		for (const chip of chips) {
			const start = Math.max(chip.start, from), end = Math.min(chip.end, to);
			rewritten += rewrite(value.slice(at, start)) + value.slice(start, end);
			at = end;
		}
		return { from, to, text: rewritten + rewrite(value.slice(at, to)) };
	}
	if (chips.every((chip) => from <= chip.start && to >= chip.end)) return { from, to, text };
	return from >= first.start && to <= first.end ? null : whole;
}

const isHigh = (ch: string | undefined) => !!ch && ch >= "\ud800" && ch <= "\udbff";
const isLow = (ch: string | undefined) => !!ch && ch >= "\udc00" && ch <= "\udfff";

/** Where a motion ends when it stopped inside one cell: past it going forward,
 *  before it going back. A normal-mode cursor sits on a character, so a chip that
 *  ends its line keeps the cursor on the chip. */
export function settleCaret(value: string, offset: number, from: number, normal: boolean): number {
	for (const chip of chipSpans(value)) {
		if (offset <= chip.start || offset >= chip.end) continue;
		if (offset < from) return chip.start;
		const endsLine = chip.end === value.length || value[chip.end] === "\n";
		return normal && endsLine ? chip.start : chip.end;
	}
	if (isLow(value[offset]) && isHigh(value[offset - 1])) return offset < from ? offset - 1 : offset + 1;
	return offset;
}

/** Normal mode has no spot past a line's last character. */
export function clipCaret(value: string, offset: number): number {
	const atLineEnd = offset >= value.length || value[offset] === "\n";
	if (!atLineEnd || offset === 0 || value[offset - 1] === "\n") return offset;
	return settleCaret(value, offset - 1, offset, true);
}
