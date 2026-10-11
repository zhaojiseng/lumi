use lumi_gateway_runtime::json::{JsonScanError, scan_object};
use lumi_gateway_runtime::policy::{
    PolicyContext, PolicyError, RuleMatch, TierAction, TierField, TierRule, apply_policy,
    observe_model, observe_tier, validate_rules,
};

fn context(endpoint: &'static str) -> PolicyContext<'static> {
    PolicyContext {
        route_id: "route-a",
        client: "codex",
        endpoint,
    }
}

fn rule(action: TierAction) -> TierRule {
    TierRule {
        id: "tier-rule".into(),
        enabled: true,
        priority: 0,
        match_scope: RuleMatch::default(),
        action,
    }
}

fn apply(body: &[u8], action: TierAction) -> lumi_gateway_runtime::policy::PolicyOutcome {
    apply_policy(body, context("/v1/responses"), &[rule(action)]).unwrap()
}

#[test]
fn preserve_and_unmatched_requests_retain_every_byte() {
    let body = b" \n{\"model\":\"m\",\"service_tier\":\"pri\\u006frity\",\"n\":1.2300e+009}\t ";
    let out = apply(body, TierAction::Preserve);
    assert_eq!(out.body, body);
    assert_eq!(out.original, TierField::String("priority".into()));
    assert_eq!(out.effective, out.original);
    assert!(!out.modified);
    let out = apply_policy(body, context("/v1/responses"), &[]).unwrap();
    assert_eq!(out.body, body);
    assert_eq!(out.rule_id, None);
    assert_eq!(out.model.as_deref(), Some("m"));
}

#[test]
fn field_observation_distinguishes_missing_null_string_invalid_and_unavailable() {
    let cases: &[(&[u8], TierField)] = &[
        (br#"{}"#, TierField::Missing),
        (br#"{"service_tier":null}"#, TierField::Null),
        (br#"{"service_tier":""}"#, TierField::String("".into())),
        (
            br#"{"service_tier":"default"}"#,
            TierField::String("default".into()),
        ),
        (br#"{"service_tier":false}"#, TierField::Invalid),
        (
            br#"{"service_tier":999999999999999999999999999999999999}"#,
            TierField::Invalid,
        ),
        (
            br#"{"service_tier":{"secret":"do-not-retain"}}"#,
            TierField::Invalid,
        ),
        (br#"{"service_tier":[]}"#, TierField::Invalid),
        (br#"{"service_tier":}"#, TierField::Unavailable),
        (br#"[]"#, TierField::Unavailable),
    ];
    for (body, expected) in cases {
        assert_eq!(observe_tier(body), *expected);
        let out = apply(body, TierAction::Preserve);
        assert_eq!(out.original, *expected);
        assert_eq!(out.body, *body);
        assert!(!out.modified);
    }
    assert_eq!(
        serde_json::to_string(&TierField::Invalid).unwrap(),
        r#"{"state":"invalid"}"#
    );
    assert_eq!(
        serde_json::from_str::<TierField>(r#"{"state":"string","value":"priority"}"#).unwrap(),
        TierField::String("priority".into())
    );
}

#[test]
fn set_if_missing_does_not_treat_null_empty_or_invalid_as_absent() {
    let cases = [
        br#"{"service_tier":null}"#.as_slice(),
        br#"{"service_tier":""}"#.as_slice(),
        br#"{"service_tier":0}"#.as_slice(),
        br#"{"service_tier":{"nested":true}}"#.as_slice(),
    ];
    for body in cases {
        let out = apply(
            body,
            TierAction::SetIfMissing {
                value: "priority".into(),
            },
        );
        assert_eq!(out.body, body);
        assert_eq!(out.effective, out.original);
        assert!(!out.modified);
    }
    let out = apply(
        br#"{"model":"m"}"#,
        TierAction::SetIfMissing {
            value: "priority".into(),
        },
    );
    assert_eq!(out.original, TierField::Missing);
    assert_eq!(out.effective, TierField::String("priority".into()));
    assert_eq!(out.body, br#"{"model":"m","service_tier":"priority"}"#);
    assert!(out.modified);
}

#[test]
fn override_changes_only_the_top_level_value_and_preserves_number_lexemes() {
    let body = br#" {"model":"m","service_tier":{"nested":"old"},"n":1234567890123456789012345678901234567890,"tools":[{"service_tier":"keep","x":-0.000000000000000000000123000e+999999999}]} "#;
    let out = apply(
        body,
        TierAction::Override {
            value: "priority".into(),
        },
    );
    assert_eq!(out.original, TierField::Invalid);
    assert_eq!(out.body, br#" {"model":"m","service_tier":"priority","n":1234567890123456789012345678901234567890,"tools":[{"service_tier":"keep","x":-0.000000000000000000000123000e+999999999}]} "#);
    assert_eq!(
        observe_tier(&out.body),
        TierField::String("priority".into())
    );
    assert_eq!(out.model.as_deref(), Some("m"));
    assert!(out.modified);
}

#[test]
fn override_same_decoded_value_is_a_byte_preserving_noop() {
    let body = br#"{"service_tier":"pri\u006frity"}"#;
    let out = apply(
        body,
        TierAction::Override {
            value: "priority".into(),
        },
    );
    assert_eq!(out.body, body);
    assert!(!out.modified);
}

#[test]
fn removal_is_valid_in_all_positions_and_is_distinct_from_default() {
    let cases: &[(&[u8], &[u8])] = &[
        (br#"{"service_tier":"default"}"#, br#"{}"#),
        (br#"{"service_tier":"default","n":1.00}"#, br#"{"n":1.00}"#),
        (
            br#"{"n":1.00,"service_tier":null,"x":2}"#,
            br#"{"n":1.00,"x":2}"#,
        ),
        (br#"{"n":1.00,"service_tier":0}"#, br#"{"n":1.00}"#),
        (
            b"{ \n \"service_tier\": null,\n \"n\": 1.00 }",
            b"{ \n \"n\": 1.00 }",
        ),
        (
            b"{ \"n\": 1.00,\n \"service_tier\": null \n}",
            b"{ \"n\": 1.00 \n}",
        ),
        (br#"{"service_tier":[]}"#, br#"{}"#),
    ];
    for (body, expected) in cases {
        let out = apply(body, TierAction::Remove);
        assert_eq!(out.body, *expected);
        assert_eq!(out.effective, TierField::Missing);
        assert!(out.modified);
        scan_object(&out.body).unwrap();
    }
    let out = apply(br#"{"n":1}"#, TierAction::Remove);
    assert_eq!(out.body, br#"{"n":1}"#);
    assert_eq!(out.effective, TierField::Missing);
    assert!(!out.modified);
    assert_ne!(TierField::Missing, TierField::String("default".into()));
}

#[test]
fn escaped_top_level_key_is_recognized_and_only_its_value_is_rewritten() {
    let body = br#"{"service_\u0074ier":"old","nested":{"service_tier":"old"}}"#;
    let out = apply(
        body,
        TierAction::Override {
            value: "auto".into(),
        },
    );
    assert_eq!(
        out.body,
        br#"{"service_\u0074ier":"auto","nested":{"service_tier":"old"}}"#
    );
}

#[test]
fn inserting_into_empty_objects_preserves_surrounding_whitespace() {
    for body in [b"{}".as_slice(), b"{ \n\t }".as_slice()] {
        let out = apply(
            body,
            TierAction::Override {
                value: "default".into(),
            },
        );
        assert_eq!(observe_tier(&out.body), TierField::String("default".into()));
        assert!(out.body.starts_with(&body[..body.len() - 1]));
        assert!(out.body.ends_with(b"}"));
    }
}

#[test]
fn unsafe_json_fails_explicit_actions_but_can_pass_through_unobserved() {
    let malformed: &[&[u8]] = &[
        b"",
        b"{",
        br#"{"a":01}"#,
        br#"{"a":1.}"#,
        br#"{"a":1e+}"#,
        br#"{"a":+1}"#,
        br#"{"a":NaN}"#,
        br#"{"a":truefalse}"#,
        br#"{"a":1,}"#,
        br#"{"a":[1,]}"#,
        br#"{"a":"\uD800"}"#,
        br#"{"a":"\x00"}"#,
        b"{\"a\":\"\xff\"}",
        b"{} {}",
    ];
    for body in malformed {
        assert_eq!(
            apply_policy(body, context("/v1/responses"), &[rule(TierAction::Remove)]),
            Err(PolicyError::InvalidJson)
        );
        let out = apply(body, TierAction::Preserve);
        assert_eq!(out.original, TierField::Unavailable);
        assert_eq!(out.body, *body);
    }
    for body in [
        b"[]".as_slice(),
        b"null".as_slice(),
        b"123".as_slice(),
        b"\"s\"".as_slice(),
    ] {
        assert_eq!(
            apply_policy(body, context("/v1/responses"), &[rule(TierAction::Remove)]),
            Err(PolicyError::RootNotObject)
        );
        assert_eq!(apply(body, TierAction::Preserve).body, body);
    }
}

#[test]
fn duplicate_keys_are_rejected_at_every_depth_after_unicode_decoding() {
    let duplicate: &[&[u8]] = &[
        br#"{"service_tier":"old","service_tier":"new"}"#,
        br#"{"a":1,"\u0061":2}"#,
        br#"{"tools":[{"args":{"a":1,"a":2}}]}"#,
        r#"{"x":{"emoji\ud83d\ude00":1,"emoji😀":2}}"#.as_bytes(),
    ];
    for body in duplicate {
        assert_eq!(
            apply_policy(
                body,
                context("/v1/responses"),
                &[rule(TierAction::Override {
                    value: "auto".into()
                })]
            ),
            Err(PolicyError::DuplicateKey)
        );
        assert_eq!(observe_tier(body), TierField::Unavailable);
        assert_eq!(apply(body, TierAction::Preserve).body, *body);
    }
    let valid = br#"{"a":{"x":1},"b":{"x":2}}"#;
    scan_object(valid).unwrap();
}

#[test]
fn deeply_nested_json_is_bounded_without_touching_preserved_bytes() {
    let body = format!("{{\"a\":{}0{}}}", "[".repeat(140), "]".repeat(140));
    assert_eq!(
        scan_object(body.as_bytes()).unwrap_err(),
        JsonScanError::InvalidJson
    );
    let out = apply(body.as_bytes(), TierAction::Preserve);
    assert_eq!(out.body, body.as_bytes());
    assert_eq!(out.original, TierField::Unavailable);
}

#[test]
fn priority_precedes_specificity_and_array_order_breaks_exact_ties() {
    let mut generic = rule(TierAction::Override {
        value: "generic".into(),
    });
    generic.id = "generic".into();
    let mut specific = rule(TierAction::Override {
        value: "specific".into(),
    });
    specific.id = "specific".into();
    specific.match_scope.model = Some("m".into());
    let body = br#"{"model":"m"}"#;
    let out = apply_policy(
        body,
        context("/v1/responses"),
        &[generic.clone(), specific.clone()],
    )
    .unwrap();
    assert_eq!(out.rule_id.as_deref(), Some("specific"));
    generic.priority = 1;
    let out = apply_policy(
        body,
        context("/v1/responses"),
        &[specific.clone(), generic.clone()],
    )
    .unwrap();
    assert_eq!(out.rule_id.as_deref(), Some("generic"));
    specific.priority = 1;
    specific.match_scope = RuleMatch::default();
    let out = apply_policy(
        body,
        context("/v1/responses"),
        &[specific.clone(), generic.clone()],
    )
    .unwrap();
    assert_eq!(out.rule_id.as_deref(), Some("specific"));
    let out = apply_policy(body, context("/v1/responses"), &[generic, specific]).unwrap();
    assert_eq!(out.rule_id.as_deref(), Some("generic"));
}

#[test]
fn scopes_use_exact_original_model_route_client_and_endpoint() {
    let mut selected = rule(TierAction::Override {
        value: "priority".into(),
    });
    selected.match_scope = RuleMatch {
        route_id: Some("route-a".into()),
        client: Some("codex".into()),
        endpoint: Some("/v1/responses".into()),
        model: Some("m".into()),
    };
    let body = br#"{"model":"m","service_tier":"old"}"#;
    let out = apply_policy(body, context("/v1/responses"), &[selected.clone()]).unwrap();
    assert_eq!(out.rule_id.as_deref(), Some("tier-rule"));
    assert_eq!(out.model.as_deref(), Some("m"));
    assert_eq!(observe_model(&out.body).as_deref(), Some("m"));
    for context in [
        PolicyContext {
            route_id: "other",
            ..context("/v1/responses")
        },
        PolicyContext {
            client: "other",
            ..context("/v1/responses")
        },
        context("/v1/chat/completions"),
    ] {
        let out = apply_policy(body, context, &[selected.clone()]).unwrap();
        assert_eq!(out.rule_id, None);
        assert_eq!(out.body, body);
    }
    let out = apply_policy(
        br#"{"model":"other"}"#,
        context("/v1/responses"),
        &[selected.clone()],
    )
    .unwrap();
    assert_eq!(out.rule_id, None);
    selected.enabled = false;
    assert_eq!(
        apply_policy(body, context("/v1/responses"), &[selected])
            .unwrap()
            .rule_id,
        None
    );
}

#[test]
fn an_unobservable_model_does_not_match_a_model_specific_rule() {
    let mut selected = rule(TierAction::Remove);
    selected.match_scope.model = Some("m".into());
    let body = br#"{"model":"m","bad":}"#;
    let out = apply_policy(body, context("/v1/responses"), &[selected]).unwrap();
    assert_eq!(out.rule_id, None);
    assert_eq!(out.model, None);
    assert_eq!(out.body, body);
    assert_eq!(out.original, TierField::Unavailable);
}

#[test]
fn unsupported_endpoints_accept_only_preservation() {
    let body = br#"{"service_tier":"old"}"#;
    for endpoint in [
        "/v1/messages",
        "/v1/responses/extra",
        "/v1/chat/completions/",
    ] {
        for action in [
            TierAction::Remove,
            TierAction::SetIfMissing {
                value: "auto".into(),
            },
            TierAction::Override {
                value: "auto".into(),
            },
        ] {
            assert_eq!(
                apply_policy(body, context(endpoint), &[rule(action)]),
                Err(PolicyError::UnsupportedEndpoint)
            );
        }
        assert_eq!(
            apply_policy(body, context(endpoint), &[rule(TierAction::Preserve)])
                .unwrap()
                .body,
            body
        );
        assert_eq!(
            apply_policy(body, context(endpoint), &[]).unwrap().body,
            body
        );
    }
    assert!(
        apply_policy(
            body,
            context("/v1/chat/completions"),
            &[rule(TierAction::Remove)]
        )
        .is_ok()
    );
}

#[test]
fn configuration_validation_rejects_bad_values_ids_and_duplicates() {
    for value in ["", "_bad", ".bad", "-bad", "with space", "é", "a/b", "a\n"] {
        assert_eq!(
            validate_rules(&[rule(TierAction::Override {
                value: value.into()
            })]),
            Err(PolicyError::InvalidTierValue)
        );
    }
    assert!(
        validate_rules(&[rule(TierAction::SetIfMissing {
            value: "a".repeat(64)
        })])
        .is_ok()
    );
    assert_eq!(
        validate_rules(&[rule(TierAction::SetIfMissing {
            value: "a".repeat(65)
        })]),
        Err(PolicyError::InvalidTierValue)
    );
    assert!(
        validate_rules(&[rule(TierAction::Override {
            value: "0.A_z-1".into()
        })])
        .is_ok()
    );
    let mut invalid = rule(TierAction::Preserve);
    invalid.id = "".into();
    assert_eq!(validate_rules(&[invalid]), Err(PolicyError::InvalidRuleId));
    let duplicate = rule(TierAction::Preserve);
    assert_eq!(
        validate_rules(&[duplicate.clone(), duplicate]),
        Err(PolicyError::DuplicateRuleId)
    );
    let mut disabled = rule(TierAction::Override {
        value: "invalid value".into(),
    });
    disabled.enabled = false;
    assert_eq!(
        validate_rules(&[disabled]),
        Err(PolicyError::InvalidTierValue)
    );
}

#[test]
fn serde_defaults_and_empty_scopes_are_stable() {
    let decoded: TierRule = serde_json::from_str(
        r#"{"id":"tier","action":{"type":"set-if-missing","value":"priority"}}"#,
    )
    .unwrap();
    assert!(decoded.enabled);
    assert_eq!(decoded.priority, 0);
    assert_eq!(decoded.match_scope, RuleMatch::default());
    assert!(
        serde_json::from_str::<TierRule>(
            r#"{"id":"tier","action":{"type":"overide","value":"priority"}}"#
        )
        .is_err()
    );
    assert!(
        serde_json::from_str::<TierAction>(r#"{"type":"preserve","value":"priority"}"#).is_err()
    );
    let mut empty = decoded;
    empty.match_scope = RuleMatch {
        route_id: Some("".into()),
        client: Some("".into()),
        endpoint: Some("".into()),
        model: Some("".into()),
    };
    assert_eq!(
        apply_policy(b"{}", context("/v1/responses"), &[empty])
            .unwrap()
            .effective,
        TierField::String("priority".into())
    );
}

#[test]
fn oversized_observation_is_bounded_without_changing_preserved_body() {
    let body = serde_json::to_vec(
        &serde_json::json!({"model":"m".repeat(300),"service_tier":"x".repeat(1900*1024)}),
    )
    .unwrap();
    let out = apply(&body, TierAction::Preserve);
    assert_eq!(out.body, body);
    assert_eq!(out.original, TierField::Unavailable);
    assert_eq!(out.effective, TierField::Unavailable);
    assert_eq!(out.model, None);
    assert_eq!(
        observe_tier(br#"{"service_tier":""}"#),
        TierField::String(String::new())
    );
}
