import type { Edge, Node } from "@xyflow/react";
import type {
	FlowConclusion,
	FlowDocument,
	FlowExperiment,
	FlowHypothesis,
	FlowRun,
} from "../../run-visualization.ts";

export type FlowNodeData = {
	kind: "run" | "hypothesis" | "experiment" | "conclusion";
	item: FlowRun | FlowHypothesis | FlowExperiment | FlowConclusion;
	orphan?: boolean;
};

export type FlowGraph = {
	nodes: Array<Node<FlowNodeData>>;
	edges: Edge[];
};

const X_RUN = 40;
const X_HYPOTHESIS = 360;
const X_EXPERIMENT = 700;
const EXPERIMENT_STEP = 660;
const X_CONCLUSION_OFFSET = 330;
const LANE_STEP = 250;

export function buildGraph(document: FlowDocument): FlowGraph {
	const nodes: Array<Node<FlowNodeData>> = [];
	const edges: Edge[] = [];
	const laneCount = document.hypotheses.length + (document.orphanExperiments.length > 0 ? 1 : 0);
	const runY = Math.max(0, (Math.max(1, laneCount) - 1) * LANE_STEP / 2);

	nodes.push({
		id: "run_0",
		type: "flowCard",
		position: { x: X_RUN, y: runY },
		data: { kind: "run", item: document.run },
	});

	for (const [lane, hypothesis] of document.hypotheses.entries()) {
		const y = lane * LANE_STEP;
		const hypothesisId = `hyp_${hypothesis.index}`;
		nodes.push({
			id: hypothesisId,
			type: "flowCard",
			position: { x: X_HYPOTHESIS, y },
			data: { kind: "hypothesis", item: hypothesis },
		});
		edges.push(edge(`contains_${hypothesis.index}`, "run_0", hypothesisId, "contains"));
		for (const [position, experiment] of hypothesis.experiments.entries()) {
			appendExperiment(nodes, edges, hypothesisId, experiment, y, position, false);
		}
	}

	if (document.orphanExperiments.length > 0) {
		const y = document.hypotheses.length * LANE_STEP;
		for (const [position, experiment] of document.orphanExperiments.entries()) {
			appendExperiment(nodes, edges, "run_0", experiment, y, position, true);
		}
	}

	return { nodes, edges };
}

function appendExperiment(
	nodes: Array<Node<FlowNodeData>>,
	edges: Edge[],
	parentId: string,
	experiment: FlowExperiment,
	y: number,
	position: number,
	orphan: boolean,
): void {
	const experimentId = `exp_${experiment.index}`;
	const x = X_EXPERIMENT + position * EXPERIMENT_STEP;
	nodes.push({
		id: experimentId,
		type: "flowCard",
		position: { x, y },
		data: { kind: "experiment", item: experiment, orphan },
	});
	edges.push(edge(
		`${orphan ? "missing" : "tests"}_${experiment.index}`,
		parentId,
		experimentId,
		orphan ? "missing hypothesis" : "tests",
		orphan,
	));
	if (!experiment.conclusion) return;
	const conclusionId = `conclusion_${experiment.index}`;
	nodes.push({
		id: conclusionId,
		type: "flowCard",
		position: { x: x + X_CONCLUSION_OFFSET, y },
		data: { kind: "conclusion", item: experiment.conclusion },
	});
	edges.push(edge(`concludes_${experiment.index}`, experimentId, conclusionId, "concludes"));
}

function edge(id: string, source: string, target: string, label: string, error = false): Edge {
	return {
		id,
		source,
		target,
		label,
		className: error ? "edge-error" : undefined,
		style: error ? { stroke: "#dc2626", strokeDasharray: "6 4" } : undefined,
	};
}
