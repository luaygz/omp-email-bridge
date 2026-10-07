import * as fs from "node:fs";
import * as path from "node:path";

/** How far before `scanFrom` each poll looks again, to cover clock skew and slow inbox indexing. */
export const SCAN_OVERLAP_MS = 10 * 60_000;
/** Processed records older than this before `scanFrom` can no longer be seen again and are dropped. */
const PROCESSED_RETENTION_MS = 24 * 60 * 60_000;

export interface ProcessedRecord {
	id: string;
	rfcMessageId?: string;
	receivedAt: string;
	/** `queued`: handed to omp, not yet seen in the session history. */
	outcome: "queued" | "delivered" | "rejected";
	note?: string;
}

export interface SessionMailState {
	version: 1;
	sessionId: string;
	address: string;
	createdAt: string;
	/** Messages received before `scanFrom - SCAN_OVERLAP_MS` have all been handled. */
	scanFrom: string;
	processed: ProcessedRecord[];
}

function isStateShape(value: unknown): value is SessionMailState {
	return (
		!!value &&
		typeof value === "object" &&
		"version" in value &&
		value.version === 1 &&
		"scanFrom" in value &&
		typeof value.scanFrom === "string" &&
		"processed" in value &&
		Array.isArray(value.processed)
	);
}

export function loadState(stateDir: string, sessionId: string, address: string): SessionMailState {
	try {
		const parsed: unknown = JSON.parse(fs.readFileSync(path.join(stateDir, "sessions", `${sessionId}.json`), "utf8"));
		if (isStateShape(parsed) && parsed.sessionId === sessionId) return parsed;
	} catch {
		// missing or unreadable: start fresh below
	}
	const now = new Date().toISOString();
	return { version: 1, sessionId, address, createdAt: now, scanFrom: now, processed: [] };
}

/** Atomic write (temp file + rename) so a crash never leaves half a state file. */
export function saveState(stateDir: string, state: SessionMailState): void {
	const scanFromMs = Date.parse(state.scanFrom);
	// Queued records stay until the email reaches the session; dropping one would lose the email.
	state.processed = state.processed.filter(
		record =>
			record.outcome === "queued" ||
			Date.parse(record.receivedAt) >= scanFromMs - SCAN_OVERLAP_MS - PROCESSED_RETENTION_MS,
	);
	const file = path.join(stateDir, "sessions", `${state.sessionId}.json`);
	fs.mkdirSync(path.dirname(file), { recursive: true });
	const temp = `${file}.${process.pid}.tmp`;
	fs.writeFileSync(temp, `${JSON.stringify(state, null, "\t")}\n`);
	fs.renameSync(temp, file);
}

function processAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return !!error && typeof error === "object" && "code" in error && error.code === "EPERM";
	}
}

/**
 * Claims the mailbox of `sessionId` for this process so two omp windows showing the same session do
 * not both deliver its email. A lock left behind by a dead process is taken over.
 */
export function acquireMailboxLock(stateDir: string, sessionId: string): boolean {
	const file = path.join(stateDir, "locks", `${sessionId}.lock`);
	fs.mkdirSync(path.dirname(file), { recursive: true });
	for (let attempt = 0; attempt < 2; attempt++) {
		try {
			fs.writeFileSync(file, JSON.stringify({ pid: process.pid, at: new Date().toISOString() }), { flag: "wx" });
			return true;
		} catch (error) {
			if (!error || typeof error !== "object" || !("code" in error) || error.code !== "EEXIST") throw error;
		}
		let holder: unknown;
		try {
			holder = JSON.parse(fs.readFileSync(file, "utf8"));
		} catch {
			holder = undefined;
		}
		const pid = holder && typeof holder === "object" && "pid" in holder && typeof holder.pid === "number" ? holder.pid : 0;
		if (pid === process.pid) return true;
		if (pid > 0 && processAlive(pid)) return false;
		fs.rmSync(file, { force: true });
	}
	return false;
}

export function releaseMailboxLock(stateDir: string, sessionId: string): void {
	const file = path.join(stateDir, "locks", `${sessionId}.lock`);
	try {
		const holder: unknown = JSON.parse(fs.readFileSync(file, "utf8"));
		if (holder && typeof holder === "object" && "pid" in holder && holder.pid === process.pid) fs.rmSync(file, { force: true });
	} catch {
		// nothing to release
	}
}
