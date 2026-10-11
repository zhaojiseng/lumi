//! Local metadata and opt-in encrypted recording. Payloads never enter metadata or logs.
use crate::policy::TierField;
use aes_gcm::{
    Aes256Gcm, KeyInit, Nonce,
    aead::{Aead, Payload},
};
use rand::{RngCore, rngs::OsRng};
use rusqlite::{Connection, OptionalExtension, Transaction, TransactionBehavior, params};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::{
    path::Path,
    time::Duration,
    time::{SystemTime, UNIX_EPOCH},
};
use thiserror::Error;

/// Each direction is bounded separately. Oversized or unparseable bodies are omitted.
pub const MAX_PAYLOAD_BYTES: usize = 1024 * 1024;
const REDACTED: &str = "[REDACTED]";
const PAYLOAD_VERSION: u8 = 1;

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct RequestRecord {
    pub id: String,
    pub started_at_ms: u64,
    pub route_id: String,
    pub client: String,
    pub endpoint: String,
    pub model: Option<String>,
    pub status: String,
    pub http_status: Option<u16>,
    pub original: TierField,
    pub effective: TierField,
    pub reported: TierField,
    pub rule_id: Option<String>,
    pub request_bytes: u64,
    pub response_bytes: u64,
    pub duration_ms: u64,
    pub first_response_ms: Option<u64>,
    #[serde(default)]
    pub first_content_ms: Option<u64>,
    #[serde(default)]
    pub input_tokens: Option<u64>,
    #[serde(default)]
    pub output_tokens: Option<u64>,
    #[serde(default)]
    pub cache_read_tokens: Option<u64>,
    #[serde(default)]
    pub cache_write_tokens: Option<u64>,
    pub recording_partial: bool,
    pub error_code: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub chain: Option<crate::gateway::RequestChain>,
}

/// Safe-to-export, decrypted recording. Call only after an explicit local export action.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct RecordPayloads {
    pub request: Vec<u8>,
    pub response: Vec<u8>,
    pub response_is_sse: bool,
}

/// The completeness of the actual persisted record after payload validation.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct SaveOutcome {
    pub recording_partial: bool,
}

#[derive(Debug, Error)]
pub enum RecordingError {
    #[error("recording database operation failed")]
    Database(#[from] rusqlite::Error),
    #[error("recording directory could not be created")]
    Io(#[from] std::io::Error),
    #[error("invalid recording configuration")]
    InvalidConfiguration,
    #[error("invalid or oversized recording metadata")]
    InvalidRecord,
    #[error("record identity cannot be changed")]
    IdentityConflict,
    #[error("record was explicitly deleted")]
    DeletedRecord,
    #[error("record is outside the retained recording window")]
    ExpiredRecord,
    #[error("recording encryption key is unavailable")]
    EncryptionUnavailable,
    #[error("recording encryption failed")]
    EncryptionFailed,
    #[error("recording authentication failed")]
    DecryptionFailed,
    #[error("recording data is corrupt")]
    CorruptRecord,
    #[error("recording page size must be between 1 and 100")]
    InvalidLimit,
    #[error("recording pagination cursor no longer exists")]
    InvalidCursor,
    #[error("recording query exceeds the bounded metadata scan")]
    RecordLimit,
}

pub struct Recorder {
    connection: Connection,
    cipher: Option<Aes256Gcm>,
    retention_days: u32,
    max_records: usize,
    max_bytes: u64,
}

impl Recorder {
    /// The caller obtains the key from OS secure storage. No key means metadata only.
    pub fn open(
        path: impl AsRef<Path>,
        key: Option<[u8; 32]>,
        retention_days: u32,
        max_records: usize,
    ) -> Result<Self, RecordingError> {
        if !(1..=3650).contains(&retention_days) || !(1..=1_000_000).contains(&max_records) {
            return Err(RecordingError::InvalidConfiguration);
        }
        if let Some(parent) = path.as_ref().parent().filter(|p| !p.as_os_str().is_empty()) {
            std::fs::create_dir_all(parent)?;
        }
        let connection = Connection::open(path)?;
        connection.busy_timeout(Duration::from_secs(5))?;
        connection.execute_batch(
            "PRAGMA journal_mode=WAL;
             PRAGMA synchronous=FULL;
             PRAGMA secure_delete=ON;
             CREATE TABLE IF NOT EXISTS records (
                id TEXT PRIMARY KEY NOT NULL,
                started_at_ms INTEGER NOT NULL,
                metadata TEXT NOT NULL,
                payload BLOB
             );
             CREATE INDEX IF NOT EXISTS records_time ON records(started_at_ms DESC, id DESC);
             CREATE TABLE IF NOT EXISTS recording_tombstones (
                id TEXT PRIMARY KEY NOT NULL,
                started_at_ms INTEGER NOT NULL,
                deleted_at_ms INTEGER NOT NULL
             );
             CREATE INDEX IF NOT EXISTS recording_tombstones_time
                ON recording_tombstones(started_at_ms DESC, id DESC);
             CREATE TABLE IF NOT EXISTS recording_watermark (
                slot INTEGER PRIMARY KEY CHECK(slot = 1),
                started_at_ms INTEGER NOT NULL,
                id TEXT NOT NULL
             );",
        )?;
        let cipher = match key {
            Some(mut raw) => {
                let result =
                    Aes256Gcm::new_from_slice(&raw).map_err(|_| RecordingError::EncryptionFailed);
                raw.fill(0);
                Some(result?)
            }
            None => None,
        };
        let mut recorder = Self {
            connection,
            cipher,
            retention_days,
            max_records,
            max_bytes: 1024 * 1024 * 1024,
        };
        recorder.purge()?;
        Ok(recorder)
    }

    /// Upserts lifecycle updates without permitting a deleted/evicted request to return.
    pub fn save(
        &mut self,
        record: &RequestRecord,
        payloads: Option<&RecordPayloads>,
    ) -> Result<SaveOutcome, RecordingError> {
        let now = now_ms();
        validate_record(record, now)?;
        if payloads.is_some() && self.cipher.is_none() {
            return Err(RecordingError::EncryptionUnavailable);
        }
        let mut metadata = record.clone();
        metadata.original = safe_tier(&metadata.original);
        metadata.effective = safe_tier(&metadata.effective);
        metadata.reported = safe_tier(&metadata.reported);
        let payload = match payloads {
            Some(raw) => {
                let (safe, partial) = sanitize_payloads(raw);
                metadata.recording_partial |= partial;
                if safe.request.is_empty() && safe.response.is_empty() {
                    None
                } else {
                    Some(encrypt(
                        self.cipher
                            .as_ref()
                            .ok_or(RecordingError::EncryptionUnavailable)?,
                        &metadata.id,
                        &safe,
                    )?)
                }
            }
            None => None,
        };
        let serialized =
            serde_json::to_string(&metadata).map_err(|_| RecordingError::InvalidRecord)?;
        let transaction = self
            .connection
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        if transaction
            .query_row(
                "SELECT 1 FROM recording_tombstones WHERE id=?1",
                [&metadata.id],
                |_| Ok(()),
            )
            .optional()?
            .is_some()
        {
            return Err(RecordingError::DeletedRecord);
        }
        let cutoff = retention_cutoff(now, self.retention_days);
        if metadata.started_at_ms < cutoff || below_watermark(&transaction, &metadata)? {
            return Err(RecordingError::ExpiredRecord);
        }
        if let Some(old_json) = transaction
            .query_row(
                "SELECT metadata FROM records WHERE id=?1",
                [&metadata.id],
                |row| row.get::<_, String>(0),
            )
            .optional()?
        {
            let old = decode_record(&old_json)?;
            if old.started_at_ms != metadata.started_at_ms
                || old.route_id != metadata.route_id
                || old.client != metadata.client
                || old.endpoint != metadata.endpoint
            {
                return Err(RecordingError::IdentityConflict);
            }
        }
        transaction.execute(
            "INSERT INTO records(id,started_at_ms,metadata,payload) VALUES(?1,?2,?3,?4)
             ON CONFLICT(id) DO UPDATE SET metadata=excluded.metadata,payload=excluded.payload",
            params![
                metadata.id,
                metadata.started_at_ms as i64,
                serialized,
                payload
            ],
        )?;
        purge_transaction(
            &transaction,
            now,
            self.retention_days,
            self.max_records,
            self.max_bytes,
        )?;
        transaction.commit()?;
        Ok(SaveOutcome {
            recording_partial: metadata.recording_partial,
        })
    }

    /// Called once when a new gateway process starts, never by passive readers.
    /// Recovery changes metadata only and preserves encrypted payload bytes.
    pub fn recover_interrupted(&mut self) -> Result<usize, RecordingError> {
        let transaction = self
            .connection
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        let raw: Vec<(String, String)> = {
            let mut statement = transaction.prepare("SELECT id, metadata FROM records")?;
            let rows = statement.query_map([], |row| Ok((row.get(0)?, row.get(1)?)))?;
            rows.collect::<Result<Vec<_>, _>>()?
        };
        let mut recovered = 0;
        for (id, json) in raw {
            let mut record = decode_record(&json)?;
            if record.status != "forwarding" {
                continue;
            }
            record.status = "interrupted".into();
            record.error_code = Some("process-interrupted".into());
            record.recording_partial = true;
            let metadata =
                serde_json::to_string(&record).map_err(|_| RecordingError::CorruptRecord)?;
            recovered += transaction.execute(
                "UPDATE records SET metadata=?1 WHERE id=?2",
                params![metadata, id],
            )?;
        }
        transaction.commit()?;
        Ok(recovered)
    }

    pub fn encryption_available(&self) -> bool {
        self.cipher.is_some()
    }

    /// Reconfigure retention atomically. Capacity is logical metadata plus encrypted payload
    /// bytes; SQLite may retain free pages until its own housekeeping runs.
    pub fn set_limits(
        &mut self,
        days: u32,
        records: usize,
        bytes: u64,
    ) -> Result<(), RecordingError> {
        if !(1..=3650).contains(&days)
            || !(1..=1_000_000).contains(&records)
            || !(1024 * 1024..=10 * 1024 * 1024 * 1024).contains(&bytes)
        {
            return Err(RecordingError::InvalidConfiguration);
        }
        let transaction = self
            .connection
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        purge_transaction(&transaction, now_ms(), days, records, bytes)?;
        transaction.commit()?;
        self.retention_days = days;
        self.max_records = records;
        self.max_bytes = bytes;
        Ok(())
    }

    /// Inputs were validated before the private disk transaction. Purge on the next
    /// recorder operation, so failed configuration writes cannot delete old records.
    pub fn adopt_limits(&mut self, days: u32, records: usize, bytes: u64) {
        self.retention_days = days;
        self.max_records = records;
        self.max_bytes = bytes;
    }

    /// Fixed-order, fixed-size metadata scan; callers cannot inject SQL predicates.
    pub fn bounded_records(&self) -> Result<Vec<RequestRecord>, RecordingError> {
        let mut statement = self.connection.prepare(
            "SELECT metadata FROM records ORDER BY started_at_ms DESC,id DESC LIMIT 10001",
        )?;
        let raw = statement
            .query_map([], |row| row.get::<_, String>(0))?
            .collect::<Result<Vec<_>, _>>()?;
        if raw.len() > 10_000 {
            return Err(RecordingError::RecordLimit);
        }
        raw.iter().map(|value| decode_record(value)).collect()
    }

    /// One transaction for the complete, already frozen selection. Tombstones also cover
    /// pending requests, so their finish event cannot recreate deleted records.
    pub fn delete_many(&mut self, ids: &[String]) -> Result<usize, RecordingError> {
        if ids.len() > 10_000 || ids.iter().any(|id| !valid_identifier(id)) {
            return Err(RecordingError::InvalidRecord);
        }
        let now = now_ms();
        let transaction = self
            .connection
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        let mut deleted = 0;
        for id in ids {
            let timestamp = transaction
                .query_row(
                    "SELECT started_at_ms FROM records WHERE id=?1",
                    [id],
                    |row| row.get::<_, i64>(0),
                )
                .optional()?;
            transaction.execute(
                "INSERT INTO recording_tombstones(id,started_at_ms,deleted_at_ms) VALUES(?1,?2,?3)
                 ON CONFLICT(id) DO NOTHING",
                params![id, timestamp.unwrap_or(now as i64), now as i64],
            )?;
            deleted += transaction.execute("DELETE FROM records WHERE id=?1", [id])?;
        }
        purge_transaction(
            &transaction,
            now,
            self.retention_days,
            self.max_records,
            self.max_bytes,
        )?;
        transaction.commit()?;
        Ok(deleted)
    }

    pub fn get(&self, id: &str) -> Result<Option<RequestRecord>, RecordingError> {
        let value = self
            .connection
            .query_row("SELECT metadata FROM records WHERE id=?1", [id], |row| {
                row.get::<_, String>(0)
            })
            .optional()?;
        value.as_deref().map(decode_record).transpose()
    }

    /// Stable descending (time,id) pagination. A removed cursor is reported explicitly.
    pub fn list(
        &self,
        limit: usize,
        before: Option<&str>,
    ) -> Result<Vec<RequestRecord>, RecordingError> {
        if !(1..=100).contains(&limit) {
            return Err(RecordingError::InvalidLimit);
        }
        let raw: Vec<String> = if let Some(cursor) = before {
            let point = self
                .connection
                .query_row(
                    "SELECT started_at_ms,id FROM records WHERE id=?1",
                    [cursor],
                    |row| Ok((row.get::<_, i64>(0)?, row.get::<_, String>(1)?)),
                )
                .optional()?
                .ok_or(RecordingError::InvalidCursor)?;
            let mut statement = self.connection.prepare(
                "SELECT metadata FROM records WHERE started_at_ms < ?1 OR (started_at_ms=?1 AND id < ?2)
                 ORDER BY started_at_ms DESC,id DESC LIMIT ?3"
            )?;
            let rows =
                statement.query_map(params![point.0, point.1, limit as i64], |row| row.get(0))?;
            rows.collect::<Result<Vec<_>, _>>()?
        } else {
            let mut statement = self.connection.prepare(
                "SELECT metadata FROM records ORDER BY started_at_ms DESC,id DESC LIMIT ?1",
            )?;
            let rows = statement.query_map([limit as i64], |row| row.get(0))?;
            rows.collect::<Result<Vec<_>, _>>()?
        };
        raw.iter().map(|value| decode_record(value)).collect()
    }

    pub fn read_payloads(&self, id: &str) -> Result<Option<RecordPayloads>, RecordingError> {
        let payload = self
            .connection
            .query_row("SELECT payload FROM records WHERE id=?1", [id], |row| {
                row.get::<_, Option<Vec<u8>>>(0)
            })
            .optional()?
            .flatten();
        payload
            .map(|bytes| {
                let cipher = self
                    .cipher
                    .as_ref()
                    .ok_or(RecordingError::EncryptionUnavailable)?;
                decrypt(cipher, id, &bytes)
            })
            .transpose()
    }

    /// Deletion is serialized with save, including requests that are still streaming.
    pub fn delete(&mut self, id: &str) -> Result<bool, RecordingError> {
        if !valid_identifier(id) {
            return Err(RecordingError::InvalidRecord);
        }
        let now = now_ms();
        let transaction = self
            .connection
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        let timestamp = transaction
            .query_row(
                "SELECT started_at_ms FROM records WHERE id=?1",
                [id],
                |row| row.get::<_, i64>(0),
            )
            .optional()?;
        transaction.execute(
            "INSERT INTO recording_tombstones(id,started_at_ms,deleted_at_ms) VALUES(?1,?2,?3)
             ON CONFLICT(id) DO NOTHING",
            params![id, timestamp.unwrap_or(now as i64), now as i64],
        )?;
        let existed = transaction.execute("DELETE FROM records WHERE id=?1", [id])? > 0;
        purge_transaction(
            &transaction,
            now,
            self.retention_days,
            self.max_records,
            self.max_bytes,
        )?;
        transaction.commit()?;
        Ok(existed)
    }

    /// Applies retention and capacity. Tombstones are bounded using a persistent watermark.
    /// Heavy deletion can conservatively shorten the retained window; old requests never return.
    pub fn purge(&mut self) -> Result<usize, RecordingError> {
        let transaction = self
            .connection
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        let removed = purge_transaction(
            &transaction,
            now_ms(),
            self.retention_days,
            self.max_records,
            self.max_bytes,
        )?;
        transaction.commit()?;
        Ok(removed)
    }
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
        .min(i64::MAX as u128) as u64
}

fn retention_cutoff(now: u64, days: u32) -> u64 {
    now.saturating_sub(u64::from(days) * 86_400_000)
}

fn below_watermark(
    transaction: &Transaction<'_>,
    record: &RequestRecord,
) -> Result<bool, RecordingError> {
    let watermark = transaction
        .query_row(
            "SELECT started_at_ms,id FROM recording_watermark WHERE slot=1",
            [],
            |row| Ok((row.get::<_, i64>(0)?, row.get::<_, String>(1)?)),
        )
        .optional()?;
    Ok(watermark.is_some_and(|(time, id)| {
        record.started_at_ms < time as u64
            || (record.started_at_ms == time as u64 && record.id <= id)
    }))
}

fn advance_watermark(
    transaction: &Transaction<'_>,
    time: i64,
    id: &str,
) -> Result<(), RecordingError> {
    transaction.execute(
        "INSERT INTO recording_watermark(slot,started_at_ms,id) VALUES(1,?1,?2)
         ON CONFLICT(slot) DO UPDATE SET started_at_ms=excluded.started_at_ms,id=excluded.id
         WHERE excluded.started_at_ms > recording_watermark.started_at_ms
            OR (excluded.started_at_ms=recording_watermark.started_at_ms AND excluded.id>recording_watermark.id)",
        params![time, id],
    )?;
    Ok(())
}

fn purge_transaction(
    transaction: &Transaction<'_>,
    now: u64,
    days: u32,
    capacity: usize,
    max_bytes: u64,
) -> Result<usize, RecordingError> {
    let cutoff = retention_cutoff(now, days);
    if cutoff > 0 {
        advance_watermark(transaction, (cutoff - 1) as i64, "\u{10ffff}")?;
    }
    let boundary = transaction.query_row(
        "SELECT started_at_ms,id FROM records ORDER BY started_at_ms DESC,id DESC LIMIT 1 OFFSET ?1",
        [capacity as i64], |row| Ok((row.get::<_, i64>(0)?, row.get::<_, String>(1)?)),
    ).optional()?;
    if let Some((time, id)) = boundary {
        advance_watermark(transaction, time, &id)?;
    }
    let byte_boundary = transaction
        .query_row(
            "SELECT started_at_ms,id FROM (
           SELECT started_at_ms,id,SUM(LENGTH(CAST(metadata AS BLOB))+COALESCE(LENGTH(payload),0))
             OVER (ORDER BY started_at_ms DESC,id DESC ROWS UNBOUNDED PRECEDING) AS retained_bytes
           FROM records
         ) WHERE retained_bytes > ?1 ORDER BY started_at_ms DESC,id DESC LIMIT 1",
            [max_bytes as i64],
            |row| Ok((row.get::<_, i64>(0)?, row.get::<_, String>(1)?)),
        )
        .optional()?;
    if let Some((time, id)) = byte_boundary {
        advance_watermark(transaction, time, &id)?;
    }
    transaction.execute(
        "DELETE FROM recording_tombstones WHERE deleted_at_ms < ?1",
        [cutoff as i64],
    )?;
    let tombstone_boundary = transaction.query_row(
        "SELECT started_at_ms,id FROM recording_tombstones ORDER BY started_at_ms DESC,id DESC LIMIT 1 OFFSET ?1",
        [capacity as i64], |row| Ok((row.get::<_, i64>(0)?, row.get::<_, String>(1)?)),
    ).optional()?;
    if let Some((time, id)) = tombstone_boundary {
        advance_watermark(transaction, time, &id)?;
    }
    let removed = transaction.execute(
        "DELETE FROM records WHERE EXISTS(SELECT 1 FROM recording_watermark w WHERE w.slot=1
          AND (records.started_at_ms < w.started_at_ms OR (records.started_at_ms=w.started_at_ms AND records.id<=w.id)))", [],
    )?;
    transaction.execute(
        "DELETE FROM recording_tombstones WHERE EXISTS(SELECT 1 FROM recording_watermark w WHERE w.slot=1
          AND (recording_tombstones.started_at_ms < w.started_at_ms
            OR (recording_tombstones.started_at_ms=w.started_at_ms AND recording_tombstones.id<=w.id)))", [],
    )?;
    Ok(removed)
}

fn decode_record(raw: &str) -> Result<RequestRecord, RecordingError> {
    serde_json::from_str(raw).map_err(|_| RecordingError::CorruptRecord)
}

fn valid_identifier(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 128
        && value
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || b"._-".contains(&c))
}

fn validate_record(record: &RequestRecord, now: u64) -> Result<(), RecordingError> {
    let bounded = |value: &str, max: usize| {
        !value.is_empty() && value.len() <= max && !value.chars().any(char::is_control)
    };
    if !valid_identifier(&record.id)
        || !valid_identifier(&record.route_id)
        || !valid_identifier(&record.client)
        || !valid_identifier(&record.status)
        || !bounded(&record.endpoint, 1024)
        || record.endpoint.contains(['?', '#'])
        || record.started_at_ms > now
        || record.started_at_ms > i64::MAX as u64
        || record.model.as_ref().is_some_and(|v| !bounded(v, 256))
        || record
            .rule_id
            .as_ref()
            .is_some_and(|v| !valid_identifier(v))
        || record
            .error_code
            .as_ref()
            .is_some_and(|v| !valid_identifier(v))
    {
        return Err(RecordingError::InvalidRecord);
    }
    Ok(())
}

/// Service-tier metadata must not turn an arbitrary untrusted request value into a log channel.
/// The policy layer still observes the actual input; unknown recording values remain Invalid.
fn safe_tier(value: &TierField) -> TierField {
    match value {
        TierField::String(text)
            if text.is_empty()
                || text.len() > 64
                || !text.as_bytes()[0].is_ascii_alphanumeric()
                || !text
                    .bytes()
                    .all(|c| c.is_ascii_alphanumeric() || b"._-".contains(&c)) =>
        {
            TierField::Invalid
        }
        _ => value.clone(),
    }
}

fn sanitize_payloads(raw: &RecordPayloads) -> (RecordPayloads, bool) {
    let request = sanitize_json(&raw.request);
    let response = if raw.response_is_sse {
        sanitize_sse(&raw.response)
    } else {
        sanitize_json(&raw.response)
    };
    let partial = request.is_none() || response.is_none();
    (
        RecordPayloads {
            request: request.unwrap_or_default(),
            response: response.unwrap_or_default(),
            response_is_sse: raw.response_is_sse,
        },
        partial,
    )
}

fn sensitive_key(key: &str) -> bool {
    let normalized: String = key
        .chars()
        .filter(|c| c.is_ascii_alphanumeric())
        .map(|c| c.to_ascii_lowercase())
        .collect();
    matches!(
        normalized.as_str(),
        "authorization"
            | "proxyauthorization"
            | "apikey"
            | "xapikey"
            | "token"
            | "accesstoken"
            | "refreshtoken"
            | "idtoken"
            | "authtoken"
            | "sessiontoken"
            | "cookie"
            | "setcookie"
            | "password"
            | "passwd"
            | "secret"
            | "clientsecret"
            | "privatekey"
            | "credential"
            | "credentials"
            | "apisecret"
    )
}

fn redact(value: &mut Value) {
    match value {
        Value::Object(object) => {
            for (key, field) in object {
                if sensitive_key(key) {
                    *field = Value::String(REDACTED.into());
                } else {
                    redact(field);
                }
            }
        }
        Value::Array(array) => {
            for field in array {
                redact(field);
            }
        }
        _ => {}
    }
}

fn sanitize_json(bytes: &[u8]) -> Option<Vec<u8>> {
    if bytes.is_empty() {
        return Some(Vec::new());
    }
    if bytes.len() > MAX_PAYLOAD_BYTES {
        return None;
    }
    let mut value: Value = serde_json::from_slice(bytes).ok()?;
    redact(&mut value);
    let safe = serde_json::to_vec(&value).ok()?;
    (safe.len() <= MAX_PAYLOAD_BYTES).then_some(safe)
}

fn sanitize_sse(bytes: &[u8]) -> Option<Vec<u8>> {
    if bytes.is_empty() {
        return Some(Vec::new());
    }
    if bytes.len() > MAX_PAYLOAD_BYTES {
        return None;
    }
    let text = std::str::from_utf8(bytes)
        .ok()?
        .replace("\r\n", "\n")
        .replace('\r', "\n");
    let mut output = Vec::new();
    let mut data: Vec<&str> = Vec::new();
    let mut event: Option<&str> = None;
    for line in text.split_terminator('\n') {
        if line.is_empty() {
            if !data.is_empty() {
                let joined = data.join("\n");
                let safe = if joined.trim() == "[DONE]" {
                    b"[DONE]".to_vec()
                } else {
                    sanitize_json(joined.as_bytes())?
                };
                if let Some(name) = event.take() {
                    output.extend_from_slice(b"event: ");
                    output.extend_from_slice(name.as_bytes());
                    output.push(b'\n');
                }
                output.extend_from_slice(b"data: ");
                output.extend_from_slice(&safe);
                output.extend_from_slice(b"\n\n");
            }
            data.clear();
            event = None;
        } else if let Some(value) = line.strip_prefix("data:") {
            data.push(value.strip_prefix(' ').unwrap_or(value));
        } else if let Some(value) = line.strip_prefix("event:") {
            let value = value.trim();
            if value.len() > 128
                || !value
                    .bytes()
                    .all(|c| c.is_ascii_alphanumeric() || b"._:-".contains(&c))
            {
                return None;
            }
            event = Some(value);
        } else if line.starts_with(':') || line.starts_with("id:") || line.starts_with("retry:") {
            // Transport-only fields are deliberately absent from recorded content.
        } else {
            return None;
        }
        if output.len() > MAX_PAYLOAD_BYTES {
            return None;
        }
    }
    // EOF cannot dispatch an unfinished SSE event, even if its JSON parses.
    if !data.is_empty() {
        return None;
    }
    Some(output)
}

fn aad(id: &str) -> Vec<u8> {
    let mut value = b"lumi.gateway.recording.v1\0".to_vec();
    value.extend_from_slice(id.as_bytes());
    value
}

fn encrypt(
    cipher: &Aes256Gcm,
    id: &str,
    payload: &RecordPayloads,
) -> Result<Vec<u8>, RecordingError> {
    let mut plain = Vec::with_capacity(10 + payload.request.len() + payload.response.len());
    plain.push(PAYLOAD_VERSION);
    plain.push(u8::from(payload.response_is_sse));
    plain.extend_from_slice(&(payload.request.len() as u32).to_be_bytes());
    plain.extend_from_slice(&(payload.response.len() as u32).to_be_bytes());
    plain.extend_from_slice(&payload.request);
    plain.extend_from_slice(&payload.response);
    let mut nonce = [0u8; 12];
    OsRng
        .try_fill_bytes(&mut nonce)
        .map_err(|_| RecordingError::EncryptionFailed)?;
    let encrypted = cipher
        .encrypt(
            Nonce::from_slice(&nonce),
            Payload {
                msg: &plain,
                aad: &aad(id),
            },
        )
        .map_err(|_| RecordingError::EncryptionFailed);
    plain.fill(0);
    let encrypted = encrypted?;
    let mut envelope = Vec::with_capacity(13 + encrypted.len());
    envelope.push(PAYLOAD_VERSION);
    envelope.extend_from_slice(&nonce);
    envelope.extend_from_slice(&encrypted);
    Ok(envelope)
}

fn decrypt(
    cipher: &Aes256Gcm,
    id: &str,
    envelope: &[u8],
) -> Result<RecordPayloads, RecordingError> {
    if envelope.len() < 39
        || envelope.len() > 2 * MAX_PAYLOAD_BYTES + 39
        || envelope[0] != PAYLOAD_VERSION
    {
        return Err(RecordingError::CorruptRecord);
    }
    let mut plain = cipher
        .decrypt(
            Nonce::from_slice(&envelope[1..13]),
            Payload {
                msg: &envelope[13..],
                aad: &aad(id),
            },
        )
        .map_err(|_| RecordingError::DecryptionFailed)?;
    let decoded = decode_payload(&plain);
    plain.fill(0);
    decoded
}

fn decode_payload(plain: &[u8]) -> Result<RecordPayloads, RecordingError> {
    if plain.len() < 10 || plain[0] != PAYLOAD_VERSION || plain[1] > 1 {
        return Err(RecordingError::CorruptRecord);
    }
    let request_len = u32::from_be_bytes(
        plain[2..6]
            .try_into()
            .map_err(|_| RecordingError::CorruptRecord)?,
    ) as usize;
    let response_len = u32::from_be_bytes(
        plain[6..10]
            .try_into()
            .map_err(|_| RecordingError::CorruptRecord)?,
    ) as usize;
    if request_len > MAX_PAYLOAD_BYTES
        || response_len > MAX_PAYLOAD_BYTES
        || plain.len() != 10 + request_len + response_len
    {
        return Err(RecordingError::CorruptRecord);
    }
    Ok(RecordPayloads {
        request: plain[10..10 + request_len].to_vec(),
        response: plain[10 + request_len..].to_vec(),
        response_is_sse: plain[1] == 1,
    })
}
