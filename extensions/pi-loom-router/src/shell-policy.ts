/**
 * Read-only shell policy for the loom router (P5b-ii of
 * extensions/pi-loom/DESIGN.md).
 *
 * P5b-i removed `bash` from the chat agent entirely, because pi.setActiveTools
 * addresses tool *names* and cannot express "this invocation is fine, that one
 * is not". The cost was real: a router that cannot run `git status` or
 * `rg -n foo src` makes its routing decisions blind. This module is the second
 * mechanism — a classifier over the command string, consulted from a
 * `tool_call` handler, which blocks the invocation instead of hiding the tool.
 *
 * **Guardrail, not a sandbox.** Every string-level shell classifier can be
 * beaten by an adversary who is willing to obfuscate; the answer to a hostile
 * model is not a better regex, it is the worktree isolation an exec stage
 * already provides. What this file buys is that a *cooperative* model cannot
 * casually mutate the user's checkout from the chat seat, and that when it
 * tries, the refusal names the workflow it should have used.
 *
 * The shape of the policy is therefore default-deny: an allowlist of command
 * names that cannot write, plus per-command argument rules for the handful of
 * allowlisted tools that grow a writing mode when you pass the wrong flag
 * (`sed -i`, `find -delete`, `sort -o`). Anything the parser does not fully
 * understand — command substitution, a heredoc, an output redirect to a real
 * path — is refused rather than guessed at.
 */

export type ShellVerdict =
	| { readonly allowed: true }
	| { readonly allowed: false; readonly reason: string };

/**
 * Every refusal ends with the same sentence, because a refusal that does not
 * say what to do instead just produces a second, sneakier attempt.
 */
const ROUTE_HINT =
	'Route the change instead: /quick "<one-line change>" for a single small edit, ' +
	'or /build "<task>" for anything larger — there a workflow sub-agent holds edit and write, ' +
	"a git worktree bounds the blast radius, and the reported diff is the one git recorded.";

function refuse(detail: string): ShellVerdict {
	return { allowed: false, reason: `${detail} ${ROUTE_HINT}` };
}

const ALLOWED: ShellVerdict = { allowed: true };

/**
 * Commands with no writing mode at all (or none reachable without a flag that
 * the argument rules below reject).
 *
 * Deliberately absent, and each for a reason worth keeping: `sh`/`bash`/`zsh`
 * and `node`/`python`/`perl`/`ruby` re-enter a language this parser does not
 * read; `xargs` and `command` run something else entirely; `tee`, `dd` and
 * `truncate` write by design; `curl`/`wget` fetch code and can save it; the
 * package and build drivers (`npm`, `cargo`, `make`, `nix-build`) all produce
 * artifacts in the tree.
 */
const READ_ONLY_COMMANDS: ReadonlySet<string> = new Set([
	// listing and inspection
	"ls",
	"dir",
	"vdir",
	"tree",
	"stat",
	"file",
	"du",
	"df",
	"realpath",
	"readlink",
	"basename",
	"dirname",
	"pwd",
	"cd",
	// content
	"cat",
	"tac",
	"head",
	"tail",
	"nl",
	"wc",
	"xxd",
	"od",
	"strings",
	"base64",
	"md5sum",
	"sha1sum",
	"sha256sum",
	"cksum",
	// search
	"grep",
	"egrep",
	"fgrep",
	"rg",
	"ag",
	"ack",
	"find",
	"fd",
	// text shaping
	"sort",
	"uniq",
	"cut",
	"tr",
	"fold",
	"column",
	"paste",
	"join",
	"comm",
	"diff",
	"cmp",
	"sed",
	"awk",
	"gawk",
	"mawk",
	"jq",
	"yq",
	// environment and trivia
	"echo",
	"printf",
	"seq",
	"date",
	"uname",
	"hostname",
	"whoami",
	"id",
	"env",
	"printenv",
	"which",
	"true",
	"false",
	"sleep",
	"ps",
	"free",
	"uptime",
	"man",
	// version control and nix, both narrowed by subcommand below
	"git",
	"nix",
]);

/** Refused by name so the reason can say *why*, rather than "not allowlisted". */
const PRIVILEGE_ESCALATORS: ReadonlySet<string> = new Set(["sudo", "doas", "su", "pkexec"]);

/**
 * git subcommands that only read. `branch`, `tag`, `remote`, `config` and
 * `stash` are absent on purpose: each has a read form and a write form
 * separated by one flag, and `for-each-ref` / `rev-parse` cover the read cases
 * unambiguously.
 */
const GIT_READ_ONLY_SUBCOMMANDS: ReadonlySet<string> = new Set([
	"status",
	"log",
	"diff",
	"show",
	"blame",
	"shortlog",
	"whatchanged",
	"grep",
	"ls-files",
	"ls-tree",
	"ls-remote",
	"cat-file",
	"rev-parse",
	"rev-list",
	"describe",
	"name-rev",
	"merge-base",
	"diff-tree",
	"diff-index",
	"for-each-ref",
	"count-objects",
	"symbolic-ref",
	"var",
	"version",
]);

/**
 * nix invocations that produce no store path and no `./result` symlink.
 * `nix build` is the instructive exclusion: it writes a symlink into the
 * working tree, which is exactly the mutation this policy exists to stop.
 */
const NIX_READ_ONLY_INVOCATIONS: readonly (readonly string[])[] = [
	["eval"],
	["search"],
	["path-info"],
	["why-depends"],
	["show-config"],
	["config", "show"],
	["flake", "show"],
	["flake", "metadata"],
	["flake", "info"],
	["derivation", "show"],
	["store", "ls"],
	["store", "cat"],
	["store", "info"],
];

/** Flags that turn an otherwise read-only tool into a writing one. */
const MUTATING_FLAGS: Readonly<Record<string, readonly string[]>> = {
	find: ["-delete", "-exec", "-execdir", "-ok", "-okdir", "-fprint", "-fprintf", "-fls"],
	fd: ["-x", "--exec", "-X", "--exec-batch"],
	sort: ["-o", "--output"],
	jq: ["--rawfile-write"],
};

interface Segment {
	readonly words: readonly string[];
}

type ScanResult =
	| { readonly ok: true; readonly segments: readonly Segment[] }
	| { readonly ok: false; readonly construct: string };

function isFileDescriptor(word: string): boolean {
	return word.length > 0 && /^[0-9]+$/.test(word);
}

/**
 * Split a command line into segments of plain words, refusing every construct
 * whose effect cannot be read off the words themselves.
 *
 * Quoting is honoured so that `grep '>' file` is a search and not a redirect,
 * and so that `echo "rm -rf /"` is an echo. Command substitution is refused
 * rather than recursed into: the inner command would need the same treatment,
 * and refusing keeps the rule one sentence long.
 */
function scan(command: string): ScanResult {
	const segments: Segment[] = [];
	let words: string[] = [];
	let current = "";
	let hasCurrent = false;

	const endWord = (): void => {
		if (hasCurrent) {
			words.push(current);
			current = "";
			hasCurrent = false;
		}
	};
	const endSegment = (): void => {
		endWord();
		if (words.length > 0) {
			segments.push({ words });
			words = [];
		}
	};

	for (let i = 0; i < command.length; i++) {
		const ch = command[i] as string;
		const next = command[i + 1];

		if (ch === "\\") {
			if (next !== undefined) {
				current += next;
				hasCurrent = true;
				i++;
			}
			continue;
		}

		if (ch === "'") {
			const close = command.indexOf("'", i + 1);
			if (close === -1) return { ok: false, construct: "an unterminated single quote" };
			current += command.slice(i + 1, close);
			hasCurrent = true;
			i = close;
			continue;
		}

		if (ch === '"') {
			let j = i + 1;
			let closed = false;
			while (j < command.length) {
				const c = command[j] as string;
				if (c === "\\") {
					const escaped = command[j + 1];
					if (escaped !== undefined) {
						current += escaped;
						hasCurrent = true;
						j += 2;
						continue;
					}
				}
				if (c === '"') {
					closed = true;
					break;
				}
				if (c === "$" && command[j + 1] === "(") return { ok: false, construct: "command substitution" };
				if (c === "`") return { ok: false, construct: "a backtick command substitution" };
				current += c;
				hasCurrent = true;
				j++;
			}
			if (!closed) return { ok: false, construct: "an unterminated double quote" };
			hasCurrent = true;
			i = j;
			continue;
		}

		if (ch === "`") return { ok: false, construct: "a backtick command substitution" };
		if (ch === "$" && next === "(") return { ok: false, construct: "command substitution" };
		if ((ch === "<" || ch === ">") && next === "(") return { ok: false, construct: "process substitution" };
		if (ch === "<" && next === "<") return { ok: false, construct: "a heredoc" };

		if (ch === ">" || ch === "<") {
			// A leading file descriptor (the `2` of `2>&1`) is part of the
			// redirection, not a word of the command.
			if (hasCurrent && isFileDescriptor(current)) {
				current = "";
				hasCurrent = false;
			}
			endWord();

			let op = ch;
			let k = i + 1;
			while (k < command.length && (command[k] === ">" || command[k] === "|")) {
				op += command[k] as string;
				k++;
			}

			// `>&1` / `2>&1` duplicate an existing descriptor and write nothing new.
			if (command[k] === "&") {
				k++;
				while (k < command.length && /[0-9-]/.test(command[k] as string)) k++;
				i = k - 1;
				continue;
			}

			while (k < command.length && (command[k] === " " || command[k] === "\t")) k++;
			let target = "";
			while (k < command.length && !/[\s;&|<>]/.test(command[k] as string)) {
				const c = command[k] as string;
				if (c !== '"' && c !== "'") target += c;
				k++;
			}
			i = k - 1;

			if (op.startsWith("<")) continue; // reading a file is fine
			if (target === "/dev/null") continue;
			return {
				ok: false,
				construct: target === "" ? "an output redirect" : `an output redirect to ${target}`,
			};
		}

		if (ch === ";" || ch === "&" || ch === "|" || ch === "\n" || ch === "(" || ch === ")") {
			endSegment();
			continue;
		}

		if (ch === " " || ch === "\t" || ch === "\r") {
			endWord();
			continue;
		}

		current += ch;
		hasCurrent = true;
	}

	endSegment();
	return { ok: true, segments };
}

function commandName(word: string): string {
	const slash = word.lastIndexOf("/");
	return slash === -1 ? word : word.slice(slash + 1);
}

/** Skip git's global flags (`-C dir`, `-c k=v`, `--no-pager`) to the subcommand. */
function classifyGit(rest: readonly string[]): ShellVerdict {
	let i = 0;
	while (i < rest.length) {
		const arg = rest[i] as string;
		if (arg === "-C" || arg === "-c") {
			i += 2;
			continue;
		}
		if (arg.startsWith("-")) {
			i += 1;
			continue;
		}
		break;
	}
	const sub = rest[i];
	if (sub === undefined) return ALLOWED;
	if (!GIT_READ_ONLY_SUBCOMMANDS.has(sub)) {
		return refuse(`Blocked 'git ${sub}': only read-only git subcommands run from loom's chat agent.`);
	}
	return ALLOWED;
}

function classifyNix(rest: readonly string[]): ShellVerdict {
	const positional = rest.filter((arg) => !arg.startsWith("-"));
	if (positional.length === 0) return ALLOWED;
	const matched = NIX_READ_ONLY_INVOCATIONS.some((invocation) =>
		invocation.every((word, index) => positional[index] === word),
	);
	if (!matched) {
		return refuse(
			`Blocked 'nix ${positional.slice(0, 2).join(" ")}': it can write a store path or a ./result symlink, so it belongs in a workflow.`,
		);
	}
	return ALLOWED;
}

function classifySegment(words: readonly string[]): ShellVerdict {
	const args = [...words];

	// `FOO=bar cmd` and `env FOO=bar cmd` are prefixes, not the command.
	while (args.length > 0) {
		const head = args[0] as string;
		if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(head)) {
			args.shift();
			continue;
		}
		if (head === "env" && args.length > 1 && !(args[1] as string).startsWith("-")) {
			args.shift();
			continue;
		}
		break;
	}
	if (args.length === 0) return ALLOWED;

	const head = commandName(args[0] as string);
	const rest = args.slice(1);

	if (PRIVILEGE_ESCALATORS.has(head)) {
		return refuse(`Blocked '${head}': loom's chat agent never runs privileged commands.`);
	}
	if (!READ_ONLY_COMMANDS.has(head)) {
		return refuse(`Blocked '${head}': it is not on the router shell's read-only allowlist, so it may change the working tree.`);
	}

	const forbidden = MUTATING_FLAGS[head];
	if (forbidden) {
		const offending = rest.find((arg) => forbidden.includes(arg));
		if (offending !== undefined) {
			return refuse(`Blocked '${head} ${offending}': that flag makes ${head} write.`);
		}
	}

	// sed's in-place flag takes an optional suffix (`-i.bak`), so it is a prefix match.
	if (head === "sed") {
		const inPlace = rest.find((arg) => arg === "--in-place" || (arg.startsWith("-i") && !arg.startsWith("--")));
		if (inPlace !== undefined) {
			return refuse(`Blocked 'sed ${inPlace}': in-place editing rewrites files.`);
		}
	}

	// awk can redirect from inside its program text, where the scanner above
	// cannot see it because the program is quoted.
	if (head === "awk" || head === "gawk" || head === "mawk") {
		const writing = rest.find((arg) => arg.includes(">") || arg.includes("system("));
		if (writing !== undefined) {
			return refuse(`Blocked '${head}': its program text can redirect or shell out, which this policy cannot verify.`);
		}
	}

	if (head === "git") return classifyGit(rest);
	if (head === "nix") return classifyNix(rest);

	return ALLOWED;
}

/**
 * Decide whether one `bash` tool call may run in loom's chat session.
 *
 * Returns `{ allowed: true }` or a refusal whose `reason` names both the
 * offending command and the workflow to route the change through.
 */
export function classifyShellCommand(command: string): ShellVerdict {
	const trimmed = command.trim();
	if (trimmed === "") return ALLOWED;

	const scanned = scan(trimmed);
	if (!scanned.ok) {
		return refuse(`Blocked: the command contains ${scanned.construct}, which the router shell cannot verify as read-only.`);
	}

	for (const segment of scanned.segments) {
		const verdict = classifySegment(segment.words);
		if (!verdict.allowed) return verdict;
	}
	return ALLOWED;
}
