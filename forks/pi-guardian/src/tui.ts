import type { ExtensionAPI, ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import { Box, Text } from "@earendil-works/pi-tui";
import { GUARDIAN_ASSESSMENT_ENTRY, type GuardianAssessmentRecordV1 } from "./types.ts";

export type GuardianDisplayTone = "success" | "warning" | "error";

export interface GuardianAssessmentDisplay {
	tone: GuardianDisplayTone;
	headline: string;
	details: string[];
}

export type GuardianRuntimeStatus = "enabled" | "disabled" | "error";

export function formatGuardianStatus(status: GuardianRuntimeStatus, model?: string): {
	tone: "warning" | "error";
	text: string;
	model?: string;
} {
	const modelPart = model ? { model } : {};
	if (status === "enabled") return { tone: "warning", text: "⬭ guardian enabled", ...modelPart };
	if (status === "disabled") return { tone: "error", text: "Ψ guardian disabled", ...modelPart };
	return { tone: "error", text: "Ψ guardian configuration error", ...modelPart };
}

export function setGuardianStatusWidget(
	ui: ExtensionUIContext,
	status: GuardianRuntimeStatus,
	model?: string,
): void {
	const display = formatGuardianStatus(status, model);
	ui.setWidget(
		"pi-guardian-status",
		(_tui, theme) =>
			new Text(
				`${theme.fg(display.tone, display.text)}${display.model ? theme.fg("muted", ` · ${display.model}`) : ""}`,
				0,
				0,
			),
		{ placement: "aboveEditor" },
	);
}

export function formatGuardianAssessment(record: GuardianAssessmentRecordV1): GuardianAssessmentDisplay {
	const toolName = record.toolName || "tool call";
	if (record.failure) {
		return {
			tone: "error",
			headline: `Guardian blocked ${toolName} because review failed`,
			details: [record.failure, ...(record.failureHelp ? [`Fix: ${record.failureHelp}`] : [])],
		};
	}

	const allowed = record.assessment.outcome === "allow";
	return {
		tone: allowed ? "success" : "warning",
		headline: `Guardian ${allowed ? "allowed" : "denied"} ${toolName}`,
		details: [
			`${record.assessment.risk_level} risk · ${record.assessment.user_authorization} user authorization`,
			record.assessment.rationale,
		],
	};
}

export function registerGuardianAssessmentRenderer(pi: ExtensionAPI): void {
	pi.registerEntryRenderer<GuardianAssessmentRecordV1>(
		GUARDIAN_ASSESSMENT_ENTRY,
		(entry, { expanded }, theme) => {
			const record = entry.data;
			if (!record) return new Text(theme.fg("error", "Guardian assessment record is missing"), 0, 0);
			const display = formatGuardianAssessment(record);
			const box = new Box(1, 1, (text) => theme.bg("customMessageBg", text));
			const icon = display.tone === "success" ? "✓" : display.tone === "warning" ? "✗" : "!";
			box.addChild(new Text(theme.fg(display.tone, `${icon} ${display.headline}`), 0, 0));
			for (const detail of display.details) box.addChild(new Text(theme.fg("muted", detail), 0, 0));
			if (expanded) {
				box.addChild(
					new Text(
						theme.fg("dim", `reviewed ${record.reviewedAt} · sidecar ${record.guardianSessionId}`),
						0,
						0,
					),
				);
			}
			return box;
		},
	);
}
