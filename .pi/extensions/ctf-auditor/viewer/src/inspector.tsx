import React from "react";
import type { FlowConclusion, FlowExperiment, FlowHypothesis, FlowRun } from "../../run-visualization.ts";
import type { FlowNodeData } from "./graph.ts";

export function Inspector({ data, warnings }: { data?: FlowNodeData; warnings: string[] }): React.JSX.Element {
	if (!data) return <aside className="inspector"><h2>Details</h2><p className="muted">Select a node to inspect its complete fields.</p></aside>;
	return <aside className="inspector"><h2>{heading(data)}</h2>{details(data, warnings)}</aside>;
}

function heading(data: FlowNodeData): string {
	if (data.kind === "run") return `Run ${(data.item as FlowRun).id}`;
	if (data.kind === "hypothesis") return `Hypothesis ${(data.item as FlowHypothesis).id}`;
	if (data.kind === "experiment") return `Experiment ${(data.item as FlowExperiment).id}`;
	return "Conclusion";
}

function details(data: FlowNodeData, warnings: string[]): React.JSX.Element {
	if (data.kind === "run") {
		const run = data.item as FlowRun;
		return <>
			<Detail label="Status" value={run.status} />
			<Detail label="Success criterion" value={run.successCriterion} />
			<Detail label="Workspace" value={run.workspace} />
			<h3>Warnings</h3>
			{warnings.length ? <ul>{warnings.map((warning, index) => <li key={index}>{warning}</li>)}</ul> : <p className="muted">None</p>}
		</>;
	}
	if (data.kind === "hypothesis") {
		const hypothesis = data.item as FlowHypothesis;
		return <>
			<Detail label="Status" value={hypothesis.status} />
			<Detail label="Statement" value={hypothesis.statement} />
			<Detail label="Falsification test" value={hypothesis.falsificationTest} />
			<Detail label="Consecutive failures" value={hypothesis.consecutiveFailures} />
			<Detail label="Experiments" value={hypothesis.experiments.map((item) => item.id).join(", ") || "None"} />
		</>;
	}
	if (data.kind === "experiment") {
		const experiment = data.item as FlowExperiment;
		return <>
			<Detail label="Status" value={experiment.status} />
			<Detail label="Hypothesis" value={experiment.hypothesisId} />
			<Detail label="Sample kind" value={experiment.sampleKind} />
			<Detail label="Risk" value={experiment.request?.risk} />
			<Detail label="Command" value={experiment.request?.command} code />
			<Detail label="Expected supports" value={experiment.request?.expectedSupports} />
			<Detail label="Expected refutes" value={experiment.request?.expectedRefutes} />
			<Detail label="Timeout" value={experiment.request?.timeoutSeconds === undefined ? undefined : `${experiment.request.timeoutSeconds}s`} />
			<Detail label="Exit code" value={experiment.execution?.exitCode} />
			<Detail label="Killed" value={experiment.execution?.killed} />
			<h3>Evidence files</h3>
			<ul className="files">{Object.entries(experiment.files).map(([name, file]) => <li key={name}><span>{name}: {file.state}</span>{file.state === "PRESENT" && <a href={file.href}>open</a>}</li>)}</ul>
		</>;
	}
	const conclusion = data.item as FlowConclusion;
	return <>
		<Detail label="Source experiment" value={conclusion.experimentId} />
		<Detail label="Verdict" value={conclusion.verdict} />
		<Detail label="Grade" value={conclusion.grade} />
		<Detail label="Conclusion" value={conclusion.conclusion} />
		<Detail label="下一步（文本）" value={conclusion.nextAction} />
	</>;
}

function Detail({ label, value, code = false }: { label: string; value: unknown; code?: boolean }): React.JSX.Element {
	const text = value === undefined || value === "" ? "UNKNOWN" : String(value);
	return <section className="detail"><h3>{label}</h3>{code ? <pre>{text}</pre> : <p>{text}</p>}</section>;
}
