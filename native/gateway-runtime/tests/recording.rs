use lumi_gateway_runtime::{
    policy::TierField,
    recording::{MAX_PAYLOAD_BYTES, RecordPayloads, Recorder, RecordingError, RequestRecord},
};
use rusqlite::{Connection, params};
use serde_json::{Value, json};
use std::{
    fs,
    path::Path,
    time::{SystemTime, UNIX_EPOCH},
};
use tempfile::TempDir;

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_millis() as u64
}
fn record(id: &str, time: u64) -> RequestRecord {
    RequestRecord {
        id: id.into(),
        started_at_ms: time,
        route_id: "route-1".into(),
        client: "codex".into(),
        endpoint: "/v1/responses".into(),
        model: Some("test-model".into()),
        status: "completed".into(),
        http_status: Some(200),
        original: TierField::Missing,
        effective: TierField::String("priority".into()),
        reported: TierField::String("default".into()),
        rule_id: Some("tier-rule-1".into()),
        request_bytes: 200,
        response_bytes: 300,
        duration_ms: 100,
        first_response_ms: None,
        first_content_ms: None,
        input_tokens: None,
        output_tokens: None,
        cache_read_tokens: None,
        cache_write_tokens: None,
        recording_partial: false,
        error_code: None,
        chain: None,
    }
}
fn database() -> (TempDir, std::path::PathBuf) {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("records.sqlite");
    (directory, path)
}
fn ciphertext(path: &Path, id: &str) -> Vec<u8> {
    Connection::open(path)
        .unwrap()
        .query_row("SELECT payload FROM records WHERE id=?1", [id], |row| {
            row.get(0)
        })
        .unwrap()
}
fn disk_bytes(path: &Path) -> Vec<u8> {
    let mut bytes = fs::read(path).unwrap();
    for suffix in ["-wal", "-shm"] {
        if let Ok(content) = fs::read(format!("{}{suffix}", path.display())) {
            bytes.extend(content);
        }
    }
    bytes
}
fn contains(bytes: &[u8], value: &str) -> bool {
    bytes.windows(value.len()).any(|v| v == value.as_bytes())
}

#[test]
fn metadata_mode_has_no_payload_and_preserves_unknown_observations() {
    let (_directory, path) = database();
    let mut recorder = Recorder::open(&path, None, 7, 100).unwrap();
    let mut value = record("metadata-1", now_ms());
    value.original = TierField::String("Provider.Custom-1".into());
    value.reported = TierField::Unavailable;
    recorder.save(&value, None).unwrap();
    assert_eq!(
        recorder.get(&value.id).unwrap().unwrap().original,
        value.original
    );
    let got = recorder.get(&value.id).unwrap().unwrap();
    assert!(matches!(got.reported, TierField::Unavailable));
    assert!(got.input_tokens.is_none());
    assert!(got.cache_read_tokens.is_none());
    assert!(recorder.read_payloads(&value.id).unwrap().is_none());
    let db = Connection::open(&path).unwrap();
    let metadata: String = db
        .query_row("SELECT metadata FROM records", [], |row| row.get(0))
        .unwrap();
    let object: Value = serde_json::from_str(&metadata).unwrap();
    assert!(object.get("request").is_none());
    assert!(object.get("response").is_none());
    assert!(object.get("headers").is_none());
}

#[test]
fn missing_key_never_falls_back_to_plaintext() {
    let (_directory, path) = database();
    let mut recorder = Recorder::open(&path, None, 7, 100).unwrap();
    let value = record("no-key", now_ms());
    let payload = RecordPayloads {
        request: br#"{"input":"private-message-no-key"}"#.to_vec(),
        response: Vec::new(),
        response_is_sse: false,
    };
    assert!(matches!(
        recorder.save(&value, Some(&payload)),
        Err(RecordingError::EncryptionUnavailable)
    ));
    assert!(recorder.get(&value.id).unwrap().is_none());
    assert!(!contains(&disk_bytes(&path), "private-message-no-key"));
    recorder.save(&value, None).unwrap();
    assert!(recorder.read_payloads(&value.id).unwrap().is_none());
}

#[test]
fn payloads_are_redacted_encrypted_and_use_a_fresh_nonce_on_every_save() {
    let (_directory, path) = database();
    let mut recorder = Recorder::open(&path, Some([7; 32]), 7, 100).unwrap();
    let value = record("encrypted-1", now_ms());
    let payload = RecordPayloads {
        request: serde_json::to_vec(&json!({"input":"message-body-request-unique", "max_tokens":300,
            "api_key":"fake-api-key-unique", "nested":[{"headers":{"Authorization":"Bearer fake-auth-unique"},
            "password":concat!("fake-password-", "unique"), "access_token":"fake-token-unique"}]})).unwrap(),
        response: serde_json::to_vec(&json!({"output":"message-body-response-unique",
            "cookie":"fake-cookie-unique","credentials":{"secret":"fake-secret-unique"}})).unwrap(),
        response_is_sse: false };
    recorder.save(&value, Some(&payload)).unwrap();
    let first = ciphertext(&path, &value.id);
    let exported = recorder.read_payloads(&value.id).unwrap().unwrap();
    let request: Value = serde_json::from_slice(&exported.request).unwrap();
    let response: Value = serde_json::from_slice(&exported.response).unwrap();
    assert_eq!(request["input"], "message-body-request-unique");
    assert_eq!(request["max_tokens"], 300);
    assert_eq!(request["api_key"], "[REDACTED]");
    assert_eq!(
        request["nested"][0]["headers"]["Authorization"],
        "[REDACTED]"
    );
    assert_eq!(request["nested"][0]["access_token"], "[REDACTED]");
    assert_eq!(request["nested"][0]["password"], "[REDACTED]");
    assert_eq!(response["cookie"], "[REDACTED]");
    assert_eq!(response["credentials"], "[REDACTED]");
    recorder.save(&value, Some(&payload)).unwrap();
    let second = ciphertext(&path, &value.id);
    assert_ne!(&first[1..13], &second[1..13]);
    assert_ne!(first, second);
    let disk = disk_bytes(&path);
    for secret in [
        "message-body-request-unique",
        "message-body-response-unique",
        "fake-api-key-unique",
        "fake-auth-unique",
        "fake-password-unique",
        "fake-cookie-unique",
        "fake-secret-unique",
    ] {
        assert!(
            !contains(&disk, secret),
            "plaintext escaped to database or WAL"
        );
    }
}

#[test]
fn wrong_key_tampering_and_copying_ciphertext_to_another_id_fail_authentication() {
    let (_directory, path) = database();
    let mut recorder = Recorder::open(&path, Some([4; 32]), 7, 100).unwrap();
    let value = record("auth-1", now_ms());
    let payload = RecordPayloads {
        request: br#"{"input":"test"}"#.to_vec(),
        response: br#"{"output":"test"}"#.to_vec(),
        response_is_sse: false,
    };
    recorder.save(&value, Some(&payload)).unwrap();
    let wrong_key = Recorder::open(&path, Some([5; 32]), 7, 100).unwrap();
    assert!(matches!(
        wrong_key.read_payloads(&value.id),
        Err(RecordingError::DecryptionFailed)
    ));
    let unavailable = Recorder::open(&path, None, 7, 100).unwrap();
    assert!(matches!(
        unavailable.read_payloads(&value.id),
        Err(RecordingError::EncryptionUnavailable)
    ));
    assert!(unavailable.get(&value.id).unwrap().is_some());
    let other = record("auth-2", value.started_at_ms);
    recorder.save(&other, None).unwrap();
    let db = Connection::open(&path).unwrap();
    let original = ciphertext(&path, &value.id);
    db.execute(
        "UPDATE records SET payload=?1 WHERE id=?2",
        params![original, other.id],
    )
    .unwrap();
    assert!(matches!(
        recorder.read_payloads(&other.id),
        Err(RecordingError::DecryptionFailed)
    ));
    let mut tampered = ciphertext(&path, &value.id);
    let last = tampered.len() - 1;
    tampered[last] ^= 1;
    db.execute(
        "UPDATE records SET payload=?1 WHERE id=?2",
        params![tampered, value.id],
    )
    .unwrap();
    assert!(matches!(
        recorder.read_payloads(&value.id),
        Err(RecordingError::DecryptionFailed)
    ));
}

#[test]
fn sse_records_each_json_event_without_leaking_sensitive_fields() {
    let (_directory, path) = database();
    let mut recorder = Recorder::open(&path, Some([8; 32]), 7, 100).unwrap();
    let value = record("sse-1", now_ms());
    let payload = RecordPayloads { request: br#"{"stream":true}"#.to_vec(), response:
        b": ignored transport comment\r\nevent: response.delta\r\nid: ignored-transport-id\r\ndata: {\"delta\":\"hello\",\"token\":\"fake-sse-token\"}\r\n\r\nevent: response.completed\r\ndata: {\"response\":\r\ndata: {\"service_tier\":\"default\",\"password\":\"fake-sse-password\"}}\r\n\r\ndata: [DONE]\r\n\r\n".to_vec(),
        response_is_sse: true };
    recorder.save(&value, Some(&payload)).unwrap();
    let exported = recorder.read_payloads(&value.id).unwrap().unwrap();
    assert!(exported.response_is_sse);
    let sse = String::from_utf8(exported.response).unwrap();
    assert!(sse.contains("event: response.delta"));
    assert!(sse.contains("event: response.completed"));
    assert!(sse.contains("\"delta\":\"hello\""));
    assert!(sse.contains("[REDACTED]"));
    assert!(sse.contains("data: [DONE]"));
    assert!(!sse.contains("fake-sse-token"));
    assert!(!sse.contains("fake-sse-password"));
    assert!(!sse.contains("ignored-transport-id"));
    assert!(!recorder.get(&value.id).unwrap().unwrap().recording_partial);
}

#[test]
fn unparseable_binary_and_oversized_payloads_are_omitted_instead_of_truncated() {
    let (_directory, path) = database();
    let mut recorder = Recorder::open(&path, Some([1; 32]), 7, 100).unwrap();
    let oversized = serde_json::to_vec(&json!({"input":"x".repeat(MAX_PAYLOAD_BYTES)})).unwrap();
    let cases = [
        (
            "bad-json",
            b"plaintext-request-must-not-persist".to_vec(),
            false,
        ),
        ("too-big", oversized, false),
        ("bad-utf8", vec![0xff, 0xfe, 0xfd], false),
        (
            "bad-sse",
            b"data: unparseable-sse-secret\n\n".to_vec(),
            true,
        ),
    ];
    for (id, bad, is_sse) in cases {
        let value = record(id, now_ms());
        let payload = if is_sse {
            RecordPayloads {
                request: Vec::new(),
                response: bad,
                response_is_sse: true,
            }
        } else {
            RecordPayloads {
                request: bad,
                response: br#"{"ok":true}"#.to_vec(),
                response_is_sse: false,
            }
        };
        recorder.save(&value, Some(&payload)).unwrap();
        assert!(recorder.get(id).unwrap().unwrap().recording_partial);
        if let Some(exported) = recorder.read_payloads(id).unwrap() {
            assert!(exported.request.is_empty());
            if is_sse {
                assert!(exported.response.is_empty());
            } else {
                assert_eq!(
                    serde_json::from_slice::<Value>(&exported.response).unwrap(),
                    json!({"ok":true})
                );
            }
        }
    }
    let disk = disk_bytes(&path);
    assert!(!contains(&disk, "plaintext-request-must-not-persist"));
    assert!(!contains(&disk, "unparseable-sse-secret"));
}

#[test]
fn deleting_a_streaming_record_blocks_late_save_and_survives_restart() {
    let (_directory, path) = database();
    let mut streaming = Recorder::open(&path, Some([2; 32]), 7, 10).unwrap();
    let mut value = record("streaming-record", now_ms());
    value.status = "forwarding".into();
    streaming.save(&value, None).unwrap();
    let mut manager = Recorder::open(&path, Some([2; 32]), 7, 10).unwrap();
    assert!(manager.delete(&value.id).unwrap());
    value.status = "completed".into();
    assert!(matches!(
        streaming.save(&value, None),
        Err(RecordingError::DeletedRecord)
    ));
    assert!(streaming.get(&value.id).unwrap().is_none());
    drop(manager);
    drop(streaming);
    let mut reopened = Recorder::open(&path, Some([2; 32]), 7, 10).unwrap();
    assert!(matches!(
        reopened.save(&value, None),
        Err(RecordingError::DeletedRecord)
    ));
    assert!(reopened.get(&value.id).unwrap().is_none());
}

#[test]
fn lifecycle_updates_preserve_identity_and_metadata_only_updates_remove_payloads() {
    let (_directory, path) = database();
    let mut recorder = Recorder::open(&path, Some([9; 32]), 7, 10).unwrap();
    let mut value = record("lifecycle-1", now_ms());
    value.status = "forwarding".into();
    let payload = RecordPayloads {
        request: br#"{"input":"test"}"#.to_vec(),
        response: Vec::new(),
        response_is_sse: false,
    };
    recorder.save(&value, Some(&payload)).unwrap();
    value.status = "completed".into();
    value.input_tokens = Some(100);
    value.first_content_ms = Some(12);
    recorder.save(&value, None).unwrap();
    let got = recorder.get(&value.id).unwrap().unwrap();
    assert_eq!(got.status, "completed");
    assert_eq!(got.input_tokens, Some(100));
    assert_eq!(got.first_content_ms, Some(12));
    assert!(recorder.read_payloads(&value.id).unwrap().is_none());
    value.route_id = "other-route".into();
    assert!(matches!(
        recorder.save(&value, None),
        Err(RecordingError::IdentityConflict)
    ));
}

#[test]
fn pagination_is_stable_for_records_with_identical_timestamps() {
    let (_directory, path) = database();
    let mut recorder = Recorder::open(&path, None, 7, 10).unwrap();
    let time = now_ms();
    for n in 1..=6 {
        recorder
            .save(&record(&format!("page-{n:02}"), time), None)
            .unwrap();
    }
    let first = recorder.list(2, None).unwrap();
    assert_eq!(
        first.iter().map(|r| r.id.as_str()).collect::<Vec<_>>(),
        ["page-06", "page-05"]
    );
    let second = recorder.list(2, Some(&first[1].id)).unwrap();
    assert_eq!(
        second.iter().map(|r| r.id.as_str()).collect::<Vec<_>>(),
        ["page-04", "page-03"]
    );
    let third = recorder.list(2, Some(&second[1].id)).unwrap();
    assert_eq!(
        third.iter().map(|r| r.id.as_str()).collect::<Vec<_>>(),
        ["page-02", "page-01"]
    );
    assert!(recorder.list(2, Some(&third[1].id)).unwrap().is_empty());
    assert!(matches!(
        recorder.list(0, None),
        Err(RecordingError::InvalidLimit)
    ));
    assert!(matches!(
        recorder.list(101, None),
        Err(RecordingError::InvalidLimit)
    ));
    assert!(matches!(
        recorder.list(2, Some("missing-cursor")),
        Err(RecordingError::InvalidCursor)
    ));
}

#[test]
fn retention_and_capacity_persist_an_eviction_watermark() {
    let (_directory, path) = database();
    let time = now_ms();
    let old = record("old-record", time - 2 * 86_400_000);
    let mut recorder = Recorder::open(&path, None, 30, 10).unwrap();
    recorder.save(&old, None).unwrap();
    drop(recorder);
    let mut recorder = Recorder::open(&path, None, 1, 2).unwrap();
    assert!(recorder.get(&old.id).unwrap().is_none());
    assert!(matches!(
        recorder.save(&old, None),
        Err(RecordingError::ExpiredRecord)
    ));
    let values = [
        record("capacity-1", time - 30),
        record("capacity-2", time - 20),
        record("capacity-3", time - 10),
    ];
    for value in &values {
        recorder.save(value, None).unwrap();
    }
    assert!(recorder.get("capacity-1").unwrap().is_none());
    assert_eq!(recorder.list(100, None).unwrap().len(), 2);
    assert!(matches!(
        recorder.save(&values[0], None),
        Err(RecordingError::ExpiredRecord)
    ));
    drop(recorder);
    let mut recorder = Recorder::open(&path, None, 1, 2).unwrap();
    assert!(matches!(
        recorder.save(&values[0], None),
        Err(RecordingError::ExpiredRecord)
    ));
}

#[test]
fn deletion_tombstones_are_bounded_without_reviving_evicted_requests() {
    let (_directory, path) = database();
    let mut recorder = Recorder::open(&path, None, 7, 2).unwrap();
    let base = now_ms() - 1000;
    let original = record("deleted-00", base);
    for index in 0..12 {
        let value = record(&format!("deleted-{index:02}"), base + index);
        recorder.save(&value, None).unwrap();
        assert!(recorder.delete(&value.id).unwrap());
    }
    let db = Connection::open(&path).unwrap();
    let count: u64 = db
        .query_row("SELECT COUNT(*) FROM recording_tombstones", [], |row| {
            row.get(0)
        })
        .unwrap();
    assert!(count <= 2);
    assert!(matches!(
        recorder.save(&original, None),
        Err(RecordingError::ExpiredRecord)
    ));
    assert!(recorder.list(100, None).unwrap().is_empty());
}

#[test]
fn invalid_metadata_is_rejected_and_untrusted_tier_text_is_not_logged() {
    let (_directory, path) = database();
    let mut recorder = Recorder::open(&path, None, 7, 10).unwrap();
    let mut value = record("invalid-metadata", now_ms());
    value.endpoint = "/v1/responses?api_key=fake-query-key".into();
    assert!(matches!(
        recorder.save(&value, None),
        Err(RecordingError::InvalidRecord)
    ));
    value.endpoint = "/v1/responses".into();
    value.original = TierField::String("Bearer fake-tier-secret".into());
    recorder.save(&value, None).unwrap();
    assert!(matches!(
        recorder.get(&value.id).unwrap().unwrap().original,
        TierField::Invalid
    ));
    assert!(!contains(&disk_bytes(&path), "fake-tier-secret"));
    assert!(!contains(&disk_bytes(&path), "fake-query-key"));
}

#[test]
fn incomplete_sse_events_are_not_reconstructed_as_complete_recordings() {
    let (_directory, path) = database();
    let mut recorder = Recorder::open(&path, Some([13; 32]), 7, 100).unwrap();
    for (index, suffix) in ["", "\n"].iter().enumerate() {
        let value = record(&format!("unfinished-sse-{index}"), now_ms());
        let payload = RecordPayloads {
            request: Vec::new(),
            response: format!("data: {{\"delta\":\"unfinished-private-content\"}}{suffix}")
                .into_bytes(),
            response_is_sse: true,
        };
        recorder.save(&value, Some(&payload)).unwrap();
        assert!(recorder.get(&value.id).unwrap().unwrap().recording_partial);
        assert!(recorder.read_payloads(&value.id).unwrap().is_none());
    }
    assert!(!contains(&disk_bytes(&path), "unfinished-private-content"));
}

#[test]
fn save_reports_actual_persisted_partial_state_after_body_omission() {
    let (_directory, path) = database();
    let mut recorder = Recorder::open(&path, Some([17; 32]), 7, 10).unwrap();
    let value = record("reported-partial", now_ms());
    let payload = RecordPayloads {
        request: serde_json::to_vec(&json!({"input":"x".repeat(MAX_PAYLOAD_BYTES)})).unwrap(),
        response: br#"{"output_text":"complete-response"}"#.to_vec(),
        response_is_sse: false,
    };
    let saved = recorder.save(&value, Some(&payload)).unwrap();
    assert!(saved.recording_partial);
    assert!(recorder.get(&value.id).unwrap().unwrap().recording_partial);
    let exported = recorder.read_payloads(&value.id).unwrap().unwrap();
    assert!(exported.request.is_empty());
    assert_eq!(
        serde_json::from_slice::<Value>(&exported.response).unwrap()["output_text"],
        "complete-response"
    );
    let complete = record("reported-complete", now_ms());
    assert!(!recorder.save(&complete, None).unwrap().recording_partial);
}

#[test]
fn explicit_interruption_recovery_preserves_ciphertext_and_observed_metadata() {
    let (_directory, path) = database();
    let mut recorder = Recorder::open(&path, Some([19; 32]), 7, 10).unwrap();
    let mut ongoing = record("recover-forwarding", now_ms());
    ongoing.status = "forwarding".into();
    ongoing.reported = TierField::Unavailable;
    ongoing.duration_ms = 0;
    ongoing.first_response_ms = None;
    ongoing.input_tokens = None;
    let payload = RecordPayloads {
        request: br#"{"input":"preserved-private-record"}"#.to_vec(),
        response: Vec::new(),
        response_is_sse: false,
    };
    recorder.save(&ongoing, Some(&payload)).unwrap();
    let encrypted = ciphertext(&path, &ongoing.id);
    let finished = record("recover-completed", ongoing.started_at_ms);
    recorder.save(&finished, Some(&payload)).unwrap();
    drop(recorder);
    let mut recorder = Recorder::open(&path, Some([19; 32]), 7, 10).unwrap();
    assert_eq!(
        recorder.get(&ongoing.id).unwrap().unwrap().status,
        "forwarding"
    );
    assert_eq!(recorder.recover_interrupted().unwrap(), 1);
    let recovered = recorder.get(&ongoing.id).unwrap().unwrap();
    assert_eq!(recovered.status, "interrupted");
    assert_eq!(recovered.error_code.as_deref(), Some("process-interrupted"));
    assert!(recovered.recording_partial);
    assert!(matches!(recovered.reported, TierField::Unavailable));
    assert_eq!(recovered.duration_ms, 0);
    assert!(recovered.first_response_ms.is_none());
    assert!(recovered.input_tokens.is_none());
    assert_eq!(ciphertext(&path, &ongoing.id), encrypted);
    assert!(recorder.read_payloads(&ongoing.id).unwrap().is_some());
    assert_eq!(
        recorder.get(&finished.id).unwrap().unwrap().status,
        "completed"
    );
    assert_eq!(recorder.recover_interrupted().unwrap(), 0);
}
