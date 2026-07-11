import { mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { ExperimentRequest, State } from "./index.ts";

type FileState = "PRESENT" | "MISSING" | "INVALID";
type JsonRead<T> = { state: FileState; value?: T; warning?: string };

type ExperimentResult = {
	execution?: {
		command?: unknown;
		exitCode?: unknown;
		killed?: unknown;
	};
	conclusion?: {
		experimentId?: unknown;
		verdict?: unknown;
		grade?: unknown;
		conclusion?: unknown;
		nextAction?: unknown;
	};
};

export interface ExperimentView {
	index: number;
	id: string;
	hypothesisId: string;
	sampleKind: string;
	status: string;
	request?: Partial<ExperimentRequest>;
	result?: ExperimentResult;
	files: {
		request: FileState;
		result: FileState;
		stdout: FileState;
		stderr: FileState;
	};
}

export interface HypothesisView {
	index: number;
	id: string;
	statement: string;
	falsificationTest: string;
	status: string;
	consecutiveFailures: number;
	experiments: ExperimentView[];
}

export interface RunView {
	run: State["run"];
	hypotheses: HypothesisView[];
	orphanExperiments: ExperimentView[];
	warnings: string[];
}

export interface MermaidGenerationResult {
	outputPath: string;
	mermaid: string;
	warnings: string[];
	nodes: number;
}

const RUN_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

function validateRunId(runId: string): string {
	const value = runId.trim();
	if (!RUN_ID_PATTERN.test(value) || value === "." || value === "..") {
		throw new Error(`Invalid run id: ${runId}`);
	}
	return value;
}

async function fileExists(path: string): Promise<boolean> {
	try {
		return (await stat(path)).isFile();
	} catch {
		return false;
	}
}

async function readJson<T>(path: string, label: string, required = false): Promise<JsonRead<T>> {
	let raw: string;
	try {
		raw = await readFile(path, "utf8");
	} catch (error) {
		const code = (error as NodeJS.ErrnoException).code;
		if (code === "ENOENT") {
			return {
				state: "MISSING",
				warning: required ? `${label} is missing` : undefined,
			};
		}
		return { state: "INVALID", warning: `${label} could not be read: ${error instanceof Error ? error.message : String(error)}` };
	}
	try {
		return { state: "PRESENT", value: JSON.parse(raw) as T };
	} catch (error) {
		return { state: "INVALID", warning: `${label} is invalid JSON: ${error instanceof Error ? error.message : String(error)}` };
	}
}

function isState(value: unknown): value is State {
	if (!value || typeof value !== "object") return false;
	const candidate = value as Partial<State>;
	return Boolean(
		candidate.run &&
			typeof candidate.run.id === "string" &&
			typeof candidate.run.successCriterion === "string" &&
			typeof candidate.run.workspace === "string" &&
			typeof candidate.run.status === "string" &&
			Array.isArray(candidate.hypotheses) &&
			candidate.hypotheses.every(
				(item) => item && typeof item === "object" && typeof item.id === "string" && typeof item.statement === "string",
			) &&
			Array.isArray(candidate.experiments) &&
			candidate.experiments.every(
				(item) => item && typeof item === "object" && typeof item.id === "string" && typeof item.hypothesisId === "string",
			),
	);
}

function requireJsonObject<T>(read: JsonRead<T>, label: string): JsonRead<T> {
	if (read.state !== "PRESENT" || (read.value && typeof read.value === "object" && !Array.isArray(read.value))) return read;
	return { state: "INVALID", warning: `${label} must contain a JSON object` };
}

export async function loadRunView(runsRoot: string, runId: string): Promise<RunView> {
	const safeRunId = validateRunId(runId);
	const runDir = resolve(runsRoot, safeRunId);
	const stateRead = await readJson<State>(join(runDir, "state.json"), `${safeRunId}/state.json`, true);
	if (stateRead.state !== "PRESENT" || !isState(stateRead.value)) {
		if (stateRead.state === "PRESENT") throw new Error(`Run ${safeRunId} has an invalid state.json structure`);
		throw new Error(stateRead.warning ?? `Run not found: ${safeRunId}`);
	}

	const state = stateRead.value;
	const warnings: string[] = [];
	const experiments: ExperimentView[] = [];
	for (const [index, experiment] of state.experiments.entries()) {
		const experimentDir = join(runDir, "experiments", experiment.id);
		const [requestRead, resultRead, stdout, stderr] = await Promise.all([
			readJson<Partial<ExperimentRequest>>(join(experimentDir, "request.json"), `${experiment.id}/request.json`, true),
			readJson<ExperimentResult>(
				join(experimentDir, "result.json"),
				`${experiment.id}/result.json`,
				experiment.status === "CLOSED",
			),
			fileExists(join(experimentDir, "stdout.txt")),
			fileExists(join(experimentDir, "stderr.txt")),
		]);
		const request = requireJsonObject(requestRead, `${experiment.id}/request.json`);
		const result = requireJsonObject(resultRead, `${experiment.id}/result.json`);
		if (request.warning) warnings.push(request.warning);
		if (result.warning) warnings.push(result.warning);
		experiments.push({
			index,
			id: String(experiment.id),
			hypothesisId: String(experiment.hypothesisId),
			sampleKind: String(experiment.sampleKind),
			status: String(experiment.status),
			request: request.value,
			result: result.value,
			files: {
				request: request.state,
				result: result.state,
				stdout: stdout ? "PRESENT" : "MISSING",
				stderr: stderr ? "PRESENT" : "MISSING",
			},
		});
	}

	const hypotheses: HypothesisView[] = state.hypotheses.map((hypothesis, index) => ({
		index,
		id: String(hypothesis.id),
		statement: String(hypothesis.statement),
		falsificationTest: String(hypothesis.falsificationTest),
		status: String(hypothesis.status),
		consecutiveFailures: Number(hypothesis.consecutiveFailures) || 0,
		experiments: experiments.filter((experiment) => experiment.hypothesisId === hypothesis.id),
	}));
	const hypothesisIds = new Set(hypotheses.map((hypothesis) => hypothesis.id));
	const orphanExperiments = experiments.filter((experiment) => !hypothesisIds.has(experiment.hypothesisId));
	for (const experiment of orphanExperiments) {
		warnings.push(`${experiment.id} references missing hypothesis ${experiment.hypothesisId}`);
	}

	return { run: state.run, hypotheses, orphanExperiments, warnings };
}

function summarize(value: unknown, maxLength: number): string {
	const text = String(value ?? "")
		.replace(/[\r\n\t]+/g, " ")
		.replace(/\s+/g, " ")
		.trim();
	const characters = [...text];
	return characters.length <= maxLength ? text : `${characters.slice(0, Math.max(0, maxLength - 1)).join("")}…`;
}

function escapeLabel(value: unknown, maxLength = 120): string {
	return summarize(value, maxLength)
		.replace(/&/g, "&amp;")
		.replace(/\\/g, "&#92;")
		.replace(/"/g, "&quot;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/\|/g, "&#124;");
}

function label(lines: Array<string | undefined>): string {
	return lines.filter((line): line is string => Boolean(line)).join("<br/>");
}

function runClass(status: string): string {
	if (status === "COMPLETE") return "supported";
	if (status === "ABORTED") return "refuted";
	if (status === "REPLAN_REQUIRED") return "pending";
	return "active";
}

function hypothesisClass(status: string): string {
	if (status === "SUPPORTED") return "supported";
	if (status === "REFUTED") return "refuted";
	if (status === "PARKED") return "parked";
	return "active";
}

function experimentClass(experiment: ExperimentView): string {
	const outputMissing = experiment.status !== "RUNNING" &&
		(experiment.files.stdout !== "PRESENT" || experiment.files.stderr !== "PRESENT");
	if (
		experiment.files.request !== "PRESENT" ||
		experiment.files.result === "INVALID" ||
		(experiment.status === "CLOSED" && experiment.files.result !== "PRESENT") ||
		outputMissing
	) return "error";
	return experiment.status === "CLOSED" ? "closed" : "pending";
}

function conclusionClass(verdict: unknown): string {
	if (verdict === "SUPPORTS") return "supported";
	if (verdict === "REFUTES") return "refuted";
	return "pending";
}

function fileMarker(name: string, state: FileState): string | undefined {
	return state === "PRESENT" ? undefined : `${name}: ${state}`;
}

export function renderRunMermaid(view: RunView): string {
	const lines = ["flowchart LR"];
	let nodes = 1;
	lines.push(
		`  run_0["${label([
			`Run ${escapeLabel(view.run.id, 80)}`,
			`Status: ${escapeLabel(view.run.status, 40)}`,
			`Success: ${escapeLabel(view.run.successCriterion)}`,
			`Workspace: ${escapeLabel(view.run.workspace)}`,
		])}"]:::${runClass(view.run.status)}`,
	);

	for (const hypothesis of view.hypotheses) {
		const hypothesisNode = `hyp_${hypothesis.index}`;
		nodes += 1;
		lines.push(
			`  ${hypothesisNode}["${label([
				`${escapeLabel(hypothesis.id, 40)} · ${escapeLabel(hypothesis.status, 40)}`,
				escapeLabel(hypothesis.statement),
				`Failures: ${hypothesis.consecutiveFailures}`,
			])}"]:::${hypothesisClass(hypothesis.status)}`,
			`  run_0 --> ${hypothesisNode}`,
		);
		for (const experiment of hypothesis.experiments) {
			nodes += renderExperiment(lines, hypothesisNode, experiment);
		}
	}

	for (const experiment of view.orphanExperiments) {
		nodes += renderExperiment(lines, "run_0", experiment, true);
	}

	lines.push(
		"  classDef active fill:#dbeafe,stroke:#2563eb,color:#172554",
		"  classDef supported fill:#dcfce7,stroke:#16a34a,color:#14532d",
		"  classDef refuted fill:#fee2e2,stroke:#dc2626,color:#7f1d1d",
		"  classDef pending fill:#fef3c7,stroke:#d97706,color:#78350f",
		"  classDef parked fill:#f3f4f6,stroke:#6b7280,color:#374151",
		"  classDef closed fill:#f3f4f6,stroke:#6b7280,color:#374151",
		"  classDef error fill:#fee2e2,stroke:#dc2626,stroke-width:2px,stroke-dasharray:5 5,color:#7f1d1d",
	);
	return `${lines.join("\n")}\n`;
}

function renderExperiment(lines: string[], parentNode: string, experiment: ExperimentView, orphan = false): number {
	const experimentNode = `exp_${experiment.index}`;
	const request = experiment.request;
	const execution = experiment.result?.execution;
	const markers = [
		fileMarker("request.json", experiment.files.request),
		fileMarker("result.json", experiment.files.result),
		fileMarker("stdout.txt", experiment.files.stdout),
		fileMarker("stderr.txt", experiment.files.stderr),
	];
	lines.push(
		`  ${experimentNode}["${label([
			`${escapeLabel(experiment.id, 40)} · ${escapeLabel(experiment.status, 40)}`,
			orphan ? `Missing hypothesis: ${escapeLabel(experiment.hypothesisId, 40)}` : undefined,
			`Sample: ${escapeLabel(experiment.sampleKind, 40)} · Risk: ${escapeLabel(request?.risk ?? "UNKNOWN", 40)}`,
			request?.command === undefined ? "Command: UNKNOWN" : `Command: ${escapeLabel(request.command, 160)}`,
			execution?.exitCode === undefined ? undefined : `Exit: ${escapeLabel(execution.exitCode, 30)}`,
			...markers,
		])}"]:::${orphan ? "error" : experimentClass(experiment)}`,
		`  ${parentNode} --> ${experimentNode}`,
	);
	const conclusion = experiment.result?.conclusion;
	if (!conclusion) return 1;
	const conclusionNode = `conclusion_${experiment.index}`;
	lines.push(
		`  ${conclusionNode}["${label([
			`${escapeLabel(conclusion.verdict ?? "UNKNOWN", 40)} · ${escapeLabel(conclusion.grade ?? "UNKNOWN", 40)}`,
			`Conclusion: ${escapeLabel(conclusion.conclusion)}`,
			`Next: ${escapeLabel(conclusion.nextAction)}`,
		])}"]:::${conclusionClass(conclusion.verdict)}`,
		`  ${experimentNode} --> ${conclusionNode}`,
	);
	return 2;
}

export async function generateRunMermaid(runsRoot: string, runId: string): Promise<MermaidGenerationResult> {
	const safeRunId = validateRunId(runId);
	const view = await loadRunView(runsRoot, safeRunId);
	const mermaid = renderRunMermaid(view);
	const outputPath = join(resolve(runsRoot, safeRunId), "run.mmd");
	await mkdir(resolve(runsRoot, safeRunId), { recursive: true });
	const temporary = `${outputPath}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
	await writeFile(temporary, mermaid, "utf8");
	await rename(temporary, outputPath);
	const nodes = 1 + view.hypotheses.length + view.hypotheses.reduce((count, item) => count + item.experiments.length, 0) + view.orphanExperiments.length +
		view.hypotheses.reduce((count, item) => count + item.experiments.filter((experiment) => experiment.result?.conclusion).length, 0) +
		view.orphanExperiments.filter((experiment) => experiment.result?.conclusion).length;
	return { outputPath, mermaid, warnings: view.warnings, nodes };
}
