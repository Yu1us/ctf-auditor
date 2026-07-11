import assert from "node:assert/strict";
import type { FlowDocument } from "../.pi/extensions/ctf-auditor/run-visualization.ts";
import { buildGraph } from "../.pi/extensions/ctf-auditor/viewer/src/graph.ts";

const document: FlowDocument = {
	run: { id: "run", status: "ACTIVE", successCriterion: "win", workspace: "/tmp", variant: "active" },
	hypotheses: [{
		index: 0,
		id: "H0001",
		statement: "statement",
		falsificationTest: "test",
		status: "ACTIVE",
		consecutiveFailures: 0,
		variant: "active",
		experiments: [experiment(0, "E0001", true), experiment(1, "E0002", false)],
	}],
	orphanExperiments: [{ ...experiment(2, "E0003", false), hypothesisId: "missing", variant: "error" }],
	warnings: [],
};

function experiment(index: number, id: string, concluded: boolean) {
	return {
		index,
		id,
		hypothesisId: "H0001",
		sampleKind: "REAL",
		status: "CLOSED",
		variant: "closed" as const,
		files: {
			request: { state: "PRESENT" as const, href: `experiments/${id}/request.json` },
			result: { state: "PRESENT" as const, href: `experiments/${id}/result.json` },
			stdout: { state: "PRESENT" as const, href: `experiments/${id}/stdout.txt` },
			stderr: { state: "PRESENT" as const, href: `experiments/${id}/stderr.txt` },
		},
		conclusion: concluded ? {
			experimentId: id,
			verdict: "SUPPORTS",
			grade: "OBSERVED",
			conclusion: "yes",
			nextAction: "text only",
			variant: "supported" as const,
		} : undefined,
	};
}

const first = buildGraph(document);
const second = buildGraph(document);
assert.deepEqual(first, second);
assert.equal(new Set(first.nodes.map((node) => node.id)).size, first.nodes.length);
assert.equal(new Set(first.edges.map((edge) => edge.id)).size, first.edges.length);
assert.deepEqual(first.edges.map((edge) => edge.label), ["contains", "tests", "concludes", "tests", "missing hypothesis"]);
assert.equal(first.nodes.find((node) => node.id === "exp_2")?.data.item.variant, "error");
assert.notEqual(
	first.nodes.find((node) => node.id === "exp_0")?.position.x,
	first.nodes.find((node) => node.id === "exp_1")?.position.x,
);
assert.equal(first.nodes.some((node) => node.id.includes("next")), false);
console.log("ctf-auditor flow graph test: ok");
