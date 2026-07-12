const { spawn, spawnSync } = require("node:child_process");

const command = process.argv[2];
if (!command) {
	process.stderr.write("windows-command-runner: command is required\n");
	process.exit(2);
}

const comspec = process.env.ComSpec || "cmd.exe";
const codePageResult = spawnSync(comspec, ["/d", "/c", "chcp"], { windowsHide: true });
const codePage = /\b(\d{3,5})\b/.exec(codePageResult.stdout.toString("ascii"))?.[1] || "65001";
const encoding = {
	"65001": "utf-8",
	"936": "gbk",
	"950": "big5",
	"932": "shift_jis",
	"949": "euc-kr",
}[codePage] || "utf-8";

let stdoutDecoder;
let stderrDecoder;
try {
	stdoutDecoder = new TextDecoder(encoding);
	stderrDecoder = new TextDecoder(encoding);
} catch {
	stdoutDecoder = new TextDecoder("utf-8");
	stderrDecoder = new TextDecoder("utf-8");
}

const child = spawn(comspec, ["/d", "/s", "/c", command], {
	stdio: ["ignore", "pipe", "pipe"],
	windowsHide: true,
});

child.stdout.on("data", (chunk) => process.stdout.write(stdoutDecoder.decode(chunk, { stream: true })));
child.stderr.on("data", (chunk) => process.stderr.write(stderrDecoder.decode(chunk, { stream: true })));
child.on("error", (error) => {
	process.stderr.write(`${error.message}\n`);
	process.exitCode = 127;
});
child.on("close", (code) => {
	process.stdout.write(stdoutDecoder.decode());
	process.stderr.write(stderrDecoder.decode());
	process.exitCode = code ?? 1;
});

for (const signal of ["SIGINT", "SIGTERM"]) {
	process.on(signal, () => child.kill(signal));
}
