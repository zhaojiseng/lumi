use lumi_gateway_runtime::{
    config::GatewayConfig,
    gateway::GatewayEngine,
    protocol,
    rectify::{self, Context, Stage},
};
use serde_json::{Value, json};
use tempfile::tempdir;
fn rule(stage: &str, field: &str, action: Value) -> Value {
    json!({"id":"test-rule","enabled":true,"priority":0,"stage":stage,"field":field,"match":{},"action":action})
}
fn config() -> GatewayConfig {
    serde_json::from_value(json!({"schemaVersion":1,"listen":"127.0.0.1:18080","routes":[{"id":"provider","client":"agent","upstream":"https://example.com/v1","protocol":"openai","name":"供应商 A","models":[{"id":"public-model","upstreamModel":"actual-model","enabled":true}],"entryEndpoints":["/v1/responses","/v1/chat/completions","/v1/messages"],"upstreamEndpoint":"/v1/responses"}],"rules":[],"recording":{"bodies":false}})).unwrap()
}
#[test]
fn nested_rewrites_preserve_sibling_number_lexemes_and_message_bytes() {
    let r = serde_json::from_value(rule(
        "entry",
        "/reasoning/effort",
        json!({"type":"override","value":"high"}),
    ))
    .unwrap();
    let original=br#" {"model":"m", "input":[{"content":"do not edit"}],"number":123456789012345678901234567890,"reasoning":{"effort":"low","big":1e999}} "#;
    let (out, c) = rectify::apply(
        original,
        Stage::Entry,
        Context {
            route_id: "p",
            client: "a",
            endpoint: "/v1/responses",
            model: Some("m"),
        },
        &[r],
    )
    .unwrap();
    assert_eq!(
        String::from_utf8(out).unwrap(),
        String::from_utf8(original.to_vec())
            .unwrap()
            .replace("\"low\"", "\"high\"")
    );
    assert!(c[0].changed);
}
#[test]
fn missing_defaults_do_not_replace_null_and_repeated_changes_are_idempotent() {
    let r = serde_json::from_value(rule(
        "model",
        "/temperature",
        json!({"type":"set-if-missing","value":0.4}),
    ))
    .unwrap();
    let context = || Context {
        route_id: "p",
        client: "a",
        endpoint: "/v1/messages",
        model: None,
    };
    let (out, c) = rectify::apply(
        br#"{"temperature":null}"#,
        Stage::Model,
        context(),
        std::slice::from_ref(&r),
    )
    .unwrap();
    assert_eq!(out, br#"{"temperature":null}"#);
    assert!(!c[0].changed);
    let (once, _) =
        rectify::apply(b"{}", Stage::Model, context(), std::slice::from_ref(&r)).unwrap();
    let (twice, c) = rectify::apply(&once, Stage::Model, context(), &[r]).unwrap();
    assert_eq!(once, twice);
    assert!(!c[0].changed);
}
#[test]
fn scope_priority_and_preservation_win_per_field_without_changing_other_rules() {
    let mut low = rule(
        "entry",
        "/service_tier",
        json!({"type":"override","value":"priority"}),
    );
    low["id"] = json!("low");
    let mut high = rule("entry", "/service_tier", json!({"type":"preserve"}));
    high["id"] = json!("specific");
    high["match"] = json!({"client":"a"});
    let extra = rule(
        "entry",
        "/max_output_tokens",
        json!({"type":"override","value":512}),
    );
    let rs: Vec<rectify::Rule> = serde_json::from_value(json!([low, high, extra])).unwrap();
    let (out, c) = rectify::apply(
        br#"{"service_tier":"default"}"#,
        Stage::Entry,
        Context {
            route_id: "p",
            client: "a",
            endpoint: "/v1/responses",
            model: None,
        },
        &rs,
    )
    .unwrap();
    let v: Value = serde_json::from_slice(&out).unwrap();
    assert_eq!(v["service_tier"], "default");
    assert_eq!(v["max_output_tokens"], 512);
    assert_eq!(c.len(), 2);
    assert!(c.iter().any(|c| c.rule_id == "specific" && !c.changed));
}
#[test]
fn clamp_map_remove_and_reject_have_explicit_outcomes() {
    let actions = [
        ("/temperature", json!({"type":"clamp","min":0.0,"max":1.0})),
        (
            "/service_tier",
            json!({"type":"map","values":{"priority":"auto"}}),
        ),
        ("/store", json!({"type":"remove"})),
    ];
    let rules = actions
        .into_iter()
        .enumerate()
        .map(|(i, (f, a))| {
            let mut r = rule("model", f, a);
            r["id"] = json!(format!("r{i}"));
            serde_json::from_value(r).unwrap()
        })
        .collect::<Vec<_>>();
    let (out, _) = rectify::apply(
        br#"{"temperature":4,"service_tier":"priority","store":true}"#,
        Stage::Model,
        Context {
            route_id: "p",
            client: "a",
            endpoint: "/v1/messages",
            model: None,
        },
        &rules,
    )
    .unwrap();
    let v: Value = serde_json::from_slice(&out).unwrap();
    assert_eq!(v["temperature"], 1.0);
    assert_eq!(v["service_tier"], "auto");
    assert!(v.get("store").is_none());
    let r = serde_json::from_value(rule(
        "entry",
        "/temperature",
        json!({"type":"reject","code":"blocked-model"}),
    ))
    .unwrap();
    assert_eq!(
        rectify::apply(
            b"{}",
            Stage::Entry,
            Context {
                route_id: "p",
                client: "a",
                endpoint: "/v1/responses",
                model: None
            },
            &[r]
        )
        .unwrap_err(),
        "blocked-model"
    );
}
#[test]
fn unsafe_fields_duplicate_json_and_scalar_parents_are_rejected() {
    let r = serde_json::from_value(rule(
        "entry",
        "/authorization",
        json!({"type":"override","value":"secret"}),
    ))
    .unwrap();
    assert!(rectify::validate(&[r]).is_err());
    let r = serde_json::from_value(rule(
        "entry",
        "/reasoning/effort",
        json!({"type":"override","value":"high"}),
    ))
    .unwrap();
    let context = || Context {
        route_id: "p",
        client: "a",
        endpoint: "/v1/responses",
        model: None,
    };
    assert!(
        rectify::apply(
            br#"{"reasoning":null}"#,
            Stage::Entry,
            context(),
            std::slice::from_ref(&r)
        )
        .is_err()
    );
    assert!(
        rectify::apply(
            br#"{"reasoning":{},"reasoning":{}}"#,
            Stage::Entry,
            context(),
            &[r]
        )
        .is_err()
    );
}
#[test]
fn native_preview_matches_real_prepare_and_keeps_original_entry_and_sent_tiers_distinct() {
    use base64::{Engine as _, engine::general_purpose::STANDARD};
    let directory = tempdir().unwrap();
    let mut cfg = config();
    let mut entry = rule(
        "entry",
        "/service_tier",
        json!({"type":"override","value":"flex"}),
    );
    entry["id"] = json!("entry-rule");
    let model = rule(
        "model",
        "/service_tier",
        json!({"type":"override","value":"priority"}),
    );
    cfg.rectifiers = serde_json::from_value(json!([entry, model])).unwrap();
    let mut engine =
        GatewayEngine::open(cfg, &directory.path().join("records.sqlite"), None).unwrap();
    let body = r#"{"model":"public-model","input":"hello","service_tier":"default"}"#;
    let preview = engine
        .request(
            "rectifiers.preview",
            json!({"routeId":"provider","endpoint":"/v1/responses","body":body}),
        )
        .unwrap();
    let actual=engine.request("prepare",json!({"routeId":"provider","endpoint":"/v1/responses","bodyB64":STANDARD.encode(body),"startedAtMs":0,"requestId":uuid::Uuid::new_v4().to_string(),"expectedConfigVersion":1})).unwrap();
    assert_eq!(
        preview["sentBody"].as_str().unwrap().as_bytes(),
        STANDARD
            .decode(actual["bodyB64"].as_str().unwrap())
            .unwrap()
    );
    assert_eq!(actual["original"]["value"], "default");
    assert_eq!(actual["chain"]["entryTier"]["value"], "flex");
    assert_eq!(actual["effective"]["value"], "priority");
    assert_eq!(actual["model"], "actual-model");
    assert_eq!(actual["chain"]["changes"].as_array().unwrap().len(), 2);
}
#[test]
fn cross_protocol_tool_round_trips_preserve_call_identity_and_large_argument_integers() {
    let messages=br#"{"model":"m","messages":[{"role":"user","content":"hello"},{"role":"assistant","content":[{"type":"tool_use","id":"call_a","name":"lookup","input":{"id":123456789012345678901234567890}}]},{"role":"user","content":[{"type":"tool_result","tool_use_id":"call_a","content":"result"}]}],"max_tokens":512,"tools":[{"name":"lookup","input_schema":{"type":"object"}}]}"#;
    for target in ["/v1/responses", "/v1/chat/completions"] {
        let converted = protocol::convert(messages, "/v1/messages", target).unwrap();
        let back = protocol::convert(&converted, target, "/v1/messages").unwrap();
        let v: Value = serde_json::from_slice(&back).unwrap();
        assert_eq!(v["messages"][1]["content"][0]["id"], "call_a");
        assert_eq!(v["messages"][2]["content"][0]["tool_use_id"], "call_a");
        assert!(
            String::from_utf8(back)
                .unwrap()
                .contains("123456789012345678901234567890")
        );
    }
}
#[test]
fn unsupported_state_builtins_cache_and_opaque_thinking_fail_before_request_execution() {
    for body in [
        r#"{"model":"m","input":"a","previous_response_id":"resp_a"}"#,
        r#"{"model":"m","input":"a","tools":[{"type":"web_search"}]}"#,
        r#"{"model":"m","input":"a","store":true}"#,
    ] {
        assert!(protocol::convert(body.as_bytes(), "/v1/responses", "/v1/messages").is_err());
    }
    for body in [
        r#"{"model":"m","messages":[{"role":"user","content":[{"type":"text","text":"a","cache_control":{"type":"ephemeral"}}]}],"max_tokens":512}"#,
        r#"{"model":"m","messages":[{"role":"assistant","content":[{"type":"thinking","thinking":"a","signature":"opaque"}]}],"max_tokens":512}"#,
    ] {
        assert!(protocol::convert(body.as_bytes(), "/v1/messages", "/v1/responses").is_err());
    }
}
#[test]
fn same_protocol_preserves_unknown_fields_and_exact_original_bytes() {
    let body = br#" {"model":"m","vendor_extension":123456789012345678901234567890} "#;
    assert_eq!(
        protocol::convert(body, "/v1/responses", "/v1/responses").unwrap(),
        body
    );
}
#[test]
fn supplier_config_rejects_incompatible_protocol_duplicate_models_and_dangling_agent_refs() {
    let mut cfg = config();
    cfg.routes[0].upstream_endpoint = Some("/v1/messages".into());
    assert!(cfg.validate().is_err());
    let mut cfg = config();
    let duplicate = cfg.routes[0].models[0].clone();
    cfg.routes[0].models.push(duplicate);
    assert!(cfg.validate().is_err());
    let mut cfg = config();
    cfg.agents=serde_json::from_value(json!([{"id":"a","name":"Agent","credentialRef":"missing","providerIds":["provider"],"enabled":true}])).unwrap();
    assert!(cfg.validate().is_err());
}

#[test]
fn explicit_cache_marker_deletion_handles_block_arrays_without_touching_other_bytes() {
    let r = serde_json::from_value(rule(
        "entry",
        "/messages/*/content/*/cache_control",
        json!({"type":"remove"}),
    ))
    .unwrap();
    let body=br#" {"messages":[{"role":"user","content":[{"type":"text","text":"keep", "cache_control":{"type":"ephemeral"},"n":123456789012345678901234567890}]},{"role":"assistant","content":"string untouched"}]} "#;
    let (out, c) = rectify::apply(
        body,
        Stage::Entry,
        Context {
            route_id: "p",
            client: "a",
            endpoint: "/v1/messages",
            model: None,
        },
        &[r],
    )
    .unwrap();
    assert!(c[0].changed);
    let out = String::from_utf8(out).unwrap();
    assert!(!out.contains("cache_control"));
    assert!(out.contains("123456789012345678901234567890"));
    assert!(out.contains("string untouched"));
}

#[test]
fn clamp_absent_field_is_a_noop_but_invalid_existing_values_are_rejected() {
    let r = serde_json::from_value(rule(
        "entry",
        "/temperature",
        json!({"type":"clamp","min":0.0,"max":1.0}),
    ))
    .unwrap();
    let context = || Context {
        route_id: "p",
        client: "a",
        endpoint: "/v1/responses",
        model: None,
    };
    let (out, changes) =
        rectify::apply(b"{}", Stage::Entry, context(), std::slice::from_ref(&r)).unwrap();
    assert_eq!(out, b"{}");
    assert!(!changes[0].changed);
    assert_eq!(
        rectify::apply(br#"{"temperature":null}"#, Stage::Entry, context(), &[r]).unwrap_err(),
        "rectifier-value-not-number"
    );
}

#[test]
fn function_strict_defaults_are_preserved_or_explicitly_refused() {
    let body=br#"{"model":"m","messages":[{"role":"user","content":"hello"}],"tools":[{"type":"function","function":{"name":"lookup","parameters":{"type":"object","properties":{"id":{"type":"integer"}}}}}]}"#;
    let out = protocol::convert(body, "/v1/chat/completions", "/v1/responses").unwrap();
    let value: Value = serde_json::from_slice(&out).unwrap();
    assert_eq!(value["tools"][0]["strict"], false);
    let out = protocol::convert(&out, "/v1/responses", "/v1/chat/completions").unwrap();
    let value: Value = serde_json::from_slice(&out).unwrap();
    assert_eq!(value["tools"][0]["function"]["strict"], false);
    let body=br#"{"model":"m","input":"hello","tools":[{"type":"function","name":"lookup","parameters":{"type":"object"}}]}"#;
    assert_eq!(
        protocol::convert(body, "/v1/responses", "/v1/chat/completions").unwrap_err(),
        "conversion-tool-strict-mapping-required"
    );
}

#[test]
fn simultaneously_matched_parent_and_child_rules_are_explicit_conflicts() {
    let rules:Vec<rectify::Rule>=serde_json::from_value(json!([rule("entry","/reasoning",json!({"type":"override","value":{"effort":"low"}})),{ "id":"child","enabled":true,"priority":10,"stage":"entry","field":"/reasoning/effort","match":{},"action":{"type":"override","value":"high"}}])).unwrap();
    assert_eq!(
        rectify::apply(
            br#"{"reasoning":{"effort":"medium"}}"#,
            Stage::Entry,
            Context {
                route_id: "p",
                client: "a",
                endpoint: "/v1/responses",
                model: None
            },
            &rules
        )
        .unwrap_err(),
        "rectifier-field-conflict"
    );
}

#[test]
fn decimal_clamp_json_bytes_round_trip_and_exact_values_keep_their_types() {
    let source=br#"[{"id":"decimal-range","enabled":true,"priority":0,"stage":"entry","field":"/temperature","match":{},"action":{"type":"clamp","min":-0.25,"max":0.4}}]"#;
    let rules: Vec<rectify::Rule> = serde_json::from_slice(source).unwrap();
    let restored: Vec<rectify::Rule> =
        serde_json::from_slice(&serde_json::to_vec(&rules).unwrap()).unwrap();
    let (body, _) = rectify::apply(
        br#"{"temperature":0.9}"#,
        Stage::Entry,
        Context {
            route_id: "p",
            client: "a",
            endpoint: "/v1/responses",
            model: None,
        },
        &restored,
    )
    .unwrap();
    assert_eq!(
        serde_json::from_slice::<Value>(&body).unwrap()["temperature"],
        json!(0.4)
    );
    let exact = br#"{"type":"override","value":123456789012345678901234567890}"#;
    let action: rectify::Action = serde_json::from_slice(exact).unwrap();
    assert_eq!(
        serde_json::to_string(&action).unwrap(),
        std::str::from_utf8(exact).unwrap()
    );
    for invalid in [
        br#"{"type":"clamp","min":0.1,"max":0.4,"extra":true}"#.as_slice(),
        br#"{"type":"clamp","min":"0.1","max":0.4}"#.as_slice(),
    ] {
        assert!(serde_json::from_slice::<rectify::Action>(invalid).is_err());
    }
}
