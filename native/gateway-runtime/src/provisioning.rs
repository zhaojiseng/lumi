//! Fixed, noninteractive host commands. Inputs only travel over the private child pipe.
//! No user paths, arbitrary files, terminal prompts, or plaintext credential fallback.
use crate::{
    config::GatewayConfig,
    gateway::{RouteSecret, Secrets},
    json::scan_object,
    secure,
};
use base64::{Engine as _, engine::general_purpose::STANDARD};
use rand::{RngCore, rngs::OsRng};
use serde::{Deserialize, Serialize};
use std::{collections::HashSet, fs, io::Read, path::Path};
use zeroize::{Zeroize, Zeroizing};

pub const MAX_PRIVATE_INPUT: usize = 256 * 1024;
const JOURNAL: &str = ".configure-transaction.json";
const SECRETS_BACKUP: &str = ".configure-secrets.backup";
const MANAGEMENT_BACKUP: &str = ".configure-management.backup";

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct InitializeInput {
    config: GatewayConfig,
    route_secrets: Vec<RouteSecret>,
    management: Option<ManagementSecrets>,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ConfigureInput {
    expected_version: u64,
    config: GatewayConfig,
    #[serde(default)]
    credentials: Vec<CredentialUpdate>,
    management: Option<ManagementUpdate>,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct CredentialUpdate {
    route_id: String,
    client_key: Option<String>,
    upstream_key: Option<String>,
}
impl Drop for CredentialUpdate {
    fn drop(&mut self) {
        if let Some(key) = &mut self.client_key {
            key.zeroize();
        }
        if let Some(key) = &mut self.upstream_key {
            key.zeroize();
        }
    }
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ManagementUpdate {
    alias: String,
    port: u16,
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ManagementSecrets {
    pub instance_id: String,
    pub alias: String,
    pub port: u16,
    pub certificate_pem: String,
    pub private_key_pem: String,
    pub fingerprint_sha256: String,
    pub token: String,
}
impl Drop for ManagementSecrets {
    fn drop(&mut self) {
        self.private_key_pem.zeroize();
        self.token.zeroize();
    }
}
impl ManagementSecrets {
    pub fn validate(&self) -> Result<(), String> {
        if !crate::config::valid_id(&self.instance_id)
            || !valid_alias(&self.alias)
            || self.port == 0
            || self.certificate_pem.len() > 16384
            || !self
                .certificate_pem
                .starts_with("-----BEGIN CERTIFICATE-----\n")
            || self.private_key_pem.len() > 16384
            || !self
                .private_key_pem
                .starts_with(concat!("-----BEGIN PRIVATE ", "KEY-----\n"))
            || self.fingerprint_sha256.len() != 64
            || !self
                .fingerprint_sha256
                .bytes()
                .all(|b| b.is_ascii_hexdigit())
            || !(32..=8192).contains(&self.token.len())
            || !self
                .token
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b"._~-".contains(&b))
        {
            return Err("invalid-management".into());
        }
        Ok(())
    }
}
fn valid_alias(alias: &str) -> bool {
    !alias.is_empty() && alias.encode_utf16().count() <= 100 && !alias.chars().any(char::is_control)
}
fn valid_key(key: &str, client: bool) -> bool {
    (if client { 16 } else { 1 }..=8192).contains(&key.len())
        && key.bytes().all(|b| (0x21..=0x7e).contains(&b))
}
fn parse<T: serde::de::DeserializeOwned>(bytes: &[u8]) -> Result<T, String> {
    if bytes.is_empty() || bytes.len() > MAX_PRIVATE_INPUT {
        return Err("private-input-limit".into());
    }
    scan_object(bytes).map_err(|_| "invalid-private-input")?;
    serde_json::from_slice(bytes).map_err(|_| "invalid-private-input".into())
}
pub fn storage_id(dir: &Path, filename: &str) -> Result<String, String> {
    Ok(format!(
        "{}::{filename}",
        fs::canonicalize(dir)
            .map_err(|_| "data-directory-unavailable")?
            .to_string_lossy()
    ))
}
pub fn load_protected(dir: &Path, filename: &str) -> Result<Zeroizing<Vec<u8>>, String> {
    let path = dir.join(filename);
    let id = storage_id(dir, filename)?;
    match secure::load(&path, &id) {
        Ok(bytes) => Ok(bytes),
        Err(_) => {
            // Older macOS builds used the directory alone as the Keychain account.
            let legacy = fs::canonicalize(dir)
                .map_err(|_| "data-directory-unavailable")?
                .to_string_lossy()
                .into_owned();
            secure::load(&path, &legacy).map_err(|_| "secure-storage-unavailable".into())
        }
    }
}
pub fn save_protected(dir: &Path, filename: &str, bytes: &[u8]) -> Result<(), String> {
    secure::save(&dir.join(filename), &storage_id(dir, filename)?, bytes)
        .map_err(|_| "secure-storage-unavailable".into())
}
fn remove_protected(dir: &Path, filename: &str) -> Result<(), String> {
    secure::remove(&dir.join(filename), &storage_id(dir, filename)?)
        .map_err(|_| "secure-storage-unavailable".into())
}
fn read_bounded(path: &Path, limit: usize) -> Result<Vec<u8>, String> {
    let file = fs::File::open(path).map_err(|_| "state-unavailable")?;
    if file.metadata().map_err(|_| "state-unavailable")?.len() > limit as u64 {
        return Err("state-limit".into());
    }
    let mut bytes = Vec::new();
    file.take(limit as u64 + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| "state-unavailable")?;
    if bytes.len() > limit {
        return Err("state-limit".into());
    }
    Ok(bytes)
}
fn validate_routes(config: &GatewayConfig, secrets: &Secrets) -> Result<(), String> {
    let mut ids = HashSet::new();
    if secrets.routes.len() != config.routes.len()
        || secrets.routes.iter().any(|secret| {
            !ids.insert(&secret.route_id)
                || !config
                    .routes
                    .iter()
                    .any(|route| route.id == secret.route_id)
                || !valid_key(&secret.client_key, true)
                || !valid_key(&secret.upstream_key, false)
        })
    {
        return Err("invalid-route-credentials".into());
    }
    let key = Zeroizing::new(
        STANDARD
            .decode(&secrets.record_key_b64)
            .map_err(|_| "invalid-record-key")?,
    );
    if key.len() != 32 {
        return Err("invalid-record-key".into());
    }
    let encoded = Zeroizing::new(serde_json::to_vec(secrets).map_err(|_| "state-encode-failed")?);
    if encoded.len() > 240 * 1024 {
        return Err("credentials-size-limit".into());
    }
    let mut client_keys = std::collections::HashSet::new();
    for agent in config.agents.iter().filter(|a| a.enabled) {
        let secret = secrets
            .routes
            .iter()
            .find(|r| r.route_id == agent.credential_ref)
            .ok_or("invalid-agent-credentials")?;
        if !client_keys.insert(&secret.client_key) {
            return Err("ambiguous-agent-credentials".into());
        }
    }
    Ok(())
}
pub fn initialize(dir: &Path, bytes: &[u8]) -> Result<u64, String> {
    if !dir.is_absolute() || dir.exists() {
        return Err("new-data-directory-required".into());
    }
    let mut input: InitializeInput = parse(bytes)?;
    input.config.validate().map_err(|_| "invalid-config")?;
    if input.config.listen.port() == 0 {
        return Err("invalid-config".into());
    }
    if input.config.config_version != 1 {
        return Err("invalid-config-version".into());
    }
    if let Some(management) = &input.management {
        management.validate()?;
    }
    let mut key = Zeroizing::new([0u8; 32]);
    OsRng.fill_bytes(&mut key[..]);
    let secrets = Secrets {
        record_key_b64: STANDARD.encode(&key[..]),
        routes: std::mem::take(&mut input.route_secrets),
    };
    validate_routes(&input.config, &secrets)?;
    let config_bytes = encode_config(&input.config)?;
    fs::create_dir(dir).map_err(|_| "new-data-directory-required")?;
    let result = (|| {
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(dir, fs::Permissions::from_mode(0o700))
                .map_err(|_| "state-write-failed")?;
        }
        let encoded =
            Zeroizing::new(serde_json::to_vec(&secrets).map_err(|_| "state-encode-failed")?);
        save_protected(dir, "secrets.bin", &encoded)?;
        if let Some(management) = &input.management {
            let encoded =
                Zeroizing::new(serde_json::to_vec(management).map_err(|_| "state-encode-failed")?);
            save_protected(dir, "management.bin", &encoded)?;
        }
        secure::atomic_write(&dir.join("config.json"), &config_bytes)
            .map_err(|_| "state-write-failed")?;
        Ok(1)
    })();
    if result.is_err() {
        // Only this operation created the directory. Never recurse into user-supplied contents.
        let _ = remove_protected(dir, "secrets.bin");
        let _ = remove_protected(dir, "management.bin");
        let _ = fs::remove_file(dir.join("config.json"));
        let _ = fs::remove_dir(dir);
    }
    result
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Transaction {
    previous_config_b64: String,
    committed_config_b64: String,
    had_management: bool,
}
fn encode_config(config: &GatewayConfig) -> Result<Vec<u8>, String> {
    let bytes = serde_json::to_vec_pretty(config).map_err(|_| "state-encode-failed")?;
    if bytes.len() > MAX_PRIVATE_INPUT {
        return Err("config-size-limit".into());
    }
    Ok(bytes)
}
fn clear_transaction(dir: &Path) -> Result<(), String> {
    // The live state has already committed or rolled back. Clear the journal first;
    // orphaned protected backups are safe to finish cleaning on the next open.
    match fs::remove_file(dir.join(JOURNAL)) {
        Ok(()) => (),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => (),
        Err(_) => return Err("state-write-failed".into()),
    }
    remove_protected(dir, SECRETS_BACKUP)?;
    remove_protected(dir, MANAGEMENT_BACKUP)?;
    Ok(())
}
pub fn recover(dir: &Path) -> Result<(), String> {
    if !dir.is_absolute() || !dir.is_dir() {
        return Err("data-directory-unavailable".into());
    }
    if !dir.join(JOURNAL).exists() {
        return clear_transaction(dir);
    }
    let bytes = read_bounded(&dir.join(JOURNAL), 1024 * 1024)?;
    scan_object(&bytes).map_err(|_| "invalid-transaction")?;
    let transaction: Transaction =
        serde_json::from_slice(&bytes).map_err(|_| "invalid-transaction")?;
    let previous = STANDARD
        .decode(&transaction.previous_config_b64)
        .map_err(|_| "invalid-transaction")?;
    let committed = STANDARD
        .decode(&transaction.committed_config_b64)
        .map_err(|_| "invalid-transaction")?;
    let old: GatewayConfig = parse(&previous)?;
    let new: GatewayConfig = parse(&committed)?;
    old.validate().map_err(|_| "invalid-transaction")?;
    new.validate().map_err(|_| "invalid-transaction")?;
    if old.config_version.checked_add(1) != Some(new.config_version) {
        return Err("invalid-transaction".into());
    }
    if read_bounded(&dir.join("config.json"), MAX_PRIVATE_INPUT)
        .ok()
        .as_deref()
        != Some(&committed)
    {
        let secrets = load_protected(dir, SECRETS_BACKUP)?;
        save_protected(dir, "secrets.bin", &secrets)?;
        if transaction.had_management {
            let management = load_protected(dir, MANAGEMENT_BACKUP)?;
            save_protected(dir, "management.bin", &management)?;
        } else {
            remove_protected(dir, "management.bin")?;
        }
        secure::atomic_write(&dir.join("config.json"), &previous)
            .map_err(|_| "state-write-failed")?;
    }
    clear_transaction(dir)
}
pub fn prepare_configuration(dir: &Path, bytes: &[u8]) -> Result<PreparedConfiguration, String> {
    if bytes.len() > MAX_PRIVATE_INPUT {
        return Err("private-message-too-large".into());
    }
    let mut input: ConfigureInput = parse(bytes)?;
    input.config.validate().map_err(|_| "invalid-config")?;
    if input.config.listen.port() == 0 {
        return Err("invalid-config".into());
    }
    recover(dir)?;
    let old_config = read_bounded(&dir.join("config.json"), MAX_PRIVATE_INPUT)?;
    let current: GatewayConfig = parse(&old_config)?;
    current.validate().map_err(|_| "invalid-config")?;
    if input.expected_version != current.config_version {
        return Err("config-conflict".into());
    }
    if input.config.config_version != 1 && input.config.config_version != input.expected_version {
        return Err("invalid-config-version".into());
    }
    let version = current
        .config_version
        .checked_add(1)
        .filter(|value| *value <= 2_147_483_647)
        .ok_or("config-version-limit")?;
    input.config.config_version = version;
    let old_secret_bytes = load_protected(dir, "secrets.bin")?;
    let old_secrets: Secrets = parse(&old_secret_bytes)?;
    validate_routes(&current, &old_secrets)?;
    let mut updated = HashSet::new();
    if input.credentials.len() > 32
        || input.credentials.iter().any(|update| {
            !updated.insert(&update.route_id)
                || !input
                    .config
                    .routes
                    .iter()
                    .any(|route| route.id == update.route_id)
                || update
                    .client_key
                    .as_deref()
                    .is_some_and(|key| !valid_key(key, true))
                || update
                    .upstream_key
                    .as_deref()
                    .is_some_and(|key| !valid_key(key, false))
                || update.client_key.is_none() && update.upstream_key.is_none()
        })
    {
        return Err("invalid-route-credentials".into());
    }
    let mut secrets = Secrets {
        record_key_b64: old_secrets.record_key_b64.clone(),
        routes: Vec::new(),
    };
    for route in &input.config.routes {
        let prior = old_secrets
            .routes
            .iter()
            .find(|secret| secret.route_id == route.id);
        let update = input
            .credentials
            .iter()
            .find(|update| update.route_id == route.id);
        let client = update
            .and_then(|update| update.client_key.as_ref())
            .or(prior.map(|secret| &secret.client_key))
            .ok_or("new-route-credentials-required")?;
        let upstream = update
            .and_then(|update| update.upstream_key.as_ref())
            .or(prior.map(|secret| &secret.upstream_key))
            .ok_or("new-route-credentials-required")?;
        secrets.routes.push(RouteSecret {
            route_id: route.id.clone(),
            client_key: client.clone(),
            upstream_key: upstream.clone(),
        });
    }
    validate_routes(&input.config, &secrets)?;
    let had_management = dir.join("management.bin").exists();
    let old_management_bytes = if had_management {
        Some(load_protected(dir, "management.bin")?)
    } else {
        None
    };
    let mut management: Option<ManagementSecrets> = old_management_bytes
        .as_deref()
        .map(|bytes| parse(bytes))
        .transpose()?;
    if let Some(secret) = &management {
        secret.validate()?;
    }
    if let Some(update) = input.management {
        if !valid_alias(&update.alias) || update.port == 0 {
            return Err("invalid-management".into());
        }
        let secret = management.as_mut().ok_or("management-not-configured")?;
        secret.alias = update.alias;
        secret.port = update.port;
    }
    Ok(PreparedConfiguration {
        config: input.config,
        secrets,
        management,
        old_config,
        old_secret_bytes,
        old_management_bytes,
        had_management,
        expected_version: current.config_version,
    })
}

/// Owns private material only in the native process until the host commits or cancels.
pub struct PreparedConfiguration {
    pub config: GatewayConfig,
    pub secrets: Secrets,
    pub management: Option<ManagementSecrets>,
    old_config: Vec<u8>,
    old_secret_bytes: Zeroizing<Vec<u8>>,
    old_management_bytes: Option<Zeroizing<Vec<u8>>>,
    had_management: bool,
    pub expected_version: u64,
}
impl PreparedConfiguration {
    pub fn commit(&self, dir: &Path) -> Result<u64, String> {
        if read_bounded(&dir.join("config.json"), MAX_PRIVATE_INPUT)? != self.old_config {
            return Err("config-conflict".into());
        }
        let committed = encode_config(&self.config)?;
        let old_config = &self.old_config;
        let old_secret_bytes = &self.old_secret_bytes;
        let old_management_bytes = &self.old_management_bytes;
        let secrets = &self.secrets;
        let management = &self.management;
        let had_management = self.had_management;

        let journal = Transaction {
            previous_config_b64: STANDARD.encode(old_config),
            committed_config_b64: STANDARD.encode(&committed),
            had_management,
        };
        let result = (|| {
            save_protected(dir, SECRETS_BACKUP, old_secret_bytes)?;
            if let Some(bytes) = &old_management_bytes {
                save_protected(dir, MANAGEMENT_BACKUP, bytes)?;
            }
            secure::atomic_write(
                &dir.join(JOURNAL),
                &serde_json::to_vec(&journal).map_err(|_| "state-encode-failed")?,
            )
            .map_err(|_| "state-write-failed")?;
            let encoded =
                Zeroizing::new(serde_json::to_vec(&secrets).map_err(|_| "state-encode-failed")?);
            save_protected(dir, "secrets.bin", &encoded)?;
            if let Some(management) = &management {
                let encoded = Zeroizing::new(
                    serde_json::to_vec(management).map_err(|_| "state-encode-failed")?,
                );
                save_protected(dir, "management.bin", &encoded)?;
            }
            secure::atomic_write(&dir.join("config.json"), &committed)
                .map_err(|_| "state-write-failed")?;
            Ok(())
        })();
        if let Err(error) = result {
            recover(dir).map_err(|_| "transaction-recovery-required")?;
            return Err(error);
        }
        // The config rename is the commit point; interrupted cleanup is finished on next open.
        let _ = clear_transaction(dir);
        Ok(self.config.config_version)
    }
}
pub fn configure(dir: &Path, bytes: &[u8]) -> Result<u64, String> {
    prepare_configuration(dir, bytes)?.commit(dir)
}
