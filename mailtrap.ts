import type { BridgeConfig } from "./config";

const GENERAL_API = "https://mailtrap.io";
const SEND_API = "https://send.api.mailtrap.io/api/send";
const REQUEST_TIMEOUT_MS = 30_000;

export interface InboundAttachment {
	attachmentId: string;
	filename: string;
	contentType: string;
	size: number;
	downloadUrl: string | undefined;
}

export interface InboundMessage {
	id: string;
	from: string;
	to: string[];
	cc: string[];
	subject: string;
	receivedAt: string;
	rfcMessageId: string | undefined;
	attachments: InboundAttachment[];
}

export interface InboundMessageDetail extends InboundMessage {
	textBody: string | undefined;
	htmlBody: string | undefined;
	rawMessageUrl: string;
}

export interface SendRequest {
	from: { email: string; name?: string };
	to: { email: string }[];
	reply_to?: { email: string };
	subject: string;
	text: string;
	headers?: Record<string, string>;
	category?: string;
}

/** Thrown when the API definitely rejected a request, or answered with something unusable. */
export class MailtrapError extends Error {
	constructor(
		message: string,
		readonly status: number,
	) {
		super(message);
		this.name = "MailtrapError";
	}
}

/** Thrown when a send may or may not have gone out (network failure, timeout, 5xx, unreadable reply). */
export class MailtrapUncertainSendError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "MailtrapUncertainSendError";
	}
}

function record(value: unknown, what: string): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new MailtrapError(`Unexpected ${what} shape`, 0);
	return Object.fromEntries(Object.entries(value));
}

function optionalString(value: unknown): string | undefined {
	return typeof value === "string" && value.length > 0 ? value : undefined;
}

function requiredString(value: unknown, what: string): string {
	if (typeof value !== "string" || value.length === 0) throw new MailtrapError(`Missing ${what} in Mailtrap reply`, 0);
	return value;
}

function stringList(value: unknown): string[] {
	return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function parseAttachment(value: unknown): InboundAttachment {
	const fields = record(value, "attachment");
	return {
		attachmentId: requiredString(fields.attachment_id, "attachment_id"),
		filename: optionalString(fields.filename) ?? "attachment",
		contentType: optionalString(fields.content_type) ?? "application/octet-stream",
		size: typeof fields.size === "number" ? fields.size : 0,
		downloadUrl: optionalString(fields.download_url),
	};
}

function parseMessage(value: unknown): InboundMessage {
	const fields = record(value, "message");
	return {
		id: requiredString(fields.id, "message id"),
		from: optionalString(fields.from) ?? "",
		to: stringList(fields.to),
		cc: stringList(fields.cc),
		subject: optionalString(fields.subject) ?? "",
		receivedAt: requiredString(fields.received_at, "received_at"),
		rfcMessageId: optionalString(fields.rfc_message_id),
		attachments: Array.isArray(fields.attachments) ? fields.attachments.map(parseAttachment) : [],
	};
}

function parseMessageDetail(value: unknown): InboundMessageDetail {
	const fields = record(value, "message");
	return {
		...parseMessage(value),
		textBody: optionalString(fields.text_body),
		htmlBody: optionalString(fields.html_body),
		rawMessageUrl: requiredString(fields.raw_message_url, "raw_message_url"),
	};
}

function withTimeout(signal?: AbortSignal): AbortSignal {
	const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
	return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

async function errorSnippet(response: Response): Promise<string> {
	try {
		return (await response.text()).replace(/\s+/g, " ").slice(0, 200);
	} catch {
		return "";
	}
}

export class MailtrapClient {
	constructor(private readonly config: BridgeConfig) {}

	async #getJson(path: string, signal?: AbortSignal): Promise<unknown> {
		const response = await fetch(`${GENERAL_API}${path}`, {
			headers: { "Api-Token": this.config.apiToken, Accept: "application/json" },
			signal: withTimeout(signal),
		});
		if (!response.ok) {
			throw new MailtrapError(
				`Mailtrap GET ${path} failed with HTTP ${response.status}: ${await errorSnippet(response)}`,
				response.status,
			);
		}
		return response.json();
	}

	/** One page of the inbox, newest first. */
	async listMessages(lastId?: string, signal?: AbortSignal): Promise<{ messages: InboundMessage[]; lastId: string | undefined }> {
		const query = lastId ? `?last_id=${encodeURIComponent(lastId)}` : "";
		const page = record(await this.#getJson(`/api/inbound/inboxes/${this.config.inboxId}/messages${query}`, signal), "list");
		return {
			messages: Array.isArray(page.data) ? page.data.map(parseMessage) : [],
			lastId: optionalString(page.last_id),
		};
	}

	/** Message with bodies plus short-lived download URLs for the raw message and attachments. */
	async getMessage(id: string, signal?: AbortSignal): Promise<InboundMessageDetail> {
		return parseMessageDetail(
			await this.#getJson(`/api/inbound/inboxes/${this.config.inboxId}/messages/${encodeURIComponent(id)}`, signal),
		);
	}

	/** Downloads a presigned URL returned by getMessage. These URLs carry their own credentials. */
	async download(url: string, maxBytes: number, signal?: AbortSignal): Promise<Uint8Array> {
		const response = await fetch(url, { signal: withTimeout(signal) });
		if (!response.ok) throw new MailtrapError(`Download failed with HTTP ${response.status}`, response.status);
		const declared = Number(response.headers.get("content-length") ?? "0");
		if (declared > maxBytes) throw new MailtrapError(`Download is ${declared} bytes, over the ${maxBytes} byte limit`, 413);
		const bytes = new Uint8Array(await response.arrayBuffer());
		if (bytes.byteLength > maxBytes) {
			throw new MailtrapError(`Download is ${bytes.byteLength} bytes, over the ${maxBytes} byte limit`, 413);
		}
		return bytes;
	}

	/**
	 * Sends a real email. Resolves with Mailtrap's message IDs only when Mailtrap confirmed acceptance.
	 * Throws MailtrapError when the request was definitely rejected and MailtrapUncertainSendError when
	 * it might have gone out.
	 */
	async send(request: SendRequest, signal?: AbortSignal): Promise<string[]> {
		let response: Response;
		try {
			response = await fetch(SEND_API, {
				method: "POST",
				headers: { Authorization: `Bearer ${this.config.apiToken}`, "Content-Type": "application/json" },
				body: JSON.stringify(request),
				signal: withTimeout(signal),
			});
		} catch (error) {
			throw new MailtrapUncertainSendError(
				`No response from Mailtrap (${error instanceof Error ? error.message : String(error)}); the email may or may not have been sent`,
			);
		}
		if (response.status >= 500) {
			throw new MailtrapUncertainSendError(
				`Mailtrap returned HTTP ${response.status}; the email may or may not have been sent: ${await errorSnippet(response)}`,
			);
		}
		if (!response.ok) {
			throw new MailtrapError(
				`Mailtrap rejected the email with HTTP ${response.status}: ${await errorSnippet(response)}`,
				response.status,
			);
		}
		let body: unknown;
		try {
			body = await response.json();
		} catch {
			throw new MailtrapUncertainSendError("Mailtrap returned HTTP 2xx with an unreadable body; check before resending");
		}
		if (!body || typeof body !== "object" || !("success" in body) || body.success !== true) {
			throw new MailtrapUncertainSendError("Mailtrap did not confirm acceptance; check before resending");
		}
		return "message_ids" in body ? stringList(body.message_ids) : [];
	}
}
