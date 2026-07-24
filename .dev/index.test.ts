import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	AuditorStore,
	MACHINE_SECTIONS,
	RESUME_SECTIONS,
	validateHumanReview,
	validateMachine,
	validateResume,
	type ToolSource,
} from "../.pi/extensions/ctf-auditor/index.ts";

const machine = MACHINE_SECTIONS.map((heading, index) => {
	if (index === 2) return `# ${heading}\n\nF1. parser rejected the sample\n来源：[T0001]`;
	return `# ${heading}\n\n${index === 6 ? "重复动作：无" : "待确认"}`;
}).join("\n\n") + "\n";

const validHuman = `# 人类接管决定

Decision: REDIRECT
Machine-Summary-Reviewed: YES

## 对机器总结的纠正

F1 只说明当前实现失败。

## 选择的方向

优先检查长度字段。

## 下一项实验

发送最小 malformed packet。

## 明确停止的路线

停止修改 ROP chain。

## 约束和风险

不重置实例。

## 给下一位 agent 的补充说明

先复现失败阶段。
`;

const resume = RESUME_SECTIONS.map((heading) => `# ${heading}\n\n${heading} content`).join("\n\n") + "\n";

async function main(): Promise<void> {
	const workspace = await mkdtemp(join(tmpdir(), "ctf-auditor-test-"));
	const root = join(workspace, ".pi", "ctf-auditor");
	try {
		validateMachine(machine);
		assert.throws(() => validateMachine(machine.replace("来源：[T0001]", "")), /must include a source/);

		const untouched = validateHumanReview(validHuman.replace("REDIRECT", "TODO"));
		assert.equal(untouched.canResume, false);
		assert.match(untouched.errors.join("\n"), /Decision/);
		assert.match(validateHumanReview(validHuman.replace("Reviewed: YES", "Reviewed: NO")).errors.join("\n"), /must be YES/);
		assert.match(validateHumanReview(validHuman.replace("优先检查长度字段。", "")).errors.join("\n"), /选择的方向/);
		assert.equal(validateHumanReview(validHuman).canResume, true);
		assert.equal(validateHumanReview(validHuman.replace("REDIRECT", "PAUSE")).canResume, false);

		const store = new AuditorStore(root, workspace);
		await store.load();
		const id = await store.nextCheckpointId(new Date("2026-07-22T00:00:00Z"));
		assert.equal(id, "CP-20260722-001");
		const sources = new Map<string, ToolSource>([
			["T0001", {
				toolCallId: "bash-1",
				toolName: "bash",
				entryId: "entry-1",
				text: "parser rejected the sample\n",
				truncated: false,
			}],
			["T0002", {
				toolCallId: "bash-2",
				toolName: "bash",
				entryId: "entry-2",
				text: "uncited output\n",
				truncated: false,
			}],
		]);
		const checkpoint = await store.createCheckpoint({
			id,
			machine,
			sources,
			sourceSessionPath: "old-session.jsonl",
			sourceLeafId: "leaf-1",
		});
		assert.equal(checkpoint.status, "AWAITING_HUMAN");
		assert.match(await readFile(checkpoint.machinePath, "utf8"), /raw\/T0001\.txt/);
		await assert.rejects(() => readFile(join(root, id, "raw", "T0002.txt"), "utf8"), /ENOENT/);
		assert.equal(JSON.parse(await readFile(join(root, id, "manifest.json"), "utf8")).status, "AWAITING_HUMAN");
		assert.throws(() => store.getCheckpoint("../outside"), /Invalid checkpoint id/);

		const review = await store.reviewHuman(id, validHuman);
		assert.equal(review.canResume, true);
		assert.equal(store.getCheckpoint(id).status, "REVIEWED");

		validateResume(resume);
		await store.writeResume(id, resume);
		await store.markResumed(id, "new-session.jsonl");
		const reloaded = new AuditorStore(root, workspace);
		await reloaded.load();
		assert.equal(reloaded.getCheckpoint(id).status, "RESUMED");
		assert.equal(reloaded.getCheckpoint(id).resumedSessionPath, "new-session.jsonl");
		await reloaded.setStatus("COMPLETE");
		await reloaded.abortLatest();
		assert.equal(reloaded.state.status, "ABORTED");

		console.log("ctf-auditor test: ok");
	} finally {
		await rm(workspace, { recursive: true, force: true });
	}
}

main().catch((error) => {
	console.error(error);
	process.exitCode = 1;
});
