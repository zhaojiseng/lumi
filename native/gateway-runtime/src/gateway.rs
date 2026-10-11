//! Fixed stdio engine used by the local development transport. No arbitrary filesystem methods.
use crate::{
    config::{GatewayConfig, Protocol, valid_id},
    observation::ResponseObserver,
    policy::{PolicyContext, TierField, apply_policy},
    recording::{MAX_PAYLOAD_BYTES, RecordPayloads, Recorder, RecordingError, RequestRecord},
};
use base64::{Engine as _, engine::general_purpose::STANDARD};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::{
    collections::{HashMap, HashSet},
    path::Path,
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RouteSecret {
    pub route_id: String,
    pub client_key: String,
    pub upstream_key: String,
}
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Secrets {
    pub record_key_b64: String,
    pub routes: Vec<RouteSecret>,
}
impl Drop for RouteSecret {
    fn drop(&mut self) {
        use zeroize::Zeroize;
        self.client_key.zeroize();
        self.upstream_key.zeroize();
    }
}
impl Drop for Secrets {
    fn drop(&mut self) {
        use zeroize::Zeroize;
        self.record_key_b64.zeroize();
    }
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RequestChain {
    pub provider_id: String,
    pub provider_name: String,
    pub requested_model: Option<String>,
    pub upstream_model: Option<String>,
    pub entry_endpoint: String,
    pub upstream_endpoint: String,
    pub entry_tier: TierField,
    pub config_version: u64,
    pub changes: Vec<crate::rectify::Change>,
    pub changes_truncated: bool,
    pub route_reason: String,
}
struct PreparedRequest {
    body: Vec<u8>,
    entry_body: Vec<u8>,
    original: TierField,
    effective: TierField,
    model: Option<String>,
    rule_id: Option<String>,
    chain: Option<RequestChain>,
    modified: bool,
}
struct Pending {
    record: RequestRecord,
    request: Vec<u8>,
    recording_bodies: bool,
    capture_bytes: usize,
    observation: Option<ResponseObserver>,
    observation_is_sse: Option<bool>,
    observed_bytes: u64,
    observation_elapsed_ms: u64,
}
struct BodySnapshot {
    record_id: String,
    text: String,
    offset: usize,
    complete: bool,
    created: Instant,
}
const BODY_PAGE_BYTES: usize = 64 * 1024;
const BODY_CURSOR_LIMIT: usize = 32;
const BODY_CURSOR_TTL: Duration = Duration::from_secs(300);
const OBSERVATION_BATCH_BYTES: usize = 64 * 1024;
const OBSERVATION_BATCH_SEGMENTS: usize = 256;
pub struct GatewayEngine {
    config: GatewayConfig,
    recorder: Recorder,
    pending: HashMap<String, Pending>,
    config_version: u64,
    body_snapshots: HashMap<String, BodySnapshot>,
}
impl GatewayEngine {
    pub fn open(config: GatewayConfig, db: &Path, key: Option<[u8; 32]>) -> Result<Self, String> {
        config.validate()?;
        if config.recording.bodies && key.is_none() {
            return Err("正文录制需要系统安全存储密钥".into());
        }
        let mut recorder = Recorder::open(
            db,
            key,
            config.recording.retention_days,
            config.recording.max_records,
        )
        .map_err(|_| "记录库初始化失败".to_string())?;
        recorder
            .set_limits(
                config.recording.retention_days,
                config.recording.max_records,
                config.recording.max_bytes,
            )
            .map_err(|_| "记录保留设置失败".to_string())?;
        recorder
            .recover_interrupted()
            .map_err(|_| "中断记录恢复失败".to_string())?;
        Ok(Self {
            config_version: config.config_version,
            config,
            recorder,
            pending: HashMap::new(),
            body_snapshots: HashMap::new(),
        })
    }
    pub fn request(&mut self, method: &str, input: Value) -> Result<Value, String> {
        self.body_snapshots
            .retain(|_, snapshot| snapshot.created.elapsed() < BODY_CURSOR_TTL);
        match method {
            "config.get" => {
                parse::<EmptyInput>(input)?;
                Ok(json!({"configVersion":self.config_version,"config":self.config}))
            }
            "config.validate" => {
                let query: ConfigInput = parse(input)?;
                self.validate_config(&query.config)?;
                Ok(json!({"valid":true}))
            }
            "config.replace" => self.replace_config(parse(input)?),
            "rules.preview" => self.preview(parse(input)?),
            "rectifiers.preview" => self.rectifier_preview(parse(input)?),
            "request.model" => {
                let q: ModelInput = parse(input)?;
                let body = STANDARD.decode(q.body_b64).map_err(|_| "invalid-body")?;
                let config = q.config_snapshot.as_ref().unwrap_or(&self.config);
                self.validate_config(config)?;
                if config.config_version > self.config_version {
                    return Err("config-conflict".into());
                }
                if body.len() > config.max_request_bytes {
                    return Err("body-too-large".into());
                }
                crate::json::scan_object(&body).map_err(|_| "invalid-json-or-policy")?;
                Ok(json!({"model":crate::policy::observe_model(&body)}))
            }
            "records.list.filtered" => self.list_filtered(parse(input)?),
            "records.get" => self.get_record(parse(input)?),
            "records.delete.selection" => self.delete_selection(parse(input)?),
            "prepare" => self.prepare(serde_json::from_value(input).map_err(|_| "invalid-input")?),
            "observe" => self.observe(parse(input)?),
            "finish" => self.finish(serde_json::from_value(input).map_err(|_| "invalid-input")?),
            "records" => {
                let query: ListInput =
                    serde_json::from_value(input).map_err(|_| "invalid-input")?;
                self.recorder.purge().map_err(|_| "recording-failed")?;
                serde_json::to_value(
                    self.recorder
                        .list(query.limit, query.before.as_deref())
                        .map_err(|_| "recording-failed")?,
                )
                .map_err(|_| "recording-failed".into())
            }
            "delete" => {
                let query: IdInput = serde_json::from_value(input).map_err(|_| "invalid-input")?;
                self.body_snapshots
                    .retain(|_, snapshot| snapshot.record_id != query.id);
                self.recorder
                    .delete(&query.id)
                    .map_err(|_| "recording-failed")?;
                Ok(json!({"deleted":true}))
            }
            "status" => {
                parse::<EmptyInput>(input)?;
                Ok(
                    json!({"protocolVersion":1,"pending":self.pending.len(),"recordingBodies":self.config.recording.bodies,"configVersion":self.config_version}),
                )
            }
            _ => Err("unsupported-method".into()),
        }
    }
    fn validate_config(&self, config: &GatewayConfig) -> Result<(), String> {
        config
            .validate()
            .map_err(|_| "invalid-config".to_string())?;
        if config.recording.bodies && !self.recorder.encryption_available() {
            return Err("encryption-unavailable".into());
        }
        Ok(())
    }

    fn replace_config(&mut self, input: ReplaceInput) -> Result<Value, String> {
        if input.expected_version != self.config_version {
            return Err("config-conflict".into());
        }
        self.validate_config(&input.config)?;
        let version = self
            .config_version
            .checked_add(1)
            .filter(|version| *version <= 2_147_483_647)
            .ok_or("config-version-limit")?;
        self.recorder
            .set_limits(
                input.config.recording.retention_days,
                input.config.recording.max_records,
                input.config.recording.max_bytes,
            )
            .map_err(recording_error)?;
        if !input.config.recording.bodies {
            self.body_snapshots.clear();
        }
        // Pending requests own their policy result and recording options; only new prepare calls
        // use the replacement configuration.
        self.config = input.config;
        self.config.config_version = version;
        self.config_version = version;
        Ok(json!({"configVersion":version}))
    }

    /// Persistence is the commit point. No SQLite operation may fail after it.
    pub fn commit_configuration<F>(
        &mut self,
        expected: u64,
        config: GatewayConfig,
        persist: F,
    ) -> Result<Value, String>
    where
        F: FnOnce() -> Result<u64, String>,
    {
        if expected != self.config_version {
            return Err("config-conflict".into());
        }
        self.validate_config(&config)?;
        if expected.checked_add(1) != Some(config.config_version) {
            return Err("invalid-config-version".into());
        }
        let version = persist()?;
        self.recorder.adopt_limits(
            config.recording.retention_days,
            config.recording.max_records,
            config.recording.max_bytes,
        );
        if !config.recording.bodies {
            self.body_snapshots.clear();
        }
        self.config = config;
        self.config_version = version;
        Ok(json!({"configVersion":version}))
    }
    fn preview(&self, input: PreviewInput) -> Result<Value, String> {
        if !valid_id(&input.route_id)
            || !supported_endpoint(&input.endpoint)
            || input
                .model
                .as_deref()
                .is_some_and(|model| !safe_text(model, 256))
        {
            return Err("invalid-input".into());
        }
        let route = self
            .config
            .routes
            .iter()
            .find(|route| route.id == input.route_id)
            .ok_or("unknown-route")?;
        let original = strict_tier(input.original_tier)?;
        if matches!(original, TierField::Unavailable) {
            return Ok(
                json!({"original":original,"effective":original,"ruleId":null,
                "modified":false,"compatible":false,"warningCode":"tier-unavailable"}),
            );
        }
        let mut body = serde_json::Map::new();
        if let Some(model) = input.model {
            body.insert("model".into(), json!(model));
        }
        match &original {
            TierField::Missing => (),
            TierField::Null => {
                body.insert("service_tier".into(), Value::Null);
            }
            TierField::String(value) => {
                body.insert("service_tier".into(), json!(value));
            }
            TierField::Invalid => {
                body.insert("service_tier".into(), json!(false));
            }
            TierField::Unavailable => unreachable!(),
        }
        let body = serde_json::to_vec(&body).map_err(|_| "invalid-input")?;
        let rules = if !route.supports_service_tier() {
            &[][..]
        } else {
            &self.config.rules[..]
        };
        match apply_policy(
            &body,
            PolicyContext {
                route_id: &route.id,
                client: &route.client,
                endpoint: &input.endpoint,
            },
            rules,
        ) {
            Ok(outcome) => {
                let mut result = json!({"original":outcome.original,"effective":outcome.effective,
                    "ruleId":outcome.rule_id,"modified":outcome.modified,"compatible":true});
                if route.protocol == Protocol::Anthropic {
                    result["compatible"] = json!(false);
                    result["warningCode"] = json!("tier-unsupported-protocol");
                } else if !route.supports_service_tier() {
                    result["compatible"] = json!(false);
                    result["warningCode"] = json!("tier-unsupported-route");
                } else if !route.enabled {
                    result["compatible"] = json!(false);
                    result["warningCode"] = json!("route-disabled");
                }
                Ok(result)
            }
            Err(_) => Ok(
                json!({"original":original,"effective":original,"ruleId":null,
                "modified":false,"compatible":false,"warningCode":"tier-unsupported-endpoint"}),
            ),
        }
    }

    fn filtered_records(&mut self, filter: &RecordFilter) -> Result<Vec<RequestRecord>, String> {
        filter.validate()?;
        self.recorder.purge().map_err(recording_error)?;
        Ok(self
            .recorder
            .bounded_records()
            .map_err(recording_error)?
            .into_iter()
            .filter(|record| filter.matches(record))
            .collect())
    }

    fn list_filtered(&mut self, input: FilterListInput) -> Result<Value, String> {
        if !(1..=100).contains(&input.limit) {
            return Err("invalid-input".into());
        }
        if input
            .cursor
            .as_deref()
            .is_some_and(|id| uuid::Uuid::parse_str(id).is_err())
        {
            return Err("invalid-input".into());
        }
        let records = self.filtered_records(&input.filter)?;
        let offset = match input.cursor {
            Some(cursor) => records
                .iter()
                .position(|record| record.id == cursor)
                .map(|position| position + 1)
                .ok_or("invalid-cursor")?,
            None => 0,
        };
        let page: Vec<_> = records
            .iter()
            .skip(offset)
            .take(input.limit)
            .cloned()
            .collect();
        let next = if offset + page.len() < records.len() {
            page.last().map(|record| record.id.clone())
        } else {
            None
        };
        Ok(json!({"records":page,"nextCursor":next}))
    }

    fn get_record(&mut self, input: GetInput) -> Result<Value, String> {
        if uuid::Uuid::parse_str(&input.record_id).is_err()
            || input
                .body_cursor
                .as_deref()
                .is_some_and(|cursor| uuid::Uuid::parse_str(cursor).is_err())
            || (!input.include_body && input.body_cursor.is_some())
        {
            return Err("invalid-input".into());
        }
        self.recorder.purge().map_err(recording_error)?;
        let record = self
            .recorder
            .get(&input.record_id)
            .map_err(recording_error)?
            .ok_or("record-not-found")?;
        if !input.include_body {
            return Ok(json!({"record":record,"body":null}));
        }
        if !self.config.recording.bodies {
            return Err("recording-disabled".into());
        }
        let snapshot = if let Some(cursor) = input.body_cursor {
            let old = self.body_snapshots.get(&cursor).ok_or("invalid-cursor")?;
            if old.record_id != input.record_id {
                return Err("invalid-cursor".into());
            }
            self.body_snapshots
                .remove(&cursor)
                .ok_or("invalid-cursor")?
        } else {
            let Some(payloads) = self
                .recorder
                .read_payloads(&input.record_id)
                .map_err(recording_error)?
            else {
                return Ok(json!({"record":record,"body":null}));
            };
            let request = String::from_utf8(payloads.request).map_err(|_| "recording-failed")?;
            let response = String::from_utf8(payloads.response).map_err(|_| "recording-failed")?;
            let text = serde_json::to_string_pretty(&json!({"request":request,"response":response,
                "responseIsSse":payloads.response_is_sse}))
            .map_err(|_| "recording-failed")?;
            BodySnapshot {
                record_id: input.record_id,
                text,
                offset: 0,
                complete: !record.recording_partial,
                created: Instant::now(),
            }
        };
        let mut end = (snapshot.offset + BODY_PAGE_BYTES).min(snapshot.text.len());
        while !snapshot.text.is_char_boundary(end) {
            end -= 1;
        }
        let text = snapshot.text[snapshot.offset..end].to_owned();
        let more = end < snapshot.text.len();
        let complete = snapshot.complete && !more;
        let truncated = !snapshot.complete || more;
        let next = if more {
            if self.body_snapshots.len() >= BODY_CURSOR_LIMIT {
                if let Some(oldest) = self
                    .body_snapshots
                    .iter()
                    .min_by_key(|(_, snapshot)| snapshot.created)
                    .map(|(id, _)| id.clone())
                {
                    self.body_snapshots.remove(&oldest);
                }
            }
            let cursor = uuid::Uuid::new_v4().to_string();
            self.body_snapshots.insert(
                cursor.clone(),
                BodySnapshot {
                    offset: end,
                    ..snapshot
                },
            );
            Some(cursor)
        } else {
            None
        };
        Ok(
            json!({"record":record,"body":{"text":text,"nextCursor":next,
            "redacted":true,"encrypted":true,"truncated":truncated,"complete":complete}}),
        )
    }

    fn delete_selection(&mut self, input: DeleteSelectionInput) -> Result<Value, String> {
        let ids = match input.selection {
            RecordSelection::Ids { record_ids } => {
                let mut distinct = HashSet::new();
                if record_ids.is_empty()
                    || record_ids.len() > 100
                    || record_ids.iter().any(|id| {
                        uuid::Uuid::parse_str(id).is_err() || !distinct.insert(id.clone())
                    })
                {
                    return Err("invalid-input".into());
                }
                record_ids
            }
            RecordSelection::Filter { filter, through_ms } => {
                if through_ms > now_ms() || through_ms > i64::MAX as u64 {
                    return Err("invalid-input".into());
                }
                self.filtered_records(&filter)?
                    .into_iter()
                    .filter(|record| record.started_at_ms <= through_ms)
                    .map(|record| record.id)
                    .collect()
            }
        };
        let deleted = self.recorder.delete_many(&ids).map_err(recording_error)?;
        self.body_snapshots
            .retain(|_, snapshot| !ids.contains(&snapshot.record_id));
        Ok(json!({"deleted":deleted}))
    }

    fn transform(
        &self,
        route_id: &str,
        endpoint: &str,
        body: &[u8],
        client: &str,
        route_reason: &str,
    ) -> Result<PreparedRequest, String> {
        Self::transform_config(
            &self.config,
            self.config_version,
            route_id,
            endpoint,
            body,
            client,
            route_reason,
        )
    }
    fn transform_config(
        config: &GatewayConfig,
        config_version: u64,
        route_id: &str,
        endpoint: &str,
        body: &[u8],
        client: &str,
        route_reason: &str,
    ) -> Result<PreparedRequest, String> {
        use crate::{
            policy::{observe_model, observe_tier},
            rectify::{self, Change, Context, Stage},
        };
        let route = config
            .routes
            .iter()
            .find(|r| r.id == route_id)
            .ok_or("unknown-route")?;
        let extended = route.name.is_some()
            || !route.models.is_empty()
            || !route.entry_endpoints.is_empty()
            || route.upstream_endpoint.is_some()
            || !config.rectifiers.is_empty()
            || !config.agents.is_empty();
        if !route.enabled {
            return Err("route-disabled".into());
        }
        if !route.entry_endpoints.is_empty() && !route.entry_endpoints.iter().any(|e| e == endpoint)
        {
            return Err("unsupported-endpoint".into());
        }
        let requested = observe_model(body);
        let (entry, mut changes) = rectify::apply(
            body,
            Stage::Entry,
            Context {
                route_id,
                client,
                endpoint,
                model: requested.as_deref(),
            },
            &config.rectifiers,
        )?;
        let entry_tier = observe_tier(&entry);
        let model = if route.models.is_empty() {
            requested.clone()
        } else {
            let m = route
                .models
                .iter()
                .find(|m| m.enabled && Some(m.id.as_str()) == requested.as_deref())
                .or_else(|| {
                    route.models.iter().find(|m| {
                        m.enabled && Some(m.upstream_model.as_str()) == requested.as_deref()
                    })
                })
                .ok_or("model-not-configured")?;
            Some(m.upstream_model.clone())
        };
        let upstream_endpoint = route.upstream_endpoint.as_deref().unwrap_or_else(|| {
            if route.protocol == Protocol::Anthropic {
                "/v1/messages"
            } else if endpoint == "/v1/messages" {
                "/v1/chat/completions"
            } else {
                endpoint
            }
        });
        let mapped = if model != requested {
            rectify::set_path(
                &entry,
                &["model"],
                model.as_ref().map(|v| json!(v)).as_ref(),
            )?
        } else {
            entry.clone()
        };
        let converted = crate::protocol::convert(&mapped, endpoint, upstream_endpoint)?;
        let rules = if route.supports_service_tier() {
            &config.rules[..]
        } else {
            &[][..]
        };
        let legacy = apply_policy(
            &converted,
            PolicyContext {
                route_id,
                client,
                endpoint: upstream_endpoint,
            },
            rules,
        )
        .map_err(|_| "invalid-json-or-policy")?;
        if let Some(id) = &legacy.rule_id {
            changes.push(Change {
                stage: Stage::Model,
                field: "/service_tier".into(),
                rule_id: id.clone(),
                action: "legacy-tier".into(),
                changed: legacy.modified,
            });
        }
        let (sent, model_changes) = rectify::apply(
            &legacy.body,
            Stage::Model,
            Context {
                route_id,
                client,
                endpoint: upstream_endpoint,
                model: requested.as_deref(),
            },
            &config.rectifiers,
        )?;
        changes.extend(model_changes);
        if extended && upstream_endpoint == "/v1/messages" {
            let value: Value =
                serde_json::from_slice(&sent).map_err(|_| "invalid-json-or-policy")?;
            if endpoint != upstream_endpoint && value["max_tokens"].as_u64().is_none_or(|n| n == 0)
            {
                return Err("conversion-max-tokens-required".into());
            }
            if !value["service_tier"].is_null()
                && !matches!(
                    value["service_tier"].as_str(),
                    Some("auto" | "standard_only")
                )
            {
                return Err("invalid-anthropic-tier".into());
            }
        }
        if sent.len() > config.max_request_bytes + 16 * 1024 {
            return Err("body-too-large".into());
        }
        let truncated = changes.len() > 16;
        let chain = extended.then(|| RequestChain {
            provider_id: route.id.clone(),
            provider_name: route.name.clone().unwrap_or_else(|| route.id.clone()),
            requested_model: requested,
            upstream_model: model.clone(),
            entry_endpoint: endpoint.into(),
            upstream_endpoint: upstream_endpoint.into(),
            entry_tier,
            config_version,
            changes: changes.into_iter().take(16).collect(),
            changes_truncated: truncated,
            route_reason: route_reason.into(),
        });
        let effective = observe_tier(&sent);
        let original = if extended {
            observe_tier(body)
        } else {
            legacy.original
        };
        Ok(PreparedRequest {
            modified: sent != body,
            body: sent,
            entry_body: entry,
            original,
            effective,
            model,
            rule_id: legacy.rule_id,
            chain,
        })
    }
    fn rectifier_preview(&self, input: RectifierPreviewInput) -> Result<Value, String> {
        if input.body.len() > 64 * 1024 || !supported_endpoint(&input.endpoint) {
            return Err("invalid-input".into());
        }
        let route = self
            .config
            .routes
            .iter()
            .find(|r| r.id == input.route_id)
            .ok_or("unknown-route")?;
        let client = input.client_alias.as_deref().unwrap_or(&route.client);
        if !valid_id(client) {
            return Err("invalid-input".into());
        }
        let result = self.transform(
            &input.route_id,
            &input.endpoint,
            input.body.as_bytes(),
            client,
            "preview",
        )?;
        Ok(
            json!({"originalBody":input.body,"entryBody":String::from_utf8(result.entry_body).map_err(|_|"invalid-input")?,
            "sentBody":String::from_utf8(result.body).map_err(|_|"invalid-input")?,"chain":result.chain,"modified":result.modified}),
        )
    }
    fn prepare(&mut self, input: PrepareInput) -> Result<Value, String> {
        // The private transport captures this immutable configuration before reading a body.
        let config = input.config_snapshot.as_ref().unwrap_or(&self.config);
        self.validate_config(config)?;
        let captured = input.config_snapshot.is_some();
        if captured
            && (input.expected_config_version != Some(config.config_version)
                || config.config_version > self.config_version)
        {
            return Err("config-conflict".into());
        }
        if !captured && self.pending.len() >= config.max_concurrency {
            return Err("too-many-requests".into());
        }
        if self.pending.contains_key(&input.request_id)
            || uuid::Uuid::parse_str(&input.request_id).is_err()
        {
            return Err("invalid-request-id".into());
        }
        let route = config
            .routes
            .iter()
            .find(|r| r.id == input.route_id)
            .ok_or("unknown-route")?;
        if !route.enabled {
            return Err("route-disabled".into());
        }
        if !matches!(
            input.endpoint.as_str(),
            "/v1/responses" | "/v1/chat/completions" | "/v1/messages"
        ) {
            return Err("unsupported-endpoint".into());
        }
        let body = STANDARD
            .decode(&input.body_b64)
            .map_err(|_| "invalid-body")?;
        if body.len() > config.max_request_bytes {
            return Err("body-too-large".into());
        }
        let client = input.client_alias.as_deref().unwrap_or(&route.client);
        if !valid_id(client)
            || !matches!(
                input.route_reason.as_deref().unwrap_or("explicit-provider"),
                "explicit-provider" | "model-match"
            )
        {
            return Err("invalid-input".into());
        }
        if !captured
            && input
                .expected_config_version
                .is_some_and(|v| v != self.config_version)
        {
            return Err("config-conflict".into());
        }
        let outcome = Self::transform_config(
            config,
            config.config_version,
            &route.id,
            &input.endpoint,
            &body,
            client,
            input.route_reason.as_deref().unwrap_or("explicit-provider"),
        )?;
        let mut record = RequestRecord {
            id: input.request_id.clone(),
            started_at_ms: input.started_at_ms,
            route_id: route.id.clone(),
            client: client.into(),
            endpoint: input.endpoint,
            model: outcome.model.clone(),
            status: "forwarding".into(),
            http_status: None,
            original: outcome.original.clone(),
            effective: outcome.effective.clone(),
            reported: TierField::Unavailable,
            rule_id: outcome.rule_id.clone(),
            request_bytes: body.len() as u64,
            response_bytes: 0,
            duration_ms: 0,
            first_response_ms: None,
            first_content_ms: None,
            input_tokens: None,
            output_tokens: None,
            cache_read_tokens: None,
            cache_write_tokens: None,
            recording_partial: matches!(&outcome.original, TierField::Unavailable)
                || matches!(&outcome.effective, TierField::Unavailable),
            error_code: None,
            chain: outcome.chain.clone(),
        };
        // Recording failure must not block forwarding, and must be visible to the transport.
        let recording_ok = self.recorder.save(&record, None).is_ok();
        record.recording_partial |= !recording_ok;
        let mut result = json!({"bodyB64":STANDARD.encode(&outcome.body),"original":outcome.original,"effective":outcome.effective,
            "model":outcome.model,"ruleId":outcome.rule_id,"modified":outcome.modified,"recordingOk":recording_ok, "chain":outcome.chain});
        if result["chain"].is_null() {
            result
                .as_object_mut()
                .ok_or("invalid-input")?
                .remove("chain");
        }
        self.pending.insert(
            input.request_id,
            Pending {
                record,
                request: body,
                recording_bodies: config.recording.bodies,
                capture_bytes: config.recording.capture_bytes,
                observation: None,
                observation_is_sse: None,
                observed_bytes: 0,
                observation_elapsed_ms: 0,
            },
        );
        Ok(result)
    }
    /// Private data-plane observation only: tied to one prepared request, contiguous bytes,
    /// fixed protocol, monotonic timings and a bounded batch. No metadata/body is returned.
    fn observe(&mut self, input: ObserveInput) -> Result<Value, String> {
        let pending = self
            .pending
            .get(&input.request_id)
            .ok_or("unknown-request")?;
        if input.offset_bytes != pending.observed_bytes {
            return Err("invalid-observation-offset".into());
        }
        if pending
            .observation_is_sse
            .is_some_and(|sse| sse != input.response_is_sse)
        {
            return Err("invalid-observation-protocol".into());
        }
        if input.segments.is_empty() || input.segments.len() > OBSERVATION_BATCH_SEGMENTS {
            return Err("invalid-observation-batch".into());
        }
        let mut decoded = Vec::with_capacity(input.segments.len());
        let mut bytes = 0usize;
        let mut elapsed = pending.observation_elapsed_ms;
        for segment in input.segments {
            if segment.elapsed_ms < elapsed || segment.elapsed_ms > 24 * 60 * 60 * 1000 {
                return Err("invalid-timing".into());
            }
            elapsed = segment.elapsed_ms;
            if segment.data_b64.len() > (OBSERVATION_BATCH_BYTES.div_ceil(3) * 4) {
                return Err("invalid-observation-batch".into());
            }
            let chunk = STANDARD
                .decode(segment.data_b64)
                .map_err(|_| "invalid-segment")?;
            bytes = bytes
                .checked_add(chunk.len())
                .ok_or("invalid-observation-batch")?;
            if chunk.is_empty() || bytes > OBSERVATION_BATCH_BYTES {
                return Err("invalid-observation-batch".into());
            }
            decoded.push((chunk, segment.elapsed_ms));
        }
        let next_bytes = pending
            .observed_bytes
            .checked_add(bytes as u64)
            .ok_or("invalid-byte-count")?;
        // Validate the complete batch before advancing any state; retries cannot duplicate bytes.
        let pending = self
            .pending
            .get_mut(&input.request_id)
            .ok_or("unknown-request")?;
        let observer = pending
            .observation
            .get_or_insert_with(|| ResponseObserver::new(input.response_is_sse, 0));
        for (chunk, elapsed) in decoded {
            observer.push(&chunk, elapsed);
        }
        pending.observation_is_sse = Some(input.response_is_sse);
        pending.observed_bytes = next_bytes;
        pending.observation_elapsed_ms = elapsed;
        Ok(json!({"observedBytes":next_bytes}))
    }
    fn finish(&mut self, input: FinishInput) -> Result<Value, String> {
        if !self.pending.contains_key(&input.request_id) {
            return Err("unknown-request".into());
        }
        if !matches!(
            input.status.as_str(),
            "completed"
                | "upstream-error"
                | "client-aborted"
                | "interrupted"
                | "execution-unknown"
                | "gateway-rejected"
        ) {
            return Err("invalid-status".into());
        }
        if input
            .error_code
            .as_deref()
            .is_some_and(|code| !valid_id(code))
        {
            return Err("invalid-error-code".into());
        }
        if input
            .http_status
            .is_some_and(|status| !(100..=599).contains(&status))
        {
            return Err("invalid-http-status".into());
        }
        if input
            .first_response_ms
            .is_some_and(|elapsed| elapsed > input.duration_ms)
        {
            return Err("invalid-timing".into());
        }
        if input.segments.len() > 16384 {
            return Err("too-many-segments".into());
        }
        let mut observer = ResponseObserver::new(input.response_is_sse, MAX_PAYLOAD_BYTES);
        let mut seen = 0usize;
        let mut previous_elapsed = 0;
        for segment in input.segments {
            if segment.elapsed_ms < previous_elapsed || segment.elapsed_ms > input.duration_ms {
                return Err("invalid-timing".into());
            }
            previous_elapsed = segment.elapsed_ms;
            let chunk = STANDARD
                .decode(segment.data_b64)
                .map_err(|_| "invalid-segment")?;
            seen = seen.checked_add(chunk.len()).ok_or("body-too-large")?;
            if seen > MAX_PAYLOAD_BYTES {
                return Err("body-too-large".into());
            }
            observer.push(&chunk, segment.elapsed_ms);
        }
        if (seen as u64) > input.response_bytes {
            return Err("invalid-byte-count".into());
        }
        let pending = self
            .pending
            .get(&input.request_id)
            .ok_or("unknown-request")?;
        if pending.observed_bytes > input.response_bytes
            || pending.observation_elapsed_ms > input.duration_ms
        {
            return Err("invalid-observation-finish".into());
        }
        if pending.observation.is_some() && !input.streaming_observation {
            return Err("invalid-observation-finish".into());
        }
        if pending
            .observation_is_sse
            .is_some_and(|sse| sse != input.response_is_sse)
        {
            return Err("invalid-observation-protocol".into());
        }
        // A malformed finish message must not consume an in-flight request.
        let mut pending = self
            .pending
            .remove(&input.request_id)
            .ok_or("unknown-request")?;
        let response_payload = observer.payload();
        let mut observation = if input.streaming_observation {
            pending
                .observation
                .take()
                .unwrap_or_else(|| ResponseObserver::new(input.response_is_sse, 0))
        } else {
            observer
        };
        observation.finish();
        if input.observation_partial
            || (input.streaming_observation && pending.observed_bytes < input.response_bytes)
        {
            observation.invalidate_final_observations();
        }
        let summary = observation.summary();
        pending.record.status = input.status;
        pending.record.http_status = input.http_status;
        pending.record.duration_ms = input.duration_ms;
        pending.record.first_response_ms = input.first_response_ms;
        pending.record.response_bytes = input.response_bytes;
        pending.record.reported = summary.reported;
        pending.record.first_content_ms = summary.first_content_ms;
        pending.record.input_tokens = summary.input_tokens;
        pending.record.output_tokens = summary.output_tokens;
        pending.record.cache_read_tokens = summary.cache_read_tokens;
        pending.record.cache_write_tokens = summary.cache_write_tokens;
        pending.record.error_code = input.error_code;
        pending.record.recording_partial |=
            input.recording_partial || summary.partial || (seen as u64) < input.response_bytes;
        let payloads = pending.recording_bodies.then(|| {
            let response = response_payload;
            let request = if pending.request.len() > pending.capture_bytes {
                pending.record.recording_partial = true;
                Vec::new()
            } else {
                pending.request
            };
            let response = if response.len() > pending.capture_bytes {
                pending.record.recording_partial = true;
                Vec::new()
            } else {
                response
            };
            RecordPayloads {
                request,
                response,
                response_is_sse: input.response_is_sse,
            }
        });
        let (recording_ok, recording_partial) =
            match self.recorder.save(&pending.record, payloads.as_ref()) {
                Ok(outcome) => (true, outcome.recording_partial),
                Err(_) => (false, true),
            };
        let mut result = json!({"recordingOk":recording_ok,"observationPartial":summary.partial,
            "recordingPartial":recording_partial,"requestId":pending.record.id});
        if pending.record.chain.is_some() {
            result["record"] = json!(pending.record);
        }
        Ok(result)
    }
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct PrepareInput {
    route_id: String,
    endpoint: String,
    body_b64: String,
    started_at_ms: u64,
    request_id: String,
    #[serde(default)]
    client_alias: Option<String>,
    #[serde(default)]
    route_reason: Option<String>,
    #[serde(default)]
    expected_config_version: Option<u64>,
    #[serde(default)]
    config_snapshot: Option<GatewayConfig>,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct FinishInput {
    request_id: String,
    status: String,
    http_status: Option<u16>,
    duration_ms: u64,
    first_response_ms: Option<u64>,
    response_bytes: u64,
    response_is_sse: bool,
    recording_partial: bool,
    #[serde(default)]
    streaming_observation: bool,
    #[serde(default)]
    observation_partial: bool,
    error_code: Option<String>,
    segments: Vec<Segment>,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ObserveInput {
    request_id: String,
    response_is_sse: bool,
    offset_bytes: u64,
    segments: Vec<Segment>,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Segment {
    data_b64: String,
    elapsed_ms: u64,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct ListInput {
    limit: usize,
    before: Option<String>,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct IdInput {
    id: String,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct EmptyInput {}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct ConfigInput {
    config: GatewayConfig,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ReplaceInput {
    expected_version: u64,
    config: GatewayConfig,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct PreviewInput {
    route_id: String,
    endpoint: String,
    model: Option<String>,
    original_tier: Value,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct RectifierPreviewInput {
    route_id: String,
    endpoint: String,
    body: String,
    client_alias: Option<String>,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ModelInput {
    body_b64: String,
    #[serde(default)]
    config_snapshot: Option<GatewayConfig>,
}
#[derive(Default, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct RecordFilter {
    route_id: Option<String>,
    client_alias: Option<String>,
    model: Option<String>,
    endpoint: Option<String>,
    status: Option<String>,
    from_ms: Option<u64>,
    to_ms: Option<u64>,
    tier: Option<String>,
}
impl RecordFilter {
    fn validate(&self) -> Result<(), String> {
        if [&self.route_id, &self.client_alias, &self.tier]
            .into_iter()
            .flatten()
            .any(|value| !valid_id(value))
            || self
                .model
                .as_deref()
                .is_some_and(|value| !safe_text(value, 256))
            || self
                .endpoint
                .as_deref()
                .is_some_and(|value| !supported_endpoint(value))
            || self.status.as_deref().is_some_and(|value| {
                !matches!(
                    value,
                    "forwarding"
                        | "completed"
                        | "upstream-error"
                        | "client-aborted"
                        | "interrupted"
                        | "execution-unknown"
                        | "gateway-rejected"
                )
            })
            || [self.from_ms, self.to_ms]
                .into_iter()
                .flatten()
                .any(|value| value > i64::MAX as u64)
            || self
                .from_ms
                .zip(self.to_ms)
                .is_some_and(|(from, to)| from > to)
        {
            return Err("invalid-input".into());
        }
        Ok(())
    }
    fn matches(&self, record: &RequestRecord) -> bool {
        self.route_id
            .as_deref()
            .is_none_or(|value| value == record.route_id)
            && self
                .client_alias
                .as_deref()
                .is_none_or(|value| value == record.client)
            && self
                .model
                .as_deref()
                .is_none_or(|value| Some(value) == record.model.as_deref())
            && self
                .endpoint
                .as_deref()
                .is_none_or(|value| value == record.endpoint)
            && self
                .status
                .as_deref()
                .is_none_or(|value| value == record.status)
            && self
                .from_ms
                .is_none_or(|value| record.started_at_ms >= value)
            && self.to_ms.is_none_or(|value| record.started_at_ms <= value)
            && self
                .tier
                .as_deref()
                .is_none_or(|value| record.effective == TierField::String(value.to_owned()))
    }
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct FilterListInput {
    #[serde(default)]
    filter: RecordFilter,
    cursor: Option<String>,
    limit: usize,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct GetInput {
    record_id: String,
    #[serde(default)]
    include_body: bool,
    body_cursor: Option<String>,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct DeleteSelectionInput {
    selection: RecordSelection,
}
#[derive(Deserialize)]
#[serde(untagged, deny_unknown_fields)]
enum RecordSelection {
    Ids {
        #[serde(rename = "recordIds")]
        record_ids: Vec<String>,
    },
    Filter {
        filter: RecordFilter,
        #[serde(rename = "throughMs")]
        through_ms: u64,
    },
}
fn parse<T: serde::de::DeserializeOwned>(input: Value) -> Result<T, String> {
    serde_json::from_value(input).map_err(|_| "invalid-input".into())
}
fn recording_error(error: RecordingError) -> String {
    match error {
        RecordingError::RecordLimit => "records-limit",
        RecordingError::InvalidCursor => "invalid-cursor",
        RecordingError::InvalidLimit
        | RecordingError::InvalidRecord
        | RecordingError::InvalidConfiguration => "invalid-input",
        RecordingError::EncryptionUnavailable => "encryption-unavailable",
        _ => "recording-failed",
    }
    .into()
}
fn supported_endpoint(value: &str) -> bool {
    matches!(
        value,
        "/v1/responses" | "/v1/chat/completions" | "/v1/messages"
    )
}
fn safe_text(value: &str, max: usize) -> bool {
    !value.is_empty() && value.len() <= max && !value.chars().any(char::is_control)
}
fn strict_tier(value: Value) -> Result<TierField, String> {
    let object = value.as_object().ok_or("invalid-input")?;
    let state = object
        .get("state")
        .and_then(Value::as_str)
        .ok_or("invalid-input")?;
    if object.keys().any(|key| key != "state" && key != "value") {
        return Err("invalid-input".into());
    }
    if state == "string" {
        let text = object
            .get("value")
            .and_then(Value::as_str)
            .filter(|value| valid_id(value))
            .ok_or("invalid-input")?;
        Ok(TierField::String(text.to_owned()))
    } else {
        if object.contains_key("value") {
            return Err("invalid-input".into());
        }
        match state {
            "missing" => Ok(TierField::Missing),
            "null" => Ok(TierField::Null),
            "invalid" => Ok(TierField::Invalid),
            "unavailable" => Ok(TierField::Unavailable),
            _ => Err("invalid-input".into()),
        }
    }
}
fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
        .min(i64::MAX as u128) as u64
}
