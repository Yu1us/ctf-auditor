import React from "react";
import { Handle, Position, type NodeProps } from "@xyflow/react";
import type { FlowConclusion, FlowExperiment, FlowHypothesis, FlowRun } from "../../run-visualization.ts";
import type { FlowNodeData } from "./graph.ts";

export function FlowCard({ data, selected }: NodeProps & { data: FlowNodeData }): React.JSX.Element {
	return (
		<article className={`flow-card variant-${data.item.variant}${selected ? " selected" : ""}`}>
			<Handle type="target" position={Position.Left} />
			<header>
				<strong>{title(data)}</strong>
				<span>{status(data)}</span>
			</header>
			<div className="card-body">{content(data)}</div>
			<Handle type="source" position={Position.Right} />
		</article>
	);
}

function title(data: FlowNodeData): string {
	if (data.kind === "run") return `Run ${(data.item as FlowRun).id}`;
	if (data.kind === "hypothesis") return (data.item as FlowHypothesis).id;
	if (data.kind === "experiment") return (data.item as FlowExperiment).id;
	return `Conclusion ${(data.item as FlowConclusion).experimentId}`;
}

function status(data: FlowNodeData): string {
	if (data.kind === "conclusion") return (data.item as FlowConclusion).verdict;
	return (data.item as FlowRun | FlowHypothesis | FlowExperiment).status;
}

function content(data: FlowNodeData): React.JSX.Element {
	if (data.kind === "run") {
		const run = data.item as FlowRun;
		return <><Field label="Success" value={run.successCriterion} clamp /><Field label="Workspace" value={run.workspace} clamp /></>;
	}
	if (data.kind === "hypothesis") {
		const hypothesis = data.item as FlowHypothesis;
		return <><Field label="Statement" value={hypothesis.statement} clamp /><Field label="Failures" value={hypothesis.consecutiveFailures} /></>;
	}
	if (data.kind === "experiment") {
		const experiment = data.item as FlowExperiment;
		return <>
			{data.orphan && <Field label="Missing hypothesis" value={experiment.hypothesisId} />}
			<Field label="Sample" value={experiment.sampleKind} />
			<Field label="Risk" value={experiment.request?.risk ?? "UNKNOWN"} />
			<Field label="Command" value={experiment.request?.command ?? "UNKNOWN"} clamp />
			{experiment.execution?.exitCode !== undefined && <Field label="Exit" value={experiment.execution.exitCode} />}
		</>;
	}
	const conclusion = data.item as FlowConclusion;
	return <><Field label="Grade" value={conclusion.grade} /><Field label="Conclusion" value={conclusion.conclusion} clamp /><Field label="下一步（文本）" value={conclusion.nextAction} clamp /></>;
}

function Field({ label, value, clamp = false }: { label: string; value: unknown; clamp?: boolean }): React.JSX.Element {
	return <div className="field"><b>{label}</b><span className={clamp ? "clamp" : undefined}>{String(value)}</span></div>;
}
