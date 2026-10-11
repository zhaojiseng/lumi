use base64::{Engine as _, engine::general_purpose::STANDARD};
use lumi_gateway_runtime::{config::GatewayConfig, gateway::GatewayEngine, recording::Recorder};
use serde_json::{Value, json};
use std::{
    fs,
    path::Path,
    time::{SystemTime, UNIX_EPOCH},
};

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_millis() as u64
}
fn config(action: Value, bodies: bool) -> GatewayConfig {
    serde_json::from_value(json!({"schemaVersion":1,"listen":"127.0.0.1:18181",
        "routes":[{"id":"primary","client":"codex","upstream":"https://example.test/v1"}],
        "rules":[{"id":"selected-tier","action":action}],"recording":{"bodies":bodies},
        "maxConcurrency":2}))
    .unwrap()
}
fn prepare(
    engine: &mut GatewayEngine,
    id: &str,
    route: &str,
    body: &[u8],
) -> Result<Value, String> {
    engine.request(
        "prepare",
        json!({"requestId":id,"routeId":route,"endpoint":"/v1/responses",
        "bodyB64":STANDARD.encode(body),"startedAtMs":now_ms()}),
    )
}
fn finish_input(id: &str, response: &[u8], sse: bool) -> Value {
    json!({"requestId":id,"status":"completed","httpStatus":200,"durationMs":50,
        "firstResponseMs":2,"responseBytes":response.len(),"responseIsSse":sse,
        "recordingPartial":false,"errorCode":null,
        "segments":[{"dataB64":STANDARD.encode(response),"elapsedMs":20}]})
}
fn finish(engine: &mut GatewayEngine, id: &str, response: &[u8], sse: bool) -> Value {
    engine
        .request("finish", finish_input(id, response, sse))
        .unwrap()
}
fn decoded(prepared: &Value) -> Vec<u8> {
    STANDARD
        .decode(prepared["bodyB64"].as_str().unwrap())
        .unwrap()
}
fn records(engine: &mut GatewayEngine) -> Vec<Value> {
    engine
        .request("records", json!({"limit":100,"before":null}))
        .unwrap()
        .as_array()
        .unwrap()
        .clone()
}
fn disk_contains(path: &Path, marker: &str) -> bool {
    ["", "-wal", "-shm"].into_iter().any(|suffix| {
        fs::read(format!("{}{suffix}", path.display())).is_ok_and(|bytes| {
            bytes
                .windows(marker.len())
                .any(|window| window == marker.as_bytes())
        })
    })
}

#[test]
fn configured_modes_change_the_actual_outbound_base64_json() {
    let original = br#"{ "model": "test-model", "service_tier":"default", "input":"hello" }"#;
    let cases = [
        (
            json!({"type":"preserve"}),
            original.as_slice(),
            Some("default"),
            false,
        ),
        (json!({"type":"remove"}), original.as_slice(), None, true),
        (
            json!({"type":"set-if-missing","value":"flex"}),
            br#"{"model":"test-model","input":"hello"}"#.as_slice(),
            Some("flex"),
            true,
        ),
        (
            json!({"type":"override","value":"priority"}),
            original.as_slice(),
            Some("priority"),
            true,
        ),
    ];
    for (action, body, tier, modified) in cases {
        let temp = tempfile::tempdir().unwrap();
        let mut engine = GatewayEngine::open(
            config(action.clone(), false),
            &temp.path().join("records.sqlite"),
            None,
        )
        .unwrap();
        let id = uuid::Uuid::new_v4().to_string();
        let result = prepare(&mut engine, &id, "primary", body).unwrap();
        let outbound = decoded(&result);
        let actual: Value = serde_json::from_slice(&outbound).unwrap();
        assert_eq!(actual.get("service_tier").and_then(Value::as_str), tier);
        assert_eq!(actual["input"], "hello");
        assert_eq!(result["modified"], modified);
        if action["type"] == "preserve" {
            assert_eq!(outbound, body);
        }
        assert_eq!(result["ruleId"], "selected-tier");
        assert_eq!(result["recordingOk"], true);
        finish(&mut engine, &id, br#"{"output_text":"ok"}"#, false);
    }
}

#[test]
fn set_if_missing_preserves_an_explicit_null_and_an_existing_tier() {
    let temp = tempfile::tempdir().unwrap();
    let mut engine = GatewayEngine::open(
        config(json!({"type":"set-if-missing","value":"priority"}), false),
        &temp.path().join("records.sqlite"),
        None,
    )
    .unwrap();
    for body in [
        br#"{"model":"test-model","service_tier":null}"#.as_slice(),
        br#"{"model":"test-model","service_tier":"flex"}"#.as_slice(),
    ] {
        let id = uuid::Uuid::new_v4().to_string();
        let result = prepare(&mut engine, &id, "primary", body).unwrap();
        assert_eq!(decoded(&result), body);
        assert_eq!(result["modified"], false);
        finish(&mut engine, &id, br#"{}"#, false);
    }
}

#[test]
fn recorded_upstream_tier_is_distinct_from_original_and_sent_tier() {
    let temp = tempfile::tempdir().unwrap();
    let mut engine = GatewayEngine::open(
        config(json!({"type":"override","value":"priority"}), false),
        &temp.path().join("records.sqlite"),
        None,
    )
    .unwrap();
    let id = uuid::Uuid::new_v4().to_string();
    prepare(
        &mut engine,
        &id,
        "primary",
        br#"{"service_tier":"flex","input":"hello"}"#,
    )
    .unwrap();
    finish(&mut engine,&id,b"event: response.output_text.delta\ndata: {\"type\":\"response.output_text.delta\",\"delta\":\"ok\"}\n\nevent: response.completed\ndata: {\"type\":\"response.completed\",\"response\":{\"service_tier\":\"default\",\"usage\":{\"input_tokens\":12,\"output_tokens\":3}}}\n\n",true);
    let saved = &records(&mut engine)[0];
    assert_eq!(saved["original"], json!({"state":"string","value":"flex"}));
    assert_eq!(
        saved["effective"],
        json!({"state":"string","value":"priority"})
    );
    assert_eq!(
        saved["reported"],
        json!({"state":"string","value":"default"})
    );
    assert_eq!(saved["input_tokens"], 12);
    assert_eq!(saved["output_tokens"], 3);
    assert_eq!(saved["cache_read_tokens"], Value::Null);
    assert_eq!(saved["first_content_ms"], 20);
}

#[test]
fn missing_or_interrupted_upstream_tier_never_claims_the_requested_tier() {
    let temp = tempfile::tempdir().unwrap();
    let mut engine = GatewayEngine::open(
        config(json!({"type":"override","value":"priority"}), false),
        &temp.path().join("records.sqlite"),
        None,
    )
    .unwrap();
    for (response, sse, state) in [
        (br#"{"output_text":"ok"}"#.as_slice(), false, "missing"),
        (
            b"data: {\"type\":\"response.output_text.delta\",\"delta\":\"partial\"}\n\n".as_slice(),
            true,
            "unavailable",
        ),
    ] {
        let id = uuid::Uuid::new_v4().to_string();
        prepare(&mut engine, &id, "primary", br#"{"input":"hello"}"#).unwrap();
        finish(&mut engine, &id, response, sse);
        let saved = records(&mut engine)
            .into_iter()
            .find(|r| r["id"] == id)
            .unwrap();
        assert_eq!(
            saved["effective"],
            json!({"state":"string","value":"priority"})
        );
        assert_eq!(saved["reported"], json!({"state":state}));
        assert_eq!(saved["input_tokens"], Value::Null);
        assert_eq!(saved["output_tokens"], Value::Null);
    }
}

#[test]
fn body_recording_requires_explicit_enablement_and_an_encryption_key() {
    let request = br#"{"input":"private-engine-request-marker","api_key":"fake-engine-secret"}"#;
    let response = br#"{"output_text":"private-engine-response-marker"}"#;
    for enabled in [false, true] {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("records.sqlite");
        let mut engine = GatewayEngine::open(
            config(json!({"type":"preserve"}), enabled),
            &path,
            Some([41; 32]),
        )
        .unwrap();
        let id = uuid::Uuid::new_v4().to_string();
        prepare(&mut engine, &id, "primary", request).unwrap();
        let result = finish(&mut engine, &id, response, false);
        assert_eq!(result["recordingOk"], true);
        let recorder = Recorder::open(&path, Some([41; 32]), 7, 10_000).unwrap();
        let payloads = recorder.read_payloads(&id).unwrap();
        assert_eq!(payloads.is_some(), enabled);
        if let Some(payloads) = payloads {
            let body: Value = serde_json::from_slice(&payloads.request).unwrap();
            assert_eq!(body["input"], "private-engine-request-marker");
            assert_eq!(body["api_key"], "[REDACTED]");
        }
        for marker in [
            "private-engine-request-marker",
            "private-engine-response-marker",
            "fake-engine-secret",
        ] {
            assert!(!disk_contains(&path, marker));
        }
        for saved in records(&mut engine) {
            assert!(saved.get("request").is_none());
            assert!(saved.get("response").is_none());
        }
    }
    let temp = tempfile::tempdir().unwrap();
    assert!(
        GatewayEngine::open(
            config(json!({"type":"preserve"}), true),
            &temp.path().join("no-key.sqlite"),
            None
        )
        .is_err()
    );
}

#[test]
fn different_routes_for_one_client_match_their_own_rules() {
    let temp = tempfile::tempdir().unwrap();
    let cfg:GatewayConfig=serde_json::from_value(json!({"schemaVersion":1,"listen":"127.0.0.1:18181",
        "routes":[{"id":"account-a","client":"codex","upstream":"https://a.example.test/v1"},
            {"id":"account-b","client":"codex","upstream":"https://b.example.test/v1"}],
        "rules":[{"id":"a-only","match":{"routeId":"account-a","client":"codex"},"action":{"type":"override","value":"priority"}},
            {"id":"b-only","match":{"routeId":"account-b","client":"codex"},"action":{"type":"remove"}}]})).unwrap();
    let mut engine = GatewayEngine::open(cfg, &temp.path().join("records.sqlite"), None).unwrap();
    let a = uuid::Uuid::new_v4().to_string();
    let b = uuid::Uuid::new_v4().to_string();
    let body = br#"{"service_tier":"flex","input":"same-client-independent-route"}"#;
    let result_a = prepare(&mut engine, &a, "account-a", body).unwrap();
    let result_b = prepare(&mut engine, &b, "account-b", body).unwrap();
    assert_eq!(
        result_a["effective"],
        json!({"state":"string","value":"priority"})
    );
    assert_eq!(result_b["effective"], json!({"state":"missing"}));
    finish(&mut engine, &a, br#"{}"#, false);
    finish(&mut engine, &b, br#"{}"#, false);
    assert_eq!(records(&mut engine).len(), 2);
}

#[test]
fn failed_prepares_do_not_consume_pending_capacity() {
    let temp = tempfile::tempdir().unwrap();
    let mut cfg = config(json!({"type":"override","value":"priority"}), false);
    cfg.max_concurrency = 1;
    let mut engine = GatewayEngine::open(cfg, &temp.path().join("records.sqlite"), None).unwrap();
    let id = uuid::Uuid::new_v4().to_string();
    assert!(prepare(&mut engine, &id, "unknown-route", br#"{}"#).is_err());
    assert!(prepare(&mut engine, &id, "primary", b"malformed-json").is_err());
    assert_eq!(engine.request("status", json!({})).unwrap()["pending"], 0);
    prepare(&mut engine, &id, "primary", br#"{}"#).unwrap();
    assert_eq!(engine.request("status", json!({})).unwrap()["pending"], 1);
    assert!(
        prepare(
            &mut engine,
            &uuid::Uuid::new_v4().to_string(),
            "primary",
            br#"{}"#
        )
        .is_err()
    );
    finish(&mut engine, &id, br#"{}"#, false);
    assert_eq!(engine.request("status", json!({})).unwrap()["pending"], 0);
}

#[test]
fn invalid_finish_does_not_consume_a_pending_request() {
    let temp = tempfile::tempdir().unwrap();
    let mut cfg = config(json!({"type":"preserve"}), false);
    cfg.max_concurrency = 1;
    let mut engine = GatewayEngine::open(cfg, &temp.path().join("records.sqlite"), None).unwrap();
    let id = uuid::Uuid::new_v4().to_string();
    prepare(&mut engine, &id, "primary", br#"{}"#).unwrap();
    let valid = finish_input(&id, br#"{}"#, false);
    let mut invalid = valid.clone();
    invalid["status"] = json!("unsupported-status");
    assert!(engine.request("finish", invalid).is_err());
    let mut invalid = valid.clone();
    invalid["segments"][0]["dataB64"] = json!("not-valid-base64!!");
    assert!(engine.request("finish", invalid).is_err());
    let mut invalid = valid.clone();
    invalid["segments"] = json!(vec![json!({"dataB64":"","elapsedMs":0}); 16385]);
    assert!(engine.request("finish", invalid).is_err());
    let mut invalid = valid.clone();
    invalid["segments"][0]["dataB64"] = json!(STANDARD.encode(vec![b'x'; 1024 * 1024 + 1]));
    assert!(engine.request("finish", invalid).is_err());
    assert_eq!(engine.request("status", json!({})).unwrap()["pending"], 1);
    assert_eq!(records(&mut engine)[0]["status"], "forwarding");
    assert_eq!(
        engine.request("finish", valid).unwrap()["recordingOk"],
        true
    );
    assert_eq!(engine.request("status", json!({})).unwrap()["pending"], 0);
    assert_eq!(records(&mut engine)[0]["status"], "completed");
}

#[test]
fn configuration_restricts_listening_and_upstream_urls() {
    let base = serde_json::to_value(config(json!({"type":"preserve"}), false)).unwrap();
    for listener in ["0.0.0.0:18181", "192.168.1.2:18181", "[::]:18181"] {
        let mut value = base.clone();
        value["listen"] = json!(listener);
        assert!(
            serde_json::from_value::<GatewayConfig>(value)
                .unwrap()
                .validate()
                .is_err()
        );
    }
    for upstream in [
        "http://example.test/v1",
        "https://user@example.test/v1",
        concat!("https://user", ":password@example.test/v1"),
        "https://example.test/v1?token=fake",
        "https://example.test/v1#fragment",
        "file:///etc/hosts",
    ] {
        let mut value = base.clone();
        value["routes"][0]["upstream"] = json!(upstream);
        assert!(
            serde_json::from_value::<GatewayConfig>(value)
                .unwrap()
                .validate()
                .is_err(),
            "{upstream}"
        );
    }
    for upstream in [
        "https://example.test/v1",
        "http://127.0.0.1:29001/v1",
        "http://[::1]:29001/v1",
    ] {
        let mut value = base.clone();
        value["routes"][0]["upstream"] = json!(upstream);
        assert!(
            serde_json::from_value::<GatewayConfig>(value)
                .unwrap()
                .validate()
                .is_ok(),
            "{upstream}"
        );
    }
    let mut ipv6 = base;
    ipv6["listen"] = json!("[::1]:18181");
    assert!(
        serde_json::from_value::<GatewayConfig>(ipv6)
            .unwrap()
            .validate()
            .is_ok()
    );
}

#[test]
fn fixed_rpc_and_endpoint_allowlists_reject_arbitrary_paths_and_methods() {
    let temp = tempfile::tempdir().unwrap();
    let mut engine = GatewayEngine::open(
        config(json!({"type":"preserve"}), false),
        &temp.path().join("records.sqlite"),
        None,
    )
    .unwrap();
    for method in [
        "readFile",
        "writeFile",
        "spawn",
        "fetch",
        "proxy",
        "export",
        "../records",
        "GET /v1/responses",
    ] {
        assert!(
            engine
                .request(
                    method,
                    json!({"path":"C:/private","url":"https://example.test/"})
                )
                .is_err()
        );
    }
    for endpoint in [
        "/v1/responses?secret=x",
        "https://example.test/v1/responses",
        "/../private",
        "/v1/models",
    ] {
        assert!(
            engine
                .request(
                    "prepare",
                    json!({"requestId":uuid::Uuid::new_v4().to_string(),"routeId":"primary",
            "endpoint":endpoint,"bodyB64":STANDARD.encode(b"{}"),"startedAtMs":now_ms()})
                )
                .is_err()
        );
    }
    assert_eq!(engine.request("status", json!({})).unwrap()["pending"], 0);
}

#[test]
fn gateway_rejected_is_a_recordable_terminal_status() {
    let temp = tempfile::tempdir().unwrap();
    let mut engine = GatewayEngine::open(
        config(json!({"type":"preserve"}), false),
        &temp.path().join("records.sqlite"),
        None,
    )
    .unwrap();
    let id = uuid::Uuid::new_v4().to_string();
    prepare(&mut engine, &id, "primary", br#"{}"#).unwrap();
    let mut input = finish_input(&id, &[], false);
    input["status"] = json!("gateway-rejected");
    input["httpStatus"] = json!(400);
    input["errorCode"] = json!("gateway-rejected");
    assert_eq!(
        engine.request("finish", input).unwrap()["recordingOk"],
        true
    );
    assert_eq!(engine.request("status", json!({})).unwrap()["pending"], 0);
    let saved = records(&mut engine);
    assert_eq!(saved[0]["status"], "gateway-rejected");
    assert_eq!(saved[0]["error_code"], "gateway-rejected");
}

#[test]
fn configured_request_body_limit_accepts_four_mib_and_rejects_above_it() {
    let mut cfg = config(json!({"type":"preserve"}), false);
    cfg.max_request_bytes = 4 * 1024 * 1024;
    assert!(cfg.validate().is_ok());
    let temp = tempfile::tempdir().unwrap();
    let mut engine =
        GatewayEngine::open(cfg.clone(), &temp.path().join("records.sqlite"), None).unwrap();
    let prefix = b"{\"input\":\"";
    let suffix = b"\"}";
    let mut body = prefix.to_vec();
    body.extend(vec![
        b'x';
        cfg.max_request_bytes - prefix.len() - suffix.len()
    ]);
    body.extend(suffix);
    assert_eq!(body.len(), 4 * 1024 * 1024);
    let id = uuid::Uuid::new_v4().to_string();
    let prepared = prepare(&mut engine, &id, "primary", &body).unwrap();
    assert_eq!(decoded(&prepared), body);
    finish(&mut engine, &id, br#"{}"#, false);
    let mut too_large = body;
    too_large.push(b' ');
    assert!(
        prepare(
            &mut engine,
            &uuid::Uuid::new_v4().to_string(),
            "primary",
            &too_large
        )
        .is_err()
    );
    assert_eq!(engine.request("status", json!({})).unwrap()["pending"], 0);
    cfg.max_request_bytes += 1;
    assert!(cfg.validate().is_err());
}

#[test]
fn finish_reports_recording_omission_separately_from_complete_response_observation() {
    let temp = tempfile::tempdir().unwrap();
    let mut engine = GatewayEngine::open(
        config(json!({"type":"preserve"}), true),
        &temp.path().join("records.sqlite"),
        Some([51; 32]),
    )
    .unwrap();
    let request = serde_json::to_vec(&json!({"input":"x".repeat(1024*1024)})).unwrap();
    let id = uuid::Uuid::new_v4().to_string();
    prepare(&mut engine, &id, "primary", &request).unwrap();
    let finished = finish(&mut engine, &id, br#"{"output_text":"complete"}"#, false);
    assert_eq!(finished["recordingOk"], true);
    assert_eq!(finished["observationPartial"], false);
    assert_eq!(finished["recordingPartial"], true);
    let saved = records(&mut engine);
    assert_eq!(saved[0]["recording_partial"], true);
}

#[test]
fn finishing_an_explicitly_deleted_record_reports_recording_failure_and_partial() {
    let temp = tempfile::tempdir().unwrap();
    let mut engine = GatewayEngine::open(
        config(json!({"type":"preserve"}), false),
        &temp.path().join("records.sqlite"),
        None,
    )
    .unwrap();
    let id = uuid::Uuid::new_v4().to_string();
    prepare(&mut engine, &id, "primary", br#"{}"#).unwrap();
    engine.request("delete", json!({"id":id})).unwrap();
    let finished = finish(&mut engine, &id, br#"{}"#, false);
    assert_eq!(finished["recordingOk"], false);
    assert_eq!(finished["observationPartial"], false);
    assert_eq!(finished["recordingPartial"], true);
    assert!(records(&mut engine).is_empty());
}

#[test]
fn invalid_finish_metadata_and_observation_limits_do_not_consume_pending() {
    let temp = tempfile::tempdir().unwrap();
    let mut engine = GatewayEngine::open(
        config(json!({"type":"preserve"}), false),
        &temp.path().join("records.sqlite"),
        None,
    )
    .unwrap();
    let id = uuid::Uuid::new_v4().to_string();
    prepare(&mut engine, &id, "primary", br#"{}"#).unwrap();
    let valid = finish_input(&id, br#"{}"#, false);
    for (field, invalid_value) in [
        ("errorCode", json!("contains private detail")),
        ("errorCode", json!("")),
        ("errorCode", json!("x".repeat(65))),
        ("httpStatus", json!(99)),
        ("httpStatus", json!(600)),
        ("firstResponseMs", json!(51)),
        ("responseBytes", json!(1)),
    ] {
        let mut invalid = valid.clone();
        invalid[field] = invalid_value;
        assert!(engine.request("finish", invalid).is_err(), "{field}");
        assert_eq!(engine.request("status", json!({})).unwrap()["pending"], 1);
    }
    let mut invalid = valid.clone();
    invalid["segments"][0]["elapsedMs"] = json!(51);
    assert!(engine.request("finish", invalid).is_err());
    let mut invalid = valid.clone();
    invalid["segments"] = json!([
        {"dataB64":STANDARD.encode(b"{"),"elapsedMs":20},
        {"dataB64":STANDARD.encode(b"}"),"elapsedMs":10}]);
    assert!(engine.request("finish", invalid).is_err());
    assert_eq!(engine.request("status", json!({})).unwrap()["pending"], 1);
    assert_eq!(
        engine.request("finish", valid).unwrap()["recordingOk"],
        true
    );
}

#[test]
fn gateway_restart_marks_old_forwarding_interrupted_without_inventing_observations() {
    let temp = tempfile::tempdir().unwrap();
    let path = temp.path().join("records.sqlite");
    let cfg = config(json!({"type":"preserve"}), false);
    let id = uuid::Uuid::new_v4().to_string();
    {
        let mut engine = GatewayEngine::open(cfg.clone(), &path, None).unwrap();
        prepare(&mut engine, &id, "primary", br#"{"input":"test"}"#).unwrap();
        assert_eq!(records(&mut engine)[0]["status"], "forwarding");
    }
    let mut reopened = GatewayEngine::open(cfg, &path, None).unwrap();
    let recovered = records(&mut reopened);
    assert_eq!(recovered[0]["status"], "interrupted");
    assert_eq!(recovered[0]["error_code"], "process-interrupted");
    assert_eq!(recovered[0]["recording_partial"], true);
    assert_eq!(recovered[0]["reported"], json!({"state":"unavailable"}));
    assert_eq!(recovered[0]["first_response_ms"], Value::Null);
    assert_eq!(recovered[0]["input_tokens"], Value::Null);
    assert_eq!(recovered[0]["duration_ms"], 0);
    assert_eq!(reopened.request("status", json!({})).unwrap()["pending"], 0);
}

#[test]
fn unavailable_tier_observation_marks_recording_partial_during_prepare() {
    let temp = tempfile::tempdir().unwrap();
    let mut engine = GatewayEngine::open(
        config(json!({"type":"preserve"}), false),
        &temp.path().join("records.sqlite"),
        None,
    )
    .unwrap();
    let id = uuid::Uuid::new_v4().to_string();
    let request =
        serde_json::to_vec(&json!({"input":"hello","service_tier":"x".repeat(65)})).unwrap();
    let prepared = prepare(&mut engine, &id, "primary", &request).unwrap();
    assert_eq!(decoded(&prepared), request);
    assert_eq!(prepared["original"], json!({"state":"unavailable"}));
    assert_eq!(records(&mut engine)[0]["recording_partial"], true);
    let finished = finish(&mut engine, &id, br#"{}"#, false);
    assert_eq!(finished["recordingPartial"], true);
    assert_eq!(finished["observationPartial"], false);
}

fn replace(
    engine: &mut GatewayEngine,
    cfg: &GatewayConfig,
    expected: u64,
) -> Result<Value, String> {
    engine.request(
        "config.replace",
        json!({"expectedVersion":expected,"config":cfg}),
    )
}
fn filtered(
    engine: &mut GatewayEngine,
    filter: Value,
    cursor: Option<&str>,
    limit: usize,
) -> Result<Value, String> {
    engine.request(
        "records.list.filtered",
        json!({"filter":filter,"cursor":cursor,"limit":limit}),
    )
}
fn get_body(engine: &mut GatewayEngine, id: &str, cursor: Option<&str>) -> Result<Value, String> {
    engine.request(
        "records.get",
        json!({"recordId":id,"includeBody":true,"bodyCursor":cursor}),
    )
}

#[test]
fn replacing_validated_config_uses_versions_and_freezes_pending_policy_and_recording() {
    let temp = tempfile::tempdir().unwrap();
    let path = temp.path().join("records.sqlite");
    let first = config(json!({"type":"preserve"}), false);
    let mut engine = GatewayEngine::open(first.clone(), &path, Some([61; 32])).unwrap();
    let old_id = uuid::Uuid::new_v4().to_string();
    let before = prepare(
        &mut engine,
        &old_id,
        "primary",
        br#"{"input":"old","service_tier":"flex"}"#,
    )
    .unwrap();
    let mut updated = config(json!({"type":"override","value":"priority"}), true);
    updated.recording.capture_bytes = 32;
    assert_eq!(
        engine
            .request("config.validate", json!({"config":updated}))
            .unwrap(),
        json!({"valid":true})
    );
    assert_eq!(
        engine.request("config.get", json!({})).unwrap()["configVersion"],
        1
    );
    assert_eq!(
        replace(&mut engine, &updated, 2),
        Err("config-conflict".into())
    );
    let mut invalid = updated.clone();
    invalid.listen = "0.0.0.0:18181".parse().unwrap();
    assert_eq!(
        replace(&mut engine, &invalid, 1),
        Err("invalid-config".into())
    );
    assert_eq!(
        replace(&mut engine, &updated, 1).unwrap()["configVersion"],
        2
    );
    let new_id = uuid::Uuid::new_v4().to_string();
    let after = prepare(
        &mut engine,
        &new_id,
        "primary",
        br#"{"input":"new","service_tier":"flex"}"#,
    )
    .unwrap();
    assert_eq!(
        before["effective"],
        json!({"state":"string","value":"flex"})
    );
    assert_eq!(
        after["effective"],
        json!({"state":"string","value":"priority"})
    );
    finish(&mut engine, &old_id, br#"{}"#, false);
    let observed = finish(
        &mut engine,
        &new_id,
        br#"{"service_tier":"default","usage":{"input_tokens":17}}"#,
        false,
    );
    assert_eq!(observed["observationPartial"], false);
    assert_eq!(observed["recordingPartial"], true);
    let recorder = Recorder::open(&path, Some([61; 32]), 7, 10_000).unwrap();
    assert!(recorder.read_payloads(&old_id).unwrap().is_none());
    assert!(recorder.read_payloads(&new_id).unwrap().is_none());
    let new_record = recorder.get(&new_id).unwrap().unwrap();
    assert_eq!(new_record.input_tokens, Some(17));
    assert_eq!(
        new_record.reported,
        lumi_gateway_runtime::policy::TierField::String("default".into())
    );
}

#[test]
fn config_validation_rejects_unavailable_encryption_and_disabled_route_does_not_prepare() {
    let temp = tempfile::tempdir().unwrap();
    let mut cfg = config(json!({"type":"preserve"}), false);
    assert!(cfg.routes[0].enabled);
    let mut engine =
        GatewayEngine::open(cfg.clone(), &temp.path().join("records.sqlite"), None).unwrap();
    cfg.recording.bodies = true;
    assert_eq!(
        engine.request("config.validate", json!({"config":cfg})),
        Err("encryption-unavailable".into())
    );
    assert_eq!(
        replace(&mut engine, &cfg, 1),
        Err("encryption-unavailable".into())
    );
    cfg.recording.bodies = false;
    cfg.routes[0].enabled = false;
    replace(&mut engine, &cfg, 1).unwrap();
    assert_eq!(
        prepare(
            &mut engine,
            &uuid::Uuid::new_v4().to_string(),
            "primary",
            br#"{}"#
        ),
        Err("route-disabled".into())
    );
    assert_eq!(engine.request("status", json!({})).unwrap()["pending"], 0);
    for (bytes, capture) in [
        (1024 * 1024 - 1, 1),
        (10 * 1024 * 1024 * 1024 + 1, 1),
        (1024 * 1024, 0),
        (1024 * 1024, 1024 * 1024 + 1),
    ] {
        cfg.recording.max_bytes = bytes;
        cfg.recording.capture_bytes = capture;
        assert_eq!(
            engine.request("config.validate", json!({"config":cfg})),
            Err("invalid-config".into())
        );
    }
    assert!(
        engine
            .request("config.get", json!({"path":"arbitrary"}))
            .is_err()
    );
    assert!(
        engine
            .request(
                "config.validate",
                json!({"config":config(json!({"type":"preserve"}),false),"extra":true})
            )
            .is_err()
    );
}

#[test]
fn rule_preview_is_pure_strict_and_matches_actual_policy_fields() {
    let temp = tempfile::tempdir().unwrap();
    let mut cfg = config(json!({"type":"set-if-missing","value":"priority"}), false);
    let mut engine =
        GatewayEngine::open(cfg.clone(), &temp.path().join("records.sqlite"), None).unwrap();
    for original in [
        json!({"state":"missing"}),
        json!({"state":"null"}),
        json!({"state":"invalid"}),
        json!({"state":"string","value":"flex"}),
    ] {
        let result = engine
            .request(
                "rules.preview",
                json!({"routeId":"primary","endpoint":"/v1/responses",
            "model":"test-model","originalTier":original}),
            )
            .unwrap();
        assert_eq!(result["original"], original);
        assert_eq!(result["compatible"], true);
        assert_eq!(result["ruleId"], "selected-tier");
        assert_eq!(result["modified"], original["state"] == "missing");
        if original["state"] == "missing" {
            assert_eq!(
                result["effective"],
                json!({"state":"string","value":"priority"})
            );
        } else {
            assert_eq!(result["effective"], original);
        }
    }
    let unavailable = engine
        .request(
            "rules.preview",
            json!({"routeId":"primary","endpoint":"/v1/responses",
        "originalTier":{"state":"unavailable"}}),
        )
        .unwrap();
    assert_eq!(unavailable["compatible"], false);
    assert_eq!(unavailable["warningCode"], "tier-unavailable");
    for invalid in [
        json!({"state":"missing","value":"fake"}),
        json!({"state":"string","value":""}),
        json!({"state":"string","value":"has space"}),
        json!({"state":"invalid","raw":{"secret":"fake"}}),
    ] {
        assert!(
            engine
                .request(
                    "rules.preview",
                    json!({"routeId":"primary","endpoint":"/v1/responses","originalTier":invalid})
                )
                .is_err()
        );
    }
    assert_eq!(engine.request("status", json!({})).unwrap()["pending"], 0);
    assert!(records(&mut engine).is_empty());
    cfg.routes[0].protocol = lumi_gateway_runtime::config::Protocol::Anthropic;
    replace(&mut engine, &cfg, 1).unwrap();
    let anthropic = engine
        .request(
            "rules.preview",
            json!({"routeId":"primary","endpoint":"/v1/messages",
        "originalTier":{"state":"missing"}}),
        )
        .unwrap();
    assert_eq!(anthropic["compatible"], false);
    assert_eq!(anthropic["warningCode"], "tier-unsupported-protocol");
    assert_eq!(anthropic["effective"], json!({"state":"missing"}));
}

#[test]
fn filtered_pagination_and_frozen_deletion_use_all_filters_and_keep_pending_tombstones() {
    let temp = tempfile::tempdir().unwrap();
    let mut engine = GatewayEngine::open(
        config(json!({"type":"preserve"}), false),
        &temp.path().join("records.sqlite"),
        None,
    )
    .unwrap();
    let mut ids = Vec::new();
    let base = now_ms() - 1000;
    for i in 0..3 {
        let id = uuid::Uuid::new_v4().to_string();
        engine.request("prepare", json!({"requestId":id,"routeId":"primary","endpoint":"/v1/responses",
            "bodyB64":STANDARD.encode(br#"{"model":"test-model","service_tier":"flex"}"#),"startedAtMs":base+i})).unwrap();
        if i != 1 {
            finish(&mut engine, &id, br#"{}"#, false);
        }
        ids.push(id);
    }
    let filter = json!({"routeId":"primary","clientAlias":"codex","model":"test-model","endpoint":"/v1/responses",
        "fromMs":base,"toMs":base+2,"tier":"flex"});
    let first = filtered(&mut engine, filter.clone(), None, 1).unwrap();
    assert_eq!(first["records"][0]["id"], ids[2]);
    let next = first["nextCursor"].as_str().unwrap();
    let second = filtered(&mut engine, filter.clone(), Some(next), 1).unwrap();
    assert_eq!(second["records"][0]["id"], ids[1]);
    let third = filtered(
        &mut engine,
        filter.clone(),
        second["nextCursor"].as_str(),
        1,
    )
    .unwrap();
    assert_eq!(third["records"][0]["id"], ids[0]);
    assert!(third["nextCursor"].is_null());
    let completed = filtered(&mut engine, json!({"status":"completed"}), None, 100).unwrap();
    assert_eq!(completed["records"].as_array().unwrap().len(), 2);
    assert!(
        filtered(&mut engine, json!({"tier":"priority"}), None, 100).unwrap()["records"]
            .as_array()
            .unwrap()
            .is_empty()
    );
    for invalid in [
        json!({"unknown":"value"}),
        json!({"fromMs":base+2,"toMs":base}),
        json!({"routeId":"../path"}),
        json!({"status":"arbitrary"}),
        json!({"endpoint":"/v1/responses?query=true"}),
        json!({"tier":"has space"}),
    ] {
        assert!(filtered(&mut engine, invalid, None, 100).is_err());
    }
    assert!(filtered(&mut engine, json!({}), None, 0).is_err());
    assert!(filtered(&mut engine, json!({}), None, 101).is_err());
    let deleted = engine
        .request(
            "records.delete.selection",
            json!({"selection":{"filter":filter,"throughMs":base+1}}),
        )
        .unwrap();
    assert_eq!(deleted["deleted"], 2);
    assert_eq!(
        finish(&mut engine, &ids[1], br#"{}"#, false)["recordingOk"],
        false
    );
    assert_eq!(records(&mut engine).len(), 1);
    assert!(
        filtered(&mut engine, json!({}), Some(next), 100).unwrap()["records"]
            .as_array()
            .unwrap()
            .is_empty()
    );
    assert_eq!(
        engine
            .request(
                "records.delete.selection",
                json!({"selection":{"recordIds":[ids[2]]}})
            )
            .unwrap()["deleted"],
        1
    );
    assert!(records(&mut engine).is_empty());
    for invalid in [
        json!({"selection":{"recordIds":[]}}),
        json!({"selection":{"recordIds":[ids[2],ids[2]]}}),
        json!({"selection":{"recordIds":[ids[2]],"filter":{},"throughMs":base}}),
        json!({"selection":{"filter":{},"throughMs":now_ms()+100_000}}),
    ] {
        assert!(engine.request("records.delete.selection", invalid).is_err());
    }
}

#[test]
fn recorded_body_pages_are_utf8_bounded_redacted_scoped_and_revoked_immediately() {
    let temp = tempfile::tempdir().unwrap();
    let path = temp.path().join("records.sqlite");
    let cfg = config(json!({"type":"preserve"}), true);
    let mut engine = GatewayEngine::open(cfg.clone(), &path, Some([62; 32])).unwrap();
    let id = uuid::Uuid::new_v4().to_string();
    let other = uuid::Uuid::new_v4().to_string();
    let request = serde_json::to_vec(
        &json!({"input":"正文🙂".repeat(20_000),"api_key":concat!("fake-secret-", "body-marker")}),
    )
    .unwrap();
    prepare(&mut engine, &id, "primary", &request).unwrap();
    assert!(get_body(&mut engine, &id, None).unwrap()["body"].is_null());
    finish(
        &mut engine,
        &id,
        br#"{"output_text":"hello","authorization":"fake-response-secret"}"#,
        false,
    );
    prepare(&mut engine, &other, "primary", br#"{}"#).unwrap();
    finish(&mut engine, &other, br#"{}"#, false);
    assert!(
        engine
            .request("records.get", json!({"recordId":id}))
            .unwrap()["body"]
            .is_null()
    );
    let first = get_body(&mut engine, &id, None).unwrap();
    let old_cursor = first["body"]["nextCursor"].as_str().unwrap().to_owned();
    assert!(get_body(&mut engine, &other, Some(&old_cursor)).is_err());
    let mut text = first["body"]["text"].as_str().unwrap().to_owned();
    assert!(text.len() <= 64 * 1024);
    assert_eq!(first["body"]["redacted"], true);
    assert_eq!(first["body"]["encrypted"], true);
    assert_eq!(first["body"]["complete"], false);
    let mut cursor = Some(old_cursor.clone());
    while let Some(current) = cursor {
        let page = get_body(&mut engine, &id, Some(&current)).unwrap();
        let chunk = page["body"]["text"].as_str().unwrap();
        assert!(chunk.len() <= 64 * 1024);
        text.push_str(chunk);
        cursor = page["body"]["nextCursor"].as_str().map(str::to_owned);
        if cursor.is_none() {
            assert_eq!(page["body"]["complete"], true);
            assert_eq!(page["body"]["truncated"], false);
        }
    }
    assert!(get_body(&mut engine, &id, Some(&old_cursor)).is_err());
    let wrapper: Value = serde_json::from_str(&text).unwrap();
    assert!(wrapper["request"].as_str().unwrap().contains("[REDACTED]"));
    assert!(wrapper["response"].as_str().unwrap().contains("[REDACTED]"));
    assert!(!text.contains("fake-secret-body-marker"));
    assert!(!text.contains("fake-response-secret"));
    let resumed = get_body(&mut engine, &id, None).unwrap();
    let revoked = resumed["body"]["nextCursor"].as_str().unwrap();
    let mut disabled = cfg.clone();
    disabled.recording.bodies = false;
    replace(&mut engine, &disabled, 1).unwrap();
    assert_eq!(
        get_body(&mut engine, &id, Some(revoked)),
        Err("recording-disabled".into())
    );
    replace(&mut engine, &cfg, 2).unwrap();
    assert_eq!(
        get_body(&mut engine, &id, Some(revoked)),
        Err("invalid-cursor".into())
    );
    let resumed = get_body(&mut engine, &id, None).unwrap();
    let revoked = resumed["body"]["nextCursor"].as_str().unwrap();
    engine
        .request(
            "records.delete.selection",
            json!({"selection":{"recordIds":[id]}}),
        )
        .unwrap();
    assert_eq!(
        get_body(&mut engine, &id, Some(revoked)),
        Err("record-not-found".into())
    );
    assert!(!disk_contains(&path, "fake-secret-body-marker"));
}

#[test]
fn body_opt_in_and_capture_limit_are_frozen_for_in_flight_requests() {
    let temp = tempfile::tempdir().unwrap();
    let path = temp.path().join("records.sqlite");
    let cfg = config(json!({"type":"preserve"}), true);
    let mut engine = GatewayEngine::open(cfg.clone(), &path, Some([63; 32])).unwrap();
    let id = uuid::Uuid::new_v4().to_string();
    prepare(
        &mut engine,
        &id,
        "primary",
        br#"{"input":"still explicitly opted in"}"#,
    )
    .unwrap();
    let mut next = cfg.clone();
    next.recording.bodies = false;
    next.recording.capture_bytes = 1;
    replace(&mut engine, &next, 1).unwrap();
    assert_eq!(
        finish(&mut engine, &id, br#"{"output_text":"full"}"#, false)["recordingPartial"],
        false
    );
    assert_eq!(
        get_body(&mut engine, &id, None),
        Err("recording-disabled".into())
    );
    let recorder = Recorder::open(&path, Some([63; 32]), 7, 10_000).unwrap();
    assert!(recorder.read_payloads(&id).unwrap().is_some());
}

#[test]
fn logical_byte_capacity_evicts_old_records_and_cannot_resurrect_them() {
    let temp = tempfile::tempdir().unwrap();
    let path = temp.path().join("records.sqlite");
    let mut cfg = config(json!({"type":"preserve"}), true);
    cfg.recording.max_bytes = 1024 * 1024;
    let mut engine = GatewayEngine::open(cfg, &path, Some([64; 32])).unwrap();
    let body = serde_json::to_vec(&json!({"input":"x".repeat(700_000)})).unwrap();
    let mut ids = Vec::new();
    let base = now_ms() - 1000;
    for i in 0..2 {
        let id = uuid::Uuid::new_v4().to_string();
        engine
            .request(
                "prepare",
                json!({"requestId":id,"routeId":"primary","endpoint":"/v1/responses",
            "bodyB64":STANDARD.encode(&body),"startedAtMs":base+i}),
            )
            .unwrap();
        finish(&mut engine, &id, br#"{}"#, false);
        ids.push(id);
    }
    let saved = records(&mut engine);
    assert_eq!(saved.len(), 1);
    assert_eq!(saved[0]["id"], ids[1]);
    let connection = rusqlite::Connection::open(&path).unwrap();
    let bytes: i64 = connection
        .query_row(
            "SELECT SUM(LENGTH(CAST(metadata AS BLOB))+COALESCE(LENGTH(payload),0)) FROM records",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert!(bytes <= 1024 * 1024);
    let mut recorder = Recorder::open(&path, Some([64; 32]), 7, 10_000).unwrap();
    let mut stale = recorder.get(&ids[1]).unwrap().unwrap();
    stale.id = ids[0].clone();
    stale.started_at_ms = base;
    assert!(recorder.save(&stale, None).is_err());
}

#[test]
fn bounded_filtered_scan_refuses_to_infer_from_a_partial_metadata_set() {
    let temp = tempfile::tempdir().unwrap();
    let path = temp.path().join("records.sqlite");
    let mut cfg = config(json!({"type":"preserve"}), false);
    cfg.recording.max_records = 20_000;
    let mut engine = GatewayEngine::open(cfg, &path, None).unwrap();
    let id = uuid::Uuid::new_v4().to_string();
    prepare(&mut engine, &id, "primary", br#"{}"#).unwrap();
    finish(&mut engine, &id, br#"{}"#, false);
    let prototype = records(&mut engine)[0].clone();
    let mut connection = rusqlite::Connection::open(&path).unwrap();
    let transaction = connection.transaction().unwrap();
    for _ in 0..10_000 {
        let mut metadata = prototype.clone();
        let id = uuid::Uuid::new_v4().to_string();
        metadata["id"] = json!(id);
        transaction
            .execute(
                "INSERT INTO records(id,started_at_ms,metadata) VALUES(?1,?2,?3)",
                rusqlite::params![
                    id,
                    metadata["started_at_ms"].as_u64().unwrap() as i64,
                    serde_json::to_string(&metadata).unwrap()
                ],
            )
            .unwrap();
    }
    transaction.commit().unwrap();
    assert_eq!(
        filtered(&mut engine, json!({}), None, 100),
        Err("records-limit".into())
    );
    assert_eq!(
        engine.request(
            "records.delete.selection",
            json!({"selection":{"filter":{},"throughMs":now_ms()}})
        ),
        Err("records-limit".into())
    );
    let count: i64 = connection
        .query_row("SELECT COUNT(*) FROM records", [], |row| row.get(0))
        .unwrap();
    assert_eq!(count, 10_001);
}

#[test]
fn route_declared_tier_capability_is_persisted_and_disables_rules_without_changing_payload_bytes() {
    let temp = tempfile::tempdir().unwrap();
    let mut cfg = config(json!({"type":"override","value":"priority"}), false);
    assert!(cfg.routes[0].supports_service_tier());
    cfg.routes[0].service_tier = Some(false);
    assert!(!cfg.routes[0].supports_service_tier());
    let mut engine =
        GatewayEngine::open(cfg.clone(), &temp.path().join("records.sqlite"), None).unwrap();
    let state = engine.request("config.get", json!({})).unwrap();
    assert_eq!(state["config"]["routes"][0]["serviceTier"], false);
    let original = br#"{ "service_tier": "flex", "input": "exact bytes" }"#;
    let id = uuid::Uuid::new_v4().to_string();
    let result = prepare(&mut engine, &id, "primary", original).unwrap();
    assert_eq!(decoded(&result), original);
    assert_eq!(result["modified"], false);
    assert!(result["ruleId"].is_null());
    assert_eq!(
        result["effective"],
        json!({"state":"string","value":"flex"})
    );
    finish(&mut engine, &id, br#"{}"#, false);
    let preview=engine.request("rules.preview",json!({"routeId":"primary","endpoint":"/v1/responses","originalTier":{"state":"string","value":"flex"}})).unwrap();
    assert_eq!(preview["compatible"], false);
    assert_eq!(preview["warningCode"], "tier-unsupported-route");
    assert_eq!(
        preview["effective"],
        json!({"state":"string","value":"flex"})
    );
    assert!(preview["ruleId"].is_null());
    cfg.routes[0].protocol = lumi_gateway_runtime::config::Protocol::Anthropic;
    cfg.routes[0].service_tier = Some(true);
    assert!(cfg.validate().is_err());
    cfg.routes[0].service_tier = None;
    assert!(cfg.validate().is_ok());
    assert!(!cfg.routes[0].supports_service_tier());
}

fn observe(
    engine: &mut GatewayEngine,
    id: &str,
    offset: u64,
    chunk: &[u8],
    elapsed: u64,
) -> Result<Value, String> {
    engine.request(
        "observe",
        json!({"requestId":id,"responseIsSse":true,"offsetBytes":offset,
        "segments":[{"dataB64":STANDARD.encode(chunk),"elapsedMs":elapsed}]}),
    )
}

#[test]
fn bounded_incremental_observation_reaches_the_actual_tail_after_multiple_mib() {
    let temp = tempfile::tempdir().unwrap();
    let mut engine = GatewayEngine::open(
        config(json!({"type":"preserve"}), false),
        &temp.path().join("records.sqlite"),
        None,
    )
    .unwrap();
    let id = uuid::Uuid::new_v4().to_string();
    prepare(&mut engine, &id, "primary", br#"{}"#).unwrap();
    let delta = format!(
        "data: {{\"type\":\"response.output_text.delta\",\"delta\":\"{}\"}}\n\n",
        "x".repeat(8192)
    );
    let mut offset = 0u64;
    for _ in 0..512 {
        offset = observe(&mut engine, &id, offset, delta.as_bytes(), 7).unwrap()["observedBytes"]
            .as_u64()
            .unwrap();
    }
    let tail = b"data: {\"type\":\"response.completed\",\"response\":{\"service_tier\":\"flex\",\"usage\":{\"input_tokens\":37,\"output_tokens\":53}}}\n\n";
    offset = observe(&mut engine, &id, offset, tail, 90).unwrap()["observedBytes"]
        .as_u64()
        .unwrap();
    let mut input = finish_input(&id, &[], true);
    input["streamingObservation"] = json!(true);
    input["durationMs"] = json!(100);
    input["responseBytes"] = json!(offset);
    input["segments"] = json!([]);
    let result = engine.request("finish", input.clone()).unwrap();
    assert_eq!(result["observationPartial"], false);
    let saved = records(&mut engine);
    assert_eq!(
        saved[0]["reported"],
        json!({"state":"string","value":"flex"})
    );
    assert_eq!(saved[0]["input_tokens"], 37);
    assert_eq!(saved[0]["output_tokens"], 53);
    assert_eq!(saved[0]["first_content_ms"], 7);
    assert_eq!(saved[0]["response_bytes"], offset);
    assert_eq!(
        engine.request("finish", input),
        Err("unknown-request".into())
    );
    assert_eq!(
        observe(&mut engine, &id, offset, tail, 91),
        Err("unknown-request".into())
    );
}

#[test]
fn invalid_observation_batches_do_not_advance_or_consume_pending_and_gaps_revoke_final_fields() {
    let temp = tempfile::tempdir().unwrap();
    let mut engine = GatewayEngine::open(
        config(json!({"type":"preserve"}), false),
        &temp.path().join("records.sqlite"),
        None,
    )
    .unwrap();
    let id = uuid::Uuid::new_v4().to_string();
    prepare(&mut engine, &id, "primary", br#"{}"#).unwrap();
    let delta = b"data: {\"type\":\"response.output_text.delta\",\"delta\":\"known content\"}\n\n";
    let size = delta.len() as u64;
    observe(&mut engine, &id, 0, delta, 10).unwrap();
    assert_eq!(
        observe(&mut engine, &id, 0, delta, 10),
        Err("invalid-observation-offset".into())
    );
    assert_eq!(
        observe(&mut engine, &id, size, delta, 9),
        Err("invalid-timing".into())
    );
    assert_eq!(
        observe(&mut engine, &id, size, &vec![b'x'; 64 * 1024 + 1], 11),
        Err("invalid-observation-batch".into())
    );
    let valid = json!({"requestId":id,"responseIsSse":true,"offsetBytes":size,"segments":[{"dataB64":STANDARD.encode(delta),"elapsedMs":11}]});
    for (field, value) in [
        ("responseIsSse", json!(false)),
        ("offsetBytes", json!(size + 1)),
        ("segments", json!([])),
        (
            "segments",
            json!([{"dataB64":"invalid base64","elapsedMs":11}]),
        ),
        (
            "segments",
            json!([{"dataB64":STANDARD.encode(delta),"elapsedMs":11},{"dataB64":STANDARD.encode(delta),"elapsedMs":9}]),
        ),
    ] {
        let mut invalid = valid.clone();
        invalid[field] = value;
        assert!(engine.request("observe", invalid).is_err());
    }
    let mut unknown = valid.clone();
    unknown["arbitraryPath"] = json!("fixture-invalid");
    assert!(engine.request("observe", unknown).is_err());
    let tail = b"data: {\"type\":\"response.completed\",\"response\":{\"service_tier\":\"flex\",\"usage\":{\"output_tokens\":53}}}\n\n";
    let bytes = observe(&mut engine, &id, size, tail, 90).unwrap()["observedBytes"]
        .as_u64()
        .unwrap();
    let mut input = finish_input(&id, &[], true);
    input["streamingObservation"] = json!(true);
    input["responseBytes"] = json!(bytes);
    input["durationMs"] = json!(100);
    let mut invalid = input.clone();
    invalid["responseBytes"] = json!(bytes - 1);
    assert!(engine.request("finish", invalid).is_err());
    let mut invalid = input.clone();
    invalid["streamingObservation"] = json!(false);
    assert!(engine.request("finish", invalid).is_err());
    input["observationPartial"] = json!(true);
    assert_eq!(
        engine.request("finish", input).unwrap()["observationPartial"],
        true
    );
    let saved = records(&mut engine);
    assert_eq!(saved[0]["reported"], json!({"state":"unavailable"}));
    assert!(saved[0]["output_tokens"].is_null());
    assert_eq!(saved[0]["first_content_ms"], 10);
}

#[test]
fn accepted_body_snapshot_keeps_model_rule_limits_and_recording_after_multiple_live_changes() {
    let dir = tempfile::tempdir().unwrap();
    let mut original = config(json!({"type":"override","value":"flex"}), true);
    original.routes[0].name = Some("旧供应商".into());
    original.routes[0].models =
        serde_json::from_value(json!([{"id":"alias","upstreamModel":"old-model","enabled":true}]))
            .unwrap();
    let mut engine = GatewayEngine::open(
        original.clone(),
        &dir.path().join("records.sqlite3"),
        Some([5; 32]),
    )
    .unwrap();
    let mut next = original.clone();
    next.routes[0].models[0].upstream_model = "new-model".into();
    next.recording.bodies = false;
    next.max_request_bytes = 100;
    next.rules = serde_json::from_value(
        json!([{"id":"new-rule","action":{"type":"override","value":"priority"}}]),
    )
    .unwrap();
    engine
        .request("config.replace", json!({"expectedVersion":1,"config":next}))
        .unwrap();
    let body =
        serde_json::to_vec(&json!({"model":"alias","input":"accepted-before-save".repeat(20)}))
            .unwrap();
    let id = uuid::Uuid::new_v4().to_string();
    let result=engine.request("prepare",json!({"requestId":id,"routeId":"primary","endpoint":"/v1/responses",
        "bodyB64":STANDARD.encode(&body),"startedAtMs":now_ms(),"expectedConfigVersion":1,"configSnapshot":original})).unwrap();
    let sent: Value = serde_json::from_slice(&decoded(&result)).unwrap();
    assert_eq!(sent["model"], "old-model");
    assert_eq!(sent["service_tier"], "flex");
    assert_eq!(result["chain"]["configVersion"], 1);
    finish(
        &mut engine,
        &id,
        br#"{"usage":{"input_tokens":3,"output_tokens":2}}"#,
        false,
    );
    let mut restored = next.clone();
    restored.recording.bodies = true;
    engine
        .request(
            "config.replace",
            json!({"expectedVersion":2,"config":restored}),
        )
        .unwrap();
    let detail = engine
        .request("records.get", json!({"recordId":id,"includeBody":true}))
        .unwrap();
    assert!(
        detail["body"]["text"]
            .as_str()
            .unwrap()
            .contains("accepted-before-save")
    );
    let mut future = original.clone();
    future.config_version = 50;
    assert!(engine.request("prepare",json!({"requestId":uuid::Uuid::new_v4().to_string(),"routeId":"primary","endpoint":"/v1/responses",
        "bodyB64":STANDARD.encode(br#"{"model":"alias"}"#),"startedAtMs":now_ms(),"expectedConfigVersion":50,"configSnapshot":future})).is_err());
}

#[test]
fn failed_private_configuration_commit_preserves_memory_pending_and_record_limits() {
    let dir = tempfile::tempdir().unwrap();
    let original = config(json!({"type":"preserve"}), true);
    let mut engine = GatewayEngine::open(
        original.clone(),
        &dir.path().join("records.sqlite3"),
        Some([6; 32]),
    )
    .unwrap();
    let id = uuid::Uuid::new_v4().to_string();
    prepare(
        &mut engine,
        &id,
        "primary",
        br#"{"model":"fixture","input":"retained"}"#,
    )
    .unwrap();
    let mut next = original.clone();
    next.config_version = 2;
    next.recording.max_records = 1;
    next.recording.bodies = false;
    assert_eq!(
        engine
            .commit_configuration(1, next, || Err("fixture-write-failed".into()))
            .unwrap_err(),
        "fixture-write-failed"
    );
    let current = engine.request("config.get", json!({})).unwrap();
    assert_eq!(current["configVersion"], 1);
    assert_eq!(current["config"]["recording"]["bodies"], true);
    assert_eq!(engine.request("status", json!({})).unwrap()["pending"], 1);
    finish(
        &mut engine,
        &id,
        br#"{"usage":{"input_tokens":1,"output_tokens":1}}"#,
        false,
    );
    assert!(
        engine
            .request("records.get", json!({"recordId":id,"includeBody":true}))
            .unwrap()["body"]["text"]
            .as_str()
            .unwrap()
            .contains("retained")
    );
}
