use std::sync::atomic::{AtomicBool, Ordering};

/// 可运行时即时切换的 Anthropic 兼容层开关。
#[derive(Debug)]
pub struct RuntimeFlags {
    auto_continue_enabled: AtomicBool,
}

impl RuntimeFlags {
    pub fn new(auto_continue_enabled: bool) -> Self {
        Self {
            auto_continue_enabled: AtomicBool::new(auto_continue_enabled),
        }
    }

    pub fn auto_continue_enabled(&self) -> bool {
        self.auto_continue_enabled.load(Ordering::Relaxed)
    }

    pub fn set_auto_continue_enabled(&self, enabled: bool) {
        self.auto_continue_enabled.store(enabled, Ordering::Relaxed);
    }
}
