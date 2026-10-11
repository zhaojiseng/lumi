use base64::{Engine as _, engine::general_purpose::STANDARD};
use lumi_gateway_runtime::{
    config::GatewayConfig,
    gateway::{GatewayEngine, RouteSecret, Secrets},
    provisioning::{self, ManagementSecrets},
};
use rand::{RngCore, rngs::OsRng};
use serde_json::{Value, json};
use std::{
    fs,
    io::{self, BufRead, IsTerminal, Write},
    path::{Path, PathBuf},
};
use zeroize::Zeroizing;

const MAX_RPC_LINE: usize = 6 * 1024 * 1024;
fn main() {
    if let Err(code) = run() {
        eprintln!("网关操作失败：{code}");
        std::process::exit(1);
    }
}
fn run() -> Result<(), String> {
    let args: Vec<String> = std::env::args().collect();
    if args.len() != 3 {
        return Err(
            "用法：lumi-gateway-runtime init|initialize-private|configure-private|protect-management|serve-engine <独立数据目录>".into(),
        );
    }
    let dir = PathBuf::from(&args[2]);
    match args[1].as_str() {
        "init" => initialize(&dir),
        "initialize-private" => private_operation(&dir, true),
        "configure-private" => private_operation(&dir, false),
        "protect-management" => protect_management(&dir),
        "serve-engine" => serve_engine(&dir),
        _ => Err("不支持的命令".into()),
    }
}
fn private_operation(dir: &Path, initialize: bool) -> Result<(), String> {
    if io::stdin().is_terminal() || io::stdout().is_terminal() {
        return Err("private-pipe-required".into());
    }
    let mut bytes = Zeroizing::new(Vec::new());
    io::stdin()
        .lock()
        .take((provisioning::MAX_PRIVATE_INPUT + 1) as u64)
        .read_to_end(&mut bytes)
        .map_err(|_| "private-input-failed")?;
    let version = if initialize {
        provisioning::initialize(dir, &bytes)?
    } else {
        provisioning::configure(dir, &bytes)?
    };
    println!("{}", json!({"configVersion":version}));
    Ok(())
}
fn initialize(dir: &Path) -> Result<(), String> {
    if dir.exists() {
        return Err("初始化目录已存在；请选择新的独立目录".into());
    }
    if !dir.is_absolute() {
        return Err("需要独立数据目录的绝对路径".into());
    }
    let protocol = prompt("路由协议（openai 或 anthropic，留空为 openai）：")?;
    let protocol = match protocol.trim() {
        "" | "openai" => "openai",
        "anthropic" => "anthropic",
        _ => return Err("路由协议无效".into()),
    };
    let upstream = prompt("上游 base URL（例如 https://api.example.com/v1）：")?;
    let key = Zeroizing::new(hidden_prompt("上游 API key（不回显）：")?);
    let client_key = Zeroizing::new(hidden_prompt(
        "本地客户端密钥（自行保存，至少16字符，不回显）：",
    )?);
    if client_key.len() < 16 || client_key.len() > 8192 || client_key.contains(['\r', '\n']) {
        return Err("本地客户端密钥无效".into());
    }
    if key.trim().is_empty() || key.contains(['\r', '\n']) {
        return Err("密钥无效".into());
    }
    let config: GatewayConfig = serde_json::from_value(json!({
        "schemaVersion":1,"listen":"127.0.0.1:18080",
        "routes":[{"id":"default","client":"local-cli","upstream":upstream,"protocol":protocol}],
        "rules":[],"recording":{"bodies":false,"retentionDays":7,"maxRecords":10000},
        "maxRequestBytes":2097152,"maxConcurrency":32
    }))
    .map_err(|_| "配置无效")?;
    config.validate()?;
    let mut record_key = [0u8; 32];
    OsRng.fill_bytes(&mut record_key);
    let mut secrets = Secrets {
        record_key_b64: STANDARD.encode(record_key),
        routes: vec![RouteSecret {
            route_id: "default".into(),
            client_key: client_key.to_string(),
            upstream_key: key.to_string(),
        }],
    };
    let encoded = Zeroizing::new(serde_json::to_vec(&secrets).map_err(|_| "密钥编码失败")?);
    {
        use zeroize::Zeroize;
        record_key.zeroize();
        secrets.record_key_b64.zeroize();
        for route in &mut secrets.routes {
            route.client_key.zeroize();
            route.upstream_key.zeroize();
        }
    }
    fs::create_dir(dir).map_err(|_| "无法创建新目录，可能已存在")?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(dir, fs::Permissions::from_mode(0o700))
            .map_err(|_| "目录权限设置失败")?;
    }
    provisioning::save_protected(dir, "secrets.bin", &encoded)
        .map_err(|_| "系统安全存储失败；没有保存明文密钥")?;
    let config_file = dir.join("config.json");
    fs::write(
        &config_file,
        serde_json::to_vec_pretty(&config).map_err(|_| "配置编码失败")?,
    )
    .map_err(|_| "无法保存配置")?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(&config_file, fs::Permissions::from_mode(0o600))
            .map_err(|_| "配置权限设置失败")?;
    }
    println!("初始化完成。配置不含密钥；密钥保存在系统保护的 secrets.bin。");
    Ok(())
}
fn serve_engine(dir: &Path) -> Result<(), String> {
    if io::stdin().is_terminal() || io::stdout().is_terminal() {
        return Err("网关核心仅允许固定私有进程管道连接".into());
    }
    provisioning::recover(dir)?;
    let config_bytes = read_config(&dir.join("config.json"))?;
    lumi_gateway_runtime::json::scan_object(&config_bytes)
        .map_err(|_| "配置JSON不完整或包含重复键")?;
    let config: GatewayConfig =
        serde_json::from_slice(&config_bytes).map_err(|_| "配置格式无效")?;
    config.validate()?;
    let secret_bytes =
        provisioning::load_protected(dir, "secrets.bin").map_err(|_| "系统安全存储不可用")?;
    let mut secrets: Secrets = serde_json::from_slice(&secret_bytes).map_err(|_| "凭据格式无效")?;
    if secrets.routes.len() != config.routes.len()
        || config
            .routes
            .iter()
            .any(|r| secrets.routes.iter().filter(|s| s.route_id == r.id).count() != 1)
    {
        return Err("凭据与路由不匹配".into());
    }
    let key_bytes = Zeroizing::new(
        STANDARD
            .decode(&secrets.record_key_b64)
            .map_err(|_| "录制密钥无效")?,
    );
    let record_key: [u8; 32] = key_bytes
        .as_slice()
        .try_into()
        .map_err(|_| "录制密钥无效")?;
    let mut engine = GatewayEngine::open(
        config.clone(),
        &dir.join("records.sqlite3"),
        Some(record_key),
    )?;
    // bootstrap is emitted only once over the private child-process pipe.
    {
        use zeroize::Zeroize;
        secrets.record_key_b64.zeroize();
    }
    let mut management = load_management(dir)?;
    let mut bootstrapped = false;
    let mut prepared_configuration: Option<(String, provisioning::PreparedConfiguration)> = None;
    let mut input = io::stdin().lock();
    let mut output = io::stdout().lock();
    loop {
        let mut line = Vec::new();
        let read = (&mut input)
            .take((MAX_RPC_LINE + 1) as u64)
            .read_until(b'\n', &mut line)
            .map_err(|_| "管理输入失败")?;
        if read == 0 {
            break;
        }
        if line.len() > MAX_RPC_LINE || !line.ends_with(b"\n") {
            return Err("管理消息过大或不完整".into());
        }
        let mut parsed: Value = serde_json::from_slice(&line).map_err(|_| "管理消息无效")?;
        let id = parsed.get("id").cloned().unwrap_or(Value::Null);
        let method = parsed.get("method").and_then(Value::as_str).unwrap_or("");
        let result = if method == "bootstrap" {
            if bootstrapped {
                Err("already-bootstrapped".into())
            } else {
                bootstrapped = true;
                let result = Ok(
                    json!({"config":config,"routeSecrets":secrets.routes,"protocolVersion":1,"management":management}),
                );
                if let Some(secret) = &mut management {
                    use zeroize::Zeroize;
                    secret.private_key_pem.zeroize();
                    secret.token.zeroize();
                }
                for route in &mut secrets.routes {
                    use zeroize::Zeroize;
                    route.client_key.zeroize();
                    route.upstream_key.zeroize();
                }
                result
            }
        } else if !bootstrapped {
            Err("bootstrap-required".into())
        } else if method == "configuration.prepare" {
            (|| {
                if prepared_configuration.is_some() {
                    return Err("configuration-busy".into());
                }
                let bytes = Zeroizing::new(
                    serde_json::to_vec(parsed.get("input").ok_or("invalid-input")?)
                        .map_err(|_| "invalid-input")?,
                );
                let plan = provisioning::prepare_configuration(dir, &bytes)?;
                let current = engine.request("config.get", json!({}))?;
                if current["configVersion"].as_u64() != Some(plan.expected_version) {
                    return Err("config-conflict".into());
                }
                engine.request("config.validate", json!({"config":plan.config}))?;
                let transaction_id = uuid::Uuid::new_v4().to_string();
                let result = json!({"transactionId":transaction_id,"configVersion":plan.config.config_version,
                    "config":plan.config,"routeSecrets":plan.secrets.routes,"management":plan.management});
                prepared_configuration = Some((transaction_id, plan));
                Ok(result)
            })()
        } else if method == "configuration.commit" || method == "configuration.cancel" {
            (|| {
                let input = parsed
                    .get("input")
                    .and_then(Value::as_object)
                    .ok_or("invalid-input")?;
                if input.len() != 1 {
                    return Err("invalid-input".into());
                }
                let id = input
                    .get("transactionId")
                    .and_then(Value::as_str)
                    .ok_or("invalid-input")?;
                if prepared_configuration
                    .as_ref()
                    .is_none_or(|(tx, _)| tx != id)
                {
                    return Err("unknown-configuration".into());
                }
                let (_, plan) = prepared_configuration
                    .take()
                    .ok_or("unknown-configuration")?;
                if method == "configuration.cancel" {
                    Ok(json!({"cancelled":true}))
                } else {
                    engine.commit_configuration(plan.expected_version, plan.config.clone(), || {
                        plan.commit(dir)
                    })
                }
            })()
        } else {
            engine.request(method, parsed.get("input").cloned().unwrap_or(json!({})))
        };
        let mut response = match result {
            Ok(value) => json!({"id":id,"result":value}),
            Err(code) => json!({"id":id,"error":{"code":code}}),
        };
        serde_json::to_writer(&mut output, &response).map_err(|_| "管理输出失败")?;
        output.write_all(b"\n").map_err(|_| "管理输出失败")?;
        output.flush().map_err(|_| "管理输出失败")?;
        wipe_json(&mut response);
        wipe_json(&mut parsed);
        {
            use zeroize::Zeroize;
            line.zeroize();
        }
    }
    Ok(())
}
fn prompt(label: &str) -> Result<String, String> {
    print!("{label}");
    io::stdout().flush().map_err(|_| "终端不可用")?;
    let mut value = Vec::new();
    let count = io::stdin()
        .lock()
        .take(8193)
        .read_until(b'\n', &mut value)
        .map_err(|_| "终端不可用")?;
    if count > 8192 || !value.ends_with(b"\n") {
        return Err("输入过长或不完整".into());
    }
    let text = String::from_utf8(value).map_err(|_| "输入编码无效")?;
    Ok(text.trim_end_matches(['\r', '\n']).to_string())
}
fn hidden_prompt(label: &str) -> Result<String, String> {
    #[cfg(windows)]
    {
        use windows_sys::Win32::System::Console::{
            ENABLE_ECHO_INPUT, GetConsoleMode, GetStdHandle, STD_INPUT_HANDLE, SetConsoleMode,
        };
        let handle = unsafe { GetStdHandle(STD_INPUT_HANDLE) };
        let mut mode = 0;
        if unsafe { GetConsoleMode(handle, &mut mode) } == 0 {
            return Err("密钥录入需要交互终端".into());
        }
        struct Restore {
            handle: windows_sys::Win32::Foundation::HANDLE,
            mode: u32,
        }
        impl Drop for Restore {
            fn drop(&mut self) {
                unsafe {
                    SetConsoleMode(self.handle, self.mode);
                }
            }
        }
        if unsafe { SetConsoleMode(handle, mode & !ENABLE_ECHO_INPUT) } == 0 {
            return Err("无法关闭密钥回显".into());
        }
        let _restore = Restore { handle, mode };
        let result = prompt(label);
        println!();
        result
    }
    #[cfg(unix)]
    {
        let mut old: libc::termios = unsafe { std::mem::zeroed() };
        if unsafe { libc::tcgetattr(libc::STDIN_FILENO, &mut old) } != 0 {
            return Err("密钥录入需要交互终端".into());
        }
        struct Restore(libc::termios);
        impl Drop for Restore {
            fn drop(&mut self) {
                unsafe {
                    libc::tcsetattr(libc::STDIN_FILENO, libc::TCSANOW, &self.0);
                }
            }
        }
        let mut new = old;
        new.c_lflag &= !libc::ECHO;
        if unsafe { libc::tcsetattr(libc::STDIN_FILENO, libc::TCSANOW, &new) } != 0 {
            return Err("无法关闭密钥回显".into());
        }
        let _restore = Restore(old);
        let result = prompt(label);
        println!();
        result
    }
    #[cfg(not(any(windows, unix)))]
    {
        let _ = label;
        Err("平台不支持安全录入".into())
    }
}
use std::io::Read;

fn read_config(path: &Path) -> Result<Vec<u8>, String> {
    let file = fs::File::open(path).map_err(|_| "无法读取配置")?;
    if file.metadata().map_err(|_| "无法读取配置")?.len() > 1024 * 1024 {
        return Err("配置过大".into());
    }
    let mut bytes = Vec::new();
    file.take(1024 * 1024 + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| "无法读取配置")?;
    if bytes.len() > 1024 * 1024 {
        return Err("配置过大".into());
    }
    Ok(bytes)
}
fn wipe_json(value: &mut Value) {
    use zeroize::Zeroize;
    match value {
        Value::String(value) => value.zeroize(),
        Value::Array(values) => {
            for value in values {
                wipe_json(value);
            }
        }
        Value::Object(values) => {
            for value in values.values_mut() {
                wipe_json(value);
            }
        }
        _ => (),
    }
}

fn protect_management(dir: &Path) -> Result<(), String> {
    if !dir.is_absolute() || io::stdin().is_terminal() || io::stdout().is_terminal() {
        return Err("管理身份仅允许固定私有管道保存".into());
    }
    if dir.join("management.bin").exists() {
        return Err("管理身份已存在；不能覆盖已配对实例".into());
    }
    let mut bytes = Zeroizing::new(Vec::new());
    io::stdin()
        .lock()
        .take(65537)
        .read_to_end(&mut bytes)
        .map_err(|_| "管理身份输入失败")?;
    if bytes.len() > 65536 {
        return Err("管理身份输入过大".into());
    }
    lumi_gateway_runtime::json::scan_object(&bytes).map_err(|_| "管理身份JSON无效")?;
    let mut secret: ManagementSecrets =
        serde_json::from_slice(&bytes).map_err(|_| "管理身份格式无效")?;
    secret.validate()?;
    {
        use zeroize::Zeroize;
        secret.token.zeroize();
        secret.private_key_pem.zeroize();
    }
    provisioning::save_protected(dir, "management.bin", &bytes)
        .map_err(|_| "系统安全存储不可用；未保存明文管理身份")?;
    println!("系统已保护管理身份。");
    Ok(())
}
fn load_management(dir: &Path) -> Result<Option<ManagementSecrets>, String> {
    if !dir.join("management.bin").exists() {
        return Ok(None);
    }
    let bytes =
        provisioning::load_protected(dir, "management.bin").map_err(|_| "管理身份系统解密失败")?;
    let secret: ManagementSecrets =
        serde_json::from_slice(&bytes).map_err(|_| "管理身份格式无效")?;
    secret.validate()?;
    Ok(Some(secret))
}
