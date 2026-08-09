// pi-rust-kernel child — persistent Rust evaluation kernel with host bridge.
//
// Speaks NDJSON over stdio, one JSON object per line in/out, plus a Unix
// socket as the mid-eval bridge channel. stderr is reserved for diagnostics.
//
// Host -> child (stdin):
//   {"type":"eval","id","code"}                  evaluate in the persistent context
//   {"type":"host_response","id","result"}       answer to a host_request the child emitted
//
// Child -> host (stdout):
//   {"type":"result","id","ok","stdout","stderr","result"?,"error"?}   eval finished
//   {"type":"host_request","id","request"}       child needs a host tool mid-eval
//
// State (variables, functions, types) persists across eval requests because
// evcxr::EvalContext keeps the accumulated program and recompiles only what
// changed. The context is created once at startup and held for process life.
//
// HOST BRIDGE (the point of this file):
//  evcxr evaluates user code in a re-spawned subprocess with no event loop, so
//  user code cannot await a host answer the way node:repl can. We give user
//  code a synchronous bridge instead: a pre-evaluated `mod kernel` whose
//  functions (read/write/edit/bash/rlm.*) open a Unix socket to this child,
//  write a request, and block reading the response. A background socket server
//  relays each request to the host as a host_request NDJSON line and returns
//  the host_response to the caller. The subprocess inherits the socket path
//  through the PI_RUST_KERNEL_SOCKET env var (set before EvalContext::new()).
//
//  A single stdin dispatcher thread routes lines: host_response -> the socket
//  server's pending-request, eval -> the main eval loop. This keeps one reader
//  on stdin (evals and host responses both arrive on the host->child pipe).
//
// Design notes:
//  - evcxr::EvalContext re-spawns the current executable as a subprocess and
//    compiles/executes user code there. The re-spawned process needs a full
//    Rust toolchain (rustc, cargo, gcc, mold) on PATH plus RUST_SRC_PATH set
//    — the Nix derivation wraps the binary with those, mirroring nixpkgs'
//    evcxr package.
//  - evcxr routes user println!/panic output to crossbeam channels
//    (EvalContextOutputs.stdout/stderr). eval BLOCKS until the sender is
//    drained, so a background thread must drain the channels continuously —
//    otherwise a println! deadlocks eval. The drained bytes accumulate in a
//    shared buffer; we snapshot it after each eval returns.
//  - The last expression's value surfaces as EvalOutputs{"text/plain"}; a
//    statement (let/...) yields None. Mirrors the JS kernel's result field.
//  - The bridge is strictly request/response and serialized per eval (one eval
//    at a time, and within an eval kernel calls are sequential), so only one
//    host_request is in flight at a time.
use std::io::{BufRead, BufReader, Write};
use std::os::unix::net::UnixListener;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};

use evcxr::EvalContext;
use serde::{Deserialize, Serialize};

const MAX_OUTPUT: usize = 65536;
const TRUNC_SUFFIX: &str = "\n[... output truncated by pi-rust-kernel ...]";
const SOCKET_ENV: &str = "PI_RUST_KERNEL_SOCKET";

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

/// A host_request the child sends to the host mid-eval.
#[derive(Serialize)]
struct HostRequest {
    #[serde(rename = "type")]
    kind: &'static str,
    id: u64,
    request: serde_json::Value,
}

// ---------------------------------------------------------------------------
// Output capture: a background thread drains evcxr's output channels
// continuously so eval never blocks on a full sender.
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

fn snapshot_output(shared: &SharedOutput) -> (String, String) {
    let mut b = shared.0.lock().unwrap();
    let out = std::mem::take(&mut b.stdout);
    let err = std::mem::take(&mut b.stderr);
    (out, err)
}

fn truncate(mut s: String) -> String {
    if s.len() > MAX_OUTPUT {
        // s.truncate panics unless the cut lies on a UTF-8 char boundary;
        // walk back until it does (multi-byte chars crossing the limit).
        let mut end = MAX_OUTPUT;
        while !s.is_char_boundary(end) {
            end -= 1;
        }
        s.truncate(end);
        s.push_str(TRUNC_SUFFIX);
    }
    s
}

// ---------------------------------------------------------------------------
// Kernel helpers injected into the persistent context.
//
// `mod kernel` is pre-evaluated so user code can call kernel::read(path),
// kernel::write(path, content), kernel::edit(path, edits_json),
// kernel::bash(cmd), and kernel::rlm::run(task) — each does a synchronous
// round-trip over the bridge socket.
// ---------------------------------------------------------------------------

const KERNEL_MOD_SOURCE: &str = r##"
mod kernel {
    use std::os::unix::net::UnixStream;
    use std::io::{Write, Read};

    fn json_escape(s: &str) -> String {
        let mut out = String::new();
        for c in s.chars() {
            match c {
                '"' => out.push_str("\\\""),
                '\\' => out.push_str("\\\\"),
                '\n' => out.push_str("\\n"),
                '\r' => out.push_str("\\r"),
                '\t' => out.push_str("\\t"),
                '\u{8}' => out.push_str("\\b"),
                '\u{c}' => out.push_str("\\f"),
                c if (c as u32) < 0x20 => out.push_str(&format!("\\u{:04x}", c as u32)),
                c => out.push(c),
            }
        }
        out
    }

    fn request(payload: &str) -> String {
        let path = std::env::var("PI_RUST_KERNEL_SOCKET").unwrap_or_default();
        let mut stream = UnixStream::connect(&path)
            .unwrap_or_else(|e| panic!("kernel: cannot reach bridge socket: {e}"));
        stream.write_all(payload.as_bytes()).expect("kernel: socket write");
        stream.write_all(b"\n").expect("kernel: socket write nl");
        stream.flush().expect("kernel: socket flush");
        let mut buf = String::new();
        stream.read_to_string(&mut buf).expect("kernel: socket read");
        buf.trim().to_string()
    }

    /// Read a file. Returns the file content (hashline-style LINEID preview).
    pub fn read(path: &str) -> String {
        request(&format!(r#"{{"request":{{"type":"read","path":"{}"}}}}"#, json_escape(path)))
    }

    /// Write (create or overwrite) a file.
    pub fn write(path: &str, content: &str) -> String {
        request(&format!(r#"{{"request":{{"type":"write","path":"{}","content":"{}"}}}}"#, json_escape(path), json_escape(content)))
    }

    /// Edit a file. edits_json is a JSON array of {oldText,newText} pairs.
    pub fn edit(path: &str, edits_json: &str) -> String {
        request(&format!(r#"{{"request":{{"type":"edit","path":"{}","edits":{}}}}}"#, json_escape(path), edits_json))
    }

    /// Run a shell command child-side. Returns the command's stdout.
    pub fn bash(cmd: &str) -> String {
        // bash is child-side (direct shell), no bridge.
        let out = std::process::Command::new("sh")
            .arg("-c")
            .arg(cmd)
            .output()
            .expect("kernel::bash: failed to spawn sh");
        String::from_utf8_lossy(&out.stdout).to_string()
    }

    pub mod rlm {
        /// Spawn a child agent with the given task. Returns the admission
        /// handle as JSON text.
        pub fn run(task: &str) -> String {
            super::request(&format!(r#"{{"request":{{"type":"rlm.run","task":"{}"}}}}"#, super::json_escape(task)))
        }
        /// List running child agents.
        pub fn list() -> String {
            super::request(r#"{"request":{"type":"rlm.list"}}"#)
        }
        /// Kill a child agent by id.
        pub fn kill(id: &str) -> String {
            super::request(&format!(r#"{{"request":{{"type":"rlm.kill","id":"{}"}}}}"#, super::json_escape(id)))
        }
    }
}
"##;

// ---------------------------------------------------------------------------
// Bridge socket server: relays kernel requests to the host and back.
// Runs on a background thread while the main thread is blocked in eval.
// ---------------------------------------------------------------------------

fn spawn_bridge_server(
    socket_path: PathBuf,
    stdout_writer: Arc<Mutex<std::io::Stdout>>,
    host_rx: crossbeam_channel::Receiver<serde_json::Value>,
) -> Result<(), String> {
    // Host request ids are child-generated, independent of eval ids.
    let counter = Arc::new(Mutex::new(0u64));

    let listener = UnixListener::bind(&socket_path).map_err(|e| format!("socket bind: {e}"))?;
    std::thread::spawn(move || {
        for conn in listener.incoming() {
            let stream = match conn {
                Ok(s) => s,
                Err(_) => continue,
            };
            let stdout_writer = Arc::clone(&stdout_writer);
            let host_rx = host_rx.clone();
            let counter = Arc::clone(&counter);
            // Service each connection on its own thread so a slow host_request
            // doesn't block the next kernel call from connecting.
            std::thread::spawn(move || {
                let mut reader = BufReader::new(stream.try_clone().unwrap());
                let mut writer = stream;
                let mut line = String::new();
                if reader.read_line(&mut line).ok() == Some(0) || line.trim().is_empty() {
                    return;
                }
                // Parse the request payload: {"request":{...}}
                let payload: serde_json::Value = match serde_json::from_str(line.trim()) {
                    Ok(v) => v,
                    Err(_) => {
                        let _ = writeln!(writer, "{{\"ok\":false,\"error\":\"malformed bridge request\"}}");
                        return;
                    }
                };
                let request = payload.get("request").cloned().unwrap_or(serde_json::Value::Null);

                // Assign an id and send host_request to the host.
                let id = {
                    let mut c = counter.lock().unwrap();
                    *c += 1;
                    *c
                };
                let hr = HostRequest { kind: "host_request", id, request };
                {
                    let mut out = stdout_writer.lock().unwrap();
                    let _ = writeln!(out, "{}", serde_json::to_string(&hr).unwrap());
                    let _ = out.flush();
                }

                // Wait for the matching host_response from the host.
                let mut response = serde_json::Value::Null;
                for line in host_rx.iter() {
                    if line.get("type").and_then(|t| t.as_str()) == Some("host_response")
                        && line.get("id").and_then(|i| i.as_u64()) == Some(id)
                    {
                        response = line.get("result").cloned().unwrap_or(serde_json::Value::Null);
                        break;
                    }
                }

                // Write the result back to the caller.
                let result_text = if response.get("ok").and_then(|o| o.as_bool()) == Some(true) {
                    response.get("value").map(|v| v.to_string()).unwrap_or_else(|| "null".into())
                } else {
                    response.get("error").map(|e| e.to_string()).unwrap_or_else(|| "{\"ok\":false}".into())
                };
                let _ = writeln!(writer, "{result_text}");
                let _ = writer.flush();
            });
        }
    });
    Ok(())
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

fn main() {
    // Must be called before EvalContext::new() or the library fork-bombs.
    evcxr::runtime_hook();

    // Create the bridge socket and expose its path to the (sub)processes.
    let socket_path = std::env::temp_dir().join(format!("pi-rust-kernel-{}.sock", std::process::id()));
    let _ = std::fs::remove_file(&socket_path);
    std::env::set_var(SOCKET_ENV, socket_path.to_string_lossy().to_string());

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

    // Channels for routing stdin lines.
    let (eval_tx, eval_rx) = crossbeam_channel::unbounded::<String>();
    let (host_tx, host_rx) = crossbeam_channel::unbounded::<serde_json::Value>();

    // Start the bridge socket server (relays kernel requests to the host).
    let stdout_writer = Arc::new(Mutex::new(std::io::stdout()));
    if let Err(e) = spawn_bridge_server(socket_path, stdout_writer.clone(), host_rx) {
        eprintln!("[pi-rust-kernel] bridge socket failed: {e}");
    }

    // A single stdin dispatcher thread routes lines: host_response -> socket
    // server's pending-request channel; eval -> main eval loop.
    {
        let eval_tx = eval_tx.clone();
        let host_tx = host_tx.clone();
        std::thread::spawn(move || {
            let stdin = std::io::stdin();
            let mut lines = stdin.lock().lines();
            while let Some(Ok(line)) = lines.next() {
                let trimmed = line.trim();
                if trimmed.is_empty() {
                    continue;
                }
                if let Ok(v) = serde_json::from_str::<serde_json::Value>(trimmed) {
                    if v.get("type").and_then(|t| t.as_str()) == Some("host_response") {
                        let _ = host_tx.send(v);
                        continue;
                    }
                }
                let _ = eval_tx.send(trimmed.to_string());
            }
        });
    }
    // The dispatcher thread is the only sender that matters; drop the
    // originals so the channels close on stdin EOF and the main eval loop
    // ends. Without this the child never exits (and the flake test pipeline
    // hangs): eval_rx.iter() blocks forever on the still-alive sender.
    drop(eval_tx);
    drop(host_tx);

    // Pre-compile the kernel module into the context so user evals can call
    // kernel::read/write/edit/bash/rlm.*. If this fails the kernel is degraded.
    if let Err(e) = context.eval(KERNEL_MOD_SOURCE) {
        eprintln!("[pi-rust-kernel] failed to pre-eval kernel module: {e}");
    }

    // Main eval loop: receive eval requests and evaluate them.
    for line in eval_rx.iter() {
        let request: Request = match serde_json::from_str(&line) {
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
                {
                    let mut out = stdout_writer.lock().unwrap();
                    let _ = writeln!(out, "{}", serde_json::to_string(&resp).unwrap());
                    let _ = out.flush();
                }
                continue;
            }
        };

        if request.kind.as_deref().unwrap_or("") != "eval" {
            continue;
        }
        let id = request.id.unwrap_or(serde_json::Value::Null);
        let code = request.code.unwrap_or_default();

        let eval_result = context.eval(&code);
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

        {
            let mut out = stdout_writer.lock().unwrap();
            let _ = writeln!(out, "{}", serde_json::to_string(&response).unwrap());
            let _ = out.flush();
        }
    }

    let _ = std::fs::remove_file(std::env::temp_dir().join(format!("pi-rust-kernel-{}.sock", std::process::id())));
}
