import { mkdir, readFile, readdir, realpath, rename, stat, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { AutocompleteItem } from "@earendil-works/pi-tui";
import { generateRunFlow } from "./run-visualization.ts";

export type Grade = "OBSERVED" | "DERIVED";
export type Verdict = "SUPPORTS" | "REFUTES" | "INCONCLUSIVE";
export type SampleKind = "REAL" | "SYNTHETIC";
export type Risk = "LOW" | "HIGH" | "IRREVERSIBLE";

export interface TraceRequest {
	command: string;
	purpose: string;
	timeoutSeconds: number;
}

export interface ExperimentRequest {
	hypothesisId: string;
	command: string;
	expectedSupports: string;
	expectedRefutes: string;
	sampleKind: SampleKind;
	risk: Risk;
	timeoutSeconds: number;
}

export interface State {
	run: {
		id: string;
		successCriterion: string;
		workspace: string;
		status: "ACTIVE" | "REPLAN_REQUIRED" | "COMPLETE" | "ABORTED";
	};
	traces: Array<{
		id: string;
		status: "RUNNING" | "CLOSED";
	}>;
	hypotheses: Array<{
		id: string;
		statement: string;
		falsificationTest: string;
		status: "ACTIVE" | "SUPPORTED" | "REFUTED" | "PARKED";
		consecutiveFailures: number;
	}>;
	experiments: Array<{
		id: string;
		hypothesisId: string;
		sampleKind: SampleKind;
		status: "RUNNING" | "AWAITING_CONCLUSION" | "CLOSED";
	}>;
	seq: number;
	traceSeq: number;
}

interface ExecutionResult {
	stdout: string;
	stderr: string;
	code: number;
	killed: boolean;
}

interface ConclusionInput {
	experimentId: string;
	verdict: Verdict;
	grade: Grade;
	conclusion: string;
	nextAction: string;
}

type Executor = (command: string, workspace: string, timeoutMs: number, signal?: AbortSignal) => Promise<ExecutionResult>;
type Approver = (message: string) => Promise<boolean>;

const RUN_ACTIONS = ["init", "add_hypothesis", "park_hypothesis", "replan", "status"] as const;
const CTF_COMMAND_ARGUMENTS: AutocompleteItem[] = [
	{ value: "status", label: "status", description: "Show the current CTF audit status" },
	{ value: "complete", label: "complete", description: "Mark the active CTF run as complete" },
	{ value: "abort", label: "abort", description: "Abort the active CTF run" },
	{ value: "toggle", label: "toggle", description: "Toggle CTF audit workflow enforcement" },
	{ value: "flow", label: "flow", description: "Generate an interactive React Flow page for a run id" },
];
const SAMPLE_KINDS = ["REAL", "SYNTHETIC"] as const;
const RISKS = ["LOW", "HIGH", "IRREVERSIBLE"] as const;
const VERDICTS = ["SUPPORTS", "REFUTES", "INCONCLUSIVE"] as const;
const GRADES = ["OBSERVED", "DERIVED"] as const;
const AUDITOR_TOOL_NAMES = ["ctf_run", "ctf_trace", "ctf_experiment", "ctf_conclude"];
const WIDGET_ID = "ctf-auditor";
const CONFIG_FILE_NAME = "ctf-auditor.json";
const DEFAULT_MAX_BYTES = 50 * 1024;
const DEFAULT_MAX_LINES = 2000;

type TailResult = {
	content: string;
	truncated: boolean;
	outputLines: number;
	outputBytes: number;
};

let truncateCommandOutput = (text: string, options: { maxBytes: number; maxLines: number }): TailResult => {
	const lines = text.split("\n");
	let selected = lines.slice(Math.max(0, lines.length - options.maxLines)).join("\n");
	let bytes = Buffer.byteLength(selected);
	if (bytes > options.maxBytes) {
		selected = Buffer.from(selected).subarray(bytes - options.maxBytes).toString("utf8");
		bytes = Buffer.byteLength(selected);
	}
	return {
		content: selected,
		truncated: selected !== text,
		outputLines: selected.split("\n").length,
		outputBytes: bytes,
	};
};

function formatSize(bytes: number): string {
	return bytes >= 1024 ? `${(bytes / 1024).toFixed(bytes % 1024 === 0 ? 0 : 1)}KB` : `${bytes}B`;
}

function required(value: string | undefined, name: string): string {
	const text = value?.trim();
	if (!text) throw new Error(`${name} is required`);
	return text;
}

function isWithin(root: string, candidate: string): boolean {
	const rel = relative(root, candidate);
	return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel));
}

function traceNeedsExperiment(command: string): boolean {
	return /(?:^|\s)(?:curl|wget|ssh|scp|nc|ncat|telnet|nmap|masscan|sqlmap)\b|https?:\/\/|(?:^|\s)(?:rm\s+-rf|shutdown|reboot|format)\b/i.test(command);
}

function makeRunId(): string {
	return `${new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 14)}-${Math.random().toString(36).slice(2, 8)}`;
}

function shellInvocation(command: string): { program: string; args: string[] } {
	if (process.platform === "win32") {
		return { program: process.env.ComSpec || "cmd.exe", args: ["/d", "/s", "/c", command] };
	}
	return { program: process.env.SHELL || "/bin/sh", args: ["-c", command] };
}

export class CtfAuditor {
	state?: State;
	private runDir?: string;
	private operation: Promise<void> = Promise.resolve();

	constructor(
		private readonly runsRoot: string,
		private readonly executor: Executor,
		private readonly approve?: Approver,
	) {}

	async load(): Promise<State | undefined> {
		await mkdir(this.runsRoot, { recursive: true });
		const candidates: Array<{ dir: string; mtime: number; state: State }> = [];
		for (const entry of await readdir(this.runsRoot, { withFileTypes: true })) {
			if (!entry.isDirectory()) continue;
			const statePath = join(this.runsRoot, entry.name, "state.json");
			try {
				const [raw, info] = await Promise.all([readFile(statePath, "utf8"), stat(statePath)]);
				const state = JSON.parse(raw) as State;
				state.traces ??= [];
				state.traceSeq ??= state.traces.length;
				candidates.push({ dir: join(this.runsRoot, entry.name), mtime: info.mtimeMs, state });
			} catch {
				// Ignore incomplete or unrelated directories.
			}
		}
		candidates.sort((a, b) => b.mtime - a.mtime);
		const selected = candidates.find((item) => item.state.run.status === "ACTIVE" || item.state.run.status === "REPLAN_REQUIRED") ?? candidates[0];
		this.state = selected?.state;
		this.runDir = selected?.dir;
		return this.state;
	}

	async init(successCriterion: string, workspace: string, id = makeRunId()): Promise<State> {
		if (this.state && (this.state.run.status === "ACTIVE" || this.state.run.status === "REPLAN_REQUIRED")) {
			throw new Error(`Run ${this.state.run.id} is still active`);
		}
		const criterion = required(successCriterion, "successCriterion");
		const canonicalWorkspace = await realpath(resolve(required(workspace, "workspace"))).catch(() => {
			throw new Error(`Workspace does not exist: ${workspace}`);
		});
		this.runDir = join(this.runsRoot, id);
		this.state = {
			run: { id, successCriterion: criterion, workspace: canonicalWorkspace, status: "ACTIVE" },
			traces: [],
			hypotheses: [],
			experiments: [],
			seq: 0,
			traceSeq: 0,
		};
		await this.save();
		return this.state;
	}

	async addHypothesis(statement: string, falsificationTest: string): Promise<string> {
		return this.exclusive(() => this.addHypothesisUnlocked(statement, falsificationTest));
	}

	private async addHypothesisUnlocked(statement: string, falsificationTest: string): Promise<string> {
		const state = this.requireActive();
		if (state.hypotheses.filter((item) => item.status === "ACTIVE").length >= 3) {
			throw new Error("At most 3 hypotheses may be active");
		}
		const id = `H${String(state.hypotheses.length + 1).padStart(4, "0")}`;
		state.hypotheses.push({
			id,
			statement: required(statement, "statement"),
			falsificationTest: required(falsificationTest, "falsificationTest"),
			status: "ACTIVE",
			consecutiveFailures: 0,
		});
		await this.save();
		return id;
	}

	async parkHypothesis(id: string): Promise<void> {
		const state = this.requireActive();
		const hypothesis = state.hypotheses.find((item) => item.id === id);
		if (!hypothesis || hypothesis.status !== "ACTIVE") throw new Error(`Active hypothesis not found: ${id}`);
		if (state.experiments.some((item) => item.hypothesisId === id && item.status !== "CLOSED")) {
			throw new Error(`Hypothesis ${id} has an unconcluded experiment`);
		}
		hypothesis.status = "PARKED";
		await this.save();
	}

	async replan(): Promise<void> {
		const state = this.requireState();
		if (state.run.status !== "REPLAN_REQUIRED") throw new Error("Replan is not currently required");
		state.run.status = "ACTIVE";
		for (const hypothesis of state.hypotheses) hypothesis.consecutiveFailures = 0;
		await this.save();
	}

	async trace(request: TraceRequest, signal?: AbortSignal): Promise<{ traceId: string; summary: string }> {
		return this.exclusive(() => this.runTrace(request, signal));
	}

	private async runTrace(request: TraceRequest, signal?: AbortSignal): Promise<{ traceId: string; summary: string }> {
		const state = this.requireActive();
		required(request.command, "command");
		required(request.purpose, "purpose");
		if (!Number.isFinite(request.timeoutSeconds) || request.timeoutSeconds <= 0) throw new Error("timeoutSeconds must be positive");
		if (traceNeedsExperiment(request.command)) throw new Error("Command exceeds LOW-risk trace scope; use ctf_experiment");

		const canonicalWorkspace = await realpath(state.run.workspace);
		if (!isWithin(state.run.workspace, canonicalWorkspace)) throw new Error("Authorized workspace no longer resolves safely");
		state.traceSeq += 1;
		const traceId = `T${String(state.traceSeq).padStart(4, "0")}`;
		const traceDir = join(this.requireRunDir(), "traces", traceId);
		await mkdir(traceDir, { recursive: true });
		await writeFile(join(traceDir, "request.json"), `${JSON.stringify(request, null, 2)}\n`, "utf8");
		state.traces.push({ id: traceId, status: "RUNNING" });
		await this.save();

		let execution: ExecutionResult;
		try {
			execution = await this.executor(request.command, canonicalWorkspace, request.timeoutSeconds * 1000, signal);
		} catch (error) {
			execution = { stdout: "", stderr: error instanceof Error ? error.message : String(error), code: -1, killed: true };
		}
		await Promise.all([
			writeFile(join(traceDir, "stdout.txt"), execution.stdout, "utf8"),
			writeFile(join(traceDir, "stderr.txt"), execution.stderr, "utf8"),
		]);
		await writeFile(join(traceDir, "result.json"), `${JSON.stringify({ execution: { command: request.command, exitCode: execution.code, killed: execution.killed } }, null, 2)}\n`, "utf8");
		state.traces.find((item) => item.id === traceId)!.status = "CLOSED";
		await this.save();

		const combined = [`exitCode: ${execution.code}`, execution.stdout && `stdout:\n${execution.stdout}`, execution.stderr && `stderr:\n${execution.stderr}`]
			.filter(Boolean)
			.join("\n");
		const truncated = truncateCommandOutput(combined, { maxBytes: DEFAULT_MAX_BYTES, maxLines: DEFAULT_MAX_LINES });
		let summary = truncated.content;
		if (truncated.truncated) summary += `\n\n[Output truncated. Full output: ${traceDir}]`;
		return { traceId, summary };
	}

	async experiment(request: ExperimentRequest, signal?: AbortSignal): Promise<{ experimentId: string; summary: string }> {
		return this.exclusive(() => this.runExperiment(request, signal));
	}

	private async runExperiment(request: ExperimentRequest, signal?: AbortSignal): Promise<{ experimentId: string; summary: string }> {
		const state = this.requireActive();
		if (state.experiments.some((item) => item.status !== "CLOSED")) {
			throw new Error("Conclude the previous experiment before starting another");
		}
		const hypothesis = state.hypotheses.find((item) => item.id === request.hypothesisId);
		if (!hypothesis || hypothesis.status !== "ACTIVE") throw new Error(`Active hypothesis not found: ${request.hypothesisId}`);
		required(request.command, "command");
		required(request.expectedSupports, "expectedSupports");
		required(request.expectedRefutes, "expectedRefutes");
		if (!Number.isFinite(request.timeoutSeconds) || request.timeoutSeconds <= 0) throw new Error("timeoutSeconds must be positive");

		const needsApproval = request.risk === "IRREVERSIBLE";
		if (needsApproval) {
			if (!this.approve) throw new Error(`${request.risk} experiment requires approval, but no UI is available`);
			const accepted = await this.approve(
				`${request.risk} experiment for ${request.hypothesisId}:\n${request.command}\n\nSupports: ${request.expectedSupports}\nRefutes: ${request.expectedRefutes}`,
			);
			if (!accepted) throw new Error("Experiment was not approved");
		}

		const canonicalWorkspace = await realpath(state.run.workspace);
		if (!isWithin(state.run.workspace, canonicalWorkspace)) throw new Error("Authorized workspace no longer resolves safely");
		state.seq += 1;
		const experimentId = `E${String(state.seq).padStart(4, "0")}`;
		const experimentDir = join(this.requireRunDir(), "experiments", experimentId);
		await mkdir(experimentDir, { recursive: true });
		await writeFile(join(experimentDir, "request.json"), `${JSON.stringify(request, null, 2)}\n`, "utf8");
		state.experiments.push({ id: experimentId, hypothesisId: request.hypothesisId, sampleKind: request.sampleKind, status: "RUNNING" });
		await this.save();

		let execution: ExecutionResult;
		try {
			execution = await this.executor(request.command, canonicalWorkspace, request.timeoutSeconds * 1000, signal);
		} catch (error) {
			execution = { stdout: "", stderr: error instanceof Error ? error.message : String(error), code: -1, killed: true };
		}
		await Promise.all([
			writeFile(join(experimentDir, "stdout.txt"), execution.stdout, "utf8"),
			writeFile(join(experimentDir, "stderr.txt"), execution.stderr, "utf8"),
		]);
		await writeFile(
			join(experimentDir, "result.json"),
			`${JSON.stringify({ execution: { command: request.command, exitCode: execution.code, killed: execution.killed } }, null, 2)}\n`,
			"utf8",
		);
		const experiment = state.experiments.find((item) => item.id === experimentId)!;
		experiment.status = "AWAITING_CONCLUSION";
		await this.save();

		const combined = [`exitCode: ${execution.code}`, execution.stdout && `stdout:\n${execution.stdout}`, execution.stderr && `stderr:\n${execution.stderr}`]
			.filter(Boolean)
			.join("\n");
		const truncated = truncateCommandOutput(combined, { maxBytes: DEFAULT_MAX_BYTES, maxLines: DEFAULT_MAX_LINES });
		let summary = truncated.content;
		if (truncated.truncated) {
			summary += `\n\n[Output truncated to ${truncated.outputLines} lines/${formatSize(truncated.outputBytes)}. Full output: ${experimentDir}]`;
		}
		return { experimentId, summary };
	}

	async conclude(input: ConclusionInput): Promise<void> {
		const state = this.requireState();
		if (state.run.status !== "ACTIVE") throw new Error(`Run is ${state.run.status}`);
		const experiment = state.experiments.find((item) => item.id === input.experimentId);
		if (!experiment || experiment.status !== "AWAITING_CONCLUSION") {
			throw new Error(`Experiment is not awaiting conclusion: ${input.experimentId}`);
		}
		if (state.experiments.some((item) => item.status === "AWAITING_CONCLUSION" && item.id !== input.experimentId)) {
			throw new Error("Only the current pending experiment may be concluded");
		}
		if (experiment.sampleKind === "SYNTHETIC" && input.grade === "OBSERVED") {
			throw new Error("Synthetic experiments cannot produce OBSERVED conclusions");
		}
		required(input.conclusion, "conclusion");
		required(input.nextAction, "nextAction");
		const resultPath = join(this.requireRunDir(), "experiments", experiment.id, "result.json");
		const result = JSON.parse(await readFile(resultPath, "utf8")) as Record<string, unknown>;
		await writeFile(join(resultPath), `${JSON.stringify({ ...result, conclusion: input }, null, 2)}\n`, "utf8");
		experiment.status = "CLOSED";

		const hypothesis = state.hypotheses.find((item) => item.id === experiment.hypothesisId)!;
		if (input.verdict === "SUPPORTS") {
			hypothesis.status = "SUPPORTED";
			hypothesis.consecutiveFailures = 0;
		} else {
			hypothesis.consecutiveFailures += 1;
			if (hypothesis.consecutiveFailures >= 2) {
				state.run.status = "REPLAN_REQUIRED";
				if (input.verdict === "REFUTES") hypothesis.status = "REFUTED";
			}
		}
		await this.save();
	}

	async statusText(): Promise<string> {
		if (!this.state) return "CTF auditor: not initialized. Use ctf_run init.";
		const state = this.state;
		const hypotheses = state.hypotheses.map((item) => `${item.id}:${item.status} ${item.statement}`).join("\n") || "(none)";
		const pending = state.experiments.find((item) => item.status !== "CLOSED");
		const closed = [...state.experiments].reverse().find((item) => item.status === "CLOSED");
		let recent = "(none)";
		let next = pending ? `Conclude ${pending.id}` : state.run.status === "REPLAN_REQUIRED" ? "Call ctf_run replan" : "Run a low-cost experiment or add a hypothesis";
		if (closed) {
			try {
				const raw = JSON.parse(await readFile(join(this.requireRunDir(), "experiments", closed.id, "result.json"), "utf8"));
				recent = `${closed.id}: ${raw.conclusion?.verdict ?? "?"} - ${raw.conclusion?.conclusion ?? "?"}`;
				if (!pending && raw.conclusion?.nextAction) next = raw.conclusion.nextAction;
			} catch {}
		}
		return `Run ${state.run.id} [${state.run.status}]\nSuccess: ${state.run.successCriterion}\nWorkspace: ${state.run.workspace}\nHypotheses:\n${hypotheses}\nPending: ${pending?.id ?? "none"}\nRecent: ${recent}\nNext: ${next}`;
	}

	async flush(): Promise<void> {
		if (this.state) await this.save();
	}

	async setTerminalStatus(status: "COMPLETE" | "ABORTED"): Promise<void> {
		const state = this.requireState();
		if (state.run.status === "COMPLETE" || state.run.status === "ABORTED") throw new Error(`Run is already ${state.run.status}`);
		if (status === "COMPLETE" && state.experiments.some((item) => item.status !== "CLOSED")) {
			throw new Error("Cannot complete with an unconcluded experiment");
		}
		state.run.status = status;
		await this.save();
	}

	private exclusive<T>(action: () => Promise<T>): Promise<T> {
		const result = this.operation.then(action, action);
		this.operation = result.then(
			() => undefined,
			() => undefined,
		);
		return result;
	}

	private requireState(): State {
		if (!this.state) throw new Error("CTF run is not initialized");
		return this.state;
	}

	private requireActive(): State {
		const state = this.requireState();
		if (state.run.status !== "ACTIVE") throw new Error(`Run is ${state.run.status}`);
		return state;
	}

	private requireRunDir(): string {
		if (!this.runDir) throw new Error("CTF run directory is unavailable");
		return this.runDir;
	}

	private async save(): Promise<void> {
		const state = this.requireState();
		const runDir = this.requireRunDir();
		await mkdir(runDir, { recursive: true });
		const target = join(runDir, "state.json");
		const temporary = `${target}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
		await writeFile(temporary, `${JSON.stringify(state, null, 2)}\n`, "utf8");
		await rename(temporary, target);
	}
}

function widgetLine(state: State | undefined, auditEnabled: boolean): string {
	if (!auditEnabled) return "CTF auditor: OFF | standard tools enabled | /ctf toggle to enable";
	if (!state) return "CTF: not initialized";
	const active = state.hypotheses.filter((item) => item.status === "ACTIVE").length;
	const pending = state.experiments.find((item) => item.status !== "CLOSED")?.id ?? "none";
	return `CTF ${state.run.id} | ${state.run.status} | hypotheses ${active}/3 | pending ${pending} | success: ${state.run.successCriterion}`;
}

export default async function ctfAuditorExtension(pi: ExtensionAPI): Promise<void> {
	const extensionDir = dirname(fileURLToPath(import.meta.url));
	const codingAgent = await import("@earendil-works/pi-coding-agent");
	const { StringEnum } = await import("@earendil-works/pi-ai");
	const { Type } = await import("typebox");
	truncateCommandOutput = codingAgent.truncateTail;
	const configDirName = codingAgent.CONFIG_DIR_NAME;

	let auditor: CtfAuditor;
	let toolsBeforeSession: string[] | undefined;
	let currentContext: ExtensionContext | undefined;
	let auditEnabled = false;
	let configPath = "";
	let runsRoot = "";
	let knownRunIds: string[] = [];

	const refreshWidget = (ctx: ExtensionContext): void => ctx.ui.setWidget(WIDGET_ID, [widgetLine(auditor?.state, auditEnabled)]);
	const applyToolMode = (): void => {
		const standardTools = (toolsBeforeSession ?? pi.getActiveTools()).filter((name) => !AUDITOR_TOOL_NAMES.includes(name));
		if (!auditEnabled) {
			pi.setActiveTools(standardTools);
			return;
		}
		pi.setActiveTools([...new Set(standardTools.concat(AUDITOR_TOOL_NAMES))]);
	};
	const loadAuditEnabled = async (): Promise<boolean> => {
		try {
			const config = JSON.parse(await readFile(configPath, "utf8")) as { enabled?: unknown };
			return config.enabled === true;
		} catch {
			return false;
		}
	};
	const setAuditEnabled = async (enabled: boolean, ctx: ExtensionContext): Promise<void> => {
		auditEnabled = enabled;
		await mkdir(dirname(configPath), { recursive: true });
		await writeFile(configPath, `${JSON.stringify({ enabled }, null, 2)}\n`, "utf8");
		applyToolMode();
		refreshWidget(ctx);
	};
	const textResult = (text: string, details: unknown = {}) => ({ content: [{ type: "text" as const, text }], details });

	pi.registerTool({
		name: "ctf_run",
		label: "CTF Run",
		description: "Initialize and manage the CTF audit state machine.",
		promptSnippet: "Initialize/manage CTF runs and falsifiable hypotheses",
		promptGuidelines: ["Use ctf_run to initialize the audit and manage at most three falsifiable hypotheses."],
		parameters: Type.Object({
			action: StringEnum(RUN_ACTIONS),
			successCriterion: Type.Optional(Type.String()),
			workspace: Type.Optional(Type.String()),
			statement: Type.Optional(Type.String()),
			falsificationTest: Type.Optional(Type.String()),
			hypothesisId: Type.Optional(Type.String()),
		}),
		async execute(_id, params, _signal, _update, ctx) {
			if (params.action === "init") await auditor.init(params.successCriterion ?? "", params.workspace ?? "");
			else if (params.action === "add_hypothesis") await auditor.addHypothesis(params.statement ?? "", params.falsificationTest ?? "");
			else if (params.action === "park_hypothesis") await auditor.parkHypothesis(required(params.hypothesisId, "hypothesisId"));
			else if (params.action === "replan") await auditor.replan();
			refreshWidget(ctx);
			return textResult(await auditor.statusText(), { state: auditor.state });
		},
	});

	pi.registerTool({
		name: "ctf_trace",
		label: "CTF Trace",
		description: `Run a LOW-risk exploratory command without creating a formal conclusion. Full output is saved on disk; model output is truncated.`,
		promptSnippet: "Run short, LOW-risk exploration without formal hypothesis bookkeeping",
		promptGuidelines: ["Use ctf_trace for file discovery, environment checks, searches, and short local static checks. Upgrade decision-changing, networked, costly, or irreversible validation to ctf_experiment."],
		parameters: Type.Object({
			command: Type.String(),
			purpose: Type.String(),
			timeoutSeconds: Type.Number({ minimum: 1 }),
		}),
		async execute(_id, params, signal, _update, ctx) {
			const result = await auditor.trace(params, signal);
			refreshWidget(ctx);
			return textResult(`${result.traceId}\n${result.summary}`, result);
		},
	});

	pi.registerTool({
		name: "ctf_experiment",
		label: "CTF Experiment",
		description: `Run one hypothesis-bound command in the authorized workspace. Full output is saved on disk; model output is truncated to ${DEFAULT_MAX_LINES} lines or ${formatSize(DEFAULT_MAX_BYTES)}.`,
		promptSnippet: "Run a real, falsifiable CTF experiment with supports/refutes criteria",
		promptGuidelines: ["Use ctf_experiment only for decision-changing or key validation, and conclude each formal experiment before another. Use ctf_trace for ordinary LOW-risk exploration."],
		parameters: Type.Object({
			hypothesisId: Type.String(),
			command: Type.String(),
			expectedSupports: Type.String(),
			expectedRefutes: Type.String(),
			sampleKind: StringEnum(SAMPLE_KINDS),
			risk: StringEnum(RISKS),
			timeoutSeconds: Type.Number({ minimum: 1 }),
		}),
		async execute(_id, params, signal, _update, ctx) {
			const result = await auditor.experiment(params, signal);
			refreshWidget(ctx);
			return textResult(`${result.experimentId}\n${result.summary}\n\nNext: call ctf_conclude.`, result);
		},
	});

	pi.registerTool({
		name: "ctf_conclude",
		label: "CTF Conclude",
		description: "Record the conclusion for the sole pending experiment and choose the next action.",
		promptSnippet: "Conclude the pending experiment from its raw output",
		promptGuidelines: ["Use ctf_conclude immediately after ctf_experiment; synthetic evidence must be DERIVED."],
		parameters: Type.Object({
			experimentId: Type.String(),
			verdict: StringEnum(VERDICTS),
			grade: StringEnum(GRADES),
			conclusion: Type.String(),
			nextAction: Type.String(),
		}),
		async execute(_id, params, _signal, _update, ctx) {
			await auditor.conclude(params);
			refreshWidget(ctx);
			return textResult(await auditor.statusText(), { state: auditor.state });
		},
	});

	pi.registerCommand("ctf", {
		description: "CTF audit controls: /ctf toggle|status|complete|abort|flow <run-id>",
		getArgumentCompletions: (prefix) => {
			const value = prefix.trimStart();
			const flowMatch = value.match(/^flow\s+(.*)$/);
			if (flowMatch) {
				const query = flowMatch[1].trim();
				const items = knownRunIds
					.filter((runId) => runId.startsWith(query))
					.map((runId) => ({ value: `flow ${runId}`, label: runId, description: "Generate run.html" }));
				return items.length > 0 ? items : null;
			}
			const items = CTF_COMMAND_ARGUMENTS.filter((item) => item.value.startsWith(value.trim()));
			return items.length > 0 ? items : null;
		},
		handler: async (args, ctx) => {
			const action = args.trim();
			if (action === "status") ctx.ui.notify(await auditor.statusText(), "info");
			else if (action === "complete") {
				if (!ctx.hasUI) throw new Error("Completing a run requires human confirmation, but no UI is available");
				if (!(await ctx.ui.confirm("Complete CTF run?", "Confirm that the success criterion has been met."))) return;
				await auditor.setTerminalStatus("COMPLETE");
				ctx.ui.notify("CTF run completed", "info");
			} else if (action === "abort") {
				await auditor.setTerminalStatus("ABORTED");
				ctx.ui.notify("CTF run aborted", "warning");
			} else if (action === "toggle") {
				await setAuditEnabled(!auditEnabled, ctx);
				ctx.ui.notify(
					auditEnabled ? "CTF audit enabled: standard tools remain available." : "CTF audit disabled.",
					auditEnabled ? "info" : "warning",
				);
				return;
			} else if (action.startsWith("flow")) {
				const match = action.match(/^flow\s+(\S+)$/);
				if (!match) {
					ctx.ui.notify("Usage: /ctf flow <run-id>", "warning");
					return;
				}
				const generated = await generateRunFlow(runsRoot, match[1], join(extensionDir, "viewer", "dist"));
				knownRunIds = [...new Set(knownRunIds.concat(match[1]))].sort();
				const warningText = generated.warnings.length > 0 ? `\nWarnings (${generated.warnings.length}):\n${generated.warnings.join("\n")}` : "";
				ctx.ui.notify(`Generated ${generated.nodes} React Flow nodes:\n${generated.outputPath}${warningText}`, generated.warnings.length > 0 ? "warning" : "info");
				return;
			} else ctx.ui.notify("Usage: /ctf toggle|status|complete|abort|flow <run-id>", "warning");
			refreshWidget(ctx);
		},
	});

	pi.on("session_start", async (_event, ctx) => {
		currentContext = ctx;
		toolsBeforeSession = pi.getActiveTools();
		configPath = join(ctx.cwd, configDirName, CONFIG_FILE_NAME);
		auditEnabled = await loadAuditEnabled();
		const invocationExecutor: Executor = async (command, workspace, timeoutMs, signal) => {
			const shell = shellInvocation(command);
			return pi.exec(shell.program, shell.args, { cwd: workspace, timeout: timeoutMs, signal });
		};
		const approver: Approver | undefined = ctx.hasUI
			? (message) => ctx.ui.confirm("Approve CTF experiment?", message)
			: undefined;
		runsRoot = join(ctx.cwd, configDirName, "ctf-runs");
		auditor = new CtfAuditor(runsRoot, invocationExecutor, approver);
		await auditor.load();
		knownRunIds = (await readdir(runsRoot, { withFileTypes: true }))
			.filter((entry) => entry.isDirectory())
			.map((entry) => entry.name)
			.sort();
		applyToolMode();
		refreshWidget(ctx);
	});

	pi.on("before_agent_start", async (event) => {
		if (!auditEnabled) return;
		const status = await auditor.statusText();
		return {
			systemPrompt: `${event.systemPrompt}\n\n[CTF AUDIT CONTROL]\n${status}\n\nAudit decisions, not individual commands. Standard tools may be used directly. Use ctf_trace when LOW-risk command output should be retained in the audit record. Use ctf_experiment when a result changes the solution route, validates a key vulnerability/exploit/flag, accesses a real network target, or has meaningful cost/risk. Keep incremental checks on one hypothesis. Every formal experiment needs supports/refutes criteria and must be concluded before the next formal experiment. Review and approve IRREVERSIBLE experiments.`,
		};
	});


	pi.on("session_shutdown", async () => {
		await auditor?.flush();
		if (currentContext) refreshWidget(currentContext);
		if (toolsBeforeSession) pi.setActiveTools(toolsBeforeSession);
	});
}
