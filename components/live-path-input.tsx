"use client";

import { forwardRef } from "react";
import { PathInput, type PathInputProps } from "@/components/path-input";
import { useAppearance } from "@/components/settings/appearance";

const WITH_MATH = { math: true };
const WITHOUT_MATH = { math: false };

/** A PathInput that formats its draft as the learner's settings ask. A draft
 *  never shows formatting the sent message would not have. */
export const LivePathInput = forwardRef<HTMLDivElement, Omit<PathInputProps, "liveFormat">>(function LivePathInput(props, ref) {
	const { userMarkdown, userMath, formatAsYouType } = useAppearance().appearance.mdRendering;
	const liveFormat = userMarkdown && formatAsYouType ? (userMath ? WITH_MATH : WITHOUT_MATH) : null;
	return <PathInput {...props} ref={ref} liveFormat={liveFormat} />;
});
