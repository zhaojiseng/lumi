//! Test-only private-pipe peer. It uses no secrets, user files, or network.
use std::io::{self, BufRead, Write};

fn main() {
    let mut input = io::stdin().lock();
    let mut output = io::stdout().lock();
    loop {
        // Read only the fixed envelope prefix so exit-write can close stdin
        // while the parent's large JSON payload is still queued for writing.
        let mut prefix = Vec::new();
        loop {
            let mut byte = Vec::new();
            match input.read_until(b'"', &mut byte) {
                Ok(0) => return,
                Ok(_) => prefix.extend_from_slice(&byte),
                Err(_) => return,
            }
            if prefix.ends_with(b",\"input\"") {
                break;
            }
            if prefix.len() > 256 {
                std::process::exit(3);
            }
        }
        let text = String::from_utf8_lossy(&prefix);
        let id = text
            .strip_prefix("{\"id\":")
            .and_then(|rest| rest.split(',').next())
            .and_then(|value| value.parse::<u64>().ok())
            .unwrap_or(0);
        if text.contains("\"exit-write\"") {
            std::process::exit(0);
        }
        let mut tail = Vec::new();
        if input.read_until(b'\n', &mut tail).is_err() {
            return;
        }
        if text.contains("\"bootstrap\"") {
            writeln!(output, "{{\"id\":{id},\"result\":{{\"protocolVersion\":1,\"fixture\":true}}}}")
                .unwrap();
        } else if text.contains("\"malformed-json\"") {
            writeln!(output, "{{broken JSON").unwrap();
        } else if text.contains("\"malformed-shape\"") {
            writeln!(output, "null").unwrap();
        } else if text.contains("\"oversized\"") {
            let block = [b'x'; 65536];
            for _ in 0..97 {
                if output.write_all(&block).is_err() {
                    return;
                }
            }
            let _ = output.write_all(b"\n");
        } else if text.contains("\"wrong-id\"") {
            writeln!(output, "{{\"id\":{},\"result\":true}}", id + 1).unwrap();
        } else {
            writeln!(output, "{{\"id\":{id},\"result\":{{\"ok\":true}}}}")
                .unwrap();
        }
        if output.flush().is_err() {
            return;
        }
    }
}
