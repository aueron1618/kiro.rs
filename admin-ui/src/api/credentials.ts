import axios from 'axios'
import { storage } from '@/lib/storage'
import type {
  CredentialsStatusResponse,
  BalanceResponse,
  SuccessResponse,
  SetDisabledRequest,
  SetPriorityRequest,
  AddCredentialRequest,
  AddCredentialResponse,
  AutoContinueConfigResponse,
  SetAutoContinueConfigRequest,
  AutoContinueConfigUpdateRequest,
  AutoContinueRequestRecord,
  QuotaExceededResult,
  EnableOverageAllResult,
} from '@/types/api'

// 创建 axios 实例
const api = axios.create({
  baseURL: '/api/admin',
  headers: {
    'Content-Type': 'application/json',
  },
})

// 请求拦截器添加 API Key
api.interceptors.request.use((config) => {
  const apiKey = storage.getApiKey()
  if (apiKey) {
    config.headers['x-api-key'] = apiKey
  }
  return config
})

// 获取所有凭据状态
export async function getCredentials(): Promise<CredentialsStatusResponse> {
  const { data } = await api.get<CredentialsStatusResponse>('/credentials')
  return data
}

// 设置凭据禁用状态
export async function setCredentialDisabled(
  id: number,
  disabled: boolean
): Promise<SuccessResponse> {
  const { data } = await api.post<SuccessResponse>(
    `/credentials/${id}/disabled`,
    { disabled } as SetDisabledRequest
  )
  return data
}

// 设置凭据优先级
export async function setCredentialPriority(
  id: number,
  priority: number
): Promise<SuccessResponse> {
  const { data } = await api.post<SuccessResponse>(
    `/credentials/${id}/priority`,
    { priority } as SetPriorityRequest
  )
  return data
}

// 重置失败计数
export async function resetCredentialFailure(
  id: number
): Promise<SuccessResponse> {
  const { data } = await api.post<SuccessResponse>(`/credentials/${id}/reset`)
  return data
}

// 强制刷新 Token
export async function forceRefreshToken(
  id: number
): Promise<SuccessResponse> {
  const { data } = await api.post<SuccessResponse>(`/credentials/${id}/refresh`)
  return data
}

// 获取凭据余额
export async function getCredentialBalance(id: number): Promise<BalanceResponse> {
  const { data } = await api.get<BalanceResponse>(`/credentials/${id}/balance`)
  return data
}

// 添加新凭据
export async function addCredential(
  req: AddCredentialRequest
): Promise<AddCredentialResponse> {
  const { data } = await api.post<AddCredentialResponse>('/credentials', req)
  return data
}

// 删除凭据
export async function deleteCredential(id: number): Promise<SuccessResponse> {
  const { data } = await api.delete<SuccessResponse>(`/credentials/${id}`)
  return data
}

// 一键禁用所有“已超额”凭据
export async function disableQuotaExceeded(): Promise<QuotaExceededResult> {
  const { data } = await api.post<QuotaExceededResult>('/credentials/disable-quota-exceeded')
  return data
}

// 设置单个凭据的超额开关
export async function setCredentialOverage(id: number, enabled: boolean): Promise<SuccessResponse> {
  const { data } = await api.post<SuccessResponse>(`/credentials/${id}/overage`, { enabled })
  return data
}

// 一键开启所有可开启超额的凭据
export async function enableOverageForAllCapable(): Promise<EnableOverageAllResult> {
  const { data } = await api.post<EnableOverageAllResult>('/credentials/overage/enable-all')
  return data
}

// 获取负载均衡模式
export async function getLoadBalancingMode(): Promise<{ mode: 'priority' | 'balanced' }> {
  const { data } = await api.get<{ mode: 'priority' | 'balanced' }>('/config/load-balancing')
  return data
}

// 设置负载均衡模式
export async function setLoadBalancingMode(mode: 'priority' | 'balanced'): Promise<{ mode: 'priority' | 'balanced' }> {
  const { data } = await api.put<{ mode: 'priority' | 'balanced' }>('/config/load-balancing', { mode })
  return data
}

// 获取自动续写开关
export async function getAutoContinueConfig(): Promise<AutoContinueConfigResponse> {
  const { data } = await api.get<AutoContinueConfigResponse>('/config/auto-continue')
  return data
}

// 设置自动续写开关
export async function setAutoContinueConfig(enabled: boolean): Promise<AutoContinueConfigResponse> {
  const { data } = await api.put<AutoContinueConfigResponse>('/config/auto-continue', { enabled } as SetAutoContinueConfigRequest)
  return data
}

// 更新自动续写完整配置
export async function updateAutoContinueConfig(req: AutoContinueConfigUpdateRequest): Promise<AutoContinueConfigResponse> {
  const { data } = await api.patch<AutoContinueConfigResponse>('/config/auto-continue', req)
  return data
}

// 获取自动续写请求记录
export async function getAutoContinueRequests(): Promise<AutoContinueRequestRecord[]> {
  const { data } = await api.get<AutoContinueRequestRecord[]>('/auto-continue/requests')
  return data
}
