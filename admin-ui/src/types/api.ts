// 凭据状态响应
export interface CredentialsStatusResponse {
  total: number
  available: number
  currentId: number
  credentials: CredentialStatusItem[]
}

// 单个凭据状态
export interface CredentialStatusItem {
  id: number
  priority: number
  disabled: boolean
  failureCount: number
  isCurrent: boolean
  expiresAt: string | null
  authMethod: string | null
  hasProfileArn: boolean
  email?: string
  refreshTokenHash?: string
  apiKeyHash?: string
  maskedApiKey?: string
  successCount: number
  lastUsedAt: string | null
  hasProxy: boolean
  proxyUrl?: string
  refreshFailureCount: number
  disabledReason?: string
  endpoint: string
}

// 余额响应
export interface BalanceResponse {
  id: number
  subscriptionTitle: string | null
  currentUsage: number
  usageLimit: number
  remaining: number
  usagePercentage: number
  nextResetAt: number | null
  /** 用户是否当前开启了超额 */
  overageEnabled?: boolean
  /** 账号订阅是否可以开启超额 */
  overageCapable?: boolean
  /** 上游 overageCapability 原始字符串，用于排查“未知”状态 */
  overageCapabilityRaw?: string
}

// 成功响应
export interface SuccessResponse {
  success: boolean
  message: string
}

// 错误响应
export interface AdminErrorResponse {
  error: {
    type: string
    message: string
  }
}

// 请求类型
export interface SetDisabledRequest {
  disabled: boolean
}

export interface SetPriorityRequest {
  priority: number
}

// 添加凭据请求
export interface AddCredentialRequest {
  refreshToken?: string
  authMethod?: 'social' | 'idc' | 'api_key'
  clientId?: string
  clientSecret?: string
  priority?: number
  authRegion?: string
  apiRegion?: string
  machineId?: string
  proxyUrl?: string
  proxyUsername?: string
  proxyPassword?: string
  kiroApiKey?: string
  endpoint?: string
}

// 添加凭据响应
export interface AddCredentialResponse {
  success: boolean
  message: string
  credentialId: number
  email?: string
}

// 一键禁用所有“已超额”凭据结果
export interface QuotaExceededResult {
  disabledIds: number[]
  skippedIds: number[]
}

// 一键开启超额结果
export interface EnableOverageAllResult {
  enabledIds: number[]
  skippedIds: number[]
  failedIds: number[]
  failureMessages: string[]
}

// 自动续写开关响应
export interface AutoContinueConfigResponse {
  enabled: boolean
  doneToolCheckEnabled: boolean
  maxAttempts: number
  prompt: string
}

// 自动续写开关设置请求
export interface SetAutoContinueConfigRequest {
  enabled: boolean
}

// 自动续写完整配置更新请求
export interface AutoContinueConfigUpdateRequest {
  enabled?: boolean
  doneToolCheckEnabled?: boolean
  maxAttempts?: number
  prompt?: string
}

// 自动续写请求记录
export interface AutoContinueRequestRecord {
  id: string
  startedAt: string
  inputTokens: number
  outputTokens: number
  durationMs: number
  continuationCount: number
  stopReasons: string[]
  doneMarkerFound: boolean
  hasToolUse: boolean
}
