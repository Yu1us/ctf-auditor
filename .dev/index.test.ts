import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { CtfAuditor, type ExperimentRequest } from "../.pi/extensions/ctf-auditor/index.ts";

const fakeExecutor = async (command: string) => ({
	stdout: `output:${command}\n`,
	stderr: "",
	code: 0,
	killed: false,
});

const request = (hypothesisId: string, overrides: Partial<ExperimentRequest> = {}): ExperimentRequest => ({
	hypothesisId,
	command: "local-probe",
	expectedSupports: "probe emits expected marker",
	expectedRefutes: "probe does not emit expected marker",
	sampleKind: "REAL",
	risk: "LOW",
	timeoutSeconds: 5,
	...overrides,
});

async function rejects(action: () => Promise<unknown>, pattern: RegExp): Promise<void> {
	await assert.rejects(action, pattern);
}

async function main(): Promise<void> {
	const workspace = await mkdtemp(join(tmpdir(), "ctf-auditor-test-"));
	const runsRoot = join(workspace, ".pi", "ctf-runs");
	try {
		const auditor = new CtfAuditor(runsRoot, fakeExecutor);

		await rejects(() => auditor.experiment(request("H0001")), /not initialized/);
		await auditor.init("recover the challenge flag", workspace, "test-run");
		const h1 = await auditor.addHypothesis("input is decoded once", "a double-encoded sample must fail");
		const h2 = await auditor.addHypothesis("parser accepts a short header", "a minimal real header is rejected");
		const h3 = await auditor.addHypothesis("deep search is required", "a shallow probe finds the target");
		await rejects(() => auditor.addHypothesis("fourth", "must fail"), /At most 3/);

		const first = await auditor.experiment(request(h1, { sampleKind: "SYNTHETIC" }));
		await rejects(() => auditor.experiment(request(h1)), /Conclude the previous/);
		const trace = await auditor.trace({ command: "list-files", purpose: "locate challenge files", timeoutSeconds: 5 });
		assert.equal(trace.traceId, "T0001");
		assert.match(trace.summary, /output:list-files/);
		assert.equal(auditor.state?.hypotheses.find((item) => item.id === h1)?.consecutiveFailures, 0);
		await rejects(
			() => auditor.trace({ command: "curl https://target.invalid", purpose: "probe target", timeoutSeconds: 5 }),
			/use ctf_experiment/,
		);
		await rejects(
			() => auditor.conclude({
				experimentId: first.experimentId,
				verdict: "INCONCLUSIVE",
				grade: "OBSERVED",
				conclusion: "generated fixture only",
				nextAction: "probe a real sample",
			}),
			/Synthetic experiments cannot produce OBSERVED/,
		);
		await auditor.conclude({
			experimentId: first.experimentId,
			verdict: "INCONCLUSIVE",
			grade: "DERIVED",
			conclusion: "generated fixture only",
			nextAction: "probe a real sample",
		});

		const second = await auditor.experiment(request(h1));
		await auditor.conclude({
			experimentId: second.experimentId,
			verdict: "INCONCLUSIVE",
			grade: "OBSERVED",
			conclusion: "real output does not distinguish the cases",
			nextAction: "replan the hypothesis",
		});
		assert.equal(auditor.state?.run.status, "REPLAN_REQUIRED");
		await rejects(() => auditor.experiment(request(h2)), /REPLAN_REQUIRED/);
		await auditor.replan();

		const low = await auditor.experiment(request(h2));
		assert.match(low.summary, /output:local-probe/);
		await auditor.conclude({
			experimentId: low.experimentId,
			verdict: "SUPPORTS",
			grade: "OBSERVED",
			conclusion: "the local real probe matched",
			nextAction: "test the remaining hypothesis",
		});

		const highWithoutApproval = await auditor.experiment(request(h3, { risk: "HIGH" }));
		await auditor.conclude({
			experimentId: highWithoutApproval.experimentId,
			verdict: "INCONCLUSIVE",
			grade: "OBSERVED",
			conclusion: "high-risk probe did not require approval",
			nextAction: "request approval for the irreversible probe",
		});
		await rejects(() => auditor.experiment(request(h3, { risk: "IRREVERSIBLE" })), /requires approval/);

		let approvals = 0;
		const approved = new CtfAuditor(runsRoot, fakeExecutor, async () => {
			approvals += 1;
			return true;
		});
		await approved.load();
		const high = await approved.experiment(request(h3, { command: "scan ../outside", risk: "IRREVERSIBLE" }));
		assert.equal(approvals, 1);
		await approved.conclude({
			experimentId: high.experimentId,
			verdict: "SUPPORTS",
			grade: "OBSERVED",
			conclusion: "approved real search found the marker",
			nextAction: "request human completion confirmation",
		});

		const resumed = new CtfAuditor(runsRoot, fakeExecutor);
		await resumed.load();
		assert.equal(resumed.state?.run.id, "test-run");
		assert.equal(resumed.state?.experiments.length, 5);
		assert.equal(resumed.state?.traces.length, 1);
		assert.equal(resumed.state?.traces[0].status, "CLOSED");
		assert.equal(resumed.state?.experiments.every((item) => item.status === "CLOSED"), true);
		assert.match(await resumed.statusText(), /request human completion confirmation/);

		const traceStdout = await readFile(join(runsRoot, "test-run", "traces", trace.traceId, "stdout.txt"), "utf8");
		assert.equal(traceStdout, "output:list-files\n");
		const stdout = await readFile(join(runsRoot, "test-run", "experiments", low.experimentId, "stdout.txt"), "utf8");
		const result = JSON.parse(await readFile(join(runsRoot, "test-run", "experiments", low.experimentId, "result.json"), "utf8"));
		assert.equal(stdout, "output:local-probe\n");
		assert.equal(result.execution.exitCode, 0);
		assert.equal(result.conclusion.verdict, "SUPPORTS");
		console.log("ctf-auditor state-machine test: ok");
	} finally {
		await rm(workspace, { recursive: true, force: true });
	}
}

main().catch((error) => {
	console.error(error);
	process.exitCode = 1;
});
