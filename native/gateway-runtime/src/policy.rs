//! Deterministic request service_tier rules. This module changes actual JSON
//! bytes; CLI configuration and response fields are outside its scope.

use crate::json::{JsonObject, JsonScanError, scan_object};
use serde::{Deserialize, Serialize};
use std::collections::HashSet;
use thiserror::Error;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "state", content = "value", rename_all = "kebab-case")]
pub enum TierField {
    Missing,
    Null,
    String(String),
    /// A valid JSON field whose value is neither a string nor null. No raw value
    /// is retained because it could contain sensitive request contents.
    Invalid,
    /// The field could not be safely observed (invalid/ambiguous JSON, etc.).
    Unavailable,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "type", rename_all = "kebab-case")]
pub enum TierAction {
    Preserve,
    Remove,
    SetIfMissing { value: String },
    Override { value: String },
}

impl<'de> Deserialize<'de> for TierAction {
    fn deserialize<D: serde::Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        // Struct variants enforce deny_unknown_fields even for valueless actions.
        #[derive(Deserialize)]
        #[serde(tag = "type", rename_all = "kebab-case", deny_unknown_fields)]
        enum StrictAction {
            Preserve {},
            Remove {},
            SetIfMissing { value: String },
            Override { value: String },
        }
        Ok(match StrictAction::deserialize(deserializer)? {
            StrictAction::Preserve {} => Self::Preserve,
            StrictAction::Remove {} => Self::Remove,
            StrictAction::SetIfMissing { value } => Self::SetIfMissing { value },
            StrictAction::Override { value } => Self::Override { value },
        })
    }
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RuleMatch {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub route_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub client: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub endpoint: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct TierRule {
    pub id: String,
    #[serde(default = "default_enabled")]
    pub enabled: bool,
    #[serde(default)]
    pub priority: i32,
    #[serde(rename = "match", default)]
    pub match_scope: RuleMatch,
    pub action: TierAction,
}

fn default_enabled() -> bool {
    true
}

#[derive(Debug, Clone, Copy)]
pub struct PolicyContext<'a> {
    pub route_id: &'a str,
    pub client: &'a str,
    pub endpoint: &'a str,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PolicyOutcome {
    pub body: Vec<u8>,
    pub original: TierField,
    pub effective: TierField,
    pub model: Option<String>,
    pub rule_id: Option<String>,
    pub modified: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Error)]
pub enum PolicyError {
    #[error("request body is not valid supported JSON")]
    InvalidJson,
    #[error("request JSON root must be an object")]
    RootNotObject,
    #[error("request JSON contains duplicate object keys")]
    DuplicateKey,
    #[error("rule ID must contain 1 to 64 ASCII identifier characters")]
    InvalidRuleId,
    #[error("rule IDs must be unique")]
    DuplicateRuleId,
    #[error("service_tier value must match [A-Za-z0-9][A-Za-z0-9._-]{{0,63}}")]
    InvalidTierValue,
    #[error("service_tier rewriting is not supported for this endpoint")]
    UnsupportedEndpoint,
}

impl From<JsonScanError> for PolicyError {
    fn from(error: JsonScanError) -> Self {
        match error {
            JsonScanError::InvalidJson => Self::InvalidJson,
            JsonScanError::RootNotObject => Self::RootNotObject,
            JsonScanError::DuplicateKey => Self::DuplicateKey,
        }
    }
}

/// Validate the full configuration before accepting it, including disabled rules.
/// Missing match fields and empty strings both denote an unrestricted scope.
pub fn validate_rules(rules: &[TierRule]) -> Result<(), PolicyError> {
    let mut ids = HashSet::new();
    for rule in rules {
        if !valid_identifier(&rule.id) {
            return Err(PolicyError::InvalidRuleId);
        }
        if !ids.insert(&rule.id) {
            return Err(PolicyError::DuplicateRuleId);
        }
        match &rule.action {
            TierAction::SetIfMissing { value } | TierAction::Override { value }
                if !valid_identifier(value) =>
            {
                return Err(PolicyError::InvalidTierValue);
            }
            _ => (),
        }
    }
    Ok(())
}

fn valid_identifier(value: &str) -> bool {
    let bytes = value.as_bytes();
    (1..=64).contains(&bytes.len())
        && bytes[0].is_ascii_alphanumeric()
        && bytes
            .iter()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b'-'))
}

fn constrained(value: &Option<String>) -> Option<&str> {
    value.as_deref().filter(|value| !value.is_empty())
}

impl RuleMatch {
    fn matches(&self, context: PolicyContext<'_>, model: Option<&str>) -> bool {
        constrained(&self.route_id).is_none_or(|value| value == context.route_id)
            && constrained(&self.client).is_none_or(|value| value == context.client)
            && constrained(&self.endpoint).is_none_or(|value| value == context.endpoint)
            && constrained(&self.model).is_none_or(|value| Some(value) == model)
    }

    fn specificity(&self) -> usize {
        [&self.route_id, &self.client, &self.endpoint, &self.model]
            .iter()
            .filter(|value| constrained(value).is_some())
            .count()
    }
}

/// Observe a JSON response/request without leaking a non-string field value.
/// Invalid JSON, a non-object root, or any duplicate object key is unavailable.
pub fn observe_tier(body: &[u8]) -> TierField {
    scan_object(body)
        .map(|object| field_from_object(body, &object))
        .unwrap_or(TierField::Unavailable)
}

pub fn observe_model(body: &[u8]) -> Option<String> {
    scan_object(body)
        .ok()
        .and_then(|object| model_from_object(body, &object))
}

fn field_from_object(body: &[u8], object: &JsonObject) -> TierField {
    let Some(member) = object.member("service_tier") else {
        return TierField::Missing;
    };
    let value = &body[member.value_start..member.value_end];
    if value == b"null" {
        TierField::Null
    } else if value.first() == Some(&b'"') {
        // scan_object has already validated this token.
        serde_json::from_slice::<String>(value)
            .map(|value| {
                if value.len() <= 64 {
                    TierField::String(value)
                } else {
                    TierField::Unavailable
                }
            })
            .unwrap_or(TierField::Unavailable)
    } else {
        TierField::Invalid
    }
}

fn model_from_object(body: &[u8], object: &JsonObject) -> Option<String> {
    let member = object.member("model")?;
    serde_json::from_slice::<String>(&body[member.value_start..member.value_end])
        .ok()
        .filter(|value| value.len() <= 256 && !value.chars().any(char::is_control))
}

/// Select one rule by priority descending, specificity descending, then original
/// array order. Selection always uses the original model. Preserve retains exact
/// body bytes even if observation is unavailable; explicit actions reject unsafe
/// JSON before any request is sent. Only the two declared OpenAI-style endpoints
/// support rewriting, and unsupported endpoints do not silently drop a rule.
pub fn apply_policy(
    body: &[u8],
    context: PolicyContext<'_>,
    rules: &[TierRule],
) -> Result<PolicyOutcome, PolicyError> {
    validate_rules(rules)?;
    let parsed = scan_object(body);
    let original = parsed
        .as_ref()
        .map(|object| field_from_object(body, object))
        .unwrap_or(TierField::Unavailable);
    let model = parsed
        .as_ref()
        .ok()
        .and_then(|object| model_from_object(body, object));
    let selected = rules
        .iter()
        .enumerate()
        .filter(|(_, rule)| rule.enabled && rule.match_scope.matches(context, model.as_deref()))
        .max_by(|(left_index, left), (right_index, right)| {
            left.priority
                .cmp(&right.priority)
                .then_with(|| {
                    left.match_scope
                        .specificity()
                        .cmp(&right.match_scope.specificity())
                })
                .then_with(|| right_index.cmp(left_index))
        })
        .map(|(_, rule)| rule);
    let mut outcome = PolicyOutcome {
        body: body.to_vec(),
        original: original.clone(),
        effective: original,
        model,
        rule_id: selected.map(|rule| rule.id.clone()),
        modified: false,
    };
    let Some(rule) = selected else {
        return Ok(outcome);
    };
    if matches!(rule.action, TierAction::Preserve) {
        return Ok(outcome);
    }
    if !matches!(context.endpoint, "/v1/responses" | "/v1/chat/completions") {
        return Err(PolicyError::UnsupportedEndpoint);
    }
    let object = parsed.map_err(PolicyError::from)?;
    match &rule.action {
        TierAction::Preserve => (),
        TierAction::Remove => {
            if let Some(index) = object
                .members
                .iter()
                .position(|member| member.key == "service_tier")
            {
                let member = &object.members[index];
                let (start, end) = if index > 0 {
                    (object.members[index - 1].value_end, member.value_end)
                } else if object.members.len() > 1 {
                    (member.key_start, object.members[1].key_start)
                } else {
                    (member.key_start, member.value_end)
                };
                outcome.body = splice(body, start, end, &[]);
                outcome.effective = TierField::Missing;
                outcome.modified = true;
            }
        }
        TierAction::SetIfMissing { value } => {
            if matches!(outcome.original, TierField::Missing) {
                outcome.body = set_field(body, &object, value)?;
                outcome.effective = TierField::String(value.clone());
                outcome.modified = true;
            }
        }
        TierAction::Override { value } => {
            if outcome.original != TierField::String(value.clone()) {
                outcome.body = set_field(body, &object, value)?;
                outcome.effective = TierField::String(value.clone());
                outcome.modified = true;
            }
        }
    }
    Ok(outcome)
}

fn set_field(body: &[u8], object: &JsonObject, value: &str) -> Result<Vec<u8>, PolicyError> {
    let encoded = serde_json::to_vec(value).map_err(|_| PolicyError::InvalidTierValue)?;
    if let Some(member) = object.member("service_tier") {
        Ok(splice(body, member.value_start, member.value_end, &encoded))
    } else {
        let mut added = Vec::new();
        let position = if let Some(last) = object.members.last() {
            added.push(b',');
            last.value_end
        } else {
            object.close
        };
        added.extend_from_slice(b"\"service_tier\":");
        added.extend_from_slice(&encoded);
        Ok(splice(body, position, position, &added))
    }
}

fn splice(body: &[u8], start: usize, end: usize, replacement: &[u8]) -> Vec<u8> {
    let mut rewritten = Vec::with_capacity(body.len() - (end - start) + replacement.len());
    rewritten.extend_from_slice(&body[..start]);
    rewritten.extend_from_slice(replacement);
    rewritten.extend_from_slice(&body[end..]);
    rewritten
}
