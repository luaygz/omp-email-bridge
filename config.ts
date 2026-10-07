import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

export interface BridgeConfig {
	/** Mailtrap API token with sending and inbound access. */
	apiToken: string;
	/** Mailtrap inbound inbox that catches every address on `domain`. */
	inboxId: string;
	/** Verified sending domain with a catch-all inbound inbox, lowercased. */
	domain: string;
	/** The one person sessions email and accept email from, lowercased. */
	owner: string;
	pollMs: number;
	/** Directory for per-session state, mailbox locks, and downloaded attachments. */
	stateDir: string;
}

export type ConfigResult = { ok: true; config: BridgeConfig } | { ok: false; problems: string[]; envFile: string };

const DEFAULT_POLL_SECONDS = 15;
const MIN_POLL_SECONDS = 5;

/** Minimal dotenv parser: KEY=VALUE lines, optional `export`, quotes, and # comments. */
export function parseDotenv(text: string): Record<string, string> {
	const out: Record<string, string> = {};
	for (const rawLine of text.split(/\r?\n/)) {
		const line = rawLine.trim();
		if (!line || line.startsWith("#")) continue;
		const match = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
		if (!match) continue;
		let value = match[2];
		const quote = value[0];
		if ((quote === '"' || quote === "'") && value.lastIndexOf(quote) > 0) {
			value = value.slice(1, value.lastIndexOf(quote));
			if (quote === '"') value = value.replace(/\\n/g, "\n").replace(/\\(["\\])/g, "$1");
		} else {
			value = value.replace(/\s+#.*$/, "").trim();
		}
		out[match[1]] = value;
	}
	return out;
}

export function resolveAgentDir(getAgentDir: (() => string) | undefined): string {
	try {
		const dir = getAgentDir?.();
		if (dir) return dir;
	} catch {
		// fall through to the default layout
	}
	return process.env.PI_CODING_AGENT_DIR || path.join(os.homedir(), ".omp", "agent");
}

/**
 * Reads settings from the process environment first, then from `<agentDir>/.env`.
 * Nothing here is logged: the token must never leave this function except inside the config.
 */
export function loadConfig(agentDir: string): ConfigResult {
	const envFile = path.join(agentDir, ".env");
	let fileValues: Record<string, string> = {};
	try {
		fileValues = parseDotenv(fs.readFileSync(envFile, "utf8"));
	} catch {
		// a missing file is reported below as missing keys
	}
	const get = (key: string): string => (process.env[key] ?? fileValues[key] ?? "").trim();

	const apiToken = get("MAILTRAP_API_TOKEN");
	const inboxId = get("OMP_EMAIL_INBOX_ID");
	const domain = get("OMP_EMAIL_DOMAIN").toLowerCase().replace(/^@/, "");
	const owner = get("OMP_EMAIL_OWNER").toLowerCase();
	const pollRaw = get("OMP_EMAIL_POLL_SECONDS");

	const problems: string[] = [];
	if (!apiToken) problems.push("MAILTRAP_API_TOKEN is not set");
	if (!/^\d+$/.test(inboxId)) problems.push("OMP_EMAIL_INBOX_ID must be the numeric Mailtrap inbound inbox ID");
	if (!/^[a-z0-9.-]+\.[a-z]{2,}$/.test(domain)) problems.push("OMP_EMAIL_DOMAIN must be a domain such as agents.example.com");
	if (!/^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(owner)) problems.push("OMP_EMAIL_OWNER must be your email address");
	let pollSeconds = DEFAULT_POLL_SECONDS;
	if (pollRaw) {
		const parsed = Number(pollRaw);
		if (!Number.isFinite(parsed) || parsed < MIN_POLL_SECONDS) {
			problems.push(`OMP_EMAIL_POLL_SECONDS must be a number of seconds, at least ${MIN_POLL_SECONDS}`);
		} else {
			pollSeconds = parsed;
		}
	}
	if (problems.length > 0) return { ok: false, problems, envFile };

	return {
		ok: true,
		config: {
			apiToken,
			inboxId,
			domain,
			owner,
			pollMs: Math.round(pollSeconds * 1000),
			stateDir: path.join(agentDir, "email-bridge"),
		},
	};
}
