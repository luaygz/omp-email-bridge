import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { loadConfig, resolveAgentDir } from "./config";
import { type InboundMessage, MailtrapClient, MailtrapError, MailtrapUncertainSendError, type SendRequest } from "./mailtrap";
import {
	acquireMailboxLock,
	loadState,
	type ProcessedRecord,
	releaseMailboxLock,
	SCAN_OVERLAP_MS,
	type SessionMailState,
	saveState,
} from "./state";
import { bareAddress, excerpt, htmlToText, messageText, stripQuotedReply } from "./text";
import { type Verdict, verifyOwnerMessage } from "./verify";

const TOOL_NAME = "email_user";
/** Every injected email starts with this, so it is never mistaken for a prompt typed in the terminal. */
const EMAIL_MARKER = "[Email from the user";
const TOKEN_LENGTH = 10;
const TOKEN_ALPHABET = "abcdefghijklmnopqrstuvwxyz234567";
/** Injected email carries its Mailtrap ID in this form, so delivery can be confirmed from the session history. */
const MESSAGE_ID_PATTERN = /Mailtrap message ID (\d+)/;
const MAX_DELIVERY_ATTEMPTS = 5;
const MAX_RAW_BYTES = 40 * 1024 * 1024;
const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024;
const MAX_INLINE_IMAGE_BYTES = 5 * 1024 * 1024;
const MAX_BACKOFF_MS = 5 * 60_000;
const INLINE_IMAGE_TYPES: Record<string, true> = {
	"image/png": true,
	"image/jpeg": true,
	"image/gif": true,
	"image/webp": true,
};

type ImagePart = { type: "image"; data: string; mimeType: string };
type UserContent = string | ({ type: "text"; text: string } | ImagePart)[];

/** One period during which this binding serves one session ID. A new one starts on every start, switch, or ID change. */
interface Activation {
	sessionId: string;
	address: string;
	/** Interactive main session: polls the inbox and sends the session email. */
	live: boolean;
	/** The session email has not been sent for this activation yet. */
	introPending: boolean;
	/** Raw text of the last prompt typed in the terminal, before skill or template expansion. */
	typedPrompt: string | undefined;
	/** Mailtrap IDs of email handed to omp during this activation that may still be waiting in its queue. */
	queued: Set<string>;
}

type Outcome =
	| { kind: "deliver"; content: UserContent; note: string }
	| { kind: "reject"; reason: string }
	| { kind: "retry"; reason: string }
	| { kind: "stale" };

/**
 * Mailbox name for a session: base32 of a hash of its ID. Session IDs are UUIDv7, which start with a
 * timestamp, so the ID itself would be partly guessable.
 */
function sessionToken(sessionId: string): string {
	const digest = createHash("sha256").update(`omp-email-bridge:${sessionId}`).digest();
	let token = "";
	let buffer = 0;
	let bits = 0;
	for (const byte of digest) {
		buffer = ((buffer << 8) | byte) & 0xffff;
		bits += 8;
		while (bits >= 5 && token.length < TOKEN_LENGTH) {
			token += TOKEN_ALPHABET[(buffer >>> (bits - 5)) & 31];
			bits -= 5;
		}
		if (token.length === TOKEN_LENGTH) break;
	}
	return token;
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/** Text of the earliest user prompt on the branch, skipping injected email and the message being sent now. */
function firstTypedPrompt(ctx: ExtensionContext, excludeTimestamp: number): string | undefined {
	for (const entry of ctx.sessionManager.getBranch()) {
		if (entry.type !== "message" || entry.message.role !== "user" || entry.message.synthetic) continue;
		if (entry.message.timestamp === excludeTimestamp) continue;
		const text = messageText(entry.message.content).trim();
		if (text && !text.startsWith(EMAIL_MARKER)) return text;
	}
	return undefined;
}

/** Mailtrap IDs of email that reached the session's history, on any branch. */
function landedEmailIds(ctx: ExtensionContext): Set<string> {
	const ids = new Set<string>();
	for (const entry of ctx.sessionManager.getEntries()) {
		if (entry.type !== "message" || entry.message.role !== "user") continue;
		const text = messageText(entry.message.content);
		if (!text.startsWith(EMAIL_MARKER)) continue;
		const id = MESSAGE_ID_PATTERN.exec(text)?.[1];
		if (id) ids.add(id);
	}
	return ids;
}

/** File name safe to create inside the attachment directory, unique among `used`. */
function safeFileName(name: string, used: Set<string>): string {
	const base = path.basename(name).replace(/[\u0000-\u001f/\\:*?"<>|]/g, "_").replace(/^\.+/, "").slice(0, 120) || "attachment";
	const extension = path.extname(base);
	const stem = base.slice(0, base.length - extension.length);
	let candidate = base;
	for (let n = 2; used.has(candidate); n++) candidate = `${stem}-${n}${extension}`;
	used.add(candidate);
	return candidate;
}

function formatBytes(bytes: number): string {
	if (bytes < 1024) return `${bytes} B`;
	if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
	return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export default function emailBridge(pi: ExtensionAPI): void {
	const agentDir = resolveAgentDir(typeof pi.pi.getAgentDir === "function" ? pi.pi.getAgentDir : undefined);
	const loaded = loadConfig(agentDir);
	const config = loaded.ok ? loaded.config : undefined;
	const configProblem = loaded.ok ? "" : `${loaded.problems.join("; ")} (set them in ${loaded.envFile})`;
	const client = config ? new MailtrapClient(config) : undefined;
	const z = pi.zod;

	let activation: Activation | undefined;
	let latestCtx: ExtensionContext | undefined;
	let pollTimer: unknown;
	let polling = false;
	let consecutiveFailures = 0;
	let backoffUntil = 0;
	let lastPollAt: string | undefined;
	let lastError: string | undefined;
	let mailboxBusy = false;
	let configWarned = false;
	const attempts = new Map<string, number>();
	const recent: string[] = [];

	function note(line: string): void {
		recent.push(`${new Date().toISOString().slice(11, 19)} ${line}`);
		if (recent.length > 20) recent.shift();
		pi.logger.debug(`email-bridge: ${line}`);
	}

	function activate(ctx: ExtensionContext): Activation | undefined {
		latestCtx = ctx;
		if (ctx.agent.kind !== "main") return undefined;
		if (!config) {
			if (!configWarned && ctx.mode === "tui") {
				configWarned = true;
				ctx.ui.notify(`Email bridge is off: ${configProblem}`, "warning");
			}
			return undefined;
		}
		if (activation?.live) releaseMailboxLock(config.stateDir, activation.sessionId);
		const sessionId = ctx.sessionManager.getSessionId();
		const live = ctx.mode === "tui";
		activation = {
			sessionId,
			address: `${sessionToken(sessionId)}@${config.domain}`,
			live,
			introPending: live,
			typedPrompt: undefined,
			queued: new Set(),
		};
		attempts.clear();
		mailboxBusy = false;
		if (live) {
			pollTimer ??= ctx.setInterval(() => void poll(), config.pollMs);
			ctx.setTimeout(() => void poll(), 1_000);
		}
		return activation;
	}

	/** The activation for the session `ctx` shows now. A changed session ID starts a new activation. */
	function syncActivation(ctx: ExtensionContext): Activation | undefined {
		latestCtx = ctx;
		if (activation && activation.sessionId === ctx.sessionManager.getSessionId()) return activation;
		return activate(ctx);
	}

	function sendRequest(ctx: ExtensionContext, act: Activation, owner: string, subject: string, text: string): SendRequest {
		return {
			from: { email: act.address, name: `omp (${path.basename(ctx.cwd) || ctx.cwd})` },
			reply_to: { email: act.address },
			to: [{ email: owner }],
			subject,
			text,
			category: "omp-email-bridge",
		};
	}

	async function sendSessionEmail(ctx: ExtensionContext, act: Activation, prompt: string, first: string | undefined) {
		if (!config || !client) return;
		const dir = path.basename(ctx.cwd) || ctx.cwd;
		const subject = first ? `Resumed omp session in ${dir}` : `New omp session in ${dir}`;
		const prompts = first ? `Started with:\n${excerpt(first)}\n\nResumed with:\n${excerpt(prompt)}` : excerpt(prompt);
		const text = `Working directory: ${ctx.cwd}\n\n${prompts}\n`;
		try {
			const ids = await client.send(sendRequest(ctx, act, config.owner, subject, text));
			note(`session email sent from ${act.address} (Mailtrap ${ids.join(", ") || "accepted"})`);
			ctx.ui.notify(`Session email sent from ${act.address}`, "info");
		} catch (error) {
			// A definite rejection is retried with the next prompt; an uncertain send is not, to avoid duplicates.
			if (error instanceof MailtrapError && activation === act) act.introPending = true;
			note(`session email failed: ${errorMessage(error)}`);
			ctx.ui.notify(`Could not send the session email: ${errorMessage(error)}`, "warning");
		}
	}

	async function prepareDelivery(
		message: InboundMessage,
		act: Activation,
		isCurrent: () => boolean,
	): Promise<Outcome> {
		if (!config || !client) return { kind: "stale" };
		const detail = await client.getMessage(message.id);
		if (!isCurrent()) return { kind: "stale" };
		const raw = await client.download(detail.rawMessageUrl, MAX_RAW_BYTES);
		if (!isCurrent()) return { kind: "stale" };
		let verdict: Verdict;
		try {
			verdict = await verifyOwnerMessage(raw, config.owner);
		} catch (error) {
			return { kind: "retry", reason: `DKIM check failed: ${errorMessage(error)}` };
		}
		if (!isCurrent()) return { kind: "stale" };
		if (!verdict.ok) return verdict.retry ? { kind: "retry", reason: verdict.reason } : { kind: "reject", reason: verdict.reason };

		// Route only on recipients covered by the passing signature, so a captured genuine email with an added
		// unsigned To or Cc header cannot be aimed at another session.
		if (!verdict.signedRecipients.includes(act.address)) {
			return { kind: "reject", reason: `${act.address} is not in a To or Cc header covered by the DKIM signature` };
		}

		const attachmentDir = path.join(config.stateDir, "attachments", act.sessionId, message.id);
		const usedNames = new Set<string>();
		const attachmentLines: string[] = [];
		const images: ImagePart[] = [];
		for (const attachment of detail.attachments) {
			if (!attachment.downloadUrl) {
				attachmentLines.push(`- ${attachment.filename} (${attachment.contentType}): no download link from Mailtrap`);
				continue;
			}
			let bytes: Uint8Array;
			try {
				bytes = await client.download(attachment.downloadUrl, MAX_ATTACHMENT_BYTES);
			} catch (error) {
				if (error instanceof MailtrapError && error.status === 413) {
					attachmentLines.push(`- ${attachment.filename} (${attachment.contentType}): not downloaded, ${errorMessage(error)}`);
					continue;
				}
				return { kind: "retry", reason: `attachment ${attachment.filename}: ${errorMessage(error)}` };
			}
			if (!isCurrent()) return { kind: "stale" };
			fs.mkdirSync(attachmentDir, { recursive: true });
			const file = path.join(attachmentDir, safeFileName(attachment.filename, usedNames));
			fs.writeFileSync(file, bytes);
			const mimeType = attachment.contentType.toLowerCase();
			const inline = INLINE_IMAGE_TYPES[mimeType] === true && bytes.byteLength <= MAX_INLINE_IMAGE_BYTES;
			if (inline) images.push({ type: "image", data: Buffer.from(bytes).toString("base64"), mimeType });
			attachmentLines.push(`- ${file} (${mimeType}, ${formatBytes(bytes.byteLength)}${inline ? ", also shown below" : ""})`);
		}

		const bodySource = detail.textBody ?? (detail.htmlBody ? htmlToText(detail.htmlBody) : "");
		const body = stripQuotedReply(bodySource) || "(no text)";
		const received = `${new Date(message.receivedAt).toISOString().slice(0, 16).replace("T", " ")} UTC`;
		const header =
			`${EMAIL_MARKER} (${message.from}) to this session's address ${act.address}, received ${received}, ` +
			`Mailtrap message ID ${message.id}. The user is probably away from the terminal; answer by email with the ${TOOL_NAME} tool.]`;
		const sections = [header, `Subject: ${message.subject || "(none)"}`];
		if (attachmentLines.length > 0) sections.push(`Attachments saved to disk:\n${attachmentLines.join("\n")}`);
		sections.push(body);
		const text = sections.join("\n\n");
		return {
			kind: "deliver",
			content: images.length > 0 ? [{ type: "text", text }, ...images] : text,
			note: `handed "${message.subject}" to the session (${detail.attachments.length} attachment(s))`,
		};
	}

	function record(state: SessionMailState, message: InboundMessage, outcome: ProcessedRecord["outcome"], note?: string): void {
		const fields = { id: message.id, rfcMessageId: message.rfcMessageId, receivedAt: message.receivedAt, outcome, note };
		const index = state.processed.findIndex(done => done.id === message.id);
		if (index >= 0) state.processed[index] = fields;
		else state.processed.push(fields);
	}

	async function pollMailbox(ctx: ExtensionContext, act: Activation): Promise<void> {
		if (!config || !client) return;
		if (!acquireMailboxLock(config.stateDir, act.sessionId)) {
			mailboxBusy = true;
			return;
		}
		mailboxBusy = false;
		// Every await below can straddle /new, /resume, or a fork. Nothing is injected or recorded unless
		// the binding still serves the same activation and session ID at that moment.
		const isCurrent = () => activation === act && ctx.sessionManager.getSessionId() === act.sessionId;
		const state = loadState(config.stateDir, act.sessionId, act.address);
		const since = Date.parse(state.scanFrom) - SCAN_OVERLAP_MS;
		const createdAt = Date.parse(state.createdAt) - SCAN_OVERLAP_MS;

		// sendUserMessage only queues the email, and omp's queue lives in memory. An email counts as delivered
		// once it shows up in the session history. One queued by an earlier activation or omp process that
		// never arrived (omp closed, or the session was switched, while it waited) is handed over again.
		const queued = state.processed.filter(done => done.outcome === "queued");
		const resend: InboundMessage[] = [];
		if (queued.length > 0) {
			const landed = landedEmailIds(ctx);
			for (const done of queued) {
				if (landed.has(done.id)) {
					done.outcome = "delivered";
					continue;
				}
				if (act.queued.has(done.id)) continue;
				try {
					resend.push(await client.getMessage(done.id));
				} catch (error) {
					if (!(error instanceof MailtrapError && error.status === 404)) throw error;
					done.outcome = "rejected";
					done.note = "deleted from Mailtrap before it reached the session";
				}
				if (!isCurrent()) return;
			}
		}

		// Read every page back to the scan point. Stopping early and then moving the scan point to the newest
		// message would skip whatever was on the pages not read.
		const candidates: InboundMessage[] = [];
		const cursorsSeen = new Set<string>();
		let newestMs: number | undefined;
		let scannedToCutoff = false;
		let cursor: string | undefined;
		for (;;) {
			const { messages, lastId } = await client.listMessages(cursor);
			if (!isCurrent()) return;
			if (cursor === undefined && messages[0]) newestMs = Date.parse(messages[0].receivedAt);
			const inWindow = messages.filter(message => Date.parse(message.receivedAt) >= since);
			candidates.push(...inWindow);
			if (inWindow.length < messages.length || !lastId) {
				scannedToCutoff = true;
				break;
			}
			// A repeated cursor would loop forever; stop without moving the scan point.
			if (cursorsSeen.has(lastId)) break;
			cursorsSeen.add(lastId);
			cursor = lastId;
		}

		const handled = (message: InboundMessage) =>
			state.processed.some(
				done => done.id === message.id || (!!message.rfcMessageId && done.rfcMessageId === message.rfcMessageId),
			);
		const newMail = candidates
			.filter(message => [...message.to, ...message.cc].some(value => bareAddress(value) === act.address))
			.filter(message => Date.parse(message.receivedAt) >= createdAt && !handled(message));
		const pending = [...resend, ...newMail].sort((a, b) => Date.parse(a.receivedAt) - Date.parse(b.receivedAt));

		let unresolvedFromMs: number | undefined;
		// One email can appear twice in a batch: as separate inbox copies sharing a Message-ID (one per recipient
		// on this domain, e.g. To one session and Cc another) or on two pages when new mail shifts the listing.
		const takenThisPoll = new Set<string>();
		for (const message of pending) {
			const keys = [message.id, message.rfcMessageId].filter((key): key is string => !!key);
			if (keys.some(key => takenThisPoll.has(key))) continue;
			for (const key of keys) takenThisPoll.add(key);
			let outcome = await prepareDelivery(message, act, isCurrent);
			if (outcome.kind === "stale" || !isCurrent()) return;
			if (outcome.kind === "retry") {
				const count = (attempts.get(message.id) ?? 0) + 1;
				attempts.set(message.id, count);
				if (count < MAX_DELIVERY_ATTEMPTS) {
					unresolvedFromMs = Math.min(unresolvedFromMs ?? Number.POSITIVE_INFINITY, Date.parse(message.receivedAt));
					note(`will retry "${message.subject}": ${outcome.reason}`);
					continue;
				}
				outcome = { kind: "reject", reason: `gave up after ${count} attempts: ${outcome.reason}` };
			}
			if (outcome.kind === "deliver") {
				pi.sendUserMessage(outcome.content);
				act.queued.add(message.id);
				record(state, message, "queued");
				note(outcome.note);
			} else {
				record(state, message, "rejected", outcome.reason);
				note(`ignored "${message.subject}" from ${message.from}: ${outcome.reason}`);
				ctx.ui.notify(`Ignored an email to this session from ${message.from}: ${outcome.reason}`, "warning");
			}
			saveState(config.stateDir, state);
		}

		const nextScanMs = unresolvedFromMs ?? (scannedToCutoff ? newestMs : undefined);
		if (nextScanMs !== undefined) state.scanFrom = new Date(nextScanMs).toISOString();
		saveState(config.stateDir, state);
	}

	async function poll(): Promise<void> {
		const ctx = latestCtx;
		if (polling || !ctx || !config || Date.now() < backoffUntil) return;
		const act = activation ? syncActivation(ctx) : undefined;
		if (!act?.live) return;
		polling = true;
		try {
			await pollMailbox(ctx, act);
			consecutiveFailures = 0;
			lastError = undefined;
		} catch (error) {
			consecutiveFailures += 1;
			lastError = errorMessage(error);
			backoffUntil = Date.now() + Math.min(MAX_BACKOFF_MS, config.pollMs * 2 ** consecutiveFailures);
			pi.logger.warn("email-bridge: poll failed", { error: lastError });
		} finally {
			polling = false;
			lastPollAt = new Date().toISOString();
		}
	}

	const emailParams = z.object({
		subject: z.string().describe("Subject line"),
		body: z.string().describe("Plain-text body"),
	});
	pi.registerTool({
		name: TOOL_NAME,
		label: "Email User",
		description:
			`Email the user${config ? ` (${config.owner})` : ""} from this session's own address. ` +
			"Replies, and any email the user sends to that address, come back into this session as user messages. " +
			"Use it for completion emails and whenever the user should hear from you while away from the terminal. Plain text only.",
		parameters: emailParams,
		loadMode: "essential",
		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			if (!config || !client) throw new Error(`The email bridge is not configured: ${configProblem}`);
			if (ctx.agent.kind !== "main") throw new Error("Only the main agent can email the user.");
			const act = syncActivation(ctx);
			if (!act) throw new Error("No active session to send from.");
			const parsed = emailParams.parse(params);
			const subject = parsed.subject.trim();
			const body = parsed.body;
			if (!subject || !body.trim()) throw new Error("Subject and body must not be empty.");
			let ids: string[];
			try {
				ids = await client.send(sendRequest(ctx, act, config.owner, subject, body), signal);
			} catch (error) {
				if (error instanceof MailtrapUncertainSendError) {
					throw new Error(`${error.message}. Do not resend automatically; check the Mailtrap email logs first.`);
				}
				throw error;
			}
			note(`email_user sent "${subject}" (Mailtrap ${ids.join(", ") || "accepted"})`);
			return {
				content: [
					{
						type: "text",
						text:
							`Mailtrap accepted the email (message ID ${ids.join(", ") || "not returned"}). ` +
							`It was sent from ${act.address} to ${config.owner}. Acceptance is not proof of inbox delivery.`,
					},
				],
				details: { messageIds: ids, from: act.address, to: config.owner },
			};
		},
	});

	pi.registerCommand("email", {
		description: "Show this session's email address and the email bridge status",
		handler: async (_args, ctx) => {
			if (!config) {
				ctx.ui.notify(`Email bridge is off: ${configProblem}`, "warning");
				return;
			}
			const act = syncActivation(ctx);
			if (!act) {
				ctx.ui.notify("Email bridge: no main session is active", "warning");
				return;
			}
			const lines = [
				`Address: ${act.address}`,
				`Owner: ${config.owner}`,
				act.live ? `Checking the inbox every ${config.pollMs / 1000}s` : "Not checking the inbox (not an interactive session)",
				act.introPending ? "Session email: not sent yet (goes out after your first prompt)" : "Session email: sent",
				mailboxBusy ? "Another omp process is delivering this session's email" : undefined,
				lastPollAt ? `Last check: ${lastPollAt.slice(11, 19)} UTC` : "Last check: none yet",
				lastError ? `Last error: ${lastError}` : undefined,
				...recent.slice(-5),
			].filter((line): line is string => typeof line === "string");
			ctx.ui.notify(lines.join("\n"), "info");
		},
	});

	pi.on("session_start", async (_event, ctx) => {
		if (ctx.agent.kind === "sub") {
			const active = pi.getActiveTools();
			if (active.includes(TOOL_NAME)) await pi.setActiveTools(active.filter(name => name !== TOOL_NAME));
			return;
		}
		activate(ctx);
	});
	pi.on("session_switch", (_event, ctx) => {
		activate(ctx);
	});
	pi.on("session_branch", (_event, ctx) => {
		syncActivation(ctx);
	});
	pi.on("session_tree", (_event, ctx) => {
		syncActivation(ctx);
	});
	pi.on("session_shutdown", () => {
		if (config && activation?.live) releaseMailboxLock(config.stateDir, activation.sessionId);
		activation = undefined;
	});

	pi.on("input", (event, ctx) => {
		const act = activation ? syncActivation(ctx) : undefined;
		if (act?.live && (event.source === "interactive" || event.source === "rpc")) act.typedPrompt = event.text;
	});

	pi.on("message_end", (event, ctx) => {
		const message = event.message;
		if (message.role !== "user" || message.synthetic) return;
		const act = activation ? syncActivation(ctx) : undefined;
		if (!act?.live || !act.introPending) return;
		const text = messageText(message.content).trim();
		if (!text || text.startsWith(EMAIL_MARKER)) return;
		act.introPending = false;
		const prompt = act.typedPrompt?.trim() || text;
		act.typedPrompt = undefined;
		void sendSessionEmail(ctx, act, prompt, firstTypedPrompt(ctx, message.timestamp));
	});
}
