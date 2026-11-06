"use client";

import { forwardRef, useMemo } from "react";
import { PathInput, type PathInputProps } from "@/components/path-input";
import { useAppearance } from "@/components/settings/appearance";
import { useVettedSnippets } from "@/components/snippet-vetting";

const WITH_MATH = { math: true };
const WITHOUT_MATH = { math: false };

/** A PathInput that formats its draft as the learner's settings ask. A draft
 *  never shows formatting the sent message would not have. */
export const LivePathInput = forwardRef<HTMLDivElement, Omit<PathInputProps, "liveFormat">>(function LivePathInput(props, ref) {
	const { mdRendering, vimMode, autoPairBrackets, autoPairMarkdown } = useAppearance().appearance;
	const { userMarkdown, userMath, formatAsYouType, latexSnippets, customSnippets } = mdRendering;
	const liveFormat = userMarkdown && formatAsYouType ? (userMath ? WITH_MATH : WITHOUT_MATH) : null;
	const snippets = userMarkdown && userMath && latexSnippets;
	const { set } = useVettedSnippets(snippets ? customSnippets : null);
	const pairs = useMemo(() => ({ brackets: autoPairBrackets, markdown: autoPairMarkdown }), [autoPairBrackets, autoPairMarkdown]);
	return <PathInput {...props} ref={ref} liveFormat={liveFormat} vim={vimMode} snippets={snippets} snippetSet={snippets ? set : undefined} pairs={pairs} />;
});
