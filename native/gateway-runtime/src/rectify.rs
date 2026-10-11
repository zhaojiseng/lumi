//! Two explicit request boundaries. Unchanged JSON spans retain their exact bytes.
use crate::{config::valid_id, json::scan_object, policy::RuleMatch};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::collections::{BTreeMap, HashSet};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum Stage {
    Entry,
    Model,
}
#[derive(Debug, Clone, Serialize)]
#[serde(tag = "type", rename_all = "kebab-case", deny_unknown_fields)]
pub enum Action {
    Preserve,
    Remove,
    SetIfMissing { value: Value },
    Override { value: Value },
    Map { values: BTreeMap<String, Value> },
    Clamp { min: f64, max: f64 },
    Reject { code: String },
}
// Decode the tag separately: serde's internally tagged buffer cannot represent
// arbitrary-precision decimal boundaries or integer parameter values. Plain
// typed bodies retain strict field checks and the original JSON numeric value.
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct EmptyAction {}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct ValueAction {
    value: Value,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct MapAction {
    values: BTreeMap<String, Value>,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct ClampAction {
    min: f64,
    max: f64,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct RejectAction {
    code: String,
}
impl<'de> Deserialize<'de> for Action {
    fn deserialize<D: serde::Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        let mut value = Value::deserialize(deserializer)?;
        let tag = value
            .as_object_mut()
            .and_then(|fields| fields.remove("type"))
            .and_then(|tag| {
                if let Value::String(tag) = tag {
                    Some(tag)
                } else {
                    None
                }
            })
            .ok_or_else(|| serde::de::Error::custom("rectifier action requires a string type"))?;
        match tag.as_str() {
            "preserve" | "remove" => {
                serde_json::from_value::<EmptyAction>(value).map_err(serde::de::Error::custom)?;
                Ok(if tag == "preserve" {
                    Self::Preserve
                } else {
                    Self::Remove
                })
            }
            "set-if-missing" | "override" => {
                let body = serde_json::from_value::<ValueAction>(value)
                    .map_err(serde::de::Error::custom)?;
                Ok(if tag == "override" {
                    Self::Override { value: body.value }
                } else {
                    Self::SetIfMissing { value: body.value }
                })
            }
            "map" => {
                let body =
                    serde_json::from_value::<MapAction>(value).map_err(serde::de::Error::custom)?;
                Ok(Self::Map {
                    values: body.values,
                })
            }
            "clamp" => {
                let body = serde_json::from_value::<ClampAction>(value)
                    .map_err(serde::de::Error::custom)?;
                Ok(Self::Clamp {
                    min: body.min,
                    max: body.max,
                })
            }
            "reject" => {
                let body = serde_json::from_value::<RejectAction>(value)
                    .map_err(serde::de::Error::custom)?;
                Ok(Self::Reject { code: body.code })
            }
            _ => Err(serde::de::Error::custom("unknown rectifier action")),
        }
    }
}
impl Action {
    fn name(&self) -> &'static str {
        match self {
            Self::Preserve => "preserve",
            Self::Remove => "remove",
            Self::SetIfMissing { .. } => "set-if-missing",
            Self::Override { .. } => "override",
            Self::Map { .. } => "map",
            Self::Clamp { .. } => "clamp",
            Self::Reject { .. } => "reject",
        }
    }
}
#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Rule {
    pub id: String,
    pub enabled: bool,
    pub priority: i32,
    pub stage: Stage,
    #[serde(rename = "match", default)]
    pub scope: RuleMatch,
    pub field: String,
    pub action: Action,
}
#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Change {
    pub stage: Stage,
    pub field: String,
    pub rule_id: String,
    pub action: String,
    pub changed: bool,
}
pub struct Context<'a> {
    pub route_id: &'a str,
    pub client: &'a str,
    pub endpoint: &'a str,
    pub model: Option<&'a str>,
}

pub const FIELDS: &[&str] = &[
    "/service_tier",
    "/reasoning",
    "/reasoning/effort",
    "/reasoning/summary",
    "/reasoning_effort",
    "/thinking",
    "/thinking/type",
    "/thinking/budget_tokens",
    "/output_config",
    "/output_config/effort",
    "/output_config/format",
    "/max_tokens",
    "/max_output_tokens",
    "/max_completion_tokens",
    "/temperature",
    "/top_p",
    "/top_k",
    "/stop",
    "/stop_sequences",
    "/tool_choice",
    "/parallel_tool_calls",
    "/response_format",
    "/text",
    "/text/format",
    "/text/verbosity",
    "/store",
    "/metadata",
    "/prompt_cache_key",
    "/prompt_cache_retention",
    "/cache_control",
    "/system/*/cache_control",
    "/messages/*/content/*/cache_control",
    "/tools/*/cache_control",
    "/input/*/content/*/cache_control",
    "/stream_options",
    "/stream_options/include_usage",
];
pub fn validate(rules: &[Rule]) -> Result<(), String> {
    let mut ids = HashSet::new();
    if rules.len() > 128 {
        return Err("rectifier-limit".into());
    }
    for rule in rules {
        if !valid_id(&rule.id) || !ids.insert(&rule.id) || !FIELDS.contains(&rule.field.as_str()) {
            return Err("invalid-rectifier".into());
        }
        if rule.scope.route_id.as_deref().is_some_and(|s| !valid_id(s))
            || rule.scope.client.as_deref().is_some_and(|s| !valid_id(s))
            || rule.scope.endpoint.as_deref().is_some_and(|s| {
                !matches!(s, "/v1/responses" | "/v1/chat/completions" | "/v1/messages")
            })
            || rule
                .scope
                .model
                .as_deref()
                .is_some_and(|s| s.is_empty() || s.len() > 256 || s.chars().any(char::is_control))
        {
            return Err("invalid-rectifier".into());
        }
        if rule.field.contains('*') && !matches!(rule.action, Action::Preserve | Action::Remove) {
            return Err("invalid-rectifier".into());
        }
        match &rule.action {
            Action::Clamp { min, max } if !min.is_finite() || !max.is_finite() || min > max => {
                return Err("invalid-rectifier".into());
            }
            Action::Reject { code }
                if !valid_id(code)
                    || code
                        .chars()
                        .any(|c| c.is_ascii_uppercase() || c == '_' || c == '.') =>
            {
                return Err("invalid-rectifier".into());
            }
            Action::Map { values } if values.is_empty() || values.len() > 32 => {
                return Err("invalid-rectifier".into());
            }
            _ => (),
        }
        let bytes = serde_json::to_vec(&rule.action).map_err(|_| "invalid-rectifier")?;
        if bytes.len() > 4096 {
            return Err("invalid-rectifier".into());
        }
        if rule.field == "/service_tier" {
            let valid = |v: &Value| v.as_str().is_some_and(valid_id);
            match &rule.action {
                Action::Override { value } | Action::SetIfMissing { value } if !valid(value) => {
                    return Err("invalid-rectifier".into());
                }
                Action::Map { values } if values.values().any(|v| !valid(v)) => {
                    return Err("invalid-rectifier".into());
                }
                Action::Clamp { .. } => return Err("invalid-rectifier".into()),
                _ => (),
            }
        }
    }
    Ok(())
}
fn matches(scope: &RuleMatch, c: &Context<'_>) -> bool {
    scope.route_id.as_deref().is_none_or(|s| s == c.route_id)
        && scope.client.as_deref().is_none_or(|s| s == c.client)
        && scope.endpoint.as_deref().is_none_or(|s| s == c.endpoint)
        && scope.model.as_deref().is_none_or(|s| Some(s) == c.model)
}
fn specificity(scope: &RuleMatch) -> usize {
    [
        &scope.route_id,
        &scope.client,
        &scope.endpoint,
        &scope.model,
    ]
    .iter()
    .filter(|v| v.is_some())
    .count()
}
fn value_at(body: &[u8], parts: &[&str]) -> Result<Option<Value>, String> {
    let object = scan_object(body).map_err(|_| "invalid-rectifier-json")?;
    let Some(member) = object.member(parts[0]) else {
        return Ok(None);
    };
    let slice = &body[member.value_start..member.value_end];
    if parts.len() == 1 {
        return serde_json::from_slice(slice)
            .map(Some)
            .map_err(|_| "invalid-rectifier-json".into());
    }
    if !slice.starts_with(b"{") {
        return Ok(None);
    }
    value_at(slice, &parts[1..])
}
/// Replace one object path without reserializing siblings, numbers or message content.
pub fn set_path(body: &[u8], parts: &[&str], value: Option<&Value>) -> Result<Vec<u8>, String> {
    if parts[0] == "*" {
        let trimmed = body
            .iter()
            .position(|b| !b.is_ascii_whitespace())
            .unwrap_or(0);
        if body.get(trimmed) != Some(&b'[') {
            return if value.is_none() {
                Ok(body.to_vec())
            } else {
                Err("rectifier-parent-not-object".into())
            };
        }
        let spans = crate::json::scan_array(body).map_err(|_| "invalid-rectifier-json")?;
        let mut out = body.to_vec();
        for (start, end) in spans.into_iter().rev() {
            let child = &body[start..end];
            if child
                .iter()
                .find(|b| !b.is_ascii_whitespace())
                .is_none_or(|b| !matches!(b, b'{' | b'['))
            {
                continue;
            }
            let replacement = set_path(child, &parts[1..], value)?;
            out.splice(start..end, replacement);
        }
        return Ok(out);
    }
    let object = scan_object(body).map_err(|_| "invalid-rectifier-json")?;
    let member = object.member(parts[0]);
    let encoded = if parts.len() > 1 {
        if let Some(m) = member {
            let child = &body[m.value_start..m.value_end];
            if !child.starts_with(b"{") && parts[1] != "*" {
                return Err("rectifier-parent-not-object".into());
            }
            Some(set_path(child, &parts[1..], value)?)
        } else if value.is_none() {
            return Ok(body.to_vec());
        } else {
            Some(set_path(b"{}", &parts[1..], value)?)
        }
    } else {
        value
            .map(serde_json::to_vec)
            .transpose()
            .map_err(|_| "invalid-rectifier")?
    };
    let (start, end, insert) = if let Some(m) = member {
        if let Some(bytes) = encoded {
            (m.value_start, m.value_end, bytes)
        } else {
            let i = object
                .members
                .iter()
                .position(|v| v.key == parts[0])
                .ok_or("invalid-rectifier")?;
            let (a, b) = if i > 0 {
                (object.members[i - 1].value_end, m.value_end)
            } else if object.members.len() > 1 {
                (m.key_start, object.members[1].key_start)
            } else {
                (m.key_start, m.value_end)
            };
            (a, b, Vec::new())
        }
    } else if let Some(bytes) = encoded {
        let mut insert = Vec::new();
        if !object.members.is_empty() {
            insert.push(b',');
        }
        insert.extend(serde_json::to_vec(parts[0]).map_err(|_| "invalid-rectifier")?);
        insert.push(b':');
        insert.extend(bytes);
        let pos = object.members.last().map_or(object.close, |m| m.value_end);
        (pos, pos, insert)
    } else {
        return Ok(body.to_vec());
    };
    let mut out = Vec::with_capacity(body.len() + insert.len());
    out.extend(&body[..start]);
    out.extend(insert);
    out.extend(&body[end..]);
    Ok(out)
}
pub fn apply(
    body: &[u8],
    stage: Stage,
    c: Context<'_>,
    rules: &[Rule],
) -> Result<(Vec<u8>, Vec<Change>), String> {
    let mut selected: BTreeMap<&str, (usize, &Rule)> = BTreeMap::new();
    for (i, r) in rules
        .iter()
        .enumerate()
        .filter(|(_, r)| r.enabled && r.stage == stage && matches(&r.scope, &c))
    {
        let better = selected.get(r.field.as_str()).is_none_or(|(old_i, old)| {
            (r.priority, specificity(&r.scope), std::cmp::Reverse(i))
                > (
                    old.priority,
                    specificity(&old.scope),
                    std::cmp::Reverse(*old_i),
                )
        });
        if better {
            selected.insert(&r.field, (i, r));
        }
    }
    let paths: Vec<_> = selected.keys().copied().collect();
    for (index, path) in paths.iter().enumerate() {
        if paths[index + 1..].iter().any(|other| {
            other
                .strip_prefix(*path)
                .is_some_and(|suffix| suffix.starts_with('/'))
        }) {
            return Err("rectifier-field-conflict".into());
        }
    }
    let mut out = body.to_vec();
    let mut changes = Vec::new();
    for (_, (_, r)) in selected {
        let parts: Vec<_> = r.field.trim_start_matches('/').split('/').collect();
        if let Action::Reject { code } = &r.action {
            return Err(code.clone());
        }
        if matches!(r.action, Action::Preserve) {
            changes.push(Change {
                stage,
                field: r.field.clone(),
                rule_id: r.id.clone(),
                action: r.action.name().into(),
                changed: false,
            });
            continue;
        }
        if parts.contains(&"*") {
            let changed = set_path(&out, &parts, None)?;
            changes.push(Change {
                stage,
                field: r.field.clone(),
                rule_id: r.id.clone(),
                action: r.action.name().into(),
                changed: changed != out,
            });
            out = changed;
            continue;
        }
        let before = value_at(&out, &parts)?;
        let after = match &r.action {
            Action::Preserve => before.clone(),
            Action::Remove => None,
            Action::SetIfMissing { value } => before.clone().or_else(|| Some(value.clone())),
            Action::Override { value } => Some(value.clone()),
            Action::Map { values } => before
                .as_ref()
                .and_then(Value::as_str)
                .and_then(|s| values.get(s))
                .cloned()
                .or_else(|| before.clone()),
            Action::Clamp { min, max } => {
                if before.is_none() {
                    changes.push(Change {
                        stage,
                        field: r.field.clone(),
                        rule_id: r.id.clone(),
                        action: r.action.name().into(),
                        changed: false,
                    });
                    continue;
                }
                let n = before
                    .as_ref()
                    .and_then(Value::as_f64)
                    .filter(|n| n.is_finite())
                    .ok_or("rectifier-value-not-number")?;
                if n < *min {
                    Some(json!(min))
                } else if n > *max {
                    Some(json!(max))
                } else {
                    before.clone()
                }
            }
            Action::Reject { .. } => unreachable!(),
        };
        let changed = before != after;
        if changed {
            out = set_path(&out, &parts, after.as_ref())?;
        }
        changes.push(Change {
            stage,
            field: r.field.clone(),
            rule_id: r.id.clone(),
            action: r.action.name().into(),
            changed,
        });
    }
    Ok((out, changes))
}
