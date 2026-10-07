/**
 * Installer for the omp email bridge. It checks or prepares the Mailtrap side (sending domain, inbound
 * receiving, catch-all inbox), writes the settings to `<agent dir>/.env`, links or copies the extension
 * into omp, and sends a test email through the whole path. Running it again reuses what already exists.
 *
 * Usage: ./install.sh [--agent-dir DIR] [--copy] [--skip-test]
 */
import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { parseDotenv } from "../config";
import { MailtrapClient } from "../mailtrap";

const REPO_DIR = path.resolve(import.meta.dir, "..");
const API = "https://mailtrap.io";
const EXTENSION_DIR_NAME = "email-bridge";
const FOLDER_NAME = "omp";
const INBOX_NAME = "omp sessions";
const TEST_TIMEOUT_MS = 120_000;
const TEST_POLL_MS = 5_000;
const DOMAIN_PATTERN = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/;
const EMAIL_PATTERN = /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/;
const USAGE = `Usage: ./install.sh [--agent-dir DIR] [--copy] [--skip-test]

  --agent-dir DIR  omp agent directory (default: $PI_CODING_AGENT_DIR or ~/.omp/agent)
  --copy           copy the extension into omp instead of linking to this checkout
  --skip-test      don't send the test email at the end`;

/** A problem the user has to fix; printed without a stack trace. */
class InstallError extends Error {}
/** Setup is waiting on something outside the script, usually DNS. */
class PendingError extends Error {}

interface Options {
	agentDir: string;
	copy: boolean;
	skipTest: boolean;
}

interface DnsRecord {
	key: string;
	type: string;
	name: string;
	value: string;
	status: string;
}

interface SendingDomain {
	id: number;
	name: string;
	dnsVerified: boolean;
	inboundEnabled: boolean;
	inboundVerified: boolean;
	compliance: string;
	records: DnsRecord[];
}

interface Inbox {
	id: number;
	address: string;
	domainId: number | undefined;
}

function parseArgs(argv: string[]): Options {
	const options: Options = {
		agentDir: process.env.PI_CODING_AGENT_DIR || path.join(os.homedir(), ".omp", "agent"),
		copy: false,
		skipTest: false,
	};
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		if (arg === "--copy") options.copy = true;
		else if (arg === "--skip-test") options.skipTest = true;
		else if (arg === "--agent-dir" && argv[i + 1]) options.agentDir = path.resolve(argv[++i].replace(/^~(?=\/|$)/, os.homedir()));
		else if (arg === "-h" || arg === "--help") {
			console.log(USAGE);
			process.exit(0);
		} else throw new InstallError(`Unknown option ${arg}\n\n${USAGE}`);
	}
	return options;
}

function heading(text: string): void {
	console.log(`\n== ${text}`);
}

/** Reads one line from the terminal. Secret input is not echoed. */
async function ask(question: string, secret = false): Promise<string> {
	const stdin = process.stdin;
	if (!stdin.isTTY) {
		throw new InstallError(`Need an answer to "${question.trim()}". Run ./install.sh in a terminal, or put the value in the .env file first.`);
	}
	process.stdout.write(question);
	const { promise, resolve, reject } = Promise.withResolvers<string>();
	let value = "";
	const finish = (error?: Error) => {
		stdin.off("data", onData);
		stdin.setRawMode(false);
		stdin.pause();
		process.stdout.write("\n");
		if (error) reject(error);
		else resolve(value.trim());
	};
	const onData = (chunk: Buffer) => {
		for (const char of chunk.toString("utf8")) {
			if (char === "\r" || char === "\n") return finish();
			if (char === "\u0003") return finish(new InstallError("Cancelled."));
			if (char === "\u007f" || char === "\b") {
				if (value.length > 0) {
					value = value.slice(0, -1);
					if (!secret) process.stdout.write("\b \b");
				}
				continue;
			}
			if (char < " ") continue;
			value += char;
			if (!secret) process.stdout.write(char);
		}
	};
	stdin.setRawMode(true);
	stdin.resume();
	stdin.on("data", onData);
	return promise;
}

function asRecord(value: unknown, what: string): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new InstallError(`Unexpected ${what} from Mailtrap`);
	return Object.fromEntries(Object.entries(value));
}

function asList(value: unknown, what: string): unknown[] {
	if (!Array.isArray(value)) throw new InstallError(`Unexpected ${what} from Mailtrap`);
	return value;
}

function text(fields: Record<string, unknown>, key: string): string {
	const value = fields[key];
	return typeof value === "string" ? value : "";
}

function integer(fields: Record<string, unknown>, key: string, what: string): number {
	const value = fields[key];
	if (typeof value !== "number") throw new InstallError(`Mailtrap returned a ${what} without ${key}`);
	return value;
}

async function api(token: string, method: string, apiPath: string, body?: unknown): Promise<unknown> {
	let response: Response;
	try {
		response = await fetch(`${API}${apiPath}`, {
			method,
			headers: { "Api-Token": token, Accept: "application/json", "Content-Type": "application/json" },
			body: body === undefined ? undefined : JSON.stringify(body),
			signal: AbortSignal.timeout(30_000),
		});
	} catch (error) {
		throw new InstallError(`Could not reach Mailtrap: ${error instanceof Error ? error.message : String(error)}`);
	}
	if (!response.ok) {
		const detail = (await response.text().catch(() => "")).replace(/\s+/g, " ").slice(0, 300);
		const hint =
			response.status === 401 || response.status === 403
				? " Check that the API token is correct and has admin access to your Mailtrap account."
				: "";
		throw new InstallError(`Mailtrap ${method} ${apiPath} failed with HTTP ${response.status}: ${detail}.${hint}`);
	}
	return response.status === 204 ? undefined : response.json();
}

function parseDomain(value: unknown): SendingDomain {
	const fields = asRecord(value, "sending domain");
	const records = Array.isArray(fields.dns_records) ? fields.dns_records : [];
	return {
		id: integer(fields, "id", "sending domain"),
		name: text(fields, "domain_name").toLowerCase(),
		dnsVerified: fields.dns_verified === true,
		inboundEnabled: fields.inbound_enabled === true,
		inboundVerified: fields.inbound_verified === true,
		compliance: text(fields, "compliance_status"),
		records: records.map(record => {
			const recordFields = asRecord(record, "DNS record");
			return {
				key: text(recordFields, "key"),
				type: text(recordFields, "type"),
				name: text(recordFields, "domain"),
				value: text(recordFields, "value"),
				status: text(recordFields, "status"),
			};
		}),
	};
}

function parseInbox(value: unknown): Inbox {
	const fields = asRecord(value, "inbox");
	return {
		id: integer(fields, "id", "inbox"),
		address: text(fields, "address"),
		domainId: typeof fields.domain_id === "number" ? fields.domain_id : undefined,
	};
}

async function getDomain(token: string, accountId: number, domainId: number): Promise<SendingDomain> {
	return parseDomain(await api(token, "GET", `/api/accounts/${accountId}/sending_domains/${domainId}`));
}

function printRecords(records: DnsRecord[]): void {
	for (const record of records) {
		const priority = record.type === "MX" ? "  (priority 10)" : "";
		const state = record.status === "pass" ? "ok" : "missing";
		console.log(`  [${state}] ${record.type.padEnd(5)} ${record.name}\n          -> ${record.value}${priority}`);
	}
	console.log(
		"\nAdd them at the company that hosts DNS for your domain. Copy the values exactly. On Cloudflare, set the CNAME" +
			"\nrecords to \"DNS only\" (grey cloud). DNS changes can take anywhere from a few minutes to a day to show up.",
	);
}

async function chooseAccount(token: string, configured: string): Promise<number> {
	const accounts = asList(await api(token, "GET", "/api/accounts"), "account list").map(value => {
		const fields = asRecord(value, "account");
		return { id: integer(fields, "id", "account"), name: text(fields, "name") };
	});
	if (accounts.length === 0) throw new InstallError("This API token can't see any Mailtrap account.");
	const match = accounts.find(account => String(account.id) === configured);
	if (match) return match.id;
	if (accounts.length === 1) return accounts[0].id;
	accounts.forEach((account, index) => console.log(`  ${index + 1}. ${account.name} (${account.id})`));
	const answer = Number(await ask("Which Mailtrap account? "));
	const chosen = accounts[answer - 1];
	if (!chosen) throw new InstallError("No such account.");
	return chosen.id;
}

async function chooseDomain(token: string, accountId: number, configured: string): Promise<SendingDomain> {
	const listing = asRecord(await api(token, "GET", `/api/accounts/${accountId}/sending_domains`), "domain list");
	// Mailtrap lists its own shared demo domain too; it can't host a catch-all inbox.
	const domains = asList(listing.data, "domain list")
		.map(parseDomain)
		.filter(domain => domain.compliance !== "demo");
	let name = configured;
	if (!name) {
		if (domains.length > 0) {
			console.log("Sending domains in your Mailtrap account:");
			domains.forEach((domain, index) => console.log(`  ${index + 1}. ${domain.name}`));
		}
		const answer = await ask(
			domains.length > 0
				? "Domain to use (a number from the list, or a new domain to add): "
				: "Domain for session email (a subdomain such as agents.example.com is best): ",
		);
		const picked = /^\d+$/.test(answer) ? domains[Number(answer) - 1] : undefined;
		name = (picked?.name ?? answer).toLowerCase();
	}
	if (!DOMAIN_PATTERN.test(name)) throw new InstallError(`"${name}" is not a domain name.`);
	const existing = domains.find(domain => domain.name === name);
	if (existing) return getDomain(token, accountId, existing.id);
	const addReply = await ask(`${name} is not in your Mailtrap account yet. Add it as a sending domain? [y/N] `);
	if (!/^y(es)?$/i.test(addReply)) {
		throw new InstallError("Add the domain in Mailtrap (Domains → Add Domain), or choose another one, and run ./install.sh again.");
	}
	const created = parseDomain(
		await api(token, "POST", `/api/accounts/${accountId}/sending_domains`, { sending_domain: { domain_name: name } }),
	);
	console.log(`Added ${name} to Mailtrap.`);
	return getDomain(token, accountId, created.id);
}

/** Makes sure the domain is verified and receives mail. Throws PendingError when DNS work is needed. */
async function prepareDomain(token: string, accountId: number, initial: SendingDomain): Promise<SendingDomain> {
	let domain = initial;
	if (!domain.dnsVerified) {
		console.log(`\n${domain.name} is not verified yet. Mailtrap needs these DNS records:`);
		printRecords(domain.records.filter(record => record.key !== "inbound_mx"));
		throw new PendingError("Run ./install.sh again once the records are in place.");
	}
	if (!domain.inboundEnabled) {
		await api(token, "PATCH", `/api/accounts/${accountId}/sending_domains/${domain.id}`, {
			sending_domain: { inbound_enabled: true },
		});
		console.log(`Turned on inbound email for ${domain.name}.`);
		domain = await getDomain(token, accountId, domain.id);
	}
	if (!domain.inboundVerified) {
		console.log(`\nTo receive email, ${domain.name} needs this MX record:`);
		printRecords(domain.records.filter(record => record.key === "inbound_mx"));
		throw new PendingError("Run ./install.sh again once the MX record is in place.");
	}
	if (domain.compliance !== "compliant") {
		console.log(
			`Note: Mailtrap reports compliance status "${domain.compliance}" for ${domain.name}. Sending may be held until` +
				" Mailtrap's review is done; finish any steps it asks for in the Mailtrap dashboard.",
		);
	}
	console.log(`${domain.name} is verified and receives email.`);
	return domain;
}

async function findOrCreateInbox(token: string, domain: SendingDomain): Promise<Inbox> {
	const folders = asList(await api(token, "GET", "/api/inbound/folders"), "folder list").map(value => {
		const fields = asRecord(value, "folder");
		return { id: integer(fields, "id", "folder"), name: text(fields, "name") };
	});
	for (const folder of folders) {
		const inboxes = asList(await api(token, "GET", `/api/inbound/folders/${folder.id}/inboxes`), "inbox list").map(parseInbox);
		const existing = inboxes.find(inbox => inbox.domainId === domain.id);
		if (existing) {
			console.log(`Using the existing catch-all inbox ${existing.address} (ID ${existing.id}).`);
			return existing;
		}
	}
	let folderId = folders.find(folder => folder.name === FOLDER_NAME)?.id;
	if (folderId === undefined) {
		folderId = integer(asRecord(await api(token, "POST", "/api/inbound/folders", { name: FOLDER_NAME }), "folder"), "id", "folder");
	}
	const inbox = parseInbox(
		await api(token, "POST", `/api/inbound/folders/${folderId}/inboxes`, { name: INBOX_NAME, domain_id: domain.id }),
	);
	console.log(`Created the catch-all inbox ${inbox.address || `*@${domain.name}`} (ID ${inbox.id}).`);
	return inbox;
}

function quoteEnvValue(value: string): string {
	return /^[\w@.:/+-]*$/.test(value) ? value : JSON.stringify(value);
}

/** Sets keys in a dotenv file, replacing existing lines in place and appending the rest. Leaves other lines alone. */
function writeEnv(file: string, updates: Record<string, string>): void {
	const keys = Object.keys(updates);
	if (keys.length === 0) return;
	const lines = fs.existsSync(file) ? fs.readFileSync(file, "utf8").split(/\r?\n/) : [];
	if (lines.at(-1) === "") lines.pop();
	const written = new Set<string>();
	const output = lines.map(line => {
		const key = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/.exec(line)?.[1];
		if (!key || !(key in updates)) return line;
		written.add(key);
		return `${key}=${quoteEnvValue(updates[key])}`;
	});
	const missing = keys.filter(key => !written.has(key));
	if (missing.length > 0) {
		output.push("", "# omp email bridge", ...missing.map(key => `${key}=${quoteEnvValue(updates[key])}`));
	}
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(file, `${output.join("\n")}\n`, { mode: 0o600 });
	fs.chmodSync(file, 0o600);
	console.log(`Saved ${keys.join(", ")} to ${file}.`);
}

function run(command: string[], cwd: string): void {
	const result = Bun.spawnSync({ cmd: command, cwd, stdout: "inherit", stderr: "inherit" });
	if (result.exitCode !== 0) throw new InstallError(`"${command.join(" ")}" failed in ${cwd}`);
}

/** True when `inner` is `outer` or lies inside it. */
function within(inner: string, outer: string): boolean {
	const relative = path.relative(outer, inner);
	return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

async function installExtension(options: Options): Promise<void> {
	const target = path.join(options.agentDir, "extensions", EXTENSION_DIR_NAME);
	fs.mkdirSync(path.dirname(target), { recursive: true });
	const repo = fs.realpathSync(REPO_DIR);
	// The target's location with links in its parent directories resolved, and what it points to if it exists.
	const targetPath = path.join(fs.realpathSync(path.dirname(target)), path.basename(target));
	const existing = fs.lstatSync(target, { throwIfNoEntry: false });
	let targetReal: string | undefined;
	try {
		targetReal = existing ? fs.realpathSync(target) : undefined;
	} catch {
		targetReal = undefined; // a link to something that no longer exists
	}
	if (targetPath === repo || targetReal === repo) {
		// Running from the installed extension itself, or from the checkout the installed link points to.
		run(["bun", "install", "--production"], repo);
		if (!existing?.isSymbolicLink()) console.log(`The extension is installed in place at ${target}.`);
		else if (options.copy) console.log(`${target} links to this checkout. Delete the link first to install a copy instead.`);
		else console.log(`${target} already links to this checkout.`);
		return;
	}
	if (within(repo, targetPath) || (targetReal !== undefined && within(repo, targetReal))) {
		throw new InstallError(`This checkout (${repo}) is inside ${target}, which installing would replace. Move the checkout first.`);
	}
	if (within(targetPath, repo)) {
		throw new InstallError(`${target} would be inside this checkout (${repo}). Use an omp agent directory outside it.`);
	}
	if (existing) {
		if (!/^y(es)?$/i.test(await ask(`${target} already exists. Replace it? [y/N] `))) {
			throw new InstallError(`Left ${target} as it was. Remove it yourself or answer yes to replace it.`);
		}
		if (existing.isSymbolicLink()) fs.unlinkSync(target);
		else fs.rmSync(target, { recursive: true, force: true });
	}
	if (options.copy) {
		fs.cpSync(REPO_DIR, target, {
			recursive: true,
			filter: source => !/[\\/](\.git|node_modules)$/.test(source),
		});
		run(["bun", "install", "--production"], target);
		console.log(`Copied the extension to ${target}.`);
	} else {
		run(["bun", "install", "--production"], REPO_DIR);
		fs.symlinkSync(REPO_DIR, target, "dir");
		console.log(`Linked ${target} -> ${REPO_DIR}. A git pull here updates the installed extension.`);
	}
}

/** Sends a message from the domain to itself and waits for it in the inbox, which exercises sending and the MX record. */
async function testRoundTrip(token: string, domain: SendingDomain, inbox: Inbox, owner: string): Promise<void> {
	const client = new MailtrapClient({
		apiToken: token,
		inboxId: String(inbox.id),
		domain: domain.name,
		owner,
		pollMs: TEST_POLL_MS,
		stateDir: os.tmpdir(),
	});
	const address = `omp-install-check@${domain.name}`;
	const subject = `omp email bridge install check ${randomUUID().slice(0, 8)}`;
	console.log(`Sending a test email from ${address} to itself...`);
	try {
		await client.send({
			from: { email: address, name: "omp email bridge installer" },
			to: [{ email: address }],
			subject,
			text: "Test message from the omp email bridge installer. It is deleted as soon as it arrives.",
		});
	} catch (error) {
		throw new InstallError(
			`Mailtrap would not send the test email: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
	const deadline = Date.now() + TEST_TIMEOUT_MS;
	while (Date.now() < deadline) {
		await Bun.sleep(TEST_POLL_MS);
		const { messages } = await client.listMessages();
		const arrived = messages.find(message => message.subject === subject);
		if (arrived) {
			await api(token, "DELETE", `/api/inbound/inboxes/${inbox.id}/messages/${arrived.id}`);
			console.log("The test email arrived in the inbox, so sending and receiving both work.");
			return;
		}
	}
	throw new PendingError(
		`The test email did not arrive within ${TEST_TIMEOUT_MS / 1000} seconds. Check that the MX record for ${domain.name} ` +
			`points to Mailtrap (dig MX ${domain.name}), then run ./install.sh again.`,
	);
}

async function main(): Promise<void> {
	const options = parseArgs(process.argv.slice(2));
	const envFile = path.join(options.agentDir, ".env");
	const fileValues = fs.existsSync(envFile) ? parseDotenv(fs.readFileSync(envFile, "utf8")) : {};
	const known = (key: string) => (process.env[key] ?? fileValues[key] ?? "").trim();
	const updates: Record<string, string> = {};
	/** Saves what was learned so far, so a rerun after DNS changes doesn't ask again. */
	const save = () => writeEnv(envFile, updates);
	console.log(`omp email bridge installer\nomp agent directory: ${options.agentDir}`);

	heading("Mailtrap API token");
	let token = known("MAILTRAP_API_TOKEN");
	if (token) {
		console.log("Using MAILTRAP_API_TOKEN from your environment or .env file.");
	} else {
		console.log(
			"Create one at https://mailtrap.io/settings/api-tokens (Add Token) with Admin access to your account.",
		);
		token = await ask("Paste the token (it won't be shown): ", true);
		if (!token) throw new InstallError("No token given.");
		updates.MAILTRAP_API_TOKEN = token;
	}
	const accountId = await chooseAccount(token, known("MAILTRAP_ACCOUNT_ID"));

	heading("Your email address");
	let owner = known("OMP_EMAIL_OWNER").toLowerCase();
	if (owner) {
		console.log(`Sessions will email ${owner}, and only accept email from it.`);
	} else {
		owner = (await ask("Your email address (sessions email you here, and only accept email from it): ")).toLowerCase();
		updates.OMP_EMAIL_OWNER = owner;
	}
	if (!EMAIL_PATTERN.test(owner)) throw new InstallError(`"${owner}" is not an email address.`);

	heading("Sending and receiving domain");
	const configuredDomain = known("OMP_EMAIL_DOMAIN").toLowerCase().replace(/^@/, "");
	const chosen = await chooseDomain(token, accountId, configuredDomain);
	if (chosen.name !== configuredDomain) updates.OMP_EMAIL_DOMAIN = chosen.name;
	let domain: SendingDomain;
	try {
		domain = await prepareDomain(token, accountId, chosen);
	} catch (error) {
		save();
		throw error;
	}

	heading("Catch-all inbox");
	const inbox = await findOrCreateInbox(token, domain);
	if (known("OMP_EMAIL_INBOX_ID") !== String(inbox.id)) updates.OMP_EMAIL_INBOX_ID = String(inbox.id);

	heading("Settings");
	save();
	for (const key of Object.keys(updates)) {
		if (process.env[key] !== undefined && process.env[key] !== updates[key]) {
			console.log(`Warning: your shell sets ${key}, which takes precedence over the .env file.`);
		}
	}
	if (Object.keys(updates).length === 0) console.log(`${envFile} already has everything.`);

	heading("Extension");
	await installExtension(options);

	if (!options.skipTest) {
		heading("Test");
		await testRoundTrip(token, domain, inbox, owner);
	}

	heading("Done");
	console.log(
		[
			"Restart omp. In a session, /email shows its address. After your first prompt the session emails you from",
			"that address; reply to it, or email the address directly, to send the session a message.",
			"",
			"To have agents email you through the bridge, add this to ~/.omp/agent/AGENTS.md:",
			"  Send every email to me with the `email_user` tool. Replies to those emails come back into the session.",
		].join("\n"),
	);
}

try {
	await main();
} catch (error) {
	if (error instanceof PendingError) {
		console.log(`\n${error.message}`);
		process.exit(2);
	}
	if (error instanceof InstallError) {
		console.error(`\nError: ${error.message}`);
		process.exit(1);
	}
	throw error;
}
