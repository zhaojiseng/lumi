use lumi_gateway_runtime::observation::ResponseObserver;
use lumi_gateway_runtime::policy::TierField;

fn event(observer: &mut ResponseObserver, data: &str, elapsed: u64) {
    observer.push(format!("data: {data}\n\n").as_bytes(), elapsed);
}

#[test]
fn http_reports_real_tier_usage_and_original_payload() {
    let body = br#"{"service_tier":"default","output":[{"type":"message","content":[{"type":"output_text","text":"hello"}]}],"usage":{"input_tokens":18,"output_tokens":7,"input_tokens_details":{"cached_tokens":9}}}"#;
    let mut observer = ResponseObserver::new(false, 4096);
    observer.push(&body[..27], 4);
    observer.push(&body[27..], 12);
    assert_eq!(observer.summary().reported, TierField::Unavailable);
    observer.finish();
    let summary = observer.summary();
    assert_eq!(summary.reported, TierField::String("default".into()));
    assert_eq!(summary.input_tokens, Some(18));
    assert_eq!(summary.output_tokens, Some(7));
    assert_eq!(summary.cache_read_tokens, Some(9));
    assert_eq!(summary.cache_write_tokens, None);
    assert_eq!(summary.first_content_ms, Some(12));
    assert!(!summary.partial);
    assert_eq!(observer.payload(), body);
}

#[test]
fn counts_absent_invalid_and_too_large_stay_unknown_and_known_zero_is_retained() {
    let mut observer = ResponseObserver::new(false, 4096);
    observer.push(br#"{"usage":{"input_tokens":18446744073709551616,"output_tokens":-1,"input_tokens_details":{"cached_tokens":null},"cache_creation_input_tokens":0}}"#, 4);
    observer.finish();
    let summary = observer.summary();
    assert_eq!(summary.reported, TierField::Missing);
    assert_eq!(summary.input_tokens, None);
    assert_eq!(summary.output_tokens, None);
    assert_eq!(summary.cache_read_tokens, None);
    assert_eq!(summary.cache_write_tokens, Some(0));
    assert_eq!(summary.first_content_ms, None);
    assert!(!summary.partial);
}

#[test]
fn byte_split_sse_utf8_crlf_and_role_heartbeat_do_not_count_as_content() {
    let mut observer = ResponseObserver::new(true, 8192);
    let heartbeat = b"\xef\xbb\xbf: ping\r\n\r\ndata: {\"choices\":[{\"delta\":{\"role\":\"assistant\"}}]}\r\n\r\n";
    for byte in heartbeat {
        observer.push(&[*byte], 3);
    }
    assert_eq!(observer.summary().first_content_ms, None);
    assert_eq!(observer.summary().reported, TierField::Unavailable);
    let content = "data: {\"choices\":[{\"delta\":{\"content\":\"你好🌈\"}}]}\r\n\r\n";
    for byte in content.as_bytes() {
        observer.push(&[*byte], 17);
    }
    assert_eq!(observer.summary().first_content_ms, Some(17));
    event(
        &mut observer,
        r#"{"choices":[],"service_tier":"default","usage":{"prompt_tokens":14,"completion_tokens":6,"prompt_tokens_details":{"cached_tokens":8}}}"#,
        22,
    );
    event(&mut observer, "[DONE]", 23);
    observer.finish();
    let summary = observer.summary();
    assert_eq!(summary.reported, TierField::String("default".into()));
    assert_eq!(summary.first_content_ms, Some(17));
    assert_eq!(summary.input_tokens, Some(14));
    assert_eq!(summary.output_tokens, Some(6));
    assert_eq!(summary.cache_read_tokens, Some(8));
    assert!(!summary.partial);
}

#[test]
fn responses_reports_only_the_real_complete_response() {
    let mut observer = ResponseObserver::new(true, 8192);
    event(
        &mut observer,
        r#"{"type":"response.created","service_tier":"fake-root","response":{"service_tier":"priority"}}"#,
        2,
    );
    assert_eq!(observer.summary().reported, TierField::Unavailable);
    event(
        &mut observer,
        r#"{"type":"response.output_text.delta","delta":""}"#,
        3,
    );
    assert_eq!(observer.summary().first_content_ms, None);
    event(
        &mut observer,
        r#"{"type":"response.function_call_arguments.delta","delta":"{\"q\":"}"#,
        9,
    );
    event(
        &mut observer,
        r#"{"type":"response.completed","response":{"service_tier":"flex","usage":{"input_tokens":30,"output_tokens":11,"input_tokens_details":{"cached_tokens":5}}}}"#,
        28,
    );
    observer.finish();
    let summary = observer.summary();
    assert_eq!(summary.reported, TierField::String("flex".into()));
    assert_eq!(summary.first_content_ms, Some(9));
    assert_eq!(summary.input_tokens, Some(30));
    assert_eq!(summary.output_tokens, Some(11));
    assert_eq!(summary.cache_read_tokens, Some(5));
    assert!(!summary.partial);
}

#[test]
fn unknown_tier_remains_unknown_until_a_real_terminal() {
    let mut observer = ResponseObserver::new(true, 4096);
    event(
        &mut observer,
        r#"{"type":"response.output_text.delta","delta":"hello"}"#,
        7,
    );
    assert_eq!(observer.summary().reported, TierField::Unavailable);
    observer.finish();
    assert_eq!(observer.summary().reported, TierField::Unavailable);
    assert!(observer.summary().partial);
    let mut completed = ResponseObserver::new(true, 4096);
    event(
        &mut completed,
        r#"{"type":"response.completed","response":{"usage":{}}}"#,
        10,
    );
    completed.finish();
    assert_eq!(completed.summary().reported, TierField::Missing);
    assert_eq!(completed.summary().input_tokens, None);
    assert_eq!(completed.summary().output_tokens, None);
    assert!(!completed.summary().partial);
}

#[test]
fn anthropic_usage_is_merged_without_inventing_missing_values() {
    let mut observer = ResponseObserver::new(true, 4096);
    event(
        &mut observer,
        r#"{"type":"message_start","message":{"usage":{"input_tokens":4,"cache_read_input_tokens":6,"cache_creation_input_tokens":2}}}"#,
        1,
    );
    event(
        &mut observer,
        r#"{"type":"content_block_delta","delta":{"type":"input_json_delta","partial_json":"{\"name\":"}}"#,
        8,
    );
    event(
        &mut observer,
        r#"{"type":"message_delta","usage":{"output_tokens":12}}"#,
        10,
    );
    event(&mut observer, r#"{"type":"message_stop"}"#, 11);
    observer.finish();
    let summary = observer.summary();
    assert_eq!(summary.reported, TierField::Missing);
    assert_eq!(summary.first_content_ms, Some(8));
    assert_eq!(summary.input_tokens, Some(4));
    assert_eq!(summary.output_tokens, Some(12));
    assert_eq!(summary.cache_read_tokens, Some(6));
    assert_eq!(summary.cache_write_tokens, Some(2));
    assert!(!summary.partial);
}

#[test]
fn duplicate_keys_are_not_trusted_even_when_nested() {
    let mut http = ResponseObserver::new(false, 4096);
    http.push(
        br#"{"service_tier":"priority","usage":{"input_tokens":1,"input_tokens":3}}"#,
        5,
    );
    http.finish();
    assert_eq!(http.summary().reported, TierField::Unavailable);
    assert_eq!(http.summary().input_tokens, None);
    assert!(http.summary().partial);
    let mut sse = ResponseObserver::new(true, 4096);
    event(
        &mut sse,
        r#"{"choices":[],"service_tier":"priority","service_tier":"flex"}"#,
        1,
    );
    event(&mut sse, "[DONE]", 2);
    sse.finish();
    assert_eq!(sse.summary().reported, TierField::Unavailable);
    assert!(sse.summary().partial);
}

#[test]
fn payload_capture_is_a_bounded_actual_byte_prefix() {
    let body = br#"{"service_tier":null,"usage":{"output_tokens":3}}"#;
    let mut observer = ResponseObserver::new(false, 7);
    observer.push(body, 4);
    observer.finish();
    assert_eq!(observer.payload(), &body[..7]);
    assert_eq!(observer.summary().reported, TierField::Null);
    assert_eq!(observer.summary().output_tokens, Some(3));
    assert!(observer.capture_truncated());
    assert!(!observer.summary().partial);
}

#[test]
fn long_sse_observes_real_terminal_fields_after_body_capture_is_full() {
    let mut observer = ResponseObserver::new(true, 1024 * 1024);
    let delta = format!(
        r#"{{"type":"response.output_text.delta","delta":"{}"}}"#,
        "x".repeat(4096)
    );
    for _ in 0..768 {
        event(&mut observer, &delta, 9);
    }
    event(
        &mut observer,
        r#"{"type":"response.completed","response":{"service_tier":"flex","usage":{"input_tokens":37,"output_tokens":53,"input_tokens_details":{"cached_tokens":8}}}}"#,
        99,
    );
    observer.finish();
    assert_eq!(observer.payload().len(), 1024 * 1024);
    assert!(observer.capture_truncated());
    let summary = observer.summary();
    assert_eq!(summary.reported, TierField::String("flex".into()));
    assert_eq!(summary.input_tokens, Some(37));
    assert_eq!(summary.output_tokens, Some(53));
    assert_eq!(summary.cache_read_tokens, Some(8));
    assert_eq!(summary.first_content_ms, Some(9));
    assert!(!summary.partial);
}

#[test]
fn incomplete_chat_stream_and_observation_gaps_keep_final_fields_unknown() {
    let mut observer = ResponseObserver::new(true, 0);
    event(
        &mut observer,
        r#"{"choices":[{"delta":{"content":"observed"}}],"service_tier":"priority","usage":{"completion_tokens":12}}"#,
        7,
    );
    observer.finish();
    assert_eq!(observer.summary().reported, TierField::Unavailable);
    assert_eq!(observer.summary().output_tokens, None);
    assert_eq!(observer.summary().first_content_ms, Some(7));
    assert!(observer.summary().partial);
    let mut completed = ResponseObserver::new(true, 0);
    event(
        &mut completed,
        r#"{"type":"response.completed","response":{"service_tier":"flex","usage":{"output_tokens":53}}}"#,
        99,
    );
    completed.finish();
    assert_eq!(completed.summary().output_tokens, Some(53));
    completed.invalidate_final_observations();
    assert_eq!(completed.summary().reported, TierField::Unavailable);
    assert_eq!(completed.summary().output_tokens, None);
    assert!(completed.summary().partial);
}

#[test]
fn overlong_line_is_dropped_and_next_event_is_observed() {
    let mut observer = ResponseObserver::new(true, 256 * 1024);
    observer.push(b"data: ", 1);
    for _ in 0..70 {
        observer.push(&[b'x'; 1024], 1);
    }
    observer.push(b"\n\n", 1);
    event(
        &mut observer,
        r#"{"type":"response.completed","response":{"service_tier":"default","usage":{"output_tokens":2}}}"#,
        2,
    );
    observer.finish();
    assert_eq!(
        observer.summary().reported,
        TierField::String("default".into())
    );
    assert_eq!(observer.summary().output_tokens, Some(2));
    assert!(observer.summary().partial);
}

#[test]
fn oversized_multiline_event_recovers_at_blank_line() {
    let mut observer = ResponseObserver::new(true, 512 * 1024);
    let line = format!("data: {}\n", "x".repeat(60 * 1024));
    for _ in 0..5 {
        observer.push(line.as_bytes(), 1);
    }
    observer.push(b"\n", 1);
    event(
        &mut observer,
        r#"{"choices":[{"delta":{"tool_calls":[{"function":{"arguments":"{}}"}}]}}],"service_tier":"priority"}"#,
        13,
    );
    event(&mut observer, "[DONE]", 14);
    observer.finish();
    assert_eq!(
        observer.summary().reported,
        TierField::String("priority".into())
    );
    assert_eq!(observer.summary().first_content_ms, Some(13));
    assert!(observer.summary().partial);
}

#[test]
fn multiline_event_and_lone_cr_are_supported() {
    let mut observer = ResponseObserver::new(true, 4096);
    observer.push(b"event: response.completed\rdata: {\rdata: \"response\":{\"service_tier\":7,\"usage\":{\"output_tokens\":0}}\rdata: }\r\r", 4);
    observer.finish();
    assert_eq!(observer.summary().reported, TierField::Invalid);
    assert_eq!(observer.summary().output_tokens, Some(0));
    assert!(!observer.summary().partial);
}

#[test]
fn undelimited_terminal_and_invalid_http_do_not_claim_completion() {
    let mut sse = ResponseObserver::new(true, 4096);
    sse.push(
        b"data: {\"type\":\"response.completed\",\"response\":{}}\n",
        3,
    );
    sse.finish();
    assert_eq!(sse.summary().reported, TierField::Unavailable);
    assert!(sse.summary().partial);
    let mut http = ResponseObserver::new(false, 4096);
    http.push(br#"{"usage":{"input_tokens":4}"#, 3);
    http.finish();
    assert_eq!(http.summary().reported, TierField::Unavailable);
    assert_eq!(http.summary().input_tokens, None);
    assert!(http.summary().partial);
}

#[test]
fn http_parser_has_an_independent_hard_bound() {
    let mut observer = ResponseObserver::new(false, 2 * 1024 * 1024);
    observer.push(b"{\"text\":\"", 1);
    for _ in 0..1025 {
        observer.push(&[b'x'; 1024], 1);
    }
    observer.push(b"\",\"service_tier\":\"priority\"}", 2);
    observer.finish();
    assert_eq!(observer.summary().reported, TierField::Unavailable);
    assert!(observer.summary().partial);
    assert!(observer.payload().len() <= 2 * 1024 * 1024);
}

#[test]
fn trailing_events_cannot_replace_terminal_observations() {
    let mut observer = ResponseObserver::new(true, 4096);
    event(
        &mut observer,
        r#"{"type":"response.completed","response":{"service_tier":"flex","usage":{"output_tokens":3}}}"#,
        5,
    );
    event(
        &mut observer,
        r#"{"choices":[{"delta":{"content":"unexpected"}}],"service_tier":"priority","usage":{"output_tokens":999}}"#,
        6,
    );
    event(&mut observer, "[DONE]", 7);
    observer.finish();
    assert_eq!(
        observer.summary().reported,
        TierField::String("flex".into())
    );
    assert_eq!(observer.summary().output_tokens, Some(3));
    assert_eq!(observer.summary().first_content_ms, None);
    assert!(observer.summary().partial);
}
