import { useState, useEffect, useRef } from 'react'
import { RefreshCw, LogOut, Moon, Sun, Server, Plus, Upload, FileUp, Trash2, RotateCcw, CheckCircle2, Zap, AlertTriangle } from 'lucide-react'
import { useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { storage } from '@/lib/storage'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { CredentialCard } from '@/components/credential-card'
import { BalanceDialog } from '@/components/balance-dialog'
import { Switch } from '@/components/ui/switch'
import { AddCredentialDialog } from '@/components/add-credential-dialog'
import { BatchImportDialog } from '@/components/batch-import-dialog'
import { KamImportDialog } from '@/components/kam-import-dialog'
import { BatchVerifyDialog, type VerifyResult } from '@/components/batch-verify-dialog'
import { useCredentials, useDeleteCredential, useResetFailure, useLoadBalancingMode, useSetLoadBalancingMode, useAutoContinueConfig, useUpdateAutoContinueConfig, useAutoContinueRequests } from '@/hooks/use-credentials'
import { getCredentialBalance, forceRefreshToken, disableQuotaExceeded, enableOverageForAllCapable } from '@/api/credentials'
import { extractErrorMessage } from '@/lib/utils'
import type { BalanceResponse } from '@/types/api'

interface DashboardProps {
  onLogout: () => void
}

export function Dashboard({ onLogout }: DashboardProps) {
  const [selectedCredentialId, setSelectedCredentialId] = useState<number | null>(null)
  const [balanceDialogOpen, setBalanceDialogOpen] = useState(false)
  const [addDialogOpen, setAddDialogOpen] = useState(false)
  const [batchImportDialogOpen, setBatchImportDialogOpen] = useState(false)
  const [kamImportDialogOpen, setKamImportDialogOpen] = useState(false)
  const [selectedIds, setSelectedIds] = useState<Set<number>>(new Set())
  const [verifyDialogOpen, setVerifyDialogOpen] = useState(false)
  const [verifying, setVerifying] = useState(false)
  const [verifyProgress, setVerifyProgress] = useState({ current: 0, total: 0 })
  const [verifyResults, setVerifyResults] = useState<Map<number, VerifyResult>>(new Map())
  const [balanceMap, setBalanceMap] = useState<Map<number, BalanceResponse>>(new Map())
  const [loadingBalanceIds, setLoadingBalanceIds] = useState<Set<number>>(new Set())
  const [queryingInfo, setQueryingInfo] = useState(false)
  const [queryInfoProgress, setQueryInfoProgress] = useState({ current: 0, total: 0 })
  const [batchRefreshing, setBatchRefreshing] = useState(false)
  const [batchRefreshProgress, setBatchRefreshProgress] = useState({ current: 0, total: 0 })
  const cancelVerifyRef = useRef(false)
  const [currentPage, setCurrentPage] = useState(1)
  const itemsPerPage = 12
  const [darkMode, setDarkMode] = useState(() => {
    if (typeof window !== 'undefined') {
      return document.documentElement.classList.contains('dark')
    }
    return false
  })
  const [activeTab, setActiveTab] = useState<'settings' | 'requests' | 'credentials'>('credentials')
  const [requestsAutoRefresh, setRequestsAutoRefresh] = useState(true)
  const [autoContinuePromptDraft, setAutoContinuePromptDraft] = useState('')

  const queryClient = useQueryClient()
  const { data, isLoading, error, refetch } = useCredentials()
  const { mutate: deleteCredential } = useDeleteCredential()
  const { mutate: resetFailure } = useResetFailure()
  const { data: loadBalancingData, isLoading: isLoadingMode } = useLoadBalancingMode()
  const { mutate: setLoadBalancingMode, isPending: isSettingMode } = useSetLoadBalancingMode()
  const { data: autoContinueData, isLoading: isLoadingAutoContinue } = useAutoContinueConfig()
  const { mutate: updateAutoContinueConfig, isPending: isUpdatingAutoContinue } = useUpdateAutoContinueConfig()
  const { data: autoContinueRequests = [], isLoading: isLoadingAutoContinueRequests, refetch: refetchAutoContinueRequests, isFetching: isFetchingAutoContinueRequests } = useAutoContinueRequests(requestsAutoRefresh)

  // 计算分页
  const totalPages = Math.ceil((data?.credentials.length || 0) / itemsPerPage)
  const startIndex = (currentPage - 1) * itemsPerPage
  const endIndex = startIndex + itemsPerPage
  const currentCredentials = data?.credentials.slice(startIndex, endIndex) || []
  const disabledCredentialCount = data?.credentials.filter(credential => credential.disabled).length || 0
  const quotaExceededCount = (data?.credentials || []).filter(credential => {
    if (credential.disabled) return false
    const balance = balanceMap.get(credential.id)
    return Boolean(balance && (balance.remaining <= 0 || balance.usagePercentage >= 100))
  }).length
  const overageStats = (() => {
    let enabled = 0
    let disabledOff = 0
    let unknown = 0
    for (const credential of data?.credentials || []) {
      if (credential.disabled) continue
      const balance = balanceMap.get(credential.id)
      if (!balance) {
        unknown++
        continue
      }
      if (balance.overageCapable === false) continue
      if (balance.overageEnabled === true) enabled++
      else if (balance.overageCapable === true) disabledOff++
      else unknown++
    }
    return { enabled, disabledOff, unknown }
  })()
  const overageEnableableCount = overageStats.disabledOff
  const overageRetryableCount = overageStats.disabledOff + overageStats.unknown
  const selectedDisabledCount = Array.from(selectedIds).filter(id => {
    const credential = data?.credentials.find(c => c.id === id)
    return Boolean(credential?.disabled)
  }).length

  // 当凭据列表变化时重置到第一页
  useEffect(() => {
    setCurrentPage(1)
  }, [data?.credentials.length])

  useEffect(() => {
    setAutoContinuePromptDraft(autoContinueData?.prompt ?? '')
  }, [autoContinueData?.prompt])

  // 只保留当前仍存在的凭据缓存，避免删除后残留旧数据
  useEffect(() => {
    if (!data?.credentials) {
      setBalanceMap(new Map())
      setLoadingBalanceIds(new Set())
      return
    }

    const validIds = new Set(data.credentials.map(credential => credential.id))

    setBalanceMap(prev => {
      const next = new Map<number, BalanceResponse>()
      prev.forEach((value, id) => {
        if (validIds.has(id)) {
          next.set(id, value)
        }
      })
      return next.size === prev.size ? prev : next
    })

    setLoadingBalanceIds(prev => {
      if (prev.size === 0) {
        return prev
      }
      const next = new Set<number>()
      prev.forEach(id => {
        if (validIds.has(id)) {
          next.add(id)
        }
      })
      return next.size === prev.size ? prev : next
    })
  }, [data?.credentials])

  const toggleDarkMode = () => {
    setDarkMode(!darkMode)
    document.documentElement.classList.toggle('dark')
  }

  const handleViewBalance = (id: number) => {
    setSelectedCredentialId(id)
    setBalanceDialogOpen(true)
  }

  const handleBalanceUpdated = (id: number, balance: BalanceResponse) => {
    setBalanceMap(prev => {
      const next = new Map(prev)
      next.set(id, balance)
      return next
    })
  }

  const handleRefresh = () => {
    refetch()
    toast.success('已刷新凭据列表')
  }

  const handleLogout = () => {
    storage.removeApiKey()
    queryClient.clear()
    onLogout()
  }

  // 选择管理
  const toggleSelect = (id: number) => {
    const newSelected = new Set(selectedIds)
    if (newSelected.has(id)) {
      newSelected.delete(id)
    } else {
      newSelected.add(id)
    }
    setSelectedIds(newSelected)
  }

  const deselectAll = () => {
    setSelectedIds(new Set())
  }

  // 批量删除（仅删除已禁用项）
  const handleBatchDelete = async () => {
    if (selectedIds.size === 0) {
      toast.error('请先选择要删除的凭据')
      return
    }

    const disabledIds = Array.from(selectedIds).filter(id => {
      const credential = data?.credentials.find(c => c.id === id)
      return Boolean(credential?.disabled)
    })

    if (disabledIds.length === 0) {
      toast.error('选中的凭据中没有已禁用项')
      return
    }

    const skippedCount = selectedIds.size - disabledIds.length
    const skippedText = skippedCount > 0 ? `（将跳过 ${skippedCount} 个未禁用凭据）` : ''

    if (!confirm(`确定要删除 ${disabledIds.length} 个已禁用凭据吗？此操作无法撤销。${skippedText}`)) {
      return
    }

    let successCount = 0
    let failCount = 0

    for (const id of disabledIds) {
      try {
        await new Promise<void>((resolve, reject) => {
          deleteCredential(id, {
            onSuccess: () => {
              successCount++
              resolve()
            },
            onError: (err) => {
              failCount++
              reject(err)
            }
          })
        })
      } catch (error) {
        // 错误已在 onError 中处理
      }
    }

    const skippedResultText = skippedCount > 0 ? `，已跳过 ${skippedCount} 个未禁用凭据` : ''

    if (failCount === 0) {
      toast.success(`成功删除 ${successCount} 个已禁用凭据${skippedResultText}`)
    } else {
      toast.warning(`删除已禁用凭据：成功 ${successCount} 个，失败 ${failCount} 个${skippedResultText}`)
    }

    deselectAll()
  }

  // 批量恢复异常
  const handleBatchResetFailure = async () => {
    if (selectedIds.size === 0) {
      toast.error('请先选择要恢复的凭据')
      return
    }

    const failedIds = Array.from(selectedIds).filter(id => {
      const cred = data?.credentials.find(c => c.id === id)
      return cred && cred.failureCount > 0
    })

    if (failedIds.length === 0) {
      toast.error('选中的凭据中没有失败的凭据')
      return
    }

    let successCount = 0
    let failCount = 0

    for (const id of failedIds) {
      try {
        await new Promise<void>((resolve, reject) => {
          resetFailure(id, {
            onSuccess: () => {
              successCount++
              resolve()
            },
            onError: (err) => {
              failCount++
              reject(err)
            }
          })
        })
      } catch (error) {
        // 错误已在 onError 中处理
      }
    }

    if (failCount === 0) {
      toast.success(`成功恢复 ${successCount} 个凭据`)
    } else {
      toast.warning(`成功 ${successCount} 个，失败 ${failCount} 个`)
    }

    deselectAll()
  }

  // 批量刷新 Token
  const handleBatchForceRefresh = async () => {
    if (selectedIds.size === 0) {
      toast.error('请先选择要刷新的凭据')
      return
    }

    const enabledIds = Array.from(selectedIds).filter(id => {
      const cred = data?.credentials.find(c => c.id === id)
      return cred && !cred.disabled
    })

    if (enabledIds.length === 0) {
      toast.error('选中的凭据中没有启用的凭据')
      return
    }

    setBatchRefreshing(true)
    setBatchRefreshProgress({ current: 0, total: enabledIds.length })

    let successCount = 0
    let failCount = 0

    for (let i = 0; i < enabledIds.length; i++) {
      try {
        await forceRefreshToken(enabledIds[i])
        successCount++
      } catch {
        failCount++
      }
      setBatchRefreshProgress({ current: i + 1, total: enabledIds.length })
    }

    setBatchRefreshing(false)
    queryClient.invalidateQueries({ queryKey: ['credentials'] })

    if (failCount === 0) {
      toast.success(`成功刷新 ${successCount} 个凭据的 Token`)
    } else {
      toast.warning(`刷新 Token：成功 ${successCount} 个，失败 ${failCount} 个`)
    }

    deselectAll()
  }

  // 一键清除所有已禁用凭据
  const handleClearAll = async () => {
    if (!data?.credentials || data.credentials.length === 0) {
      toast.error('没有可清除的凭据')
      return
    }

    const disabledCredentials = data.credentials.filter(credential => credential.disabled)

    if (disabledCredentials.length === 0) {
      toast.error('没有可清除的已禁用凭据')
      return
    }

    if (!confirm(`确定要清除所有 ${disabledCredentials.length} 个已禁用凭据吗？此操作无法撤销。`)) {
      return
    }

    let successCount = 0
    let failCount = 0

    for (const credential of disabledCredentials) {
      try {
        await new Promise<void>((resolve, reject) => {
          deleteCredential(credential.id, {
            onSuccess: () => {
              successCount++
              resolve()
            },
            onError: (err) => {
              failCount++
              reject(err)
            }
          })
        })
      } catch (error) {
        // 错误已在 onError 中处理
      }
    }

    if (failCount === 0) {
      toast.success(`成功清除所有 ${successCount} 个已禁用凭据`)
    } else {
      toast.warning(`清除已禁用凭据：成功 ${successCount} 个，失败 ${failCount} 个`)
    }

    deselectAll()
  }

  // 一键超额：把所有已超额（未禁用）凭据标记为 QuotaExceeded 并禁用
  const [disablingQuota, setDisablingQuota] = useState(false)
  const handleDisableQuotaExceeded = async () => {
    if (quotaExceededCount === 0) {
      toast.info('当前没有已超额的凭据，可先点击“查询信息”刷新余额')
      return
    }
    if (!confirm(`确定要把 ${quotaExceededCount} 个已超额的凭据全部禁用吗？`)) return
    setDisablingQuota(true)
    try {
      const result = await disableQuotaExceeded()
      const ok = result.disabledIds.length
      const skip = result.skippedIds.length
      if (ok > 0) toast.success(`已禁用 ${ok} 个已超额凭据${skip > 0 ? `，跳过 ${skip} 个` : ''}`)
      else toast.warning('未找到已超额凭据（缓存可能已失效）')
      queryClient.invalidateQueries({ queryKey: ['credentials'] })
    } catch (error) {
      toast.error('一键超额禁用失败: ' + extractErrorMessage(error))
    } finally {
      setDisablingQuota(false)
    }
  }

  // 一键开启超额：调用上游 setUserPreference 把所有“可开启且未开启”的凭据开启
  const [enablingOverage, setEnablingOverage] = useState(false)
  const handleEnableOverageAll = async () => {
    if (overageRetryableCount === 0) {
      toast.info('没有需要开启超额的凭据，可先点击“查询信息”刷新状态')
      return
    }
    const msg = overageEnableableCount > 0
      ? `确定要为 ${overageEnableableCount} 个凭据开启超额吗？开启后超出额度可能产生额外费用。`
      : `当前没有明确“未开”的凭据，将对 ${overageStats.unknown} 个状态待定的凭据尝试开启超额。继续？`
    if (!confirm(msg)) return
    setEnablingOverage(true)
    try {
      const result = await enableOverageForAllCapable()
      const ok = result.enabledIds.length
      const fail = result.failedIds.length
      if (ok > 0 && fail === 0) toast.success(`已为 ${ok} 个凭据开启超额`)
      else if (ok > 0) toast.warning(`开启超额：成功 ${ok} 个，失败 ${fail} 个`)
      else toast.warning(`没有成功开启超额，失败 ${fail} 个，跳过 ${result.skippedIds.length} 个`)
      queryClient.invalidateQueries({ queryKey: ['credentials'] })
      setBalanceMap(new Map())
    } catch (error) {
      toast.error('一键开启超额失败: ' + extractErrorMessage(error))
    } finally {
      setEnablingOverage(false)
    }
  }

  // 查询当前页凭据信息（逐个查询，避免瞬时并发）
  const handleQueryCurrentPageInfo = async () => {
    if (currentCredentials.length === 0) {
      toast.error('当前页没有可查询的凭据')
      return
    }

    const ids = currentCredentials
      .filter(credential => !credential.disabled)
      .map(credential => credential.id)

    if (ids.length === 0) {
      toast.error('当前页没有可查询的启用凭据')
      return
    }

    setQueryingInfo(true)
    setQueryInfoProgress({ current: 0, total: ids.length })

    let successCount = 0
    let failCount = 0

    for (let i = 0; i < ids.length; i++) {
      const id = ids[i]

      setLoadingBalanceIds(prev => {
        const next = new Set(prev)
        next.add(id)
        return next
      })

      try {
        const balance = await getCredentialBalance(id)
        successCount++

        setBalanceMap(prev => {
          const next = new Map(prev)
          next.set(id, balance)
          return next
        })
      } catch (error) {
        failCount++
      } finally {
        setLoadingBalanceIds(prev => {
          const next = new Set(prev)
          next.delete(id)
          return next
        })
      }

      setQueryInfoProgress({ current: i + 1, total: ids.length })
    }

    setQueryingInfo(false)

    if (failCount === 0) {
      toast.success(`查询完成：成功 ${successCount}/${ids.length}`)
    } else {
      toast.warning(`查询完成：成功 ${successCount} 个，失败 ${failCount} 个`)
    }
  }

  // 批量验活
  const handleBatchVerify = async () => {
    if (selectedIds.size === 0) {
      toast.error('请先选择要验活的凭据')
      return
    }

    // 初始化状态
    setVerifying(true)
    cancelVerifyRef.current = false
    const ids = Array.from(selectedIds)
    setVerifyProgress({ current: 0, total: ids.length })

    let successCount = 0

    // 初始化结果，所有凭据状态为 pending
    const initialResults = new Map<number, VerifyResult>()
    ids.forEach(id => {
      initialResults.set(id, { id, status: 'pending' })
    })
    setVerifyResults(initialResults)
    setVerifyDialogOpen(true)

    // 开始验活
    for (let i = 0; i < ids.length; i++) {
      // 检查是否取消
      if (cancelVerifyRef.current) {
        toast.info('已取消验活')
        break
      }

      const id = ids[i]

      // 更新当前凭据状态为 verifying
      setVerifyResults(prev => {
        const newResults = new Map(prev)
        newResults.set(id, { id, status: 'verifying' })
        return newResults
      })

      try {
        const balance = await getCredentialBalance(id)
        successCount++

        // 更新为成功状态
        setVerifyResults(prev => {
          const newResults = new Map(prev)
          newResults.set(id, {
            id,
            status: 'success',
            usage: `${balance.currentUsage}/${balance.usageLimit}`
          })
          return newResults
        })
      } catch (error) {
        // 更新为失败状态
        setVerifyResults(prev => {
          const newResults = new Map(prev)
          newResults.set(id, {
            id,
            status: 'failed',
            error: extractErrorMessage(error)
          })
          return newResults
        })
      }

      // 更新进度
      setVerifyProgress({ current: i + 1, total: ids.length })

      // 添加延迟防止封号（最后一个不需要延迟）
      if (i < ids.length - 1 && !cancelVerifyRef.current) {
        await new Promise(resolve => setTimeout(resolve, 2000))
      }
    }

    setVerifying(false)

    if (!cancelVerifyRef.current) {
      toast.success(`验活完成：成功 ${successCount}/${ids.length}`)
    }
  }

  // 取消验活
  const handleCancelVerify = () => {
    cancelVerifyRef.current = true
    setVerifying(false)
  }

  // 切换负载均衡模式
  const handleToggleLoadBalancing = () => {
    const currentMode = loadBalancingData?.mode || 'priority'
    const newMode = currentMode === 'priority' ? 'balanced' : 'priority'

    setLoadBalancingMode(newMode, {
      onSuccess: () => {
        const modeName = newMode === 'priority' ? '优先级模式' : '均衡负载模式'
        toast.success(`已切换到${modeName}`)
      },
      onError: (error) => {
        toast.error(`切换失败: ${extractErrorMessage(error)}`)
      }
    })
  }

  const handleUpdateAutoContinue = (updates: {
    enabled?: boolean
    stopReasonCheckEnabled?: boolean
    doneToolCheckEnabled?: boolean
    maxAttempts?: number
    prompt?: string
  }, successMessage = '自动续写配置已更新') => {
    updateAutoContinueConfig(updates, {
      onSuccess: () => {
        toast.success(successMessage)
      },
      onError: (error) => {
        toast.error(`更新自动续写配置失败: ${extractErrorMessage(error)}`)
      }
    })
  }

  const formatRecordTime = (startedAt: string) => {
    const millis = Number(startedAt)
    if (!Number.isFinite(millis) || millis <= 0) return startedAt || '-'
    return new Date(millis).toLocaleString()
  }

  const formatStopReasons = (reasons: string[]) => {
    if (!reasons.length) return '-'
    return reasons.join(' → ')
  }

  const promptDirty = autoContinuePromptDraft !== (autoContinueData?.prompt ?? '')
  const promptInvalid = autoContinuePromptDraft.trim().length === 0

  const handleSaveAutoContinuePrompt = () => {
    if (promptInvalid) {
      toast.error('续写提示词不能为空')
      return
    }
    handleUpdateAutoContinue({ prompt: autoContinuePromptDraft }, '续写提示词已保存')
  }


  if (isLoading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-background">
        <div className="text-center">
          <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-primary mx-auto mb-4"></div>
          <p className="text-muted-foreground">加载中...</p>
        </div>
      </div>
    )
  }

  if (error) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-background p-4">
        <Card className="w-full max-w-md">
          <CardContent className="pt-6 text-center">
            <div className="text-red-500 mb-4">加载失败</div>
            <p className="text-muted-foreground mb-4">{(error as Error).message}</p>
            <div className="space-x-2">
              <Button onClick={() => refetch()}>重试</Button>
              <Button variant="outline" onClick={handleLogout}>重新登录</Button>
            </div>
          </CardContent>
        </Card>
      </div>
    )
  }

  return (
    <div className="min-h-screen bg-background">
      {/* 顶部导航 */}
      <header className="sticky top-0 z-50 w-full border-b bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/60">
        <div className="container flex min-h-14 flex-wrap items-center justify-between gap-2 px-3 py-2 sm:flex-nowrap sm:px-4 md:px-8">
          <div className="flex min-w-0 items-center gap-2">
            <Server className="h-5 w-5" />
            <span className="font-semibold">Kiro Admin</span>
          </div>
          <div className="flex min-w-0 flex-1 items-center justify-end gap-1 sm:gap-2">
            <Button
              variant="outline"
              size="sm"
              onClick={handleToggleLoadBalancing}
              disabled={isLoadingMode || isSettingMode}
              title="切换负载均衡模式"
              className="min-w-0 max-w-[9rem] px-2 text-xs sm:max-w-none sm:px-3 sm:text-sm"
            >
              {isLoadingMode ? '加载中...' : (loadBalancingData?.mode === 'priority' ? '优先级模式' : '均衡负载')}
            </Button>
            <Button variant="ghost" size="icon" onClick={toggleDarkMode} className="h-9 w-9 shrink-0 sm:h-10 sm:w-10">
              {darkMode ? <Sun className="h-5 w-5" /> : <Moon className="h-5 w-5" />}
            </Button>
            <Button variant="ghost" size="icon" onClick={handleRefresh} className="h-9 w-9 shrink-0 sm:h-10 sm:w-10">
              <RefreshCw className="h-5 w-5" />
            </Button>
            <Button variant="ghost" size="icon" onClick={handleLogout} className="h-9 w-9 shrink-0 sm:h-10 sm:w-10">
              <LogOut className="h-5 w-5" />
            </Button>
          </div>
        </div>
        <div className="container flex min-h-11 items-center gap-2 overflow-x-auto border-t px-3 py-1.5 sm:px-4 md:px-8">
          <Button
            variant={activeTab === 'credentials' ? 'default' : 'ghost'}
            size="sm"
            className="shrink-0"
            onClick={() => setActiveTab('credentials')}
          >凭证管理</Button>
          <Button
            variant={activeTab === 'requests' ? 'default' : 'ghost'}
            size="sm"
            className="shrink-0"
            onClick={() => setActiveTab('requests')}
          >请求</Button>
          <Button
            variant={activeTab === 'settings' ? 'default' : 'ghost'}
            size="sm"
            className="shrink-0"
            onClick={() => setActiveTab('settings')}
          >设置</Button>
        </div>
      </header>

      {/* 主内容 */}
      <main className="container mx-auto px-3 py-4 sm:px-4 sm:py-6 md:px-8">
        {activeTab === 'settings' ? (
        <>
        <div className="grid gap-4 md:grid-cols-2 mb-6">
          <Card>
            <CardHeader className="p-4 sm:p-6">
              <CardTitle className="text-base">自动续写设置</CardTitle>
            </CardHeader>
            <CardContent className="space-y-4 px-4 pb-4 sm:px-6 sm:pb-6">
              <div className="flex flex-col gap-3 rounded-md border p-3 sm:flex-row sm:items-center sm:justify-between">
                <div>
                  <div className="font-medium">续写开关</div>
                  <div className="text-sm text-muted-foreground">控制后端自动续写功能，切换后即时生效</div>
                </div>
                <Switch
                  checked={autoContinueData?.enabled ?? true}
                  disabled={isLoadingAutoContinue || isUpdatingAutoContinue}
                  onCheckedChange={(enabled) => handleUpdateAutoContinue({ enabled })}
                />
              </div>
              <div className="flex flex-col gap-3 rounded-md border p-3 sm:flex-row sm:items-center sm:justify-between">
                <div>
                  <div className="font-medium">stop_reason 判断</div>
                  <div className="text-sm text-muted-foreground">优先判断 max_tokens / end_turn，只有 max_tokens 才允许续写</div>
                </div>
                <Switch
                  checked={autoContinueData?.stopReasonCheckEnabled ?? true}
                  disabled={isLoadingAutoContinue || isUpdatingAutoContinue || !(autoContinueData?.enabled ?? true)}
                  onCheckedChange={(stopReasonCheckEnabled) => handleUpdateAutoContinue({ stopReasonCheckEnabled })}
                />
              </div>
              <div className="flex flex-col gap-3 rounded-md border p-3 sm:flex-row sm:items-center sm:justify-between">
                <div>
                  <div className="font-medium">结束工具判断</div>
                  <div className="text-sm text-muted-foreground">当 stop_reason 为 max_tokens 时，再用 auto_continue_done 作为二级结束信号</div>
                </div>
                <Switch
                  checked={autoContinueData?.doneToolCheckEnabled ?? true}
                  disabled={isLoadingAutoContinue || isUpdatingAutoContinue || !(autoContinueData?.enabled ?? true)}
                  onCheckedChange={(doneToolCheckEnabled) => handleUpdateAutoContinue({ doneToolCheckEnabled })}
                />
              </div>
            </CardContent>
          </Card>
          <Card>
            <CardHeader className="p-4 sm:p-6">
              <CardTitle className="text-base">续写参数</CardTitle>
            </CardHeader>
            <CardContent className="space-y-4 px-4 pb-4 sm:px-6 sm:pb-6">
              <div className="space-y-2">
                <label className="text-sm font-medium">续写次数</label>
                <input
                  className="w-full rounded-md border bg-background px-3 py-2 text-sm"
                  type="number"
                  min={1}
                  max={20}
                  value={autoContinueData?.maxAttempts ?? 3}
                  disabled={isLoadingAutoContinue || isUpdatingAutoContinue}
                  onChange={(e) => handleUpdateAutoContinue({ maxAttempts: Number(e.target.value) })}
                />
              </div>
              <div className="space-y-2">
                <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between sm:gap-3">
                  <label className="text-sm font-medium">续写提示词</label>
                  <div className="flex items-center gap-2">
                    {promptDirty && <span className="text-xs text-muted-foreground">未保存</span>}
                    <Button
                      type="button"
                      size="sm"
                      onClick={handleSaveAutoContinuePrompt}
                      disabled={isLoadingAutoContinue || isUpdatingAutoContinue || !promptDirty || promptInvalid}
                    >
                      保存
                    </Button>
                  </div>
                </div>
                <textarea
                  className="min-h-28 w-full rounded-md border bg-background px-3 py-2 text-sm"
                  value={autoContinuePromptDraft}
                  disabled={isLoadingAutoContinue || isUpdatingAutoContinue}
                  onChange={(e) => setAutoContinuePromptDraft(e.target.value)}
                />
                {promptInvalid && (
                  <p className="text-xs text-destructive">续写提示词不能为空</p>
                )}
              </div>
            </CardContent>
          </Card>
        </div>
        </>
        ) : activeTab === 'credentials' ? (
        <>
        {/* 统计卡片 */}
        <div className="grid gap-4 md:grid-cols-3 mb-6">
          <Card>
            <CardHeader className="p-4 pb-2 sm:p-6 sm:pb-2">
              <CardTitle className="text-sm font-medium text-muted-foreground">
                凭据总数
              </CardTitle>
            </CardHeader>
            <CardContent className="px-4 pb-4 sm:px-6 sm:pb-6">
              <div className="text-2xl font-bold">{data?.total || 0}</div>
            </CardContent>
          </Card>
          <Card>
            <CardHeader className="p-4 pb-2 sm:p-6 sm:pb-2">
              <CardTitle className="text-sm font-medium text-muted-foreground">
                可用凭据
              </CardTitle>
            </CardHeader>
            <CardContent className="px-4 pb-4 sm:px-6 sm:pb-6">
              <div className="text-2xl font-bold text-green-600">{data?.available || 0}</div>
            </CardContent>
          </Card>
          <Card>
            <CardHeader className="p-4 pb-2 sm:p-6 sm:pb-2">
              <CardTitle className="text-sm font-medium text-muted-foreground">
                当前活跃
              </CardTitle>
            </CardHeader>
            <CardContent className="px-4 pb-4 sm:px-6 sm:pb-6">
              <div className="flex flex-wrap items-center gap-2 text-2xl font-bold">
                #{data?.currentId || '-'}
                <Badge variant="success">活跃</Badge>
              </div>
            </CardContent>
          </Card>
        </div>

        {/* 凭据列表 */}
        <div className="space-y-4">
          <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
            <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:gap-4">
              <h2 className="text-xl font-semibold">凭据管理</h2>
              {selectedIds.size > 0 && (
                <div className="flex flex-wrap items-center gap-2">
                  <Badge variant="secondary">已选择 {selectedIds.size} 个</Badge>
                  <Button onClick={deselectAll} size="sm" variant="ghost">
                    取消选择
                  </Button>
                </div>
              )}
            </div>
            <div className="grid grid-cols-2 gap-2 lg:flex lg:flex-wrap lg:justify-end">
              {selectedIds.size > 0 && (
                <>
                  <Button onClick={handleBatchVerify} size="sm" variant="outline" className="min-w-0 px-2 lg:w-auto lg:px-3">
                    <CheckCircle2 className="h-4 w-4 mr-2" />
                    批量验活
                  </Button>
                  <Button
                    onClick={handleBatchForceRefresh}
                    size="sm"
                    variant="outline"
                    disabled={batchRefreshing}
                    className="min-w-0 px-2 lg:w-auto lg:px-3"
                  >
                    <RefreshCw className={`h-4 w-4 mr-2 ${batchRefreshing ? 'animate-spin' : ''}`} />
                    {batchRefreshing ? `刷新中... ${batchRefreshProgress.current}/${batchRefreshProgress.total}` : '批量刷新 Token'}
                  </Button>
                  <Button onClick={handleBatchResetFailure} size="sm" variant="outline" className="min-w-0 px-2 lg:w-auto lg:px-3">
                    <RotateCcw className="h-4 w-4 mr-2" />
                    恢复异常
                  </Button>
                  <Button
                    onClick={handleBatchDelete}
                    size="sm"
                    variant="destructive"
                    disabled={selectedDisabledCount === 0}
                    title={selectedDisabledCount === 0 ? '只能删除已禁用凭据' : undefined}
                    className="min-w-0 px-2 lg:w-auto lg:px-3"
                  >
                    <Trash2 className="h-4 w-4 mr-2" />
                    批量删除
                  </Button>
                </>
              )}
              {verifying && !verifyDialogOpen && (
                <Button onClick={() => setVerifyDialogOpen(true)} size="sm" variant="secondary" className="min-w-0 px-2 lg:w-auto lg:px-3">
                  <CheckCircle2 className="h-4 w-4 mr-2 animate-spin" />
                  验活中... {verifyProgress.current}/{verifyProgress.total}
                </Button>
              )}
              {data?.credentials && data.credentials.length > 0 && (
                <Button
                  onClick={handleQueryCurrentPageInfo}
                  size="sm"
                  variant="outline"
                  disabled={queryingInfo}
                  className="min-w-0 px-2 lg:w-auto lg:px-3"
                >
                  <RefreshCw className={`h-4 w-4 mr-2 ${queryingInfo ? 'animate-spin' : ''}`} />
                  {queryingInfo ? `查询中... ${queryInfoProgress.current}/${queryInfoProgress.total}` : '查询信息'}
                </Button>
              )}
              {data?.credentials && data.credentials.length > 0 && (
                <Button
                  onClick={handleEnableOverageAll}
                  size="sm"
                  variant="outline"
                  disabled={enablingOverage || overageRetryableCount === 0}
                  title={overageRetryableCount === 0 ? `全部 ${overageStats.enabled} 个可超额凭据均已开启` : `已开 ${overageStats.enabled} 个 / 未开 ${overageStats.disabledOff} 个 / 待确定 ${overageStats.unknown} 个`}
                  className="min-w-0 px-2 lg:w-auto lg:px-3"
                >
                  <Zap className={`h-4 w-4 mr-2 ${enablingOverage ? 'animate-pulse' : ''}`} />
                  {overageRetryableCount === 0
                    ? `全部已开启超额（${overageStats.enabled}）`
                    : overageEnableableCount > 0
                      ? `一键开启超额（${overageEnableableCount}）`
                      : `重试超额状态（${overageStats.unknown}）`}
                </Button>
              )}
              {data?.credentials && data.credentials.length > 0 && (
                <Button
                  onClick={handleDisableQuotaExceeded}
                  size="sm"
                  variant="outline"
                  disabled={disablingQuota || quotaExceededCount === 0}
                  className="min-w-0 px-2 lg:w-auto lg:px-3"
                >
                  <AlertTriangle className="h-4 w-4 mr-2" />
                  一键超额禁用 ({quotaExceededCount})
                </Button>
              )}
              {data?.credentials && data.credentials.length > 0 && (
                <Button
                  onClick={handleClearAll}
                  size="sm"
                  variant="outline"
                  disabled={disabledCredentialCount === 0}
                  title={disabledCredentialCount === 0 ? '没有可清除的已禁用凭据' : undefined}
                  className="min-w-0 px-2 text-destructive hover:text-destructive lg:w-auto lg:px-3"
                >
                  <Trash2 className="h-4 w-4 mr-2" />
                  清除已禁用
                </Button>
              )}
              <Button onClick={() => setKamImportDialogOpen(true)} size="sm" variant="outline" className="min-w-0 px-2 lg:w-auto lg:px-3">
                <FileUp className="h-4 w-4 mr-2" />
                <span className="truncate">Kiro Account Manager 导入</span>
              </Button>
              <Button onClick={() => setBatchImportDialogOpen(true)} size="sm" variant="outline" className="min-w-0 px-2 lg:w-auto lg:px-3">
                <Upload className="h-4 w-4 mr-2" />
                批量导入
              </Button>
              <Button onClick={() => setAddDialogOpen(true)} size="sm" className="min-w-0 px-2 lg:w-auto lg:px-3">
                <Plus className="h-4 w-4 mr-2" />
                添加凭据
              </Button>
            </div>
          </div>
          {data?.credentials.length === 0 ? (
            <Card>
              <CardContent className="py-8 text-center text-muted-foreground">
                暂无凭据
              </CardContent>
            </Card>
          ) : (
            <>
              <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
                {currentCredentials.map((credential) => (
                  <CredentialCard
                    key={credential.id}
                    credential={credential}
                    onViewBalance={handleViewBalance}
                    selected={selectedIds.has(credential.id)}
                    onToggleSelect={() => toggleSelect(credential.id)}
                    balance={balanceMap.get(credential.id) || null}
                    loadingBalance={loadingBalanceIds.has(credential.id)}
                    onBalanceUpdated={handleBalanceUpdated}
                  />
                ))}
              </div>

              {/* 分页控件 */}
              {totalPages > 1 && (
                <div className="mt-6 flex flex-col items-stretch justify-center gap-3 sm:flex-row sm:items-center sm:gap-4">
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => setCurrentPage(p => Math.max(1, p - 1))}
                    disabled={currentPage === 1}
                  >
                    上一页
                  </Button>
                  <span className="text-center text-sm text-muted-foreground">
                    第 {currentPage} / {totalPages} 页（共 {data?.credentials.length} 个凭据）
                  </span>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => setCurrentPage(p => Math.min(totalPages, p + 1))}
                    disabled={currentPage === totalPages}
                  >
                    下一页
                  </Button>
                </div>
              )}
            </>
          )}
        </div>
        </>
        ) : (
          <div className="space-y-4">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <h2 className="text-xl font-semibold">请求记录</h2>
              <div className="grid w-full grid-cols-2 gap-2 sm:w-auto sm:grid-cols-[auto_auto_auto] sm:items-center sm:gap-3">
                <Badge variant="secondary">{autoContinueRequests.length} 条</Badge>
                <div
                  className="flex items-center justify-between gap-2 rounded-md border px-3 py-1.5 sm:justify-start"
                  title="开启后每 5 秒自动刷新请求记录"
                >
                  <span className="text-sm text-muted-foreground whitespace-nowrap">自动刷新</span>
                  <Switch
                    checked={requestsAutoRefresh}
                    onCheckedChange={setRequestsAutoRefresh}
                    aria-label="请求记录自动刷新开关"
                  />
                </div>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => refetchAutoContinueRequests()}
                  disabled={isFetchingAutoContinueRequests}
                  className="min-w-0 px-2 sm:w-auto sm:px-3"
                >
                  <RefreshCw className={`h-4 w-4 mr-2 ${isFetchingAutoContinueRequests ? 'animate-spin' : ''}`} />
                  手动刷新
                </Button>
              </div>
            </div>
            <Card>
              <CardContent className="overflow-x-auto p-0">
                <table className="w-full min-w-[720px] text-sm">
                  <thead className="border-b bg-muted/40">
                    <tr>
                      <th className="px-4 py-3 text-left font-medium">时间</th>
                      <th className="px-4 py-3 text-left font-medium">输入 Token</th>
                      <th className="px-4 py-3 text-left font-medium">输出 Token</th>
                      <th className="px-4 py-3 text-left font-medium">耗时</th>
                      <th className="px-4 py-3 text-left font-medium">续写次数</th>
                      <th className="px-4 py-3 text-left font-medium">所有结束信号</th>
                    </tr>
                  </thead>
                  <tbody>
                    {isLoadingAutoContinueRequests ? (
                      <tr><td className="px-4 py-6 text-center text-muted-foreground" colSpan={6}>加载中...</td></tr>
                    ) : autoContinueRequests.length === 0 ? (
                      <tr><td className="px-4 py-6 text-center text-muted-foreground" colSpan={6}>暂无请求记录</td></tr>
                    ) : autoContinueRequests.map((record) => (
                      <tr key={record.id} className="border-b last:border-0">
                        <td className="px-4 py-3 whitespace-nowrap">{formatRecordTime(record.startedAt)}</td>
                        <td className="px-4 py-3">{record.inputTokens}</td>
                        <td className="px-4 py-3">{record.outputTokens}</td>
                        <td className="px-4 py-3">{record.durationMs} ms</td>
                        <td className="px-4 py-3">{record.continuationCount}</td>
                        <td className="px-4 py-3 min-w-64">
                          <div>{formatStopReasons(record.stopReasons)}</div>
                          <div className="mt-1 flex gap-2 text-xs text-muted-foreground">
                            <span>结束工具: {record.doneMarkerFound ? '是' : '否'}</span>
                            <span>工具调用: {record.hasToolUse ? '是' : '否'}</span>
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </CardContent>
            </Card>
          </div>
        )}
      </main>

      {/* 余额对话框 */}
      <BalanceDialog
        credentialId={selectedCredentialId}
        open={balanceDialogOpen}
        onOpenChange={setBalanceDialogOpen}
      />

      {/* 添加凭据对话框 */}
      <AddCredentialDialog
        open={addDialogOpen}
        onOpenChange={setAddDialogOpen}
      />

      {/* 批量导入对话框 */}
      <BatchImportDialog
        open={batchImportDialogOpen}
        onOpenChange={setBatchImportDialogOpen}
      />

      {/* KAM 账号导入对话框 */}
      <KamImportDialog
        open={kamImportDialogOpen}
        onOpenChange={setKamImportDialogOpen}
      />

      {/* 批量验活对话框 */}
      <BatchVerifyDialog
        open={verifyDialogOpen}
        onOpenChange={setVerifyDialogOpen}
        verifying={verifying}
        progress={verifyProgress}
        results={verifyResults}
        onCancel={handleCancelVerify}
      />
    </div>
  )
}
