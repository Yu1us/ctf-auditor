import { readFile, rename, stat, writeFile } from "node:fs/promises";
import { join, relative, resolve, sep } from "node:path";
import type { ExperimentRequest, State } from "./index.ts";

export type FileState = "PRESENT" | "MISSING" | "INVALID";
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

export type FlowVariant = "active" | "supported" | "refuted" | "pending" | "parked" | "closed" | "error";

export interface FlowFile {
	state: FileState;
	href: string;
}

export interface FlowConclusion {
	experimentId: string;
	verdict: string;
	grade: string;
	conclusion: string;
	nextAction: string;
	variant: FlowVariant;
}

export interface FlowExperiment {
	index: number;
	id: string;
	hypothesisId: string;
	sampleKind: string;
	status: string;
	variant: FlowVariant;
	request?: {
		command?: string;
		expectedSupports?: string;
		expectedRefutes?: string;
		risk?: string;
		timeoutSeconds?: number;
	};
	execution?: {
		exitCode?: string | number;
		killed?: boolean;
	};
	conclusion?: FlowConclusion;
	files: {
		request: FlowFile;
		result: FlowFile;
		stdout: FlowFile;
		stderr: FlowFile;
	};
}

export interface FlowHypothesis {
	index: number;
	id: string;
	statement: string;
	falsificationTest: string;
	status: string;
	consecutiveFailures: number;
	variant: FlowVariant;
	experiments: FlowExperiment[];
}

export interface FlowRun {
	id: string;
	successCriterion: string;
	workspace: string;
	status: string;
	variant: FlowVariant;
}

export interface FlowDocument {
	run: FlowRun;
	hypotheses: FlowHypothesis[];
	orphanExperiments: FlowExperiment[];
	warnings: string[];
}

export interface ViewerAssets {
	javascript: string;
	stylesheet: string;
}

export interface FlowGenerationResult {
	outputPath: string;
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

function runClass(status: string): FlowVariant {
	if (status === "COMPLETE") return "supported";
	if (status === "ABORTED") return "refuted";
	if (status === "REPLAN_REQUIRED") return "pending";
	return "active";
}

function hypothesisClass(status: string): FlowVariant {
	if (status === "SUPPORTED") return "supported";
	if (status === "REFUTED") return "refuted";
	if (status === "PARKED") return "parked";
	return "active";
}

function experimentClass(experiment: ExperimentView): FlowVariant {
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

function conclusionClass(verdict: unknown): FlowVariant {
	if (verdict === "SUPPORTS") return "supported";
	if (verdict === "REFUTES") return "refuted";
	return "pending";
}

function optionalText(value: unknown): string | undefined {
	return value === undefined || value === null ? undefined : String(value);
}

function flowFile(experimentId: string, name: string, state: FileState): FlowFile {
	return {
		state,
		href: `experiments/${encodeURIComponent(experimentId)}/${name}`,
	};
}

function buildFlowExperiment(experiment: ExperimentView): FlowExperiment {
	const request = experiment.request;
	const execution = experiment.result?.execution;
	const conclusion = experiment.result?.conclusion;
	return {
		index: experiment.index,
		id: experiment.id,
		hypothesisId: experiment.hypothesisId,
		sampleKind: experiment.sampleKind,
		status: experiment.status,
		variant: experimentClass(experiment),
		request: request ? {
			command: optionalText(request.command),
			expectedSupports: optionalText(request.expectedSupports),
			expectedRefutes: optionalText(request.expectedRefutes),
			risk: optionalText(request.risk),
			timeoutSeconds: typeof request.timeoutSeconds === "number" && Number.isFinite(request.timeoutSeconds)
				? request.timeoutSeconds
				: undefined,
		} : undefined,
		execution: execution ? {
			exitCode: typeof execution.exitCode === "number" || typeof execution.exitCode === "string" ? execution.exitCode : undefined,
			killed: typeof execution.killed === "boolean" ? execution.killed : undefined,
		} : undefined,
		conclusion: conclusion ? {
			experimentId: experiment.id,
			verdict: optionalText(conclusion.verdict) ?? "UNKNOWN",
			grade: optionalText(conclusion.grade) ?? "UNKNOWN",
			conclusion: optionalText(conclusion.conclusion) ?? "",
			nextAction: optionalText(conclusion.nextAction) ?? "",
			variant: conclusionClass(conclusion.verdict),
		} : undefined,
		files: {
			request: flowFile(experiment.id, "request.json", experiment.files.request),
			result: flowFile(experiment.id, "result.json", experiment.files.result),
			stdout: flowFile(experiment.id, "stdout.txt", experiment.files.stdout),
			stderr: flowFile(experiment.id, "stderr.txt", experiment.files.stderr),
		},
	};
}

export function buildFlowDocument(view: RunView): FlowDocument {
	return {
		run: {
			id: String(view.run.id),
			successCriterion: String(view.run.successCriterion),
			workspace: String(view.run.workspace),
			status: String(view.run.status),
			variant: runClass(view.run.status),
		},
		hypotheses: view.hypotheses.map((hypothesis) => ({
			index: hypothesis.index,
			id: hypothesis.id,
			statement: hypothesis.statement,
			falsificationTest: hypothesis.falsificationTest,
			status: hypothesis.status,
			consecutiveFailures: hypothesis.consecutiveFailures,
			variant: hypothesisClass(hypothesis.status),
			experiments: hypothesis.experiments.map(buildFlowExperiment),
		})),
		orphanExperiments: view.orphanExperiments.map((experiment) => ({
			...buildFlowExperiment(experiment),
			variant: "error",
		})),
		warnings: [...view.warnings],
	};
}

function safeInlineJson(value: unknown): string {
	return JSON.stringify(value)
		.replace(/&/g, "\\u0026")
		.replace(/</g, "\\u003c")
		.replace(/>/g, "\\u003e")
		.replace(/\u2028/g, "\\u2028")
		.replace(/\u2029/g, "\\u2029");
}

function escapeAttribute(value: string): string {
	return value.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export function renderRunFlowHtml(document: FlowDocument, assetUrls: ViewerAssets): string {
	return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>CTF Run ${escapeAttribute(document.run.id)}</title>
<link rel="stylesheet" href="${escapeAttribute(assetUrls.stylesheet)}">
</head>
<body>
<div id="root"></div>
<script>window.__CTF_RUN_FLOW__=${safeInlineJson(document)};<\/script>
<script src="${escapeAttribute(assetUrls.javascript)}"><\/script>
</body>
</html>
`;
}

function relativeUrl(from: string, to: string): string {
	return relative(from, to).split(sep).map((part) => part === ".." || part === "." ? part : encodeURIComponent(part)).join("/");
}

function countFlowNodes(document: FlowDocument): number {
	const experiments = document.hypotheses.flatMap((hypothesis) => hypothesis.experiments).concat(document.orphanExperiments);
	return 1 + document.hypotheses.length + experiments.length + experiments.filter((experiment) => experiment.conclusion).length;
}

export async function generateRunFlow(runsRoot: string, runId: string, viewerAssetsDir: string): Promise<FlowGenerationResult> {
	const safeRunId = validateRunId(runId);
	const assetsDir = resolve(viewerAssetsDir);
	const javascriptPath = join(assetsDir, "viewer.js");
	const stylesheetPath = join(assetsDir, "viewer.css");
	if (!(await fileExists(javascriptPath)) || !(await fileExists(stylesheetPath))) {
		throw new Error(`Flow viewer assets are missing in ${assetsDir}; run npm run build:viewer`);
	}
	const view = await loadRunView(runsRoot, safeRunId);
	const document = buildFlowDocument(view);
	const runDir = resolve(runsRoot, safeRunId);
	const html = renderRunFlowHtml(document, {
		javascript: relativeUrl(runDir, javascriptPath),
		stylesheet: relativeUrl(runDir, stylesheetPath),
	});
	const outputPath = join(runDir, "run.html");
	const temporary = `${outputPath}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
	await writeFile(temporary, html, "utf8");
	await rename(temporary, outputPath);
	return { outputPath, warnings: view.warnings, nodes: countFlowNodes(document) };
}

