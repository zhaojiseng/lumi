use crate::policy::{TierRule, validate_rules};
use serde::{Deserialize, Serialize};
use std::net::SocketAddr;
use url::Url;

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct GatewayConfig {
    pub schema_version: u32,
    /// Persisted optimistic version. Old standalone configurations start at one.
    #[serde(default = "default_config_version")]
    pub config_version: u64,
    pub listen: SocketAddr,
    pub routes: Vec<RouteConfig>,
    #[serde(default)]
    pub rules: Vec<TierRule>,
    #[serde(default)]
    pub recording: RecordingConfig,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub rectifiers: Vec<crate::rectify::Rule>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub agents: Vec<AgentConfig>,
    #[serde(default = "default_request_limit")]
    pub max_request_bytes: usize,
    #[serde(default = "default_concurrency")]
    pub max_concurrency: usize,
}
fn default_config_version() -> u64 {
    1
}
fn default_enabled() -> bool {
    true
}
fn default_request_limit() -> usize {
    2 * 1024 * 1024
}
fn default_concurrency() -> usize {
    32
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RouteConfig {
    pub id: String,
    pub client: String,
    #[serde(default = "default_enabled")]
    pub enabled: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub service_tier: Option<bool>,
    /// Fixed upstream origin/base path, including /v1 when required.
    pub upstream: Url,
    #[serde(default)]
    pub protocol: Protocol,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub models: Vec<ModelConfig>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub entry_endpoints: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub upstream_endpoint: Option<String>,
}
impl RouteConfig {
    pub fn supports_service_tier(&self) -> bool {
        self.protocol == Protocol::Openai && self.service_tier.unwrap_or(true)
    }
}
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ModelConfig {
    pub id: String,
    pub upstream_model: String,
    pub enabled: bool,
}
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AgentConfig {
    pub id: String,
    pub name: String,
    pub credential_ref: String,
    pub provider_ids: Vec<String>,
    pub enabled: bool,
}
pub fn endpoint_valid(value: &str) -> bool {
    matches!(
        value,
        "/v1/responses" | "/v1/chat/completions" | "/v1/messages"
    )
}
fn text_valid(value: &str, max: usize) -> bool {
    !value.trim().is_empty() && value.len() <= max && !value.chars().any(char::is_control)
}
#[derive(Clone, Copy, Debug, Default, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum Protocol {
    #[default]
    Openai,
    Anthropic,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RecordingConfig {
    #[serde(default)]
    pub bodies: bool,
    #[serde(default = "default_retention")]
    pub retention_days: u32,
    #[serde(default = "default_record_count")]
    pub max_records: usize,
    #[serde(default = "default_max_bytes")]
    pub max_bytes: u64,
    #[serde(default = "default_capture_bytes")]
    pub capture_bytes: usize,
}
fn default_max_bytes() -> u64 {
    1024 * 1024 * 1024
}
fn default_capture_bytes() -> usize {
    crate::recording::MAX_PAYLOAD_BYTES
}
fn default_retention() -> u32 {
    7
}
fn default_record_count() -> usize {
    10_000
}
impl Default for RecordingConfig {
    fn default() -> Self {
        Self {
            bodies: false,
            retention_days: default_retention(),
            max_records: default_record_count(),
            max_bytes: default_max_bytes(),
            capture_bytes: default_capture_bytes(),
        }
    }
}
impl GatewayConfig {
    pub fn validate(&self) -> Result<(), String> {
        if self.schema_version != 1 || !(1..=2_147_483_647).contains(&self.config_version) {
            return Err("不支持的配置版本".into());
        }
        if !self.listen.ip().is_loopback() {
            return Err("网关只允许监听 loopback".into());
        }
        if self.routes.is_empty() || self.routes.len() > 32 {
            return Err("路由数量应为 1–32".into());
        }
        if !(1..=128).contains(&self.max_concurrency)
            || !(1..=4 * 1024 * 1024).contains(&self.max_request_bytes)
        {
            return Err("并发或请求体限制无效".into());
        }
        if !(1..=365).contains(&self.recording.retention_days)
            || !(1..=100_000).contains(&self.recording.max_records)
            || !(1024 * 1024..=10 * 1024 * 1024 * 1024).contains(&self.recording.max_bytes)
            || !(1..=crate::recording::MAX_PAYLOAD_BYTES).contains(&self.recording.capture_bytes)
        {
            return Err("保留期或记录数量限制无效".into());
        }
        let mut ids = std::collections::HashSet::new();
        for route in &self.routes {
            // The legacy tier switch remains OpenAI-only; native Messages uses explicit rectifiers.
            if route.protocol == Protocol::Anthropic && route.service_tier == Some(true) {
                return Err("tier-unsupported-route".into());
            }
            if route.name.as_deref().is_some_and(|s| !text_valid(s, 100))
                || route.models.len() > 128
                || route.entry_endpoints.len() > 3
                || route.entry_endpoints.iter().any(|s| !endpoint_valid(s))
                || route.upstream_endpoint.as_deref().is_some_and(|s| {
                    !endpoint_valid(s)
                        || (s == "/v1/messages") != (route.protocol == Protocol::Anthropic)
                })
            {
                return Err("invalid-provider-config".into());
            }
            let mut model_ids = std::collections::HashSet::new();
            if route.models.iter().any(|m| {
                !text_valid(&m.id, 256)
                    || !text_valid(&m.upstream_model, 256)
                    || !model_ids.insert(&m.id)
            }) {
                return Err("invalid-model-config".into());
            }
            if !valid_id(&route.id) || !valid_id(&route.client) || !ids.insert(&route.id) {
                return Err("路由 ID 或客户端 ID 无效/重复".into());
            }
            if route.upstream.scheme() != "https"
                && !(route.upstream.scheme() == "http"
                    && route.upstream.host_str().is_some_and(is_loopback_host))
            {
                return Err("上游须为 HTTPS；HTTP 仅允许本机测试上游".into());
            }
            if !route.upstream.username().is_empty()
                || route.upstream.password().is_some()
                || route.upstream.query().is_some()
                || route.upstream.fragment().is_some()
            {
                return Err("上游 URL 不能包含凭据、查询或 fragment".into());
            }
        }
        if self.rules.len() > 128 {
            return Err("规则数量超过限制".into());
        }
        if self.agents.len() > 32 {
            return Err("invalid-agent-config".into());
        }
        let mut agent_ids = std::collections::HashSet::new();
        let mut agent_refs = std::collections::HashSet::new();
        for a in &self.agents {
            if !valid_id(&a.id)
                || !text_valid(&a.name, 100)
                || !agent_ids.insert(&a.id)
                || !agent_refs.insert(&a.credential_ref)
                || !self.routes.iter().any(|r| r.id == a.credential_ref)
                || a.provider_ids.is_empty()
                || a.provider_ids.len() > 32
                || a.provider_ids
                    .iter()
                    .any(|id| !self.routes.iter().any(|r| r.id == *id))
                || a.provider_ids
                    .iter()
                    .collect::<std::collections::HashSet<_>>()
                    .len()
                    != a.provider_ids.len()
            {
                return Err("invalid-agent-config".into());
            }
        }
        crate::rectify::validate(&self.rectifiers)?;
        validate_rules(&self.rules).map_err(|_| "网关 tier 规则无效".to_string())?;
        Ok(())
    }
}
pub fn valid_id(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 64
        && value.as_bytes()[0].is_ascii_alphanumeric()
        && value
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'_' | b'-'))
}
fn is_loopback_host(host: &str) -> bool {
    host.trim_matches(['[', ']'])
        .parse::<std::net::IpAddr>()
        .is_ok_and(|ip| ip.is_loopback())
}
