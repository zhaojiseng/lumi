//! Explicit text/image/function-call request conversion. Stateful and opaque features fail before sending.
use crate::json::scan_object;
use serde_json::{Map, Value, json};

const CHAT: &str = "/v1/chat/completions";
const RESPONSES: &str = "/v1/responses";
const MESSAGES: &str = "/v1/messages";
fn err(code: &str) -> String {
    code.into()
}
fn array(value: &Value) -> Result<&Vec<Value>, String> {
    value
        .as_array()
        .ok_or_else(|| err("conversion-invalid-input"))
}
fn string(value: &Value) -> Result<&str, String> {
    value
        .as_str()
        .ok_or_else(|| err("conversion-invalid-input"))
}
fn arguments(value: &Value) -> Result<Value, String> {
    if let Some(s) = value.as_str() {
        scan_object(s.as_bytes()).map_err(|_| err("conversion-invalid-tool-arguments"))?;
        serde_json::from_str(s).map_err(|_| err("conversion-invalid-tool-arguments"))
    } else if value.is_object() {
        Ok(value.clone())
    } else {
        Err(err("conversion-invalid-tool-arguments"))
    }
}
#[derive(Clone)]
struct Message {
    role: String,
    blocks: Vec<Value>,
}
fn text(value: &str) -> Value {
    json!({"kind":"text","text":value})
}
fn blocks(value: &Value, source: &str) -> Result<Vec<Value>, String> {
    if value.is_null() {
        return Ok(vec![]);
    }
    if let Some(s) = value.as_str() {
        return Ok(vec![text(s)]);
    }
    let mut result = vec![];
    for b in array(value)? {
        if !b["cache_control"].is_null()
            || b["annotations"].as_array().is_some_and(|a| !a.is_empty())
        {
            return Err(err("conversion-content-unsupported"));
        }

        match b["type"].as_str().ok_or_else(||err("conversion-content-unsupported"))? {
            "text"|"input_text"|"output_text" => result.push(text(string(&b["text"])?)),
            "image_url"|"input_image" => {
                let url=if source==CHAT {string(&b["image_url"]["url"])?}else{string(&b["image_url"])?};
                let detail=if source==CHAT {&b["image_url"]["detail"]}else{&b["detail"]};
                result.push(json!({"kind":"image","url":url,"detail":detail}));
            },
            "image" if source==MESSAGES => {
                let url=match b["source"]["type"].as_str(){
                    Some("url")=>string(&b["source"]["url"])?.to_owned(),
                    Some("base64")=>format!("data:{};base64,{}",string(&b["source"]["media_type"] )?,string(&b["source"]["data"])?),
                    _=>return Err(err("conversion-content-unsupported")),
                };result.push(json!({"kind":"image","url":url}));
            },
            "tool_use" if source==MESSAGES => result.push(json!({"kind":"call","id":string(&b["id"])?,"name":string(&b["name"])?,"arguments":arguments(&b["input"])?})),
            "tool_result" if source==MESSAGES => {
                if b["is_error"]==true{return Err(err("conversion-tool-error-unsupported"))}
                let content=if b["content"].is_string(){b["content"].clone()}else{
                    let values=blocks(&b["content"],source)?;
                    if values.iter().any(|v|v["kind"]!="text"){return Err(err("conversion-content-unsupported"))}
                    json!(values.iter().map(|v|v["text"].as_str().unwrap_or_default()).collect::<Vec<_>>().join("\n"))
                };
                result.push(json!({"kind":"result","id":string(&b["tool_use_id"] )?,"text":content}));
            },
            _=>return Err(err("conversion-content-unsupported")),
        }
    }
    Ok(result)
}
fn read_messages(v: &Value, source: &str) -> Result<Vec<Message>, String> {
    let mut result = vec![];
    if source == RESPONSES {
        if let Some(s) = v["instructions"].as_str() {
            result.push(Message {
                role: "system".into(),
                blocks: vec![text(s)],
            });
        } else if !v["instructions"].is_null() {
            return Err(err("conversion-invalid-input"));
        }
        if let Some(s) = v["input"].as_str() {
            result.push(Message {
                role: "user".into(),
                blocks: vec![text(s)],
            });
            return Ok(result);
        }
        for item in array(&v["input"])? {
            match item["type"].as_str().unwrap_or("message") {
                "message"=>result.push(Message{role:string(&item["role"])?.into(),blocks:blocks(&item["content"],source)?}),
                "function_call"=>result.push(Message{role:"assistant".into(),blocks:vec![json!({"kind":"call","id":string(&item["call_id"] )?,"name":string(&item["name"] )?,"arguments":arguments(&item["arguments"])?})]}),
                "function_call_output"=>result.push(Message{role:"tool".into(),blocks:vec![json!({"kind":"result","id":string(&item["call_id"] )?,"text":string(&item["output"] )?})]}),
                _=>return Err(err("conversion-content-unsupported")),
            }
        }
    } else {
        if source == MESSAGES && !v["system"].is_null() {
            result.push(Message {
                role: "system".into(),
                blocks: blocks(&v["system"], source)?,
            });
        }
        for m in array(&v["messages"])? {
            let role = string(&m["role"])?;
            let mut content = if role == "tool" && source == CHAT {
                vec![
                    json!({"kind":"result","id":string(&m["tool_call_id"] )?,"text":string(&m["content"] )?}),
                ]
            } else {
                blocks(&m["content"], source)?
            };
            if source == CHAT && !m["tool_calls"].is_null() {
                for t in array(&m["tool_calls"])? {
                    if t["type"] != "function" {
                        return Err(err("conversion-tool-unsupported"));
                    }
                    content.push(json!({"kind":"call","id":string(&t["id"] )?,"name":string(&t["function"]["name"] )?,"arguments":arguments(&t["function"]["arguments"])?}));
                }
            }
            if source == CHAT && (!m["function_call"].is_null() || !m["audio"].is_null()) {
                return Err(err("conversion-content-unsupported"));
            }
            result.push(Message {
                role: role.into(),
                blocks: content,
            });
        }
    }
    if result.len() > 4096
        || result.iter().any(|m| {
            !matches!(
                m.role.as_str(),
                "system" | "developer" | "user" | "assistant" | "tool"
            )
        })
    {
        return Err(err("conversion-role-unsupported"));
    }
    Ok(result)
}
fn content_block(b: &Value, target: &str, role: &str) -> Result<Value, String> {
    match b["kind"].as_str() {
        Some("text") => Ok(
            json!({"type":if target==RESPONSES {if role=="assistant"{"output_text"}else{"input_text"}}else{"text"},"text":b["text"]}),
        ),
        Some("image") => {
            if role != "user" {
                return Err(err("conversion-content-unsupported"));
            }
            let url = string(&b["url"])?;
            if target == MESSAGES {
                if !b["detail"].is_null() && b["detail"] != "auto" {
                    return Err(err("conversion-image-detail-unsupported"));
                }
                let source = if let Some(data) = url.strip_prefix("data:") {
                    let (media, data) = data
                        .split_once(";base64,")
                        .ok_or_else(|| err("conversion-image-unsupported"))?;
                    if !["image/png", "image/jpeg", "image/gif", "image/webp"].contains(&media) {
                        return Err(err("conversion-image-unsupported"));
                    }
                    json!({"type":"base64","media_type":media,"data":data})
                } else {
                    json!({"type":"url","url":url})
                };
                Ok(json!({"type":"image","source":source}))
            } else {
                let mut block = if target == CHAT {
                    json!({"type":"image_url","image_url":{"url":url}})
                } else {
                    json!({"type":"input_image","image_url":url})
                };
                if !b["detail"].is_null() {
                    if target == CHAT {
                        block["image_url"]["detail"] = b["detail"].clone()
                    } else {
                        block["detail"] = b["detail"].clone()
                    }
                }
                Ok(block)
            }
        }
        _ => Err(err("conversion-content-unsupported")),
    }
}
fn write_messages(
    messages: &[Message],
    target: &str,
    out: &mut Map<String, Value>,
) -> Result<(), String> {
    let mut list = vec![];
    let mut system = vec![];
    for m in messages {
        let normal = m
            .blocks
            .iter()
            .filter(|b| b["kind"] == "text" || b["kind"] == "image")
            .map(|b| content_block(b, target, &m.role))
            .collect::<Result<Vec<_>, _>>()?;
        let calls = m
            .blocks
            .iter()
            .filter(|b| b["kind"] == "call")
            .collect::<Vec<_>>();
        let results = m
            .blocks
            .iter()
            .filter(|b| b["kind"] == "result")
            .collect::<Vec<_>>();
        if target == RESPONSES {
            if !normal.is_empty() {
                list.push(json!({"role":m.role,"content":normal}));
            }
            for b in calls {
                list.push(json!({"type":"function_call","call_id":b["id"],"name":b["name"],"arguments":b["arguments"].to_string()}));
            }
            for b in results {
                list.push(
                    json!({"type":"function_call_output","call_id":b["id"],"output":b["text"]}),
                );
            }
        } else if target == CHAT {
            if !normal.is_empty() || !calls.is_empty() {
                let mut v = json!({"role":m.role,"content":normal});
                if !calls.is_empty() {
                    v["tool_calls"]=json!(calls.iter().map(|b|json!({"id":b["id"],"type":"function","function":{"name":b["name"],"arguments":b["arguments"].to_string()}})).collect::<Vec<_>>());
                }
                list.push(v);
            }
            for b in results {
                list.push(json!({"role":"tool","tool_call_id":b["id"],"content":b["text"]}));
            }
        } else {
            if m.role == "developer" {
                return Err(err("conversion-role-unsupported"));
            }
            if m.role == "system" {
                if !calls.is_empty() || !results.is_empty() {
                    return Err(err("conversion-role-unsupported"));
                }
                system.extend(normal);
                continue;
            }
            let role = if m.role == "tool" {
                "user"
            } else {
                m.role.as_str()
            };
            let mut content = normal;
            for b in calls {
                content.push(
                    json!({"type":"tool_use","id":b["id"],"name":b["name"],"input":b["arguments"]}),
                );
            }
            for b in results {
                content
                    .push(json!({"type":"tool_result","tool_use_id":b["id"],"content":b["text"]}));
            }
            if let Some(last) = list.last_mut().filter(|last| last["role"] == role) {
                last["content"]
                    .as_array_mut()
                    .ok_or_else(|| err("conversion-invalid-input"))?
                    .extend(content)
            } else {
                list.push(json!({"role":role,"content":content}));
            }
        }
    }
    out.insert(
        if target == RESPONSES {
            "input"
        } else {
            "messages"
        }
        .into(),
        json!(list),
    );
    if !system.is_empty() {
        out.insert("system".into(), json!(system));
    }
    Ok(())
}
fn tools(
    v: &Value,
    source: &str,
    target: &str,
    out: &mut Map<String, Value>,
) -> Result<(), String> {
    if !v["tools"].is_null() {
        let mut result = vec![];
        for raw in array(&v["tools"])? {
            let t = if source == CHAT {
                if raw["type"] != "function" {
                    return Err(err("conversion-tool-unsupported"));
                }
                &raw["function"]
            } else {
                raw
            };
            if source == RESPONSES && t["type"] != "function" {
                return Err(err("conversion-tool-unsupported"));
            }
            if source == MESSAGES && (!t["type"].is_null() || !t["cache_control"].is_null()) {
                return Err(err("conversion-tool-unsupported"));
            }
            let name = string(&t["name"])?;
            let parameters = if source == MESSAGES {
                &t["input_schema"]
            } else {
                &t["parameters"]
            };
            if !parameters.is_object() {
                return Err(err("conversion-tool-unsupported"));
            }
            if !t["strict"].is_null() && !t["strict"].is_boolean() {
                return Err(err("conversion-tool-unsupported"));
            }
            // Responses may normalize an omitted strict flag. Other protocols cannot reproduce that policy.
            if source == RESPONSES && t["strict"].is_null() {
                return Err(err("conversion-tool-strict-mapping-required"));
            }
            if target == MESSAGES && t["strict"] == true {
                return Err(err("conversion-tool-strict-unsupported"));
            }
            let mut def = if target == MESSAGES {
                json!({"name":name,"input_schema":parameters})
            } else {
                json!({"name":name,"parameters":parameters})
            };
            if !t["description"].is_null() {
                def["description"] = t["description"].clone();
            }
            if target != MESSAGES {
                def["strict"] = if t["strict"].is_null() {
                    json!(false)
                } else {
                    t["strict"].clone()
                };
            }
            if target == CHAT {
                def = json!({"type":"function","function":def});
            } else if target == RESPONSES {
                def["type"] = json!("function");
            }
            result.push(def);
        }
        out.insert("tools".into(), json!(result));
    }
    if !v["tool_choice"].is_null() {
        let c = &v["tool_choice"];
        let (kind, name) = if source == MESSAGES {
            (
                match c["type"].as_str() {
                    Some("auto") => "auto",
                    Some("any") => "required",
                    Some("none") => "none",
                    Some("tool") => "function",
                    _ => return Err(err("conversion-tool-choice-unsupported")),
                },
                c["name"].as_str(),
            )
        } else if let Some(s) = c.as_str() {
            (s, None)
        } else {
            (
                string(&c["type"])?,
                if source == CHAT {
                    c["function"]["name"].as_str()
                } else {
                    c["name"].as_str()
                },
            )
        };
        let choice = if target == MESSAGES {
            match kind {
                "auto" | "none" => json!({"type":kind}),
                "required" => json!({"type":"any"}),
                "function" => {
                    json!({"type":"tool","name":name.ok_or_else(||err("conversion-tool-choice-unsupported"))?})
                }
                _ => return Err(err("conversion-tool-choice-unsupported")),
            }
        } else if kind == "function" {
            if target == CHAT {
                json!({"type":"function","function":{"name":name.ok_or_else(||err("conversion-tool-choice-unsupported"))?}})
            } else {
                json!({"type":"function","name":name.ok_or_else(||err("conversion-tool-choice-unsupported"))?})
            }
        } else if ["auto", "none", "required"].contains(&kind) {
            json!(kind)
        } else {
            return Err(err("conversion-tool-choice-unsupported"));
        };
        out.insert("tool_choice".into(), choice);
    }
    let parallel = if source == MESSAGES {
        v["tool_choice"]["disable_parallel_tool_use"]
            .as_bool()
            .map(|b| !b)
    } else {
        v["parallel_tool_calls"].as_bool()
    };
    if let Some(p) = parallel {
        if target == MESSAGES {
            let choice = out
                .entry("tool_choice")
                .or_insert_with(|| json!({"type":"auto"}));
            choice["disable_parallel_tool_use"] = json!(!p);
        } else {
            out.insert("parallel_tool_calls".into(), json!(p));
        }
    }
    Ok(())
}
fn format(
    v: &Value,
    source: &str,
    target: &str,
    out: &mut Map<String, Value>,
) -> Result<(), String> {
    let f = if source == CHAT {
        &v["response_format"]
    } else if source == RESPONSES {
        &v["text"]["format"]
    } else {
        &v["output_config"]["format"]
    };
    if f.is_null() {
        return Ok(());
    }
    let mut canonical = if source == CHAT && f["type"] == "json_schema" {
        let mut v = f["json_schema"].clone();
        v["type"] = json!("json_schema");
        v
    } else {
        f.clone()
    };
    if ![Some("text"), Some("json_object"), Some("json_schema")]
        .contains(&canonical["type"].as_str())
    {
        return Err(err("conversion-format-unsupported"));
    }
    if target == MESSAGES {
        if canonical["type"] != "json_schema" || !canonical["schema"].is_object() {
            return Err(err("conversion-format-unsupported"));
        }
        out.entry("output_config").or_insert_with(|| json!({}))["format"] =
            json!({"type":"json_schema","schema":canonical["schema"]});
    } else {
        if canonical["type"] == "json_schema" && canonical["name"].is_null() {
            canonical["name"] = json!("output");
        }
        if target == CHAT {
            let f = if canonical["type"] == "json_schema" {
                canonical
                    .as_object_mut()
                    .ok_or_else(|| err("conversion-format-unsupported"))?
                    .remove("type");
                json!({"type":"json_schema","json_schema":canonical})
            } else {
                canonical
            };
            out.insert("response_format".into(), f);
        } else {
            out.entry("text").or_insert_with(|| json!({}))["format"] = canonical;
        }
    }
    Ok(())
}
pub fn convert(body: &[u8], source: &str, target: &str) -> Result<Vec<u8>, String> {
    if source == target {
        return Ok(body.to_vec());
    }
    if ![CHAT, RESPONSES, MESSAGES].contains(&source)
        || ![CHAT, RESPONSES, MESSAGES].contains(&target)
    {
        return Err(err("conversion-protocol-unsupported"));
    }
    scan_object(body).map_err(|_| err("conversion-invalid-input"))?;
    let v: Value = serde_json::from_slice(body).map_err(|_| err("conversion-invalid-input"))?;
    const KNOWN: &[&str] = &[
        "model",
        "input",
        "instructions",
        "messages",
        "system",
        "stream",
        "tools",
        "tool_choice",
        "parallel_tool_calls",
        "max_tokens",
        "max_output_tokens",
        "max_completion_tokens",
        "temperature",
        "top_p",
        "stop",
        "stop_sequences",
        "service_tier",
        "metadata",
        "response_format",
        "text",
        "output_config",
        "reasoning_effort",
        "reasoning",
        "stream_options",
        "store",
    ];
    if v.as_object()
        .ok_or_else(|| err("conversion-invalid-input"))?
        .keys()
        .any(|k| !KNOWN.contains(&k.as_str()))
    {
        return Err(err("conversion-field-unsupported"));
    }
    if v["store"] == true {
        return Err(err("conversion-state-unsupported"));
    }
    if source == MESSAGES && !v["output_config"]["effort"].is_null()
        || target == MESSAGES && (!v["reasoning_effort"].is_null() || !v["reasoning"].is_null())
    {
        return Err(err("conversion-reasoning-mapping-required"));
    }
    for (field, allowed) in [
        ("reasoning", &["effort", "summary"][..]),
        ("text", &["format", "verbosity"][..]),
        ("output_config", &["format", "effort"][..]),
        ("stream_options", &["include_usage"][..]),
    ] {
        if !v[field].is_null()
            && v[field]
                .as_object()
                .is_none_or(|m| m.keys().any(|k| !allowed.contains(&k.as_str())))
        {
            return Err(err("conversion-field-unsupported"));
        }
    }
    if !v["reasoning"]["summary"].is_null() {
        return Err(err("conversion-reasoning-mapping-required"));
    }
    if !v["text"]["verbosity"].is_null() {
        return Err(err("conversion-field-unsupported"));
    }
    if v["stream_options"]
        .as_object()
        .is_some_and(|m| m.keys().any(|k| k != "include_usage"))
    {
        return Err(err("conversion-field-unsupported"));
    }
    let mut out = Map::new();
    out.insert("model".into(), v["model"].clone());
    for k in ["stream", "temperature", "top_p", "service_tier", "metadata"] {
        if !v[k].is_null() {
            out.insert(k.into(), v[k].clone());
        }
    }
    if target == MESSAGES
        && v["metadata"]
            .as_object()
            .is_some_and(|m| m.keys().any(|k| k != "user_id"))
    {
        return Err(err("conversion-metadata-unsupported"));
    }
    let limit = if source == MESSAGES {
        &v["max_tokens"]
    } else if source == RESPONSES {
        &v["max_output_tokens"]
    } else if !v["max_completion_tokens"].is_null() {
        &v["max_completion_tokens"]
    } else {
        &v["max_tokens"]
    };
    if !limit.is_null() {
        out.insert(
            if target == MESSAGES {
                "max_tokens"
            } else if target == RESPONSES {
                "max_output_tokens"
            } else {
                "max_completion_tokens"
            }
            .into(),
            limit.clone(),
        );
    }
    let stop = if source == MESSAGES {
        &v["stop_sequences"]
    } else {
        &v["stop"]
    };
    if !stop.is_null() {
        if target == RESPONSES {
            return Err(err("conversion-stop-unsupported"));
        }
        out.insert(
            if target == MESSAGES {
                "stop_sequences"
            } else {
                "stop"
            }
            .into(),
            if target == MESSAGES && stop.is_string() {
                json!([stop])
            } else {
                stop.clone()
            },
        );
    }
    if target != MESSAGES {
        let effort = if source == CHAT {
            &v["reasoning_effort"]
        } else {
            &v["reasoning"]["effort"]
        };
        if !effort.is_null() {
            if target == CHAT {
                out.insert("reasoning_effort".into(), effort.clone());
            } else {
                out.insert("reasoning".into(), json!({"effort":effort}));
            }
        }
        if target == CHAT && v["stream"] == true {
            out.insert("stream_options".into(), json!({"include_usage":true}));
        }
    }
    write_messages(&read_messages(&v, source)?, target, &mut out)?;
    tools(&v, source, target, &mut out)?;
    format(&v, source, target, &mut out)?;
    serde_json::to_vec(&out).map_err(|_| err("conversion-invalid-input"))
}
