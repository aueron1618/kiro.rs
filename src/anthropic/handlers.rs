//! Anthropic API Handler 函数

use std::convert::Infallible;
use std::sync::Arc;

use anyhow::Error;
use crate::kiro::model::events::Event;
use crate::kiro::model::requests::kiro::KiroRequest;
use crate::kiro::parser::decoder::EventStreamDecoder;
use crate::token;
use axum::{
    Json as JsonExtractor,
    body::Body,
    extract::State,
    http::{StatusCode, header},
    response::{IntoResponse, Json, Response},
};
use bytes::Bytes;
use futures::{Stream, StreamExt, stream};
use serde_json::json;
use std::time::Duration;
use tokio::time::interval;
use uuid::Uuid;

use super::converter::{ConversionError, convert_request};
use super::middleware::AppState;
use super::runtime::RuntimeFlags;
use super::stream::{AutoContinueSegment, BufferedStreamContext, SseEvent, StreamContext};
use super::types::{CountTokensRequest, CountTokensResponse, ErrorResponse, Message, MessagesRequest, Model, ModelsResponse, OutputConfig, Thinking};
use super::websearch;

/// 单次上游请求耗时小于该阈值时，允许自动续写
const AUTO_CONTINUE_MAX_DURATION: Duration = Duration::from_secs(4 * 60);
/// 单次可见输出 tokens 小于该阈值时，允许自动续写
const AUTO_CONTINUE_MAX_OUTPUT_TOKENS: i32 = 8000;
/// 自动续写最大轮数，避免异常场景无限循环
const AUTO_CONTINUE_MAX_ATTEMPTS: usize = 8;
/// 参考 SillyTavern 的默认 continue nudge
const AUTO_CONTINUE_NUDGE_PROMPT: &str =
    "[Continue your last message without repeating its original content.]";
/// 触发自动续写所需的最小可见文本长度
const AUTO_CONTINUE_MIN_VISIBLE_CHARS: usize = 5;

fn should_auto_continue(elapsed: Duration, segment: &AutoContinueSegment) -> bool {
    if segment.has_tool_use {
        return false;
    }

    if elapsed >= AUTO_CONTINUE_MAX_DURATION {
        return false;
    }

    if segment.visible_text.trim().chars().count() <= AUTO_CONTINUE_MIN_VISIBLE_CHARS {
        return false;
    }

    segment.estimated_output_tokens() < AUTO_CONTINUE_MAX_OUTPUT_TOKENS
}

fn build_auto_continue_payload(
    payload: &MessagesRequest,
    assistant_text: &str,
) -> MessagesRequest {
    let mut next_payload = payload.clone();

    // thinking 请求的续写历史只追加“可见输出”，并关闭后续请求的 thinking 前缀。
    // 这样可以避免同一个 Anthropic 响应里出现多段 thinking block，同时仍然让模型基于已输出文本继续写。
    if next_payload.thinking.as_ref().is_some_and(|t| t.is_enabled()) {
        next_payload.thinking = None;
        next_payload.output_config = None;
    }

    next_payload.messages.push(Message {
        role: "assistant".to_string(),
        content: serde_json::Value::String(assistant_text.to_string()),
    });
    next_payload.messages.push(Message {
        role: "user".to_string(),
        content: serde_json::Value::String(AUTO_CONTINUE_NUDGE_PROMPT.to_string()),
    });
    next_payload
}

fn build_request_body(payload: &MessagesRequest) -> anyhow::Result<String> {
    let conversion_result = convert_request(payload)
        .map_err(|e| anyhow::anyhow!("请求转换失败: {}", e))?;

    let kiro_request = KiroRequest {
        conversation_state: conversion_result.conversation_state,
        profile_arn: None,
    };

    serde_json::to_string(&kiro_request).map_err(|e| anyhow::anyhow!("序列化请求失败: {}", e))
}

fn prepare_auto_continue_request(
    payload: &MessagesRequest,
    assistant_text: &str,
) -> anyhow::Result<(MessagesRequest, String)> {
    let next_payload = build_auto_continue_payload(payload, assistant_text);
    let next_request_body = build_request_body(&next_payload)?;
    Ok((next_payload, next_request_body))
}

fn continuation_log_suffix(segment: &AutoContinueSegment, elapsed: Duration) -> String {
    format!(
        "耗时 {:?}，可见输出约 {} tokens",
        elapsed,
        segment.estimated_output_tokens()
    )
}

/// 将 KiroProvider 错误映射为 HTTP 响应
fn map_provider_error(err: Error) -> Response {
    let err_str = err.to_string();

    // 上下文窗口满了（对话历史累积超出模型上下文窗口限制）
    if err_str.contains("CONTENT_LENGTH_EXCEEDS_THRESHOLD") {
        tracing::warn!(error = %err, "上游拒绝请求：上下文窗口已满（不应重试）");
        return (
            StatusCode::BAD_REQUEST,
            Json(ErrorResponse::new(
                "invalid_request_error",
                "Context window is full. Reduce conversation history, system prompt, or tools.",
            )),
        )
            .into_response();
    }

    // 单次输入太长（请求体本身超出上游限制）
    if err_str.contains("Input is too long") {
        tracing::warn!(error = %err, "上游拒绝请求：输入过长（不应重试）");
        return (
            StatusCode::BAD_REQUEST,
            Json(ErrorResponse::new(
                "invalid_request_error",
                "Input is too long. Reduce the size of your messages.",
            )),
        )
            .into_response();
    }
    tracing::error!("Kiro API 调用失败: {}", err);
    (
        StatusCode::BAD_GATEWAY,
        Json(ErrorResponse::new(
            "api_error",
            format!("上游 API 调用失败: {}", err),
        )),
    )
        .into_response()
}

/// GET /v1/models
///
/// 返回可用的模型列表
pub async fn get_models() -> impl IntoResponse {
    tracing::info!("Received GET /v1/models request");

    let models = vec![
        Model {
            id: "claude-opus-4-7".to_string(),
            object: "model".to_string(),
            created: 1772582400, // Mar 4, 2026
            owned_by: "anthropic".to_string(),
            display_name: "Claude Opus 4.7".to_string(),
            model_type: "chat".to_string(),
            max_tokens: 64000,
        },
        Model {
            id: "claude-opus-4-7-thinking".to_string(),
            object: "model".to_string(),
            created: 1772582400, // Mar 4, 2026
            owned_by: "anthropic".to_string(),
            display_name: "Claude Opus 4.7 (Thinking)".to_string(),
            model_type: "chat".to_string(),
            max_tokens: 64000,
        },
        Model {
            id: "claude-opus-4-6".to_string(),
            object: "model".to_string(),
            created: 1770163200, // Feb 4, 2026
            owned_by: "anthropic".to_string(),
            display_name: "Claude Opus 4.6".to_string(),
            model_type: "chat".to_string(),
            max_tokens: 64000,
        },
        Model {
            id: "claude-opus-4-6-thinking".to_string(),
            object: "model".to_string(),
            created: 1770163200, // Feb 4, 2026
            owned_by: "anthropic".to_string(),
            display_name: "Claude Opus 4.6 (Thinking)".to_string(),
            model_type: "chat".to_string(),
            max_tokens: 64000,
        },
        Model {
            id: "claude-sonnet-4-6".to_string(),
            object: "model".to_string(),
            created: 1771286400, // Feb 17, 2026
            owned_by: "anthropic".to_string(),
            display_name: "Claude Sonnet 4.6".to_string(),
            model_type: "chat".to_string(),
            max_tokens: 64000,
        },
        Model {
            id: "claude-sonnet-4-6-thinking".to_string(),
            object: "model".to_string(),
            created: 1771286400, // Feb 17, 2026
            owned_by: "anthropic".to_string(),
            display_name: "Claude Sonnet 4.6 (Thinking)".to_string(),
            model_type: "chat".to_string(),
            max_tokens: 64000,
        },
        Model {
            id: "claude-opus-4-5-20251101".to_string(),
            object: "model".to_string(),
            created: 1763942400, // Nov 24, 2025
            owned_by: "anthropic".to_string(),
            display_name: "Claude Opus 4.5".to_string(),
            model_type: "chat".to_string(),
            max_tokens: 64000,
        },
        Model {
            id: "claude-opus-4-5-20251101-thinking".to_string(),
            object: "model".to_string(),
            created: 1763942400, // Nov 24, 2025
            owned_by: "anthropic".to_string(),
            display_name: "Claude Opus 4.5 (Thinking)".to_string(),
            model_type: "chat".to_string(),
            max_tokens: 64000,
        },
        Model {
            id: "claude-sonnet-4-5-20250929".to_string(),
            object: "model".to_string(),
            created: 1759104000, // Sep 29, 2025
            owned_by: "anthropic".to_string(),
            display_name: "Claude Sonnet 4.5".to_string(),
            model_type: "chat".to_string(),
            max_tokens: 64000,
        },
        Model {
            id: "claude-sonnet-4-5-20250929-thinking".to_string(),
            object: "model".to_string(),
            created: 1759104000, // Sep 29, 2025
            owned_by: "anthropic".to_string(),
            display_name: "Claude Sonnet 4.5 (Thinking)".to_string(),
            model_type: "chat".to_string(),
            max_tokens: 64000,
        },
        Model {
            id: "claude-haiku-4-5-20251001".to_string(),
            object: "model".to_string(),
            created: 1760486400, // Oct 15, 2025
            owned_by: "anthropic".to_string(),
            display_name: "Claude Haiku 4.5".to_string(),
            model_type: "chat".to_string(),
            max_tokens: 64000,
        },
        Model {
            id: "claude-haiku-4-5-20251001-thinking".to_string(),
            object: "model".to_string(),
            created: 1760486400, // Oct 15, 2025
            owned_by: "anthropic".to_string(),
            display_name: "Claude Haiku 4.5 (Thinking)".to_string(),
            model_type: "chat".to_string(),
            max_tokens: 64000,
        },
    ];

    Json(ModelsResponse {
        object: "list".to_string(),
        data: models,
    })
}

/// POST /v1/messages
///
/// 创建消息（对话）
pub async fn post_messages(
    State(state): State<AppState>,
    JsonExtractor(mut payload): JsonExtractor<MessagesRequest>,
) -> Response {
    tracing::info!(
        model = %payload.model,
        max_tokens = %payload.max_tokens,
        stream = %payload.stream,
        message_count = %payload.messages.len(),
        "Received POST /v1/messages request"
    );
    // 检查 KiroProvider 是否可用
    let provider = match &state.kiro_provider {
        Some(p) => p.clone(),
        None => {
            tracing::error!("KiroProvider 未配置");
            return (
                StatusCode::SERVICE_UNAVAILABLE,
                Json(ErrorResponse::new(
                    "service_unavailable",
                    "Kiro API provider not configured",
                )),
            )
                .into_response();
        }
    };

    // 检测模型名是否包含 "thinking" 后缀，若包含则覆写 thinking 配置
    override_thinking_from_model_name(&mut payload);

    let request_template = payload.clone();

    // 检查是否为 WebSearch 请求
    if websearch::has_web_search_tool(&payload) {
        tracing::info!("检测到 WebSearch 工具，路由到 WebSearch 处理");

        // 估算输入 tokens
        let input_tokens = token::count_all_tokens(
            payload.model.clone(),
            payload.system.clone(),
            payload.messages.clone(),
            payload.tools.clone(),
        ) as i32;

        return websearch::handle_websearch_request(provider, &payload, input_tokens).await;
    }

    // 转换请求
    let conversion_result = match convert_request(&payload) {
        Ok(result) => result,
        Err(e) => {
            let message = match &e {
                ConversionError::EmptyMessages => "消息列表为空".to_string(),
            };
            tracing::warn!("请求转换失败: {}", e);
            return (
                StatusCode::BAD_REQUEST,
                Json(ErrorResponse::new("invalid_request_error", message)),
            )
                .into_response();
        }
    };

    // 构建 Kiro 请求（profile_arn 由 provider 层根据实际凭据注入）
    let kiro_request = KiroRequest {
        conversation_state: conversion_result.conversation_state,
        profile_arn: None,
    };

    let request_body = match serde_json::to_string(&kiro_request) {
        Ok(body) => body,
        Err(e) => {
            tracing::error!("序列化请求失败: {}", e);
            return (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(ErrorResponse::new(
                    "internal_error",
                    format!("序列化请求失败: {}", e),
                )),
            )
                .into_response();
        }
    };

    tracing::debug!("Kiro request body: {}", request_body);

    // 估算输入 tokens
    let input_tokens = token::count_all_tokens(
        payload.model.clone(),
        payload.system,
        payload.messages,
        payload.tools,
    ) as i32;

    // 检查是否启用了thinking
    let thinking_enabled = payload
        .thinking
        .as_ref()
        .map(|t| t.is_enabled())
        .unwrap_or(false);

    let tool_name_map = conversion_result.tool_name_map;

    if payload.stream {
        // 流式响应
        handle_stream_request(
            provider,
            &request_body,
            request_template,
            &payload.model,
            input_tokens,
            thinking_enabled,
            state.runtime_flags.clone(),
            tool_name_map,
        )
        .await
    } else {
        // 非流式响应：仅在配置开启时提取 thinking 块
        let extract_thinking = state.extract_thinking && thinking_enabled;
        handle_non_stream_request(
            provider,
            &request_body,
            request_template,
            &payload.model,
            input_tokens,
            extract_thinking,
            state.runtime_flags.clone(),
            tool_name_map,
        ).await
    }
}

/// 处理流式请求
async fn handle_stream_request(
    provider: std::sync::Arc<crate::kiro::provider::KiroProvider>,
    request_body: &str,
    request_template: MessagesRequest,
    model: &str,
    input_tokens: i32,
    thinking_enabled: bool,
    runtime_flags: Arc<RuntimeFlags>,
    tool_name_map: std::collections::HashMap<String, String>,
) -> Response {
    // 调用 Kiro API（支持多凭据故障转移）
    let response = match provider.call_api_stream(request_body).await {
        Ok(resp) => resp,
        Err(e) => return map_provider_error(e),
    };

    // 创建流处理上下文
    let mut ctx = StreamContext::new_with_thinking(model, input_tokens, thinking_enabled, tool_name_map);

    // 生成初始事件
    let initial_events = ctx.generate_initial_events();

    // 创建 SSE 流
    let stream = create_sse_stream(
        provider,
        request_template,
        response,
        ctx,
        initial_events,
        thinking_enabled,
        runtime_flags,
    );

    // 返回 SSE 响应
    Response::builder()
        .status(StatusCode::OK)
        .header(header::CONTENT_TYPE, "text/event-stream")
        .header(header::CACHE_CONTROL, "no-cache")
        .header(header::CONNECTION, "keep-alive")
        .body(Body::from_stream(stream))
        .unwrap()
}

/// Ping 事件间隔（25秒）
const PING_INTERVAL_SECS: u64 = 25;

/// 创建 ping 事件的 SSE 字符串
fn create_ping_sse() -> Bytes {
    Bytes::from("event: ping\ndata: {\"type\": \"ping\"}\n\n")
}
/// 创建 SSE 事件流
fn create_sse_stream(
    provider: std::sync::Arc<crate::kiro::provider::KiroProvider>,
    request_template: MessagesRequest,
    response: reqwest::Response,
    ctx: StreamContext,
    initial_events: Vec<SseEvent>,
    thinking_enabled: bool,
    runtime_flags: Arc<RuntimeFlags>,
) -> impl Stream<Item = Result<Bytes, Infallible>> {
    let initial_stream = stream::iter(
        initial_events
            .into_iter()
            .map(|e| Ok(Bytes::from(e.to_sse_string()))),
    );

    let processing_stream = stream::unfold(
        (
            provider,
            request_template,
            response.bytes_stream(),
            ctx,
            EventStreamDecoder::new(),
            false,
            interval(Duration::from_secs(PING_INTERVAL_SECS)),
            std::time::Instant::now(),
            0usize,
            thinking_enabled,
            runtime_flags,
        ),
        |(
            provider,
            mut request_template,
            mut body_stream,
            mut ctx,
            mut decoder,
            finished,
            mut ping_interval,
            mut request_started_at,
            mut continue_count,
            thinking_enabled,
            runtime_flags,
        )| async move {
            if finished {
                return None;
            }

            loop {
                tokio::select! {
                    chunk_result = body_stream.next() => {
                       match chunk_result {
                            Some(Ok(chunk)) => {
                                if let Err(e) = decoder.feed(&chunk) {
                                    tracing::warn!("缓冲区溢出: {}", e);
                                }

                                let mut events = Vec::new();
                                for result in decoder.decode_iter() {
                                    match result {
                                        Ok(frame) => {
                                            if let Ok(event) = Event::from_frame(frame) {
                                                events.extend(ctx.process_kiro_event(&event));
                                            }
                                        }
                                        Err(e) => {
                                            tracing::warn!("解码事件失败: {}", e);
                                        }
                                    }
                                }

                                let bytes: Vec<Result<Bytes, Infallible>> = events
                                    .into_iter()
                                    .map(|e| Ok(Bytes::from(e.to_sse_string())))
                                    .collect();

                                return Some((
                                    stream::iter(bytes),
                                    (
                                        provider,
                                        request_template,
                                        body_stream,
                                        ctx,
                                        decoder,
                                        false,
                                        ping_interval,
                                        request_started_at,
                                        continue_count,
                                        thinking_enabled,
                                        runtime_flags,
                                    ),
                                ));
                            }
                            Some(Err(e)) => {
                                tracing::error!("读取响应流失败: {}", e);
                                let final_events = ctx.generate_final_events();
                                let bytes: Vec<Result<Bytes, Infallible>> = final_events
                                    .into_iter()
                                    .map(|e| Ok(Bytes::from(e.to_sse_string())))
                                    .collect();

                                return Some((
 stream::iter(bytes),
                                    (
                                        provider,
                                        request_template,
                                        body_stream,
                                        ctx,
                                        decoder,
                                        true,
                                        ping_interval,
                                        request_started_at,
                                        continue_count,
                                        thinking_enabled,
                                        runtime_flags,
                                    ),
                                ));
                            }
                            None => {
                                let segment = ctx.auto_continue_segment();
                                let elapsed = request_started_at.elapsed();
                                let can_continue = runtime_flags.auto_continue_enabled()
                                    && continue_count < AUTO_CONTINUE_MAX_ATTEMPTS
                                    && should_auto_continue(elapsed, &segment);

                                if can_continue {
                                    match prepare_auto_continue_request(&request_template, &segment.visible_text) {
                                        Ok((next_payload, next_request_body)) => {
                                            tracing::info!(
                                                "触发自动续写（流式）：第 {} 轮，{}",
                                                continue_count + 1,
            continuation_log_suffix(&segment, elapsed)
                                            );

                                            match provider.call_api_stream(&next_request_body).await {
                                                Ok(next_response) => {
                                                    request_template = next_payload;
                                                    body_stream = next_response.bytes_stream();
                                                    decoder = EventStreamDecoder::new();
                                                    request_started_at = std::time::Instant::now();
                                                    continue_count += 1;
                                                    ctx.reset_auto_continue_segment();
                                                    continue;
                                                }
                                                Err(err) => {
                                                    tracing::warn!("自动续写请求失败，结束当前流: {}", err);
                                                }
                                            }
                                        }
                                        Err(err) => {
                                            tracing::warn!("构建自动续写请求失败，结束当前流: {}", err);
                                        }
                                    }
                                }

                                let final_events = ctx.generate_final_events();
                                let bytes: Vec<Result<Bytes, Infallible>> = final_events
                                    .into_iter()
                                    .map(|e| Ok(Bytes::from(e.to_sse_string())))
                                    .collect();

 return Some((
                                    stream::iter(bytes),
                                    (
                                        provider,
                                        request_template,
                                        body_stream,
                                        ctx,
                                        decoder,
                                        true,
                                        ping_interval,
                                        request_started_at,
                                        continue_count,
                                        thinking_enabled,
                                        runtime_flags,
                                    ),
                                ));
                            }
                        }
                    }
                    _ = ping_interval.tick() => {
                        tracing::trace!("发送 ping 保活事件");
                        let bytes: Vec<Result<Bytes, Infallible>> = vec![Ok(create_ping_sse())];

                        return Some((
                            stream::iter(bytes),
                            (
                                provider,
                                request_template,
                                body_stream,
                                ctx,
                                decoder,
                                false,
                                ping_interval,
                                request_started_at,
                                continue_count,
                                thinking_enabled,
                                runtime_flags,
                            ),
                        ));
                    }
                }
            }
        },
    )
    .flatten();

    initial_stream.chain(processing_stream)
}

use super::converter::get_context_window_size;

struct NonStreamSegmentResult {
    content: Vec<serde_json::Value>,
    visible_text: String,
    has_tool_use: bool,
    stop_reason: String,
    context_input_tokens: Option<i32>,
}

fn parse_non_stream_segment(
    body_bytes: &Bytes,
    model: &str,
    thinking_enabled: bool,
    tool_name_map: &std::collections::HashMap<String, String>,
) -> NonStreamSegmentResult {
    let mut decoder = EventStreamDecoder::new();
    if let Err(e) = decoder.feed(body_bytes) {
        tracing::warn!("缓冲区溢出: {}", e);
    }

    let mut text_content = String::new();
    let mut tool_uses: Vec<serde_json::Value> = Vec::new();
    let mut has_tool_use = false;
    let mut stop_reason = "end_turn".to_string();
    let mut context_input_tokens: Option<i32> = None;
    let mut tool_json_buffers: std::collections::HashMap<String, String> =
        std::collections::HashMap::new();

    for result in decoder.decode_iter() {
        match result {
            Ok(frame) => {
                if let Ok(event) = Event::from_frame(frame) {
                    match event {
                Event::AssistantResponse(resp) => {
                            text_content.push_str(&resp.content);
                        }
                        Event::ToolUse(tool_use) => {
                            has_tool_use = true;
                            let buffer = tool_json_buffers
                                .entry(tool_use.tool_use_id.clone())
                                .or_insert_with(String::new);
                            buffer.push_str(&tool_use.input);

                            if tool_use.stop {
                                let input: serde_json::Value = if buffer.is_empty() {
                                    serde_json::json!({})
                                } else {
                                    serde_json::from_str(buffer).unwrap_or_else(|e| {
                                        tracing::warn!(
                                            "工具输入 JSON 解析失败: {}, tool_use_id: {}",
                                            e,
                                            tool_use.tool_use_id
                                        );
                                        serde_json::json!({})
                                    })
                                };

                                let original_name = tool_name_map
                                    .get(&tool_use.name)
                                    .cloned()
                                    .unwrap_or_else(|| tool_use.name.clone());

                                tool_uses.push(json!({
                                    "type": "tool_use",
                                    "id": tool_use.tool_use_id,
                                    "name": original_name,
                                    "input": input
                                }));
                            }
                 }
                        Event::ContextUsage(context_usage) => {
                            let window_size = get_context_window_size(model);
                            let actual_input_tokens =
                                (context_usage.context_usage_percentage * (window_size as f64) / 100.0)
                                    as i32;
                            context_input_tokens = Some(actual_input_tokens);
                            if context_usage.context_usage_percentage >= 100.0 {
                                stop_reason = "model_context_window_exceeded".to_string();
                            }
                            tracing::debug!(
                                "收到 contextUsageEvent: {}%, 计算 input_tokens: {}",
                                context_usage.context_usage_percentage,
                                actual_input_tokens
                            );
                        }
                        Event::Exception { exception_type, .. } => {
                            if exception_type == "ContentLengthExceededException" {
                                stop_reason = "max_tokens".to_string();
                            }
                        }
                        _ => {}
                    }
                }
            }
            Err(e) => {
                tracing::warn!("解码事件失败: {}", e);
            }
        }
    }

    if has_tool_use && stop_reason == "end_turn" {
        stop_reason = "tool_use".to_string();
    }

    let mut content: Vec<serde_json::Value> = Vec::new();
    let mut visible_text = text_content.clone();

    if thinking_enabled {
        let (thinking, remaining_text) =
            super::stream::extract_thinking_from_complete_text(&text_content);

        if let Some(thinking_text) = thinking {
            content.push(json!({
                "type": "thinking",
                "thinking": thinking_text
            }));
        }

        if !remaining_text.is_empty() {
            content.push(json!({
                "type": "text",
                "text": remaining_text.clone()
            }));
    }

        visible_text = remaining_text;
    } else if !text_content.is_empty() {
        content.push(json!({
            "type": "text",
            "text": text_content
        }));
    }

    content.extend(tool_uses);

    NonStreamSegmentResult {
        content,
        visible_text,
        has_tool_use,
        stop_reason,
        context_input_tokens,
    }
}

/// 处理非流式请求
async fn handle_non_stream_request(
    provider: std::sync::Arc<crate::kiro::provider::KiroProvider>,
    request_body: &str,
    request_template: MessagesRequest,
    model: &str,
    input_tokens: i32,
    thinking_enabled: bool,
    runtime_flags: Arc<RuntimeFlags>,
    tool_name_map: std::collections::HashMap<String, String>,
) -> Response {
    let mut current_request_template = request_template;
    let mut current_request_body = request_body.to_string();
    let mut continue_count = 0usize;
    let mut final_input_tokens = input_tokens;
    let mut aggregated_visible_text = String::new();
    let mut final_content: Vec<serde_json::Value> = Vec::new();
    let mut stop_reason = "end_turn".to_string();

    loop {
        let request_started_at = std::time::Instant::now();
        let response = match provider.call_api(&current_request_body).await {
            Ok(resp) => resp,
            Err(e) => return map_provider_error(e),
        };

        let body_bytes = match response.bytes().await {
            Ok(bytes) => bytes,
            Err(e) => {
                tracing::error!("读取响应体失败: {}", e);
                return (
                    StatusCode::BAD_GATEWAY,
                    Json(ErrorResponse::new(
                        "api_error",
                        format!("读取响应失败: {}", e),
                    )),
                )
                    .into_response();
            }
        };

        let segment = parse_non_stream_segment(&body_bytes, model, thinking_enabled, &tool_name_map);
        let elapsed = request_started_at.elapsed();

        if continue_count == 0 {
            final_input_tokens = segment.context_input_tokens.unwrap_or(input_tokens);
        }

        stop_reason = segment.stop_reason.clone();

        if thinking_enabled || segment.has_tool_use {
            final_content.extend(segment.content.clone());
        } else {
            aggregated_visible_text.push_str(&segment.visible_text);
        }

        let segment_snapshot = AutoContinueSegment {
            visible_text: segment.visible_text.clone(),
            has_tool_use: segment.has_tool_use,
        };

        let can_continue = runtime_flags.auto_continue_enabled()
            && continue_count < AUTO_CONTINUE_MAX_ATTEMPTS
            && should_auto_continue(elapsed, &segment_snapshot);

        if !can_continue {
            if !thinking_enabled && !segment.has_tool_use {
                final_content = if aggregated_visible_text.is_empty() {
                    Vec::new()
                } else {
                    vec![json!({
                        "type": "text",
                        "text": aggregated_visible_text
                    })]
                };
            }
            break;
        }

        match prepare_auto_continue_request(&current_request_template, &segment.visible_text) {
            Ok((next_payload, next_request_body)) => {
                tracing::info!(
                    "触发自动续写（非流式）：第 {} 轮，{}",
                    continue_count + 1,
                    continuation_log_suffix(&segment_snapshot, elapsed)
                );
                current_request_template = next_payload;
                current_request_body = next_request_body;
                continue_count += 1;
            }
            Err(err) => {
                tracing::warn!("构建自动续写请求失败，返回当前结果: {}", err);
                if !thinking_enabled && !segment.has_tool_use {
                    final_content = if aggregated_visible_text.is_empty() {
                        Vec::new()
                    } else {
                        vec![json!({
                            "type": "text",
                            "text": aggregated_visible_text
                        })]
                    };
                }
                break;
            }
        }
    }

    let output_tokens = token::estimate_output_tokens(&final_content);
    let response_body = json!({
        "id": format!("msg_{}", Uuid::new_v4().to_string().replace('-', "")),
        "type": "message",
        "role": "assistant",
        "content": final_content,
        "model": model,
        "stop_reason": stop_reason,
        "stop_sequence": null,
        "usage": {
            "input_tokens": final_input_tokens,
            "output_tokens": output_tokens
        }
    });

    (StatusCode::OK, Json(response_body)).into_response()
}



/// 检测模型名是否包含 "thinking" 后缀，若包含则覆写 thinking 配置
///
/// - Opus 4.6 / 4.7：覆写为 adaptive 类型
/// - 其他模型：覆写为 enabled 类型
/// - budget_tokens 固定为 20000
fn override_thinking_from_model_name(payload: &mut MessagesRequest) {
    let model_lower = payload.model.to_lowercase();
    if !model_lower.contains("thinking") {
        return;
    }

    let is_opus_4_6_or_4_7 = model_lower.contains("opus")
        && ((model_lower.contains("4-6") || model_lower.contains("4.6"))
            || (model_lower.contains("4-7") || model_lower.contains("4.7")));

    let thinking_type = if is_opus_4_6_or_4_7 {
        "adaptive"
    } else {
        "enabled"
    };

    tracing::info!(
        model = %payload.model,
        thinking_type = thinking_type,
        "模型名包含 thinking 后缀，覆写 thinking 配置"
    );

    payload.thinking = Some(Thinking {
        thinking_type: thinking_type.to_string(),
        budget_tokens: 20000,
    });
    
    if is_opus_4_6_or_4_7 {
        payload.output_config = Some(OutputConfig {
            effort: "high".to_string(),
        });
    }
}

/// POST /v1/messages/count_tokens
///
/// 计算消息的 token 数量
pub async fn count_tokens(
    JsonExtractor(payload): JsonExtractor<CountTokensRequest>,
) -> impl IntoResponse {
    tracing::info!(
        model = %payload.model,
        message_count = %payload.messages.len(),
        "Received POST /v1/messages/count_tokens request"
    );

    let total_tokens = token::count_all_tokens(
        payload.model,
        payload.system,
        payload.messages,
        payload.tools,
    ) as i32;

    Json(CountTokensResponse {
        input_tokens: total_tokens.max(1) as i32,
    })
}

/// POST /cc/v1/messages
///
/// Claude Code 兼容端点，与 /v1/messages 的区别在于：
/// - 流式响应会等待 kiro 端返回 contextUsageEvent 后再发送 message_start
/// - message_start 中的 input_tokens 是从 contextUsageEvent 计算的准确值
pub async fn post_messages_cc(
    State(state): State<AppState>,
    JsonExtractor(mut payload): JsonExtractor<MessagesRequest>,
) -> Response {
    tracing::info!(
        model = %payload.model,
        max_tokens = %payload.max_tokens,
        stream = %payload.stream,
        message_count = %payload.messages.len(),
        "Received POST /cc/v1/messages request"
    );

    // 检查 KiroProvider 是否可用
    let provider = match &state.kiro_provider {
        Some(p) => p.clone(),
        None => {
            tracing::error!("KiroProvider 未配置");
            return (
                StatusCode::SERVICE_UNAVAILABLE,
                Json(ErrorResponse::new(
                    "service_unavailable",
                    "Kiro API provider not configured",
                )),
            )
                .into_response();
        }
    };

    // 检测模型名是否包含 "thinking" 后缀，若包含则覆写 thinking 配置
    override_thinking_from_model_name(&mut payload);

    let request_template = payload.clone();

    // 检查是否为 WebSearch 请求
    if websearch::has_web_search_tool(&payload) {
        tracing::info!("检测到 WebSearch 工具，路由到 WebSearch 处理");

        // 估算输入 tokens
        let input_tokens = token::count_all_tokens(
            payload.model.clone(),
            payload.system.clone(),
            payload.messages.clone(),
            payload.tools.clone(),
        ) as i32;

        return websearch::handle_websearch_request(provider, &payload, input_tokens).await;
    }

    // 转换请求
    let conversion_result = match convert_request(&payload) {
        Ok(result) => result,
        Err(e) => {
            let message = match &e {
                ConversionError::EmptyMessages => "消息列表为空".to_string(),
            };
            tracing::warn!("请求转换失败: {}", e);
            return (
                StatusCode::BAD_REQUEST,
                Json(ErrorResponse::new("invalid_request_error", message)),
            )
                .into_response();
        }
    };

    // 构建 Kiro 请求（profile_arn 由 provider 层根据实际凭据注入）
    let kiro_request = KiroRequest {
        conversation_state: conversion_result.conversation_state,
        profile_arn: None,
    };

    let request_body = match serde_json::to_string(&kiro_request) {
        Ok(body) => body,
        Err(e) => {
            tracing::error!("序列化请求失败: {}", e);
            return (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(ErrorResponse::new(
                    "internal_error",
                    format!("序列化请求失败: {}", e),
                )),
            )
                .into_response();
        }
    };

    tracing::debug!("Kiro request body: {}", request_body);

    // 估算输入 tokens
    let input_tokens = token::count_all_tokens(
        payload.model.clone(),
        payload.system,
        payload.messages,
        payload.tools,
    ) as i32;

    // 检查是否启用了thinking
    let thinking_enabled = payload
        .thinking
        .as_ref()
        .map(|t| t.is_enabled())
        .unwrap_or(false);

    let tool_name_map = conversion_result.tool_name_map;

    if payload.stream {
        // 流式响应（缓冲模式）
        handle_stream_request_buffered(
            provider,
            &request_body,
            request_template,
            &payload.model,
            input_tokens,
            thinking_enabled,
            state.runtime_flags.clone(),
            tool_name_map,
        )
        .await
    } else {
        // 非流式响应：仅在配置开启时提取 thinking 块
        let extract_thinking = state.extract_thinking && thinking_enabled;
        handle_non_stream_request(
            provider,
            &request_body,
            request_template,
            &payload.model,
            input_tokens,
            extract_thinking,
            state.runtime_flags.clone(),
            tool_name_map,
        )
        .await
    }
}

/// 处理流式请求（缓冲版本）
///
/// 与 `handle_stream_request` 不同，此函数会缓冲所有事件直到流结束，
/// 然后用从 contextUsageEvent 计算的正确 input_tokens 生成 message_start 事件。
async fn handle_stream_request_buffered(
    provider: std::sync::Arc<crate::kiro::provider::KiroProvider>,
    request_body: &str,
    request_template: MessagesRequest,
    model: &str,
    estimated_input_tokens: i32,
    thinking_enabled: bool,
    runtime_flags: Arc<RuntimeFlags>,
    tool_name_map: std::collections::HashMap<String, String>,
) -> Response {
    // 调用 Kiro API（支持多凭据故障转移）
    let response = match provider.call_api_stream(request_body).await {
        Ok(resp) => resp,
        Err(e) => return map_provider_error(e),
    };

    // 创建缓冲流处理上下文
    let ctx = BufferedStreamContext::new(model, estimated_input_tokens, thinking_enabled, tool_name_map);

    // 创建缓冲 SSE 流
    let stream = create_buffered_sse_stream(
        provider,
        request_template,
        response,
        ctx,
        thinking_enabled,
        runtime_flags,
    );

    // 返回 SSE 响应
    Response::builder()
        .status(StatusCode::OK)
        .header(header::CONTENT_TYPE, "text/event-stream")
        .header(header::CACHE_CONTROL, "no-cache")
        .header(header::CONNECTION, "keep-alive")
        .body(Body::from_stream(stream))
        .unwrap()
}

/// 创建缓冲 SSE 事件流
///
/// 工作流程：
/// 1. 等待上游流完成，期间只发送 ping 保活信号
/// 2. 使用 StreamContext 的事件处理逻辑处理所有 Kiro 事件，结果缓存
/// 3. 流结束后，用正确的 input_tokens 更正 message_start 事件
/// 4. 一次性发送所有事件
fn create_buffered_sse_stream(
    provider: std::sync::Arc<crate::kiro::provider::KiroProvider>,
    request_template: MessagesRequest,
    response: reqwest::Response,
    ctx: BufferedStreamContext,
    thinking_enabled: bool,
    runtime_flags: Arc<RuntimeFlags>,
) -> impl Stream<Item = Result<Bytes, Infallible>> {
    let body_stream = response.bytes_stream();

    stream::unfold(
        (
            provider,
            request_template,
            body_stream,
            ctx,
            EventStreamDecoder::new(),
            false,
            interval(Duration::from_secs(PING_INTERVAL_SECS)),
            std::time::Instant::now(),
            0usize,
            thinking_enabled,
            runtime_flags,
        ),
        |(
            provider,
            mut request_template,
            mut body_stream,
            mut ctx,
            mut decoder,
            finished,
            mut ping_interval,
            mut request_started_at,
            mut continue_count,
            thinking_enabled,
            runtime_flags,
        )| async move {
            if finished {
                return None;
            }

            loop {
                tokio::select! {
                    biased;

                    _ = ping_interval.tick() => {
                        tracing::trace!("发送 ping 保活事件（缓冲模式）");
                        let bytes: Vec<Result<Bytes, Infallible>> = vec![Ok(create_ping_sse())];
                        return Some((
                            stream::iter(bytes),
                            (
                                provider,
                                request_template,
                                body_stream,
                                ctx,
                                decoder,
                                false,
                                ping_interval,
                                request_started_at,
                                continue_count,
                                thinking_enabled,
                                runtime_flags,
                            ),
                        ));
                    }

                    chunk_result = body_stream.next() => {
                        match chunk_result {
                            Some(Ok(chunk)) => {
                                if let Err(e) = decoder.feed(&chunk) {
                                    tracing::warn!("缓冲区溢出: {}", e);
                                }


                                for result in decoder.decode_iter() {
                                    match result {
                                        Ok(frame) => {
                                            if let Ok(event) = Event::from_frame(frame) {
                                                ctx.process_and_buffer(&event);
                                            }
              }
                                        Err(e) => {
                                            tracing::warn!("解码事件失败: {}", e);
                                        }
                                    }
                                }
                            }
                            Some(Err(e)) => {
                                tracing::error!("读取响应流失败: {}", e);
                                let all_events = ctx.finish_and_get_all_events();
                                let bytes: Vec<Result<Bytes, Infallible>> = all_events
                                    .into_iter()
                                    .map(|e| Ok(Bytes::from(e.to_sse_string())))
                                    .collect();
                                return Some((
                                    stream::iter(bytes),
                                    (
                                        provider,
                                        request_template,
                                        body_stream,
                                        ctx,
                                        decoder,
                                        true,
                                        ping_interval,
                                        request_started_at,
                                        continue_count,
                                        thinking_enabled,
                                        runtime_flags,
                                    ),
                                ));
                            }
                            None => {
                                let segment = ctx.auto_continue_segment();
                                let elapsed = request_started_at.elapsed();
                                let can_continue = runtime_flags.auto_continue_enabled()
                                    && continue_count < AUTO_CONTINUE_MAX_ATTEMPTS
                                    && should_auto_continue(elapsed, &segment);

                                if can_continue {
                                    match prepare_auto_continue_request(&request_template, &segment.visible_text) {
                                        Ok((next_payload, next_request_body)) => {
                                            tracing::info!(
                                                "触发自动续写（缓冲流）：第 {} 轮，{}",
                                                continue_count + 1,
                                                continuation_log_suffix(&segment, elapsed)
                                            );

                                            match provider.call_api_stream(&next_request_body).await {
                                                Ok(next_response) => {
                                                    request_template = next_payload;
                                                    body_stream = next_response.bytes_stream();
                                                    decoder = EventStreamDecoder::new();
                                                    request_started_at = std::time::Instant::now();
                                                    continue_count += 1;
                                                    ctx.reset_auto_continue_segment();
                                                    continue;
                                                }
                                     Err(err) => {
                                                    tracing::warn!("自动续写请求失败，结束缓冲流: {}", err);
                                                }
                                            }
                                        }
                                        Err(err) => {
                                            tracing::warn!("构建自动续写请求失败，结束缓冲流: {}", err);
                                        }
                                    }
                                }

                                let all_events = ctx.finish_and_get_all_events();
                                let bytes: Vec<Result<Bytes, Infallible>> = all_events
                                    .into_iter()
                                    .map(|e| Ok(Bytes::from(e.to_sse_string())))
                                    .collect();
                                return Some((
                                    stream::iter(bytes),
                                    (
                                        provider,
                                        request_template,
                                        body_stream,
                                        ctx,
                                        decoder,
                                        true,
                                        ping_interval,
                                        request_started_at,
                                        continue_count,
                                        thinking_enabled,
                                        runtime_flags,
                                    ),
                                ));
                            }
                        }
                    }
                }
            }
        },
    )
    .flatten()
}

