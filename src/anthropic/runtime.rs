use std::collections::VecDeque;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Mutex, RwLock};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use serde::Serialize;
use uuid::Uuid;

/// 可运行时即时切换的 Anthropic 兼容层开关与统计。
#[derive(Debug)]
pub struct RuntimeFlags {
    auto_continue_enabled: AtomicBool,
    auto_continue_stop_reason_check_enabled: AtomicBool,
    auto_continue_done_tool_check_enabled: AtomicBool,
    auto_continue_max_attempts: AtomicUsize,
    auto_continue_prompt: RwLock<String>,
    auto_continue_requests: Mutex<VecDeque<AutoContinueRequestRecord>>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AutoContinueConfigSnapshot {
    pub enabled: bool,
    pub stop_reason_check_enabled: bool,
    pub done_tool_check_enabled: bool,
    pub max_attempts: usize,
    pub prompt: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AutoContinueRequestRecord {
    pub id: String,
    pub started_at: String,
    pub input_tokens: i32,
    pub output_tokens: i32,
    pub duration_ms: u128,
    pub continuation_count: usize,
    pub stop_reasons: Vec<String>,
    pub done_marker_found: bool,
    pub has_tool_use: bool,
}

#[derive(Debug, Clone)]
pub struct AutoContinueRecordInput {
    pub started_at: SystemTime,
    pub duration: Duration,
    pub input_tokens: i32,
    pub output_tokens: i32,
    pub continuation_count: usize,
    pub stop_reasons: Vec<String>,
    pub done_marker_found: bool,
    pub has_tool_use: bool,
}

const MAX_AUTO_CONTINUE_REQUEST_RECORDS: usize = 200;

impl RuntimeFlags {
    pub fn new_with_auto_continue_config(
        auto_continue_enabled: bool,
        stop_reason_check_enabled: bool,
        done_tool_check_enabled: bool,
        max_attempts: usize,
        prompt: String,
    ) -> Self {
        Self {
            auto_continue_enabled: AtomicBool::new(auto_continue_enabled),
            auto_continue_stop_reason_check_enabled: AtomicBool::new(stop_reason_check_enabled),
            auto_continue_done_tool_check_enabled: AtomicBool::new(done_tool_check_enabled),
            auto_continue_max_attempts: AtomicUsize::new(max_attempts),
            auto_continue_prompt: RwLock::new(prompt),
            auto_continue_requests: Mutex::new(VecDeque::with_capacity(
                MAX_AUTO_CONTINUE_REQUEST_RECORDS,
            )),
        }
    }

    pub fn auto_continue_enabled(&self) -> bool {
        self.auto_continue_enabled.load(Ordering::Relaxed)
    }

    pub fn set_auto_continue_enabled(&self, enabled: bool) {
        self.auto_continue_enabled.store(enabled, Ordering::Relaxed);
    }

    pub fn auto_continue_stop_reason_check_enabled(&self) -> bool {
        self.auto_continue_stop_reason_check_enabled
            .load(Ordering::Relaxed)
    }

    pub fn set_auto_continue_stop_reason_check_enabled(&self, enabled: bool) {
        self.auto_continue_stop_reason_check_enabled
            .store(enabled, Ordering::Relaxed);
    }

    pub fn auto_continue_done_tool_check_enabled(&self) -> bool {
        self.auto_continue_done_tool_check_enabled
            .load(Ordering::Relaxed)
    }

    pub fn set_auto_continue_done_tool_check_enabled(&self, enabled: bool) {
        self.auto_continue_done_tool_check_enabled
            .store(enabled, Ordering::Relaxed);
    }

    pub fn auto_continue_max_attempts(&self) -> usize {
        self.auto_continue_max_attempts.load(Ordering::Relaxed)
    }

    pub fn set_auto_continue_max_attempts(&self, max_attempts: usize) {
        self.auto_continue_max_attempts
            .store(max_attempts, Ordering::Relaxed);
    }

    pub fn auto_continue_prompt(&self) -> String {
        self.auto_continue_prompt
            .read()
            .map(|prompt| prompt.clone())
            .unwrap_or_else(|_| "Continue your last message without repeating its original content. When the answer is fully complete, call the auto_continue_done tool.".to_string())
    }

    pub fn set_auto_continue_prompt(&self, prompt: String) {
        if let Ok(mut current) = self.auto_continue_prompt.write() {
            *current = prompt;
        }
    }

    pub fn auto_continue_config_snapshot(&self) -> AutoContinueConfigSnapshot {
        AutoContinueConfigSnapshot {
            enabled: self.auto_continue_enabled(),
            stop_reason_check_enabled: self.auto_continue_stop_reason_check_enabled(),
            done_tool_check_enabled: self.auto_continue_done_tool_check_enabled(),
            max_attempts: self.auto_continue_max_attempts(),
            prompt: self.auto_continue_prompt(),
        }
    }

    pub fn record_auto_continue_request(&self, input: AutoContinueRecordInput) {
        let record = AutoContinueRequestRecord {
            id: format!("acr_{}", Uuid::new_v4().to_string().replace('-', "")),
            started_at: format_system_time(input.started_at),
            input_tokens: input.input_tokens,
            output_tokens: input.output_tokens,
            duration_ms: input.duration.as_millis(),
            continuation_count: input.continuation_count,
            stop_reasons: input.stop_reasons,
            done_marker_found: input.done_marker_found,
            has_tool_use: input.has_tool_use,
        };

        if let Ok(mut requests) = self.auto_continue_requests.lock() {
            if requests.len() >= MAX_AUTO_CONTINUE_REQUEST_RECORDS {
                requests.pop_front();
            }
            requests.push_back(record);
        }
    }

    pub fn auto_continue_requests(&self) -> Vec<AutoContinueRequestRecord> {
        self.auto_continue_requests
            .lock()
            .map(|requests| requests.iter().rev().cloned().collect())
            .unwrap_or_default()
    }
}

fn format_system_time(time: SystemTime) -> String {
    let millis = time
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis())
        .unwrap_or_default();
    millis.to_string()
}
