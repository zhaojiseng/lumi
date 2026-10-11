//! Bounded, passive response observation. Forwarding never depends on parsing.
//!
//! Missing observations stay unknown until a real protocol terminator arrives.
//! Authentication headers are intentionally outside this module's input.

use crate::json::scan_object;
use crate::policy::{TierField, observe_tier};
use serde::{Deserialize, Serialize};
use serde_json::Value;

const MAX_LINE: usize = 64 * 1024;
const MAX_EVENT: usize = 256 * 1024;
const MAX_HTTP_JSON: usize = 1024 * 1024;
const MAX_CAPTURE: usize = 8 * 1024 * 1024;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Observation {
    pub reported: TierField,
    pub first_content_ms: Option<u64>,
    pub input_tokens: Option<u64>,
    pub output_tokens: Option<u64>,
    pub cache_read_tokens: Option<u64>,
    pub cache_write_tokens: Option<u64>,
    pub partial: bool,
}

impl Default for Observation {
    fn default() -> Self {
        Self {
            reported: TierField::Unavailable,
            first_content_ms: None,
            input_tokens: None,
            output_tokens: None,
            cache_read_tokens: None,
            cache_write_tokens: None,
            partial: false,
        }
    }
}

pub struct ResponseObserver {
    is_sse: bool,
    max_capture: usize,
    capture: Vec<u8>,
    capture_truncated: bool,
    http_body: Vec<u8>,
    http_overflow: bool,
    line: Vec<u8>,
    line_overflow: bool,
    event_data: Vec<u8>,
    event_name: String,
    discard_event: bool,
    after_cr: bool,
    first_line: bool,
    terminal: bool,
    damaged_stream: bool,
    saw_chat: bool,
    finished: bool,
    elapsed_ms: u64,
    observation: Observation,
}

impl ResponseObserver {
    pub fn new(is_sse: bool, max_capture: usize) -> Self {
        Self {
            is_sse,
            max_capture: max_capture.min(MAX_CAPTURE),
            capture: Vec::new(),
            capture_truncated: false,
            http_body: Vec::new(),
            http_overflow: false,
            line: Vec::new(),
            line_overflow: false,
            event_data: Vec::new(),
            event_name: String::new(),
            discard_event: false,
            after_cr: false,
            first_line: true,
            terminal: false,
            damaged_stream: false,
            saw_chat: false,
            finished: false,
            elapsed_ms: 0,
            observation: Observation::default(),
        }
    }

    pub fn push(&mut self, chunk: &[u8], elapsed_ms: u64) {
        if self.finished {
            return;
        }
        self.elapsed_ms = elapsed_ms;
        let available = self.max_capture.saturating_sub(self.capture.len());
        let kept = available.min(chunk.len());
        self.capture.extend_from_slice(&chunk[..kept]);
        if kept != chunk.len() {
            self.capture_truncated = true;
        }
        if !self.is_sse {
            if !self.http_overflow {
                if chunk.len() > MAX_HTTP_JSON.saturating_sub(self.http_body.len()) {
                    self.http_body.clear();
                    self.http_overflow = true;
                    self.observation.partial = true;
                } else {
                    self.http_body.extend_from_slice(chunk);
                }
            }
            return;
        }
        for &byte in chunk {
            if self.after_cr {
                self.after_cr = false;
                if byte == b'\n' {
                    continue;
                }
            }
            match byte {
                b'\r' => {
                    self.end_line();
                    self.after_cr = true;
                }
                b'\n' => self.end_line(),
                _ if self.line_overflow => (),
                _ if self.line.len() == MAX_LINE => {
                    self.line.clear();
                    self.line_overflow = true;
                    self.damage_event();
                }
                _ => self.line.push(byte),
            }
        }
    }

    pub fn finish(&mut self) {
        if self.finished {
            return;
        }
        self.finished = true;
        if self.is_sse {
            // SSE dispatch requires a blank line. EOF alone cannot complete an
            // event, even when its prefix happens to look like complete JSON.
            if !self.terminal
                || !self.line.is_empty()
                || self.line_overflow
                || !self.event_data.is_empty()
                || self.discard_event
            {
                self.observation.partial = true;
            }
            if !self.terminal {
                self.invalidate_final_observations();
            }
        } else if !self.http_overflow {
            if let Some(value) = trusted_json(&self.http_body) {
                self.observation.reported = if value["type"] == "message" {
                    tier_from_value(&value["usage"])
                } else {
                    observe_tier(&self.http_body)
                };
                self.observe_usage(value.get("usage"));
                if full_content(&value) {
                    self.mark_content();
                }
            } else {
                self.observation.partial = true;
            }
        }
    }

    pub fn summary(&self) -> Observation {
        self.observation.clone()
    }

    /// A possibly truncated prefix of the actual response bytes, never a
    /// reconstructed body. Callers choose whether encrypted storage is enabled.
    pub fn payload(&self) -> Vec<u8> {
        self.capture.clone()
    }

    /// Recording capacity does not limit incremental protocol observation.
    pub fn capture_truncated(&self) -> bool {
        self.capture_truncated
    }

    /// A transport observation gap cannot be repaired by guessing final usage/tier.
    /// Already observed first-content timing remains useful even for an interrupted stream.
    pub fn invalidate_final_observations(&mut self) {
        self.observation.reported = TierField::Unavailable;
        self.observation.input_tokens = None;
        self.observation.output_tokens = None;
        self.observation.cache_read_tokens = None;
        self.observation.cache_write_tokens = None;
        self.observation.partial = true;
    }

    fn damage_event(&mut self) {
        self.observation.partial = true;
        self.damaged_stream = true;
        self.discard_event = true;
        self.event_data.clear();
        self.event_name.clear();
    }

    fn end_line(&mut self) {
        if self.line_overflow {
            self.line_overflow = false;
            self.line.clear();
            self.first_line = false;
            return;
        }
        let mut line = std::mem::take(&mut self.line);
        if self.first_line {
            self.first_line = false;
            if line.starts_with(&[0xef, 0xbb, 0xbf]) {
                line.drain(..3);
            }
        }
        if line.is_empty() {
            if !self.discard_event && !self.event_data.is_empty() {
                self.dispatch_event();
            }
            self.event_data.clear();
            self.event_name.clear();
            self.discard_event = false;
            self.line = line;
            return;
        }
        if self.discard_event || line[0] == b':' {
            line.clear();
            self.line = line;
            return;
        }
        let separator = line.iter().position(|&byte| byte == b':');
        let (field, mut data) = match separator {
            Some(index) => (&line[..index], &line[index + 1..]),
            None => (line.as_slice(), &[][..]),
        };
        if data.first() == Some(&b' ') {
            data = &data[1..];
        }
        match field {
            b"data" => {
                if data.len() + 1 > MAX_EVENT.saturating_sub(self.event_data.len()) {
                    self.damage_event();
                } else {
                    self.event_data.extend_from_slice(data);
                    self.event_data.push(b'\n');
                }
            }
            b"event" => {
                // Protocol names are short; retain no arbitrary large labels.
                if data.len() > 128 {
                    self.damage_event();
                } else if let Ok(name) = std::str::from_utf8(data) {
                    self.event_name.clear();
                    self.event_name.push_str(name);
                } else {
                    self.damage_event();
                }
            }
            _ => (),
        }
        line.clear();
        self.line = line;
    }

    fn dispatch_event(&mut self) {
        let mut bytes = std::mem::take(&mut self.event_data);
        bytes.pop(); // SSE's appended final line-feed is not part of event data.
        if bytes.as_slice() == b"[DONE]" {
            self.terminal = true;
            self.complete_missing_tier();
            self.event_data = bytes;
            return;
        }
        if self.terminal {
            // Final observations are frozen. Extra data after a protocol
            // terminator is anomalous and cannot replace the actual result.
            self.observation.partial = true;
            self.damaged_stream = true;
            self.event_data = bytes;
            return;
        }
        let Some(value) = trusted_json(&bytes) else {
            self.observation.partial = true;
            self.damaged_stream = true;
            self.event_data = bytes;
            return;
        };
        let kind = value
            .get("type")
            .and_then(Value::as_str)
            .unwrap_or(&self.event_name)
            .to_owned();
        let chat = value.get("choices").is_some_and(Value::is_array)
            || value
                .get("object")
                .and_then(Value::as_str)
                .is_some_and(|name| name.starts_with("chat.completion"));
        self.saw_chat |= chat;
        if (chat || self.saw_chat) && value.get("service_tier").is_some() {
            self.observation.reported = tier_from_value(&value);
        }
        self.observe_usage(value.get("usage"));
        if kind.starts_with("message_") && value["usage"].get("service_tier").is_some() {
            self.observation.reported = tier_from_value(&value["usage"]);
        }
        if let Some(message) = value.get("message").filter(|value| value.is_object()) {
            self.observe_usage(message.get("usage"));
            if message["usage"].get("service_tier").is_some() {
                self.observation.reported = tier_from_value(&message["usage"]);
            }
        }
        if kind == "response.completed" {
            if let Some(response) = value.get("response").filter(|value| value.is_object()) {
                self.observation.reported = tier_from_value(response);
                self.observe_usage(response.get("usage"));
                self.terminal = true;
            } else {
                self.observation.partial = true;
                self.damaged_stream = true;
            }
        } else if kind == "message_stop" {
            self.terminal = true;
            self.complete_missing_tier();
        }
        if incremental_content(&value, &kind) {
            self.mark_content();
        }
        self.event_data = bytes;
    }

    fn complete_missing_tier(&mut self) {
        // A malformed/dropped event might have held a tier field. Do not turn
        // unavailable observation into a false assertion that it was absent.
        if !self.damaged_stream && self.observation.reported == TierField::Unavailable {
            self.observation.reported = TierField::Missing;
        }
    }

    fn mark_content(&mut self) {
        self.observation
            .first_content_ms
            .get_or_insert(self.elapsed_ms);
    }

    fn observe_usage(&mut self, usage: Option<&Value>) {
        let Some(usage) = usage.filter(|value| value.is_object()) else {
            return;
        };
        update_count(
            &mut self.observation.input_tokens,
            usage
                .get("input_tokens")
                .or_else(|| usage.get("prompt_tokens")),
        );
        update_count(
            &mut self.observation.output_tokens,
            usage
                .get("output_tokens")
                .or_else(|| usage.get("completion_tokens")),
        );
        update_count(
            &mut self.observation.cache_read_tokens,
            usage
                .get("cache_read_input_tokens")
                .or_else(|| {
                    usage
                        .get("input_tokens_details")
                        .and_then(|details| details.get("cached_tokens"))
                })
                .or_else(|| {
                    usage
                        .get("prompt_tokens_details")
                        .and_then(|details| details.get("cached_tokens"))
                }),
        );
        update_count(
            &mut self.observation.cache_write_tokens,
            usage.get("cache_creation_input_tokens"),
        );
    }
}

fn trusted_json(bytes: &[u8]) -> Option<Value> {
    scan_object(bytes).ok()?;
    serde_json::from_slice(bytes).ok()
}

fn tier_from_value(value: &Value) -> TierField {
    match value.get("service_tier") {
        None => TierField::Missing,
        Some(Value::Null) => TierField::Null,
        Some(Value::String(value)) => TierField::String(value.clone()),
        Some(_) => TierField::Invalid,
    }
}

fn update_count(destination: &mut Option<u64>, source: Option<&Value>) {
    if let Some(value) = source.and_then(Value::as_u64) {
        *destination = Some(value);
    }
}

fn nonempty_text(value: Option<&Value>) -> bool {
    match value {
        Some(Value::String(text)) => !text.is_empty(),
        Some(Value::Array(parts)) => parts
            .iter()
            .any(|part| nonempty_text(part.get("text")) || nonempty_text(part.get("content"))),
        _ => false,
    }
}

fn function_content(value: Option<&Value>) -> bool {
    value.is_some_and(|value| {
        nonempty_text(value.get("name")) || nonempty_text(value.get("arguments"))
    })
}

fn message_content(value: &Value) -> bool {
    nonempty_text(value.get("content"))
        || nonempty_text(value.get("refusal"))
        || nonempty_text(value.get("reasoning_content"))
        || function_content(value.get("function_call"))
        || value
            .get("tool_calls")
            .and_then(Value::as_array)
            .is_some_and(|calls| {
                calls
                    .iter()
                    .any(|call| function_content(call.get("function")))
            })
}

fn incremental_content(value: &Value, kind: &str) -> bool {
    if value
        .get("choices")
        .and_then(Value::as_array)
        .is_some_and(|choices| {
            choices
                .iter()
                .filter_map(|choice| choice.get("delta"))
                .any(message_content)
        })
    {
        return true;
    }
    match kind {
        "response.output_text.delta"
        | "response.refusal.delta"
        | "response.reasoning_text.delta"
        | "response.reasoning_summary_text.delta"
        | "response.function_call_arguments.delta"
        | "response.custom_tool_call_input.delta" => nonempty_text(value.get("delta")),
        "response.output_item.added" => value.get("item").is_some_and(|item| {
            matches!(
                item.get("type").and_then(Value::as_str),
                Some("function_call" | "custom_tool_call")
            ) && (nonempty_text(item.get("name"))
                || nonempty_text(item.get("arguments"))
                || nonempty_text(item.get("input")))
        }),
        "content_block_delta" => value.get("delta").is_some_and(|delta| {
            nonempty_text(delta.get("text"))
                || nonempty_text(delta.get("partial_json"))
                || nonempty_text(delta.get("thinking"))
        }),
        "content_block_start" => value.get("content_block").is_some_and(|block| {
            nonempty_text(block.get("text"))
                || (block.get("type").and_then(Value::as_str) == Some("tool_use")
                    && nonempty_text(block.get("name")))
        }),
        _ => false,
    }
}

fn full_content(value: &Value) -> bool {
    nonempty_text(value.get("output_text"))
        || value
            .get("choices")
            .and_then(Value::as_array)
            .is_some_and(|choices| {
                choices
                    .iter()
                    .filter_map(|choice| choice.get("message"))
                    .any(message_content)
            })
        || value
            .get("output")
            .and_then(Value::as_array)
            .is_some_and(|output| {
                output.iter().any(|item| {
                    nonempty_text(item.get("content"))
                        || (matches!(
                            item.get("type").and_then(Value::as_str),
                            Some("function_call" | "custom_tool_call")
                        ) && (nonempty_text(item.get("name"))
                            || nonempty_text(item.get("arguments"))
                            || nonempty_text(item.get("input"))))
                })
            })
        || value
            .get("content")
            .and_then(Value::as_array)
            .is_some_and(|content| {
                content.iter().any(|block| {
                    nonempty_text(block.get("text"))
                        || (block.get("type").and_then(Value::as_str) == Some("tool_use")
                            && nonempty_text(block.get("name")))
                })
            })
}
