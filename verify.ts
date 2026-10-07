import { type DNSResolver, dkimVerify } from "mailauth";

const DOH_ENDPOINTS = ["https://cloudflare-dns.com/dns-query", "https://dns.google/resolve"];
const DNS_TIMEOUT_MS = 10_000;
const TXT_RECORD_TYPE = 16;
const NOT_FOUND_CODES: Record<string, true> = { ENOTFOUND: true, ENODATA: true };

function dnsError(code: string, message: string): Error {
	return Object.assign(new Error(message), { code });
}

function errorCode(error: unknown): string | undefined {
	if (error && typeof error === "object" && "code" in error && typeof error.code === "string") return error.code;
	return undefined;
}

/** Splits DoH TXT data such as `"v=DKIM1; p=abc" "def"` into its character-strings. */
function parseTxtData(data: string): string[] {
	if (!data.startsWith('"')) return [data];
	const chunks: string[] = [];
	let i = 0;
	while (i < data.length) {
		if (data[i] !== '"') {
			i++;
			continue;
		}
		let chunk = "";
		i++;
		while (i < data.length && data[i] !== '"') {
			if (data[i] === "\\" && /^\d{3}$/.test(data.slice(i + 1, i + 4))) {
				chunk += String.fromCharCode(Number(data.slice(i + 1, i + 4)));
				i += 4;
			} else if (data[i] === "\\" && i + 1 < data.length) {
				chunk += data[i + 1];
				i += 2;
			} else {
				chunk += data[i++];
			}
		}
		chunks.push(chunk);
		i++;
	}
	return chunks;
}

/** TXT answers from a DoH JSON reply; throws resolver-style errors for NXDOMAIN, no data, and failures. */
function txtRecordsFromDohReply(name: string, body: unknown): string[][] {
	if (!body || typeof body !== "object" || !("Status" in body) || typeof body.Status !== "number") {
		throw dnsError("ESERVFAIL", `Malformed DoH reply for ${name}`);
	}
	if (body.Status === 3) throw dnsError("ENOTFOUND", `${name} does not exist`);
	if (body.Status !== 0) throw dnsError("ESERVFAIL", `DNS status ${body.Status} for ${name}`);
	const answers = "Answer" in body && Array.isArray(body.Answer) ? body.Answer : [];
	const records: string[][] = [];
	for (const answer of answers) {
		if (!answer || typeof answer !== "object" || !("type" in answer) || !("data" in answer)) continue;
		if (answer.type === TXT_RECORD_TYPE && typeof answer.data === "string") records.push(parseTxtData(answer.data));
	}
	if (records.length === 0) throw dnsError("ENODATA", `No TXT records for ${name}`);
	return records;
}

/**
 * DKIM key lookups over DNS-over-HTTPS. Bun's resolver returns each character-string of a
 * multi-string TXT record as a separate record, which breaks every 2048-bit DKIM key (Gmail's included).
 */
const resolver: DNSResolver = async (name, rrtype) => {
	if (rrtype !== "TXT") throw dnsError("ENOTIMP", `Only TXT lookups are supported, got ${rrtype}`);
	let lastError: unknown;
	for (const endpoint of DOH_ENDPOINTS) {
		try {
			const response = await fetch(`${endpoint}?name=${encodeURIComponent(name)}&type=TXT`, {
				headers: { Accept: "application/dns-json" },
				signal: AbortSignal.timeout(DNS_TIMEOUT_MS),
			});
			if (!response.ok) throw dnsError("ESERVFAIL", `DoH HTTP ${response.status}`);
			return txtRecordsFromDohReply(name, await response.json());
		} catch (error) {
			if (NOT_FOUND_CODES[errorCode(error) ?? ""]) throw error;
			lastError = error;
		}
	}
	throw lastError instanceof Error ? lastError : dnsError("ESERVFAIL", `TXT lookup failed for ${name}`);
};

export type Verdict =
	/** `signedRecipients`: lowercased addresses from the To and Cc headers the passing signature covers. */
	| { ok: true; signingDomain: string; signedRecipients: string[] }
	/** `retry` marks DNS trouble, where the same message may verify on a later poll. */
	| { ok: false; reason: string; retry: boolean };

const ADDRESS_PATTERN = /[^\s<>,;:"()]+@[^\s<>,;:"()]+/g;

/**
 * Addresses in the To and Cc header instances a signature covers. DKIM only has to sign From, and a
 * header added above the signed instance is not covered, so the raw headers can't be trusted for routing.
 * mailauth returns the canonicalized signed header block base64-encoded.
 */
function coveredRecipients(canonicalizedHeader: string | undefined): string[] {
	const block = Buffer.from(canonicalizedHeader ?? "", "base64")
		.toString("utf8")
		.replace(/\r?\n[ \t]+/g, " ");
	return block
		.split(/\r?\n/)
		.filter(line => /^(to|cc)\s*:/i.test(line))
		.flatMap(line => line.slice(line.indexOf(":") + 1).match(ADDRESS_PATTERN) ?? [])
		.map(address => address.toLowerCase());
}

/**
 * Accepts a raw message only when it has exactly one From address, that address is `owner`, and it
 * carries a passing DKIM signature aligned with the From domain (DMARC relaxed alignment) that covers
 * the whole body.
 */
export async function verifyOwnerMessage(raw: Uint8Array, owner: string): Promise<Verdict> {
	const result = await dkimVerify(Buffer.from(raw), { resolver });
	const from = result.headerFrom.map(address => address.toLowerCase());
	if (result.fromFields !== 1 || from.length !== 1 || from[0] !== owner) {
		return { ok: false, reason: `From is ${from.join(", ") || "missing"}, not ${owner}`, retry: false };
	}
	const pass = result.results.find(
		signature => signature.status.result === "pass" && signature.status.aligned && !signature.status.underSized,
	);
	if (pass) {
		return {
			ok: true,
			signingDomain: pass.signingDomain ?? "",
			signedRecipients: coveredRecipients(pass.signingHeaders?.canonicalizedHeader),
		};
	}
	const summary =
		result.results
			.map(s => `d=${s.signingDomain ?? "?"} ${s.status.result}${s.status.comment ? ` (${s.status.comment})` : ""}`)
			.join("; ") || "no DKIM signature";
	const retry = result.results.some(s => s.status.result === "temperror");
	return { ok: false, reason: `no aligned passing DKIM signature: ${summary}`, retry };
}
