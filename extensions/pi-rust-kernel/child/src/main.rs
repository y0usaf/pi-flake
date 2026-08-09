// pi-rust-kernel child — persistent Rust evaluation kernel.
//
// Speaks NDJSON over stdio, one JSON object per line in/out. stderr is
// reserved for diagnostics only — never protocol traffic.
//
// Host -> child:
//   {"type":"eval","id","code"}                  evaluate in the persistent context
//
// Child -> host:
//   {"type":"result","id","ok","stdout","stderr","result"?,"error"?}
//
// State (variables, functions, types) persists across eval requests because
// evcxr::EvalContext keeps the accumulated program and recompiles only what
// changed. The context is created once at startup and held for process life.
//
// Design notes:
//  - evcxr::EvalContext re-spawns the current executable as a subprocess and
//    compiles/executes user code there. The re-spawned process needs a full
//    Rust toolchain (rustc, cargo, gcc, mold) on PATH plus RUST_SRC_PATH set
//    — the Nix derivation wraps the binary with those, mirroring nixpkgs'
//    evcxr package.
//  - evcxr routes user println!/panic output to crossbeam channels
//    (EvalContextOutputs.stdout/stderr). eval BLOCKS until the sender is
//    drained, so a background thread must be draining the channels
//    continuously — otherwise a println! deadlocks eval. The drained bytes
//    accumulate in a shared buffer; we snapshot it after each eval returns.
//  - The last expression's value surfaces as EvalOutputs{"text/plain"}; a
//    statement (let/...) yields None. Mirrors the JS kernel's result field.
//  - A kernel_bash helper is pre-compiled into the context at startup so user
//    code can run shell commands child-side (mirrors js-kernel's kernel.bash).
//    The startup compile is slow (~tens of seconds); it is paid once so
//    subsequent user evals reuse the warm context.
//  - No host-bridge (read/edit/rlm) in this version: evcxr evaluates user code
//    synchronously in a subprocess, so mid-eval host callbacks are not
//    possible. That is a deferred phase (see DESIGN.md).
use std::io::{BufRead, Write};
use std::sync::{Arc, Mutex};

use evcxr::EvalContext;
use serde::{Deserialize, Serialize};

const MAX_OUTPUT: usize = 65536;
const TRUNC_SUFFIX: &str = "\n[... output truncated by pi-rust-kernel ...]";

// ---------------------------------------------------------------------------
// Wire protocol
// ---------------------------------------------------------------------------

#[derive(Deserialize)]
struct Request {
    #[serde(rename = "type")]
    kind: Option<String>,
    id: Option<serde_json::Value>,
    code: Option<String>,
}

#[derive(Serialize)]
struct ResultResponse {
    #[serde(rename = "type")]
    kind: &'static str,
    id: serde_json::Value,
    ok: bool,
    stdout: String,
    stderr: String,
    result: Option<String>,
    error: Option<ErrorInfo>,
}

#[derive(Serialize)]
struct ErrorInfo {
    name: String,
    message: String,
    stack: String,
}

// ---------------------------------------------------------------------------
// Output capture: a background thread drains evcxr's channels continuously so
// eval never blocks on a full sender. The bytes accumulate in a shared buffer;
// we snapshot-and-clear it after each eval.
// ---------------------------------------------------------------------------

#[derive(Default)]
struct OutputBuffer {
    stdout: String,
    stderr: String,
}

type SharedOutput = Arc<(Mutex<OutputBuffer>, crossbeam_channel::Receiver<String>, crossbeam_channel::Receiver<String>)>;

fn spawn_output_drainer(outputs: evcxr::EvalContextOutputs) -> SharedOutput {
    let buf = Arc::new((
        Mutex::new(OutputBuffer::default()),
        outputs.stdout,
        outputs.stderr,
    ));
    // stdout drainer
    {
        let buf2 = Arc::clone(&buf);
        let rx = buf.1.clone();
        std::thread::spawn(move || {
            for line in rx.iter() {
                let mut b = buf2.0.lock().unwrap();
                b.stdout.push_str(&line);
                b.stdout.push('\n');
            }
        });
    }
    // stderr drainer
    {
        let buf2 = Arc::clone(&buf);
        let rx = buf.2.clone();
        std::thread::spawn(move || {
            for line in rx.iter() {
                let mut b = buf2.0.lock().unwrap();
                b.stderr.push_str(&line);
                b.stderr.push('\n');
            }
        });
    }
    buf
}

fn snapshot_output(
    shared: &SharedOutput,
) -> (String, String) {
    let mut b = shared.0.lock().unwrap();
    let out = std::mem::take(&mut b.stdout);
    let err = std::mem::take(&mut b.stderr);
    (out, err)
}

fn truncate(mut s: String) -> String {
    if s.len() > MAX_OUTPUT {
        s.truncate(MAX_OUTPUT);
        s.push_str(TRUNC_SUFFIX);
    }
    s
}

// ---------------------------------------------------------------------------
// Kernel helpers injected into the persistent context
// ---------------------------------------------------------------------------

/// Rust source for the child-side shell helper. Pre-evaluated at startup so
/// user code can call `kernel_bash("...") -> String` (stdout of the command).
const KERNEL_BASH_SOURCE: &str = r#"
fn kernel_bash(cmd: &str) -> String {
    let out = std::process::Command::new("sh")
        .arg("-c")
        .arg(cmd)
        .output()
        .expect("kernel_bash: failed to spawn sh");
    String::from_utf8_lossy(&out.stdout).to_string()
}
"#;

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

fn main() {
    // Must be called before EvalContext::new() or the library fork-bombs.
    evcxr::runtime_hook();

    let stdin = std::io::stdin();
    let mut stdin = stdin.lock();
    let stdout = std::io::stdout();
    let mut stdout = stdout.lock();

    // Create the persistent context. This is the slow, one-time startup cost.
    let (mut context, outputs) = match EvalContext::new() {
        Ok(pair) => pair,
        Err(e) => {
            eprintln!("[pi-rust-kernel] failed to create evcxr context: {e}");
            std::process::exit(1);
        }
    };

    // Continuously drain evcxr's output channels so eval never deadlocks.
    let shared_output = spawn_output_drainer(outputs);

    // Pre-compile the kernel_bash helper into the context so user evals are
    // warm from the first call. If this fails the kernel is still usable.
    if let Err(e) = context.eval(KERNEL_BASH_SOURCE) {
        eprintln!("[pi-rust-kernel] failed to pre-eval kernel_bash: {e}");
    }

    // Read one JSON request per line from stdin.
    let mut line = String::new();
    loop {
        line.clear();
        match stdin.read_line(&mut line) {
            Ok(0) => break, // EOF — host closed stdin
            Ok(_) => {}
            Err(e) => {
                eprintln!("[pi-rust-kernel] stdin read error: {e}");
                break;
            }
        }
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }

        let request: Request = match serde_json::from_str(trimmed) {
            Ok(r) => r,
            Err(e) => {
                let resp = ResultResponse {
                    kind: "result",
                    id: serde_json::Value::Null,
                    ok: false,
                    stdout: String::new(),
                    stderr: String::new(),
                    result: None,
                    error: Some(ErrorInfo {
                        name: "MalformedRequest".into(),
                        message: format!("Malformed request: {e}"),
                        stack: String::new(),
                    }),
                };
                let _ = writeln!(stdout, "{}", serde_json::to_string(&resp).unwrap());
                let _ = stdout.flush();
                continue;
            }
        };

        // Only eval requests are handled in this version.
        if request.kind.as_deref().unwrap_or("") != "eval" {
            continue;
        }
        let id = request.id.unwrap_or(serde_json::Value::Null);
        let code = request.code.unwrap_or_default();

        // Evaluate. This is the blocking compile+run step.
        let eval_result = context.eval(&code);

        // Snapshot stdout/stderr produced by this eval.
        let (stdout_text, stderr_text) = snapshot_output(&shared_output);

        let response = match eval_result {
            Ok(evals) => {
                let result = evals.get("text/plain").map(|s| s.to_string());
                ResultResponse {
                    kind: "result",
                    id,
                    ok: true,
                    stdout: truncate(stdout_text),
                    stderr: truncate(stderr_text),
                    result,
                    error: None,
                }
            }
            Err(e) => ResultResponse {
                kind: "result",
                id,
                ok: false,
                stdout: truncate(stdout_text),
                stderr: truncate(stderr_text),
                result: None,
                error: Some(ErrorInfo {
                    name: "EvalError".into(),
                    message: e.to_string(),
                    stack: String::new(),
                }),
            },
        };

        let _ = writeln!(stdout, "{}", serde_json::to_string(&response).unwrap());
        let _ = stdout.flush();
    }
}
