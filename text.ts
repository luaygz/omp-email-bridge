/** Rough length of one paragraph; longer prompts are shortened to their start and end. */
export const EXCERPT_MAX_CHARS = 600;

/** Plain text of a user message, ignoring images. */
export function messageText(content: string | ReadonlyArray<{ type: string; text?: string }>): string {
	if (typeof content === "string") return content;
	return content
		.filter(block => block.type === "text" && typeof block.text === "string")
		.map(block => block.text)
		.join("\n");
}

/**
 * Collapses whitespace and, when the text is longer than `max`, keeps its start and end around " ... ",
 * cutting at word boundaries.
 */
export function excerpt(text: string, max = EXCERPT_MAX_CHARS): string {
	const flat = text.replace(/\s+/g, " ").trim();
	if (flat.length <= max) return flat;
	const half = Math.floor((max - 5) / 2);
	let head = flat.slice(0, half);
	const headBreak = head.lastIndexOf(" ");
	if (headBreak > half * 0.6) head = head.slice(0, headBreak);
	let tail = flat.slice(flat.length - half);
	const tailBreak = tail.indexOf(" ");
	if (tailBreak >= 0 && tailBreak < half * 0.4) tail = tail.slice(tailBreak + 1);
	return `${head.trimEnd()} ... ${tail.trimStart()}`;
}

/**
 * Removes the quoted original that mail clients append to replies: Gmail/Apple "On … wrote:",
 * Outlook "-----Original Message-----" and "From:/Sent:" headers, and a trailing block of "> " lines.
 * Returns the whole text when nothing would be left.
 */
export function stripQuotedReply(text: string): string {
	const lines = text.replace(/\r\n?/g, "\n").split("\n");
	let cut = lines.length;
	for (let i = 0; i < lines.length && cut === lines.length; i++) {
		const line = lines[i].trim();
		const attribution = [1, 2, 3].some(n => /\bwrote:\s*$/.test(lines.slice(i, i + n).join(" ").trim()));
		if (/^On\b/.test(line) && attribution) {
			cut = i;
		} else if (/^-{2,}\s*Original Message\s*-{2,}$/i.test(line)) {
			cut = i;
		} else if (/^From:\s.+/.test(line) && lines.slice(i + 1, i + 5).some(next => /^(Sent|Date):\s/.test(next.trim()))) {
			cut = i;
		} else if (line.startsWith(">") && lines.slice(i).every(rest => rest.trim() === "" || rest.trim().startsWith(">"))) {
			cut = i;
		}
	}
	// Outlook puts a line of underscores or dashes above its "From:/Sent:" block.
	const kept = lines
		.slice(0, cut)
		.join("\n")
		.trim()
		.replace(/\n\s*[_-]{5,}$/, "")
		.trim();
	return kept || text.trim();
}

const NAMED_ENTITIES: Record<string, string> = { nbsp: " ", amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };

/** Crude HTML to text for messages that arrive without a plain-text part. */
export function htmlToText(html: string): string {
	return html
		.replace(/<(style|script|head)[\s\S]*?<\/\1>/gi, "")
		.replace(/<br\s*\/?>/gi, "\n")
		.replace(/<\/(p|div|li|tr|h[1-6]|blockquote)>/gi, "\n")
		.replace(/<[^>]+>/g, "")
		.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (entity, code: string) => {
			if (code[0] === "#") {
				const point = code[1] === "x" || code[1] === "X" ? Number.parseInt(code.slice(2), 16) : Number(code.slice(1));
				return Number.isFinite(point) ? String.fromCodePoint(point) : entity;
			}
			return NAMED_ENTITIES[code.toLowerCase()] ?? entity;
		})
		.replace(/\n{3,}/g, "\n\n")
		.trim();
}

/** Bare lowercased address from "Name <user@host>" or "user@host". */
export function bareAddress(value: string): string {
	const angle = /<([^>]+)>/.exec(value);
	return (angle ? angle[1] : value).trim().toLowerCase();
}
