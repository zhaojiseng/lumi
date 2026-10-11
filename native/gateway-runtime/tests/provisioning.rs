//! Real private child-pipe and Windows DPAPI regressions, using only fake credentials.
use lumi_gateway_runtime::provisioning::{self, MAX_PRIVATE_INPUT};
use serde_json::{Value, json};
use std::{fs, path::Path};

fn config() -> Value {
    json!({"schemaVersion":1,"listen":"127.0.0.1:18080",
        "routes":[{"id":"primary","client":"codex","upstream":"https://api.example.test/v1"}],
        "recording":{"bodies":false},"rules":[]})
}
fn management() -> Value {
    json!({"instanceId":"fixture-instance","alias":"界面网关","port":18081,
        "certificatePem":"-----BEGIN CERTIFICATE-----\nfixture-cert\n-----END CERTIFICATE-----\n",
        "privateKeyPem":concat!("-----BEGIN PRIVATE ", "KEY-----\nfixture-private-key-marker\n-----END PRIVATE KEY-----\n"),
        "fingerprintSha256":"a".repeat(64),"token":"fixture-management-token-marker-0123456789"})
}
fn initialize_input() -> Value {
    json!({"config":config(),"routeSecrets":[{"routeId":"primary",
        "clientKey":"fixture-client-key-marker-0123456789","upstreamKey":"fixture-upstream-key-marker"}],
        "management":management()})
}
fn bytes(value: &Value) -> Vec<u8> {
    serde_json::to_vec(value).unwrap()
}
fn new_dir(parent: &Path) -> std::path::PathBuf {
    parent.join(uuid::Uuid::new_v4().to_string())
}

#[test]
fn bounded_private_input_rejects_duplicate_unknown_invalid_utf8_and_keys_before_creating_state() {
    let parent = tempfile::tempdir().unwrap();
    let mut unknown = initialize_input();
    unknown["filesystem"] = json!("not-an-api");
    let mut invalid_key = initialize_input();
    invalid_key["routeSecrets"][0]["clientKey"] = json!("too-short");
    let mut injected_key = initialize_input();
    injected_key["routeSecrets"][0]["upstreamKey"] = json!("fake\r\nAuthorization: marker");
    let mut duplicate_route = initialize_input();
    duplicate_route["config"]["routes"]
        .as_array_mut()
        .unwrap()
        .push(config()["routes"][0].clone());
    let mut secret_field = initialize_input();
    secret_field["config"]["routes"][0]["upstreamKey"] = json!("must-not-be-stored");
    let mut bad_version = initialize_input();
    bad_version["config"]["configVersion"] = json!(2);
    let duplicate = bytes(&initialize_input());
    let duplicate = String::from_utf8(duplicate)
        .unwrap()
        .replacen(
            "\"schemaVersion\":1",
            "\"schemaVersion\":1,\"schema\\u0056ersion\":1",
            1,
        )
        .into_bytes();
    for input in [
        bytes(&unknown),
        bytes(&invalid_key),
        bytes(&injected_key),
        bytes(&duplicate_route),
        bytes(&secret_field),
        bytes(&bad_version),
        duplicate,
        vec![0xff],
        vec![b' '; MAX_PRIVATE_INPUT + 1],
    ] {
        let directory = new_dir(parent.path());
        assert!(provisioning::initialize(&directory, &input).is_err());
        assert!(!directory.exists());
    }
    assert!(
        provisioning::initialize(
            Path::new("relative-private-data"),
            &bytes(&initialize_input())
        )
        .is_err()
    );
    assert_eq!(fs::read_dir(parent.path()).unwrap().count(), 0);
}

#[test]
fn management_alias_limit_matches_javascript_utf16_lengths_for_chinese_and_non_bmp_text() {
    for alias in ["界".repeat(100), "😀".repeat(50)] {
        let mut value = management();
        value["alias"] = json!(alias);
        let identity: provisioning::ManagementSecrets = serde_json::from_value(value).unwrap();
        identity.validate().unwrap();
    }
    for alias in ["界".repeat(101), "😀".repeat(51), "invalid\nlabel".into()] {
        let mut value = management();
        value["alias"] = json!(alias);
        let identity: provisioning::ManagementSecrets = serde_json::from_value(value).unwrap();
        assert!(identity.validate().is_err());
    }
}

#[cfg(windows)]
fn protected(directory: &Path, name: &str) -> Value {
    serde_json::from_slice(&provisioning::load_protected(directory, name).unwrap()).unwrap()
}
#[cfg(windows)]
fn assert_no_plaintext(directory: &Path) {
    for entry in fs::read_dir(directory).unwrap() {
        let entry = entry.unwrap();
        if entry.file_type().unwrap().is_file() {
            let content = fs::read(entry.path()).unwrap();
            for marker in [
                "fixture-client-key-marker",
                "fixture-upstream-key-marker",
                "fixture-private-key-marker",
                "fixture-management-token-marker",
                "replacement-client-key-marker",
                "new-upstream-key-marker",
            ] {
                assert!(
                    !content
                        .windows(marker.len())
                        .any(|part| part == marker.as_bytes()),
                    "plaintext marker in {}",
                    entry.file_name().to_string_lossy()
                );
            }
        }
    }
}

#[cfg(windows)]
#[test]
fn private_initialize_uses_real_dpapi_and_safe_stdout_and_never_overwrites_an_existing_directory() {
    use std::io::Write;
    use std::process::{Command, Stdio};
    let parent = tempfile::tempdir().unwrap();
    let directory = new_dir(parent.path());
    let mut child = Command::new(env!("CARGO_BIN_EXE_lumi-gateway-runtime"))
        .args(["initialize-private", directory.to_str().unwrap()])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    child
        .stdin
        .take()
        .unwrap()
        .write_all(&bytes(&initialize_input()))
        .unwrap();
    let output = child.wait_with_output().unwrap();
    assert!(output.status.success());
    assert_eq!(
        serde_json::from_slice::<Value>(&output.stdout).unwrap(),
        json!({"configVersion":1})
    );
    assert!(output.stderr.is_empty());
    let stored = protected(&directory, "secrets.bin");
    assert_eq!(stored["routes"], initialize_input()["routeSecrets"]);
    assert_eq!(protected(&directory, "management.bin"), management());
    assert_eq!(stored["recordKeyB64"].as_str().unwrap().len(), 44);
    assert_eq!(fs::read_dir(&directory).unwrap().count(), 3);
    assert_no_plaintext(&directory);
    let before = fs::read(directory.join("secrets.bin")).unwrap();
    assert_eq!(
        provisioning::initialize(&directory, &bytes(&initialize_input())).unwrap_err(),
        "new-data-directory-required"
    );
    assert_eq!(fs::read(directory.join("secrets.bin")).unwrap(), before);
}

#[cfg(windows)]
#[test]
fn configure_persists_route_add_remove_credentials_version_and_preserves_record_and_management_identity()
 {
    use lumi_gateway_runtime::{config::GatewayConfig, gateway::GatewayEngine};
    let parent = tempfile::tempdir().unwrap();
    let directory = new_dir(parent.path());
    provisioning::initialize(&directory, &bytes(&initialize_input())).unwrap();
    let first = protected(&directory, "secrets.bin");
    let mut next = config();
    next["routes"].as_array_mut().unwrap().push(json!({"id":"claude","client":"claude-cli","protocol":"anthropic","upstream":"https://anthropic.example.test/v1"}));
    next["listen"] = json!("127.0.0.1:18100");
    assert_eq!(provisioning::configure(&directory, &bytes(&json!({"expectedVersion":1,"config":next,
        "credentials":[{"routeId":"primary","clientKey":"replacement-client-key-marker-0123456789"},
            {"routeId":"claude","clientKey":"new-client-key-marker-0123456789","upstreamKey":"new-upstream-key-marker"}],
        "management":{"alias":"重命名界面网关","port":18101}}))).unwrap(), 2);
    let second = protected(&directory, "secrets.bin");
    assert_eq!(second["recordKeyB64"], first["recordKeyB64"]);
    assert_eq!(
        second["routes"][0]["upstreamKey"],
        first["routes"][0]["upstreamKey"]
    );
    assert_eq!(
        second["routes"][0]["clientKey"],
        "replacement-client-key-marker-0123456789"
    );
    assert_eq!(second["routes"].as_array().unwrap().len(), 2);
    let identity = protected(&directory, "management.bin");
    for field in [
        "instanceId",
        "certificatePem",
        "privateKeyPem",
        "fingerprintSha256",
        "token",
    ] {
        assert_eq!(identity[field], management()[field]);
    }
    assert_eq!(identity["alias"], "重命名界面网关");
    assert_eq!(identity["port"], 18101);
    let mut persisted: Value =
        serde_json::from_slice(&fs::read(directory.join("config.json")).unwrap()).unwrap();
    assert_eq!(persisted["configVersion"], 2);
    let cfg: GatewayConfig = serde_json::from_value(persisted.clone()).unwrap();
    let mut engine =
        GatewayEngine::open(cfg, &directory.join("records.sqlite3"), Some([1; 32])).unwrap();
    assert_eq!(
        engine.request("config.get", json!({})).unwrap()["configVersion"],
        2
    );
    drop(engine);
    persisted["routes"].as_array_mut().unwrap().remove(0);
    assert_eq!(
        provisioning::configure(
            &directory,
            &bytes(&json!({"expectedVersion":2,"config":persisted}))
        )
        .unwrap(),
        3
    );
    let final_secrets = protected(&directory, "secrets.bin");
    assert_eq!(final_secrets["routes"].as_array().unwrap().len(), 1);
    assert_eq!(final_secrets["routes"][0]["routeId"], "claude");
    assert_eq!(final_secrets["recordKeyB64"], first["recordKeyB64"]);
    assert_no_plaintext(&directory);
    assert!(!directory.join(".configure-transaction.json").exists());
    assert!(!directory.join(".configure-secrets.backup").exists());
}

#[cfg(windows)]
#[test]
fn configure_rejects_conflicts_wrong_fields_new_route_missing_keys_and_unknown_or_duplicate_updates_without_mutation()
 {
    let parent = tempfile::tempdir().unwrap();
    let directory = new_dir(parent.path());
    provisioning::initialize(&directory, &bytes(&initialize_input())).unwrap();
    let before_config = fs::read(directory.join("config.json")).unwrap();
    let before_secrets = fs::read(directory.join("secrets.bin")).unwrap();
    let before_management = fs::read(directory.join("management.bin")).unwrap();
    let mut added = config();
    added["routes"]
        .as_array_mut()
        .unwrap()
        .push(json!({"id":"new","client":"new-client","upstream":"https://new.example.test/v1"}));
    let mut wrong_version = config();
    wrong_version["configVersion"] = json!(9);
    for update in [
        json!({"expectedVersion":2,"config":config()}),
        json!({"expectedVersion":1,"config":wrong_version}),
        json!({"expectedVersion":1,"config":config(),"command":"arbitrary"}),
        json!({"expectedVersion":1,"config":added}),
        json!({"expectedVersion":1,"config":added,"credentials":[{"routeId":"new","clientKey":"new-client-key-0123456789"}]}),
        json!({"expectedVersion":1,"config":config(),"credentials":[{"routeId":"unknown","upstreamKey":"key"}]}),
        json!({"expectedVersion":1,"config":config(),"credentials":[{"routeId":"primary","upstreamKey":"key"},{"routeId":"primary","upstreamKey":"second"}]}),
        json!({"expectedVersion":1,"config":config(),"credentials":[{"routeId":"primary","upstreamKey":"bad\nheader"}]}),
        json!({"expectedVersion":1,"config":config(),"credentials":[{"routeId":"primary","upstreamKey":"a".repeat(8193)}]}),
        json!({"expectedVersion":1,"config":config(),"credentials":[{"routeId":"primary"}]}),
        json!({"expectedVersion":1,"config":config(),"management":{"alias":"changed","port":18081,"token":"forbidden"}}),
        json!({"expectedVersion":1,"config":config(),"management":{"alias":"changed","port":0}}),
    ] {
        assert!(provisioning::configure(&directory, &bytes(&update)).is_err());
        assert_eq!(
            fs::read(directory.join("config.json")).unwrap(),
            before_config
        );
        assert_eq!(
            fs::read(directory.join("secrets.bin")).unwrap(),
            before_secrets
        );
        assert_eq!(
            fs::read(directory.join("management.bin")).unwrap(),
            before_management
        );
        assert_eq!(fs::read_dir(&directory).unwrap().count(), 3);
    }
}

#[cfg(windows)]
#[test]
fn interrupted_transaction_rolls_back_before_commit_and_finishes_after_commit_without_plaintext_backups()
 {
    use base64::{Engine as _, engine::general_purpose::STANDARD};
    for committed in [false, true] {
        let parent = tempfile::tempdir().unwrap();
        let directory = new_dir(parent.path());
        provisioning::initialize(&directory, &bytes(&initialize_input())).unwrap();
        let old_config = fs::read(directory.join("config.json")).unwrap();
        let old_secrets = provisioning::load_protected(&directory, "secrets.bin").unwrap();
        let old_management = provisioning::load_protected(&directory, "management.bin").unwrap();
        let mut next: Value = serde_json::from_slice(&old_config).unwrap();
        next["configVersion"] = json!(2);
        next["listen"] = json!("127.0.0.1:18200");
        let next_config = serde_json::to_vec_pretty(&next).unwrap();
        provisioning::save_protected(&directory, ".configure-secrets.backup", &old_secrets)
            .unwrap();
        provisioning::save_protected(&directory, ".configure-management.backup", &old_management)
            .unwrap();
        fs::write(directory.join(".configure-transaction.json"), bytes(&json!({"previousConfigB64":STANDARD.encode(&old_config),"committedConfigB64":STANDARD.encode(&next_config),"hadManagement":true}))).unwrap();
        let mut replacement: Value = serde_json::from_slice(&old_secrets).unwrap();
        replacement["routes"][0]["clientKey"] = json!("replacement-client-key-marker-0123456789");
        provisioning::save_protected(&directory, "secrets.bin", &bytes(&replacement)).unwrap();
        let mut new_management = management();
        new_management["alias"] = json!("changed-alias");
        provisioning::save_protected(&directory, "management.bin", &bytes(&new_management))
            .unwrap();
        if committed {
            fs::write(directory.join("config.json"), &next_config).unwrap();
        }
        assert_no_plaintext(&directory);
        provisioning::recover(&directory).unwrap();
        assert_eq!(
            fs::read(directory.join("config.json")).unwrap(),
            if committed { next_config } else { old_config }
        );
        assert_eq!(
            protected(&directory, "secrets.bin"),
            if committed {
                replacement
            } else {
                serde_json::from_slice::<Value>(&old_secrets).unwrap()
            }
        );
        assert_eq!(
            protected(&directory, "management.bin"),
            if committed {
                new_management
            } else {
                management()
            }
        );
        assert_eq!(fs::read_dir(&directory).unwrap().count(), 3);
        provisioning::recover(&directory).unwrap();
    }
}

#[cfg(windows)]
#[test]
fn failed_commit_keeps_recoverable_protected_backups_and_restores_original_credentials() {
    let parent = tempfile::tempdir().unwrap();
    let directory = new_dir(parent.path());
    provisioning::initialize(&directory, &bytes(&initialize_input())).unwrap();
    let original = protected(&directory, "secrets.bin");
    let config_path = directory.join("config.json");
    let config_bytes = fs::read(&config_path).unwrap();
    let original_permissions = fs::metadata(&config_path).unwrap().permissions();
    let mut protected_permissions = original_permissions.clone();
    protected_permissions.set_readonly(true);
    fs::set_permissions(&config_path, protected_permissions).unwrap();
    let result = provisioning::configure(
        &directory,
        &bytes(&json!({"expectedVersion":1,"config":config(),
        "credentials":[{"routeId":"primary","clientKey":"replacement-client-key-marker-0123456789"}],
        "management":{"alias":"changed-before-failed-commit","port":18301}})),
    );
    assert!(result.is_err());
    assert_eq!(fs::read(&config_path).unwrap(), config_bytes);
    assert_eq!(protected(&directory, "secrets.bin"), original);
    assert_eq!(protected(&directory, "management.bin"), management());
    assert_no_plaintext(&directory);
    fs::set_permissions(&config_path, original_permissions).unwrap();
    provisioning::recover(&directory).unwrap();
    assert_eq!(fs::read(&config_path).unwrap(), config_bytes);
    assert_eq!(fs::read_dir(&directory).unwrap().count(), 3);
}

#[cfg(windows)]
#[test]
fn fixed_private_configure_and_engine_restart_read_the_same_persisted_version_and_only_emit_pipe_results()
 {
    use std::io::{BufRead, Write};
    use std::process::{Command, Stdio};
    let parent = tempfile::tempdir().unwrap();
    let directory = new_dir(parent.path());
    provisioning::initialize(&directory, &bytes(&initialize_input())).unwrap();
    let mut child = Command::new(env!("CARGO_BIN_EXE_lumi-gateway-runtime"))
        .args(["configure-private", directory.to_str().unwrap()])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    let mut next = config();
    next["rectifiers"] = json!([{"id":"fractional-clamp","enabled":true,"priority":0,"stage":"entry",
        "field":"/temperature","match":{},"action":{"type":"clamp","min":-0.25,"max":0.4}}]);
    child.stdin.take().unwrap().write_all(&bytes(&json!({"expectedVersion":1,"config":next,
        "credentials":[{"routeId":"primary","clientKey":"replacement-client-key-marker-0123456789"}]}))).unwrap();
    let output = child.wait_with_output().unwrap();
    assert!(output.status.success());
    assert!(output.stderr.is_empty());
    assert_eq!(
        serde_json::from_slice::<Value>(&output.stdout).unwrap(),
        json!({"configVersion":2})
    );
    let mut engine = Command::new(env!("CARGO_BIN_EXE_lumi-gateway-runtime"))
        .args(["serve-engine", directory.to_str().unwrap()])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    let mut input = engine.stdin.take().unwrap();
    let mut reader = std::io::BufReader::new(engine.stdout.take().unwrap());
    input
        .write_all(b"{\"id\":1,\"method\":\"bootstrap\"}\n")
        .unwrap();
    let mut line = String::new();
    reader.read_line(&mut line).unwrap();
    let boot: Value = serde_json::from_str(&line).unwrap();
    assert_eq!(boot["result"]["config"]["configVersion"], 2);
    assert_eq!(
        boot["result"]["routeSecrets"][0]["clientKey"],
        "replacement-client-key-marker-0123456789"
    );
    input
        .write_all(b"{\"id\":2,\"method\":\"config.get\"}\n")
        .unwrap();
    line.clear();
    reader.read_line(&mut line).unwrap();
    let current: Value = serde_json::from_str(&line).unwrap();
    assert_eq!(current["result"]["configVersion"], 2);
    assert_eq!(
        current["result"]["config"]["rectifiers"][0]["action"],
        json!({"type":"clamp","min":-0.25,"max":0.4})
    );
    input
        .write_all(b"{\"id\":3,\"method\":\"bootstrap\"}\n")
        .unwrap();
    line.clear();
    reader.read_line(&mut line).unwrap();
    assert_eq!(
        serde_json::from_str::<Value>(&line).unwrap()["error"]["code"],
        "already-bootstrapped"
    );
    drop(input);
    drop(reader);
    let output = engine.wait_with_output().unwrap();
    assert!(output.status.success());
    assert!(output.stderr.is_empty());
    // A second private transaction must read the already persisted decimal rule.
    let next: Value =
        serde_json::from_slice(&fs::read(directory.join("config.json")).unwrap()).unwrap();
    assert_eq!(
        provisioning::configure(
            &directory,
            &bytes(&json!({"expectedVersion":2,"config":next}))
        )
        .unwrap(),
        3
    );
    assert_no_plaintext(&directory);
}

#[cfg(windows)]
#[test]
fn prepared_private_configuration_changes_nothing_until_commit_and_rechecks_original_disk_bytes() {
    let parent = tempfile::tempdir().unwrap();
    let dir = new_dir(parent.path());
    provisioning::initialize(&dir, &bytes(&initialize_input())).unwrap();
    let before: Vec<_> = ["config.json", "secrets.bin", "management.bin"]
        .into_iter()
        .map(|name| (name, fs::read(dir.join(name)).unwrap()))
        .collect();
    let update = json!({"expectedVersion":1,"config":config(),"credentials":[{"routeId":"primary","upstreamKey":"new-upstream-key-marker"}],"management":{"alias":"新别名","port":18181}});
    let cancelled = provisioning::prepare_configuration(&dir, &bytes(&update)).unwrap();
    assert_eq!(cancelled.config.config_version, 2);
    assert_eq!(
        cancelled.secrets.routes[0].upstream_key,
        "new-upstream-key-marker"
    );
    drop(cancelled);
    for (name, data) in &before {
        assert_eq!(&fs::read(dir.join(name)).unwrap(), data);
    }
    let plan = provisioning::prepare_configuration(&dir, &bytes(&update)).unwrap();
    plan.commit(&dir).unwrap();
    assert_eq!(
        protected(&dir, "secrets.bin")["routes"][0]["upstreamKey"],
        "new-upstream-key-marker"
    );
    assert_eq!(protected(&dir, "management.bin")["port"], 18181);
    assert_no_plaintext(&dir);
    assert!(provisioning::prepare_configuration(&dir, &bytes(&update)).is_err());
    assert!(plan.commit(&dir).is_err());
}
