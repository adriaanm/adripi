import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { GUARDIAN_STATE_ENTRY, GUARDIAN_ASSESSMENT_ENTRY } from "./types.ts";

export const GUARDIAN_USAGE_ENTRY = "pi-guardian.usage";
export const REVIEWER_USAGE_ENTRY = "pi-guardian.reviewer-usage";
export const USAGE_KINDS = ["review", "format-retry", "summary", "legacy"] as const;
export type UsageKind = typeof USAGE_KINDS[number];
export interface UsageTotals {
	calls: number; input: number; output: number; cacheRead: number; cacheWrite: number;
	usd: number; unpriced: number; unreported: number;
}
export interface GuardianUsageSnapshot {
	version: 1; parentSessionId: string; reviewerSessionId: string; revision: number;
	totals: Record<UsageKind, UsageTotals>;
}
export interface ReviewerUsageRecord {
	version: 1; id: string; sourceId?: string; kind: UsageKind; totals: UsageTotals;
}
export interface UsageView { totals: Record<UsageKind, UsageTotals>; gaps: number; pending?: number; uncovered?: number }
export type GuardianUsageNotice = { kind: "snapshot"; snapshot: GuardianUsageSnapshot; requestId?: string } | { kind: "gap" | "pending"; parentSessionId: string; requestId: string };
const fields = ["calls", "input", "output", "cacheRead", "cacheWrite", "usd", "unpriced", "unreported"] as const;
const record = (v: unknown): v is Record<string, unknown> => Boolean(v) && typeof v === "object" && !Array.isArray(v);
const identity = (v: unknown): v is string => typeof v === "string" && v.length > 0 && Buffer.byteLength(v) <= 256 && !v.includes("\0");
const integer = (v: unknown): v is number => Number.isSafeInteger(v) && (v as number) >= 0;
export const emptyTotals = (): UsageTotals => ({ calls: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, usd: 0, unpriced: 0, unreported: 0 });
export const emptyKinds = (): Record<UsageKind, UsageTotals> => Object.fromEntries(USAGE_KINDS.map((k) => [k, emptyTotals()])) as Record<UsageKind, UsageTotals>;
function isTotals(v: unknown): v is UsageTotals {
	return record(v) && Object.keys(v).length === fields.length && fields.every((f) => f === "usd" ? typeof v[f] === "number" && Number.isFinite(v[f]) && v[f] >= 0 && v[f] <= 1e12 : integer(v[f])) &&
		(v.unpriced as number) <= (v.calls as number) && (v.unreported as number) <= (v.calls as number);
}
export function parseUsageSnapshot(v: unknown): GuardianUsageSnapshot {
	if (!record(v) || Object.keys(v).length !== 5 || v.version !== 1 || !identity(v.parentSessionId) || !identity(v.reviewerSessionId) || !integer(v.revision) ||
		!record(v.totals) || Object.keys(v.totals).length !== USAGE_KINDS.length || !USAGE_KINDS.every((k) => isTotals((v.totals as Record<string, unknown>)[k]))) {
		throw new Error("Guardian returned invalid usage telemetry");
	}
	return structuredClone(v) as unknown as GuardianUsageSnapshot;
}
function usageRecord(v: unknown): v is ReviewerUsageRecord {
	return record(v) && v.version === 1 && identity(v.id) && (v.sourceId === undefined || identity(v.sourceId)) && USAGE_KINDS.includes(v.kind as UsageKind) && isTotals(v.totals) && v.totals.calls === 1;
}
function add(into: UsageTotals, value: UsageTotals): void { for (const f of fields) into[f] += value[f]; }

/** Zero-only catalog prices cannot distinguish a free model from omitted pricing. */
export function measureUsage(usage: unknown, model?: unknown): UsageTotals {
	const result = emptyTotals(); result.calls = 1;
	const tokens = ["input", "output", "cacheRead", "cacheWrite"] as const;
	const complete = record(usage) && tokens.every((f) => integer(usage[f]));
	if (record(usage)) for (const f of tokens) if (integer(usage[f])) result[f] = usage[f] as number;
	// Every Guardian prompt has input: SDK zero-filled placeholder usage is not
	// evidence of a free call, even when stopReason is successful.
	if (!complete || !tokens.some((f) => result[f] > 0)) result.unreported = 1;
	const reported = record(usage) && record(usage.cost) ? usage.cost.total : undefined;
	if (typeof reported === "number" && (!Number.isFinite(reported) || reported < 0 || reported > 1e12)) { result.unpriced = 1; return result; }
	if (typeof reported === "number" && reported > 0) { result.usd = reported; return result; }
	if (result.unreported) { result.unpriced = 1; return result; }
	const prices = record(model) && record(model.cost) ? model.cost : undefined;
	if (prices && tokens.every((f) => typeof prices[f] === "number" && Number.isFinite(prices[f]) && prices[f] >= 0) && tokens.some((f) => (prices[f] as number) > 0)) {
		result.usd = tokens.reduce((sum, f) => sum + result[f] * (prices[f] as number) / 1_000_000, 0);
		if (!Number.isFinite(result.usd) || result.usd > 1e12) { result.usd = 0; result.unpriced = 1; }
	} else result.unpriced = 1;
	return result;
}

/** Full immutable audit tree, not the projected/active branch: compaction never unspends money. */
export function reviewerUsageSnapshot(entries: readonly SessionEntry[], parentSessionId: string, reviewerSessionId: string): GuardianUsageSnapshot {
	const calls = new Map<string, ReviewerUsageRecord>();
	for (const entry of entries) if (entry.type === "custom" && entry.customType === REVIEWER_USAGE_ENTRY && usageRecord(entry.data)) calls.set(entry.data.id, entry.data);
	const sources = new Set([...calls.values()].map((c) => c.sourceId));
	const totals = emptyKinds();
	for (const call of calls.values()) add(totals[call.kind], call.totals);
	for (const entry of entries) {
		if (sources.has(entry.id)) continue;
		if (entry.type === "custom" && entry.customType === REVIEWER_USAGE_ENTRY && !usageRecord(entry.data)) add(totals.legacy, measureUsage(undefined));
		if (entry.type === "message" && entry.message.role === "assistant") add(totals.legacy, measureUsage(entry.message.usage));
		if ((entry.type === "compaction" || entry.type === "branch_summary") && entry.usage) {
			const linked = (entry.details as { guardianUsageId?: unknown } | undefined)?.guardianUsageId;
			if (typeof linked !== "string" || !calls.has(linked)) add(totals.legacy, measureUsage(entry.usage));
		}
		if (entry.type === "usage") add(totals.legacy, measureUsage(entry.usage));
	}
	return parseUsageSnapshot({ version: 1, parentSessionId, reviewerSessionId, revision: entries.length, totals });
}

/** Parent custom entries only; never add an assistant/SDK usage entry to native Pi totals. */
export function guardianUsageView(entries: readonly SessionEntry[], parentSessionId: string): UsageView {
	const snapshots = new Map<string, GuardianUsageSnapshot>();
	const gaps = new Set<string>();
	const pending = new Set<string>();
	const resolved = new Set<string>();
	const usedReviewers = new Set<string>();
	const ownReviewers = new Set(entries.flatMap((entry) => entry.type === "custom" && entry.customType === GUARDIAN_STATE_ENTRY && record(entry.data) && entry.data.parentSessionId === parentSessionId && identity(entry.data.guardianSessionId) ? [entry.data.guardianSessionId] : []));
	for (const entry of entries) {
		if (entry.type === "custom" && record(entry.data) && identity(entry.data.guardianSessionId) && ownReviewers.has(entry.data.guardianSessionId) &&
			((entry.customType === GUARDIAN_STATE_ENTRY && typeof entry.data.reviewCount === "number" && entry.data.reviewCount > 0) ||
			(entry.customType === GUARDIAN_ASSESSMENT_ENTRY && entry.data.source === "reviewer"))) usedReviewers.add(entry.data.guardianSessionId);
		if (entry.type !== "custom" || entry.customType !== GUARDIAN_USAGE_ENTRY || !record(entry.data)) continue;
		const data = entry.data;
		if (data.kind === "pending" && data.parentSessionId === parentSessionId && identity(data.requestId) && !resolved.has(data.requestId)) pending.add(data.requestId);
		if (data.kind === "gap" && data.parentSessionId === parentSessionId && identity(data.requestId) && !resolved.has(data.requestId)) { gaps.add(data.requestId); pending.delete(data.requestId); }
		if (data.kind !== "snapshot") continue;
		try {
			const snapshot = parseUsageSnapshot(data.snapshot);
			if (snapshot.parentSessionId !== parentSessionId) continue;
			if (identity(data.requestId)) { resolved.add(data.requestId); pending.delete(data.requestId); gaps.delete(data.requestId); }
			const previous = snapshots.get(snapshot.reviewerSessionId);
			if (!previous || snapshot.revision > previous.revision) snapshots.set(snapshot.reviewerSessionId, snapshot);
		} catch { gaps.add(`invalid:${entry.id}`); }
	}
	const totals = emptyKinds();
	for (const snapshot of snapshots.values()) for (const kind of USAGE_KINDS) add(totals[kind], snapshot.totals[kind]);
	return { totals, gaps: gaps.size, pending: pending.size, uncovered: [...usedReviewers].filter((id) => !snapshots.has(id)).length };
}
export function formatUsageTotals(totals: UsageTotals): string {
	const priced = totals.calls - totals.unpriced;
	const amount = totals.usd > 0 && totals.usd < 0.0001 ? "<$0.0001" : `$${totals.usd.toFixed(4)}`;
	const dollars = priced ? `${totals.unpriced ? "known " : ""}${amount} estimate` : totals.calls ? "cost unavailable" : "no model calls recorded";
	return `${dollars} · ${totals.calls} calls · tokens in ${totals.input} / out ${totals.output} / cache read ${totals.cacheRead} / write ${totals.cacheWrite}` +
		(totals.unpriced ? ` · ${totals.unpriced} unpriced (zero/absent tariffs)` : "") + (totals.unreported ? ` · ${totals.unreported} unreported usage` : "");
}
export function formatGuardianCosts(view: UsageView, detail = false): string {
	const total = emptyTotals(); for (const kind of USAGE_KINDS) add(total, view.totals[kind]);
	return `Guardian only: ${formatUsageTotals(total)}` + (view.gaps ? ` · ${view.gaps} incomplete review transports` : "") +
		(view.pending ? ` · ${view.pending} pending/unreconciled review transports` : "") +
		(view.uncovered ? ` · ${view.uncovered} reviewer generations lack historical telemetry` : "") +
		(detail ? USAGE_KINDS.map((k) => `\n  ${k}: ${formatUsageTotals(view.totals[k])}`).join("") : "");
}
