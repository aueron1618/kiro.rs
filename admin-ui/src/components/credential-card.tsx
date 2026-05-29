import { useState } from 'react'
import { toast } from 'sonner'
import { RefreshCw, ChevronUp, ChevronDown, Wallet, Trash2, Loader2, Zap, ZapOff } from 'lucide-react'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Switch } from '@/components/ui/switch'
import { Input } from '@/components/ui/input'
import { Checkbox } from '@/components/ui/checkbox'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import type { CredentialStatusItem, BalanceResponse } from '@/types/api'
import { getCredentialBalance, setCredentialOverage } from '@/api/credentials'
import { extractErrorMessage } from '@/lib/utils'
import {
  useSetDisabled,
  useSetPriority,
  useResetFailure,
  useDeleteCredential,
  useForceRefreshToken,
} from '@/hooks/use-credentials'

interface CredentialCardProps {
  credential: CredentialStatusItem
  onViewBalance: (id: number) => void
  selected: boolean
  onToggleSelect: () => void
  balance: BalanceResponse | null
  loadingBalance: boolean
  onBalanceUpdated?: (id: number, balance: BalanceResponse) => void
}

function formatLastUsed(lastUsedAt: string | null): string {
  if (!lastUsedAt) return '从未使用'
  const date = new Date(lastUsedAt)
  const now = new Date()
  const diff = now.getTime() - date.getTime()
  if (diff < 0) return '刚刚'
  const seconds = Math.floor(diff / 1000)
  if (seconds < 60) return `${seconds} 秒前`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes} 分钟前`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours} 小时前`
  const days = Math.floor(hours / 24)
  return `${days} 天前`
}

function OverageStatusPill({ balance }: { balance: BalanceResponse }) {
  if (balance.overageCapable === false) return null

  if (balance.overageEnabled === true) {
    return (
      <Badge variant="success" className="inline-flex items-center gap-1">
        <Zap className="h-3 w-3" />超额已开
      </Badge>
    )
  }

  if (balance.overageCapable === true) {
    return (
      <Badge
        variant="warning"
        className="inline-flex items-center gap-1"
        title="此账号支持超额但当前未开启"
      >
        <ZapOff className="h-3 w-3" />超额未开
      </Badge>
    )
  }

  return (
    <Badge
      variant="outline"
      title={
        balance.overageCapabilityRaw
          ? `overageCapability = ${balance.overageCapabilityRaw}`
          : '上游未返回 overageCapability'
      }
    >
      超额未知
    </Badge>
  )
}

export function CredentialCard({
  credential,
  onViewBalance,
  selected,
  onToggleSelect,
  balance,
  loadingBalance,
  onBalanceUpdated,
}: CredentialCardProps) {
  const [editingPriority, setEditingPriority] = useState(false)
  const [priorityValue, setPriorityValue] = useState(String(credential.priority))
  const [showDeleteDialog, setShowDeleteDialog] = useState(false)

  const setDisabled = useSetDisabled()
  const setPriority = useSetPriority()
  const resetFailure = useResetFailure()
  const deleteCredential = useDeleteCredential()
  const forceRefresh = useForceRefreshToken()
  const [overageBusy, setOverageBusy] = useState(false)

  const handleToggleDisabled = () => {
    setDisabled.mutate(
      { id: credential.id, disabled: !credential.disabled },
      {
        onSuccess: (res) => {
          toast.success(res.message)
        },
        onError: (err) => {
          toast.error('操作失败: ' + (err as Error).message)
        },
      }
    )
  }

  const handlePriorityChange = () => {
    const newPriority = parseInt(priorityValue, 10)
    if (isNaN(newPriority) || newPriority < 0) {
      toast.error('优先级必须是非负整数')
      return
    }
    setPriority.mutate(
      { id: credential.id, priority: newPriority },
      {
        onSuccess: (res) => {
          toast.success(res.message)
          setEditingPriority(false)
        },
        onError: (err) => {
          toast.error('操作失败: ' + (err as Error).message)
        },
      }
    )
  }

  const handleReset = () => {
    resetFailure.mutate(credential.id, {
      onSuccess: (res) => {
        toast.success(res.message)
      },
      onError: (err) => {
        toast.error('操作失败: ' + (err as Error).message)
      },
    })
  }

  const handleForceRefresh = () => {
    forceRefresh.mutate(credential.id, {
      onSuccess: (res) => {
        toast.success(res.message)
      },
      onError: (err) => {
        toast.error('刷新失败: ' + (err as Error).message)
      },
    })
  }

  const handleSetOverage = async (enabled: boolean) => {
    setOverageBusy(true)
    try {
      await setCredentialOverage(credential.id, enabled)
      toast.success(enabled ? '已开启超额' : '已关闭超额')

      try {
        const latestBalance = await getCredentialBalance(credential.id)
        onBalanceUpdated?.(credential.id, latestBalance)
      } catch (error) {
        toast.warning('超额状态已变更，但刷新余额失败: ' + extractErrorMessage(error))
      }
    } catch (error) {
      toast.error((enabled ? '开启' : '关闭') + '超额失败: ' + extractErrorMessage(error))
    } finally {
      setOverageBusy(false)
    }
  }

  const handleDelete = () => {
    if (!credential.disabled) {
      toast.error('请先禁用凭据再删除')
      setShowDeleteDialog(false)
      return
    }

    deleteCredential.mutate(credential.id, {
      onSuccess: (res) => {
        toast.success(res.message)
        setShowDeleteDialog(false)
      },
      onError: (err) => {
        toast.error('删除失败: ' + (err as Error).message)
      },
    })
  }

  const isQuotaExceeded = balance
    ? balance.remaining <= 0 || balance.usagePercentage >= 100
    : false
  const disabledByQuota = credential.disabled && credential.disabledReason === 'QuotaExceeded'

  return (
    <>
      <Card className={`${credential.isCurrent ? 'ring-2 ring-primary' : ''} ${!credential.disabled && isQuotaExceeded ? 'ring-1 ring-yellow-500/70' : ''} ${disabledByQuota ? 'ring-1 ring-yellow-500/80 bg-yellow-50/40 dark:bg-yellow-500/[0.04]' : ''}`}>
        <CardHeader className="p-4 pb-2 sm:p-6 sm:pb-2">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
            <div className="flex min-w-0 items-start gap-2">
              <Checkbox
                checked={selected}
                onCheckedChange={onToggleSelect}
              />
              <CardTitle className="flex min-w-0 flex-wrap items-center gap-2 break-all text-base sm:text-lg">
                {credential.email || `凭据 #${credential.id}`}
                {credential.isCurrent && (
                  <Badge variant="success">当前</Badge>
                )}
                {credential.disabled && (
                  <Badge variant="destructive">已禁用</Badge>
                )}
                {credential.disabled && credential.disabledReason && (
                  <Badge variant={credential.disabledReason === 'QuotaExceeded' ? 'warning' : 'outline'}>
                    {credential.disabledReason === 'QuotaExceeded' ? '已超额' : credential.disabledReason}
                  </Badge>
                )}
                {!credential.disabled && isQuotaExceeded && (
                  <Badge variant="warning">已超额</Badge>
                )}
                {credential.authMethod && (
                  <Badge variant="secondary">
                    {credential.authMethod === 'api_key' ? 'API Key' :
                     credential.authMethod === 'idc' ? 'IdC' :
                     credential.authMethod === 'social' ? 'Social' :
                     credential.authMethod}
                  </Badge>
                )}
                {credential.endpoint && (
                  <Badge variant="outline">{credential.endpoint}</Badge>
                )}
              </CardTitle>
            </div>
            <div className="flex shrink-0 items-center justify-between gap-2 sm:justify-start">
              <span className="text-sm text-muted-foreground">启用</span>
              <Switch
                checked={!credential.disabled}
                onCheckedChange={handleToggleDisabled}
                disabled={setDisabled.isPending}
              />
            </div>
          </div>
        </CardHeader>
        <CardContent className="space-y-4 px-4 pb-4 sm:px-6 sm:pb-6">
          {/* 信息网格 */}
          <div className="grid grid-cols-2 gap-3 text-sm sm:gap-4">
            <div>
              <span className="text-muted-foreground">优先级：</span>
              {editingPriority ? (
                <div className="mt-2 flex flex-wrap items-center gap-1 sm:mt-0 sm:inline-flex sm:ml-1">
                  <Input
                    type="number"
                    value={priorityValue}
                    onChange={(e) => setPriorityValue(e.target.value)}
                    className="w-16 h-7 text-sm"
                    min="0"
                  />
                  <Button
                    size="sm"
                    variant="ghost"
                    className="h-7 w-7 p-0"
                    onClick={handlePriorityChange}
                    disabled={setPriority.isPending}
                  >
                    ✓
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    className="h-7 w-7 p-0"
                    onClick={() => {
                      setEditingPriority(false)
                      setPriorityValue(String(credential.priority))
                    }}
                  >
                    ✕
                  </Button>
                </div>
              ) : (
                <span
                  className="font-medium cursor-pointer hover:underline ml-1"
                  onClick={() => setEditingPriority(true)}
                >
                  {credential.priority}
                  <span className="text-xs text-muted-foreground ml-1">(点击编辑)</span>
                </span>
              )}
            </div>
            <div>
              <span className="text-muted-foreground">失败次数：</span>
              <span className={credential.failureCount > 0 ? 'text-red-500 font-medium' : ''}>
                {credential.failureCount}
              </span>
            </div>
            <div>
              <span className="text-muted-foreground">刷新失败：</span>
              <span className={credential.refreshFailureCount > 0 ? 'text-red-500 font-medium' : ''}>
                {credential.refreshFailureCount}
              </span>
            </div>
            <div>
              <span className="text-muted-foreground">订阅等级：</span>
              <span className="font-medium">
                {loadingBalance ? (
                  <Loader2 className="inline w-3 h-3 animate-spin" />
                ) : balance?.subscriptionTitle || '未知'}
              </span>
            </div>
            <div>
              <span className="text-muted-foreground">成功次数：</span>
              <span className="font-medium">{credential.successCount}</span>
            </div>
            <div className="col-span-2">
              <span className="text-muted-foreground">最后调用：</span>
              <span className="font-medium">{formatLastUsed(credential.lastUsedAt)}</span>
            </div>
            {credential.maskedApiKey && (
              <div className="col-span-2">
                <span className="text-muted-foreground">API Key：</span>
                <span className="break-all font-mono font-medium">{credential.maskedApiKey}</span>
              </div>
            )}
            <div className="col-span-2">
              <span className="text-muted-foreground">剩余用量：</span>
              {loadingBalance ? (
                <span className="text-sm ml-1">
                  <Loader2 className="inline w-3 h-3 animate-spin" /> 加载中...
                </span>
              ) : balance ? (
                <span className="font-medium ml-1">
                  <span className={balance.remaining < 0 ? 'text-red-500' : ''}>
                    {balance.remaining.toFixed(2)}
                  </span> / {balance.usageLimit.toFixed(2)}
                  <span className="text-xs text-muted-foreground ml-1">
                    ({balance.usagePercentage.toFixed(1)}% 已用)
                  </span>
                </span>
              ) : (
                <span className="text-sm text-muted-foreground ml-1">未知</span>
              )}
            </div>
            {balance && (
              <div className="col-span-2 flex items-center gap-2">
                <span className="text-muted-foreground">超额状态：</span>
                <OverageStatusPill balance={balance} />
              </div>
            )}
            {credential.hasProxy && (
              <div className="col-span-2">
                <span className="text-muted-foreground">代理：</span>
                <span className="break-all font-medium">{credential.proxyUrl}</span>
              </div>
            )}
            {credential.hasProfileArn && (
              <div className="col-span-2">
                <Badge variant="secondary">有 Profile ARN</Badge>
              </div>
            )}
          </div>

          {/* 操作按钮 */}
          <div className="grid grid-cols-2 gap-2 border-t pt-2 lg:flex lg:flex-wrap">
            <Button
              size="sm"
              variant="outline"
              onClick={handleReset}
              disabled={resetFailure.isPending || (credential.failureCount === 0 && credential.refreshFailureCount === 0)}
              className="min-w-0 px-2 lg:w-auto lg:px-3"
            >
              <RefreshCw className="h-4 w-4 mr-1" />
              重置失败
            </Button>
            <Button
              size="sm"
              variant="outline"
              onClick={handleForceRefresh}
              disabled={forceRefresh.isPending || credential.disabled || credential.authMethod === 'api_key'}
              title={credential.authMethod === 'api_key' ? 'API Key 凭据无需刷新 Token' : credential.disabled ? '已禁用的凭据无法刷新 Token' : '强制刷新 Token'}
              className="min-w-0 px-2 lg:w-auto lg:px-3"
            >
              <RefreshCw className={`h-4 w-4 mr-1 ${forceRefresh.isPending ? 'animate-spin' : ''}`} />
              刷新 Token
            </Button>
            <Button
              size="sm"
              variant="outline"
              onClick={() => {
                const newPriority = Math.max(0, credential.priority - 1)
                setPriority.mutate(
                  { id: credential.id, priority: newPriority },
                  {
                    onSuccess: (res) => toast.success(res.message),
                    onError: (err) => toast.error('操作失败: ' + (err as Error).message),
                  }
                )
              }}
              disabled={setPriority.isPending || credential.priority === 0}
              className="min-w-0 px-2 lg:w-auto lg:px-3"
            >
              <ChevronUp className="h-4 w-4 mr-1" />
              提高优先级
            </Button>
            <Button
              size="sm"
              variant="outline"
              onClick={() => {
                const newPriority = credential.priority + 1
                setPriority.mutate(
                  { id: credential.id, priority: newPriority },
                  {
                    onSuccess: (res) => toast.success(res.message),
                    onError: (err) => toast.error('操作失败: ' + (err as Error).message),
                  }
                )
              }}
              disabled={setPriority.isPending}
              className="min-w-0 px-2 lg:w-auto lg:px-3"
            >
              <ChevronDown className="h-4 w-4 mr-1" />
              降低优先级
            </Button>
            <Button
              size="sm"
              variant="default"
              onClick={() => onViewBalance(credential.id)}
              className="min-w-0 px-2 lg:w-auto lg:px-3"
            >
              <Wallet className="h-4 w-4 mr-1" />
              查看余额
            </Button>
            {balance?.overageCapable === true && (
              balance.overageEnabled ? (
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => handleSetOverage(false)}
                  disabled={overageBusy || credential.disabled}
                  className="min-w-0 px-2 lg:w-auto lg:px-3"
                >
                  <ZapOff className="h-4 w-4 mr-1" />
                  关闭超额
                </Button>
              ) : (
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => handleSetOverage(true)}
                  disabled={overageBusy || credential.disabled}
                  className="min-w-0 px-2 lg:w-auto lg:px-3"
                >
                  <Zap className="h-4 w-4 mr-1" />
                  开启超额
                </Button>
              )
            )}
            <Button
              size="sm"
              variant="destructive"
              onClick={() => setShowDeleteDialog(true)}
              disabled={!credential.disabled}
              title={!credential.disabled ? '需要先禁用凭据才能删除' : undefined}
              className="min-w-0 px-2 lg:w-auto lg:px-3"
            >
              <Trash2 className="h-4 w-4 mr-1" />
              删除
            </Button>
          </div>
        </CardContent>
      </Card>

      {/* 删除确认对话框 */}
      <Dialog open={showDeleteDialog} onOpenChange={setShowDeleteDialog}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>确认删除凭据</DialogTitle>
            <DialogDescription>
              您确定要删除凭据 #{credential.id} 吗？此操作无法撤销。
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setShowDeleteDialog(false)}
              disabled={deleteCredential.isPending}
            >
              取消
            </Button>
            <Button
              variant="destructive"
              onClick={handleDelete}
              disabled={deleteCredential.isPending || !credential.disabled}
            >
              确认删除
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  )
}
