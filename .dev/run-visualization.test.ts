import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	buildFlowDocument,
	generateRunFlow,
	loadRunView,
	renderRunFlowHtml,
} from "../.pi/extensions/ctf-auditor/run-visualization.ts";

async function writeJson(path: string, value: unknown): Promise<void> {
	await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

async function main(): Promise<void> {
	const root = await mkdtemp(join(tmpdir(), "ctf-run-visualization-"));
	const runsRoot = join(root, ".pi", "ctf-runs");
	const runDir = join(runsRoot, "test-run");
	try {
		await mkdir(join(runDir, "experiments", "E0001"), { recursive: true });
		await mkdir(join(runDir, "experiments", "E0002"), { recursive: true });
		await mkdir(join(runDir, "experiments", "E0003"), { recursive: true });
		const state = {
			run: {
				id: "test-run",
				successCriterion: "找到中文 <flag> & 保留 \"证据\"",
				workspace: "C:\\ctf\\workspace",
				status: "ACTIVE",
			},
			hypotheses: [
				{
					id: "H0001",
					statement: "输入包含 | 和换行\n但图仍有效",
					falsificationTest: "probe",
					status: "SUPPORTED",
					consecutiveFailures: 0,
				},
			],
			experiments: [
				{ id: "E0001", hypothesisId: "H0001", sampleKind: "REAL", status: "CLOSED" },
				{ id: "E0002", hypothesisId: "H0001", sampleKind: "SYNTHETIC", status: "AWAITING_CONCLUSION" },
				{ id: "E0003", hypothesisId: "H9999", sampleKind: "REAL", status: "CLOSED" },
			],
			seq: 3,
		};
		await writeJson(join(runDir, "state.json"), state);
		await writeJson(join(runDir, "experiments", "E0001", "request.json"), {
			unknownRequestField: "must-not-be-inlined",
			hypothesisId: "H0001",
			command: "printf \"a|b\"",
			expectedSupports: "yes",
			expectedRefutes: "no",
			sampleKind: "REAL",
			risk: "LOW",
			timeoutSeconds: 5,
		});
		await writeJson(join(runDir, "experiments", "E0001", "result.json"), {
			unknownResultField: "must-not-be-inlined",
			execution: { command: "printf \"a|b\"", exitCode: 0, killed: false },
			conclusion: {
				experimentId: "E0001",
				verdict: "SUPPORTS",
				grade: "OBSERVED",
				conclusion: "观察成立",
				nextAction: "完成",
			},
		});
		await writeFile(join(runDir, "experiments", "E0001", "stdout.txt"), "ok\n", "utf8");
		await writeFile(join(runDir, "experiments", "E0001", "stderr.txt"), "", "utf8");
		await writeJson(join(runDir, "experiments", "E0002", "request.json"), {
			hypothesisId: "H0001",
			command: "x".repeat(220),
			sampleKind: "SYNTHETIC",
			risk: "LOW",
		});
		await writeFile(join(runDir, "experiments", "E0002", "stdout.txt"), "pending\n", "utf8");
		await writeFile(join(runDir, "experiments", "E0002", "stderr.txt"), "", "utf8");
		await writeFile(join(runDir, "experiments", "E0003", "request.json"), "{not json", "utf8");
		await writeJson(join(runDir, "experiments", "E0003", "result.json"), {
			execution: { exitCode: 1 },
			conclusion: { verdict: "REFUTES", grade: "OBSERVED", conclusion: "no", nextAction: "replan" },
		});

		const stateBefore = await readFile(join(runDir, "state.json"), "utf8");
		const requestBefore = await readFile(join(runDir, "experiments", "E0001", "request.json"), "utf8");
		const resultBefore = await readFile(join(runDir, "experiments", "E0001", "result.json"), "utf8");
		const view = await loadRunView(runsRoot, "test-run");
		assert.equal(view.hypotheses[0].experiments.length, 2);
		assert.equal(view.orphanExperiments.length, 1);
		assert.match(view.warnings.join("\n"), /E0003\/request.json is invalid JSON/);
		assert.match(view.warnings.join("\n"), /missing hypothesis H9999/);


		const flow = buildFlowDocument(view);
		assert.equal(flow.run.variant, "active");
		assert.equal(flow.hypotheses[0].variant, "supported");
		assert.equal(flow.hypotheses[0].experiments[0].conclusion?.variant, "supported");
		assert.equal(flow.orphanExperiments[0].variant, "error");
		assert.equal(flow.hypotheses[0].experiments[0].files.stdout.href, "experiments/E0001/stdout.txt");
		assert.doesNotMatch(JSON.stringify(flow), /must-not-be-inlined/);
		const flowHtml = renderRunFlowHtml(flow, { javascript: "../viewer/viewer.js", stylesheet: "../viewer/viewer.css" });
		assert.match(flowHtml, /window\.__CTF_RUN_FLOW__=/);
		assert.match(flowHtml, /"nextAction":"完成"/);
		assert.match(flowHtml, /\\u003cflag\\u003e/);
		assert.doesNotMatch(flowHtml, /<flag>/);

		const assetsDir = join(root, "extension assets", "dist");
		await mkdir(assetsDir, { recursive: true });
		await writeFile(join(assetsDir, "viewer.js"), "// viewer", "utf8");
		await writeFile(join(assetsDir, "viewer.css"), "/* viewer */", "utf8");
		const generatedFlow = await generateRunFlow(runsRoot, "test-run", assetsDir);
		assert.equal(generatedFlow.nodes, 7);
		const generatedHtml = await readFile(generatedFlow.outputPath, "utf8");
		assert.match(generatedHtml, /extension%20assets\/dist\/viewer\.js/);
		assert.equal(await readFile(join(runDir, "state.json"), "utf8"), stateBefore);
		assert.equal(await readFile(join(runDir, "experiments", "E0001", "request.json"), "utf8"), requestBefore);
		assert.equal(await readFile(join(runDir, "experiments", "E0001", "result.json"), "utf8"), resultBefore);
		await assert.rejects(() => loadRunView(runsRoot, "../outside"), /Invalid run id/);
		await assert.rejects(() => loadRunView(runsRoot, "C:\\outside"), /Invalid run id/);
		await assert.rejects(() => loadRunView(runsRoot, "missing-run"), /state.json is missing/);
		console.log("ctf-auditor run-visualization test: ok");
	} finally {
		await rm(root, { recursive: true, force: true });
	}
}

main().catch((error) => {
	console.error(error);
	process.exitCode = 1;
});
