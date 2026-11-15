// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { MemoryRouter } from 'react-router-dom'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { Dashboard } from './Dashboard'
import { api, type DataStatus } from '@/lib/api'
import { QK } from '@/lib/queryKeys'

vi.mock('@/lib/api', () => ({ api: {
  dataStatus: vi.fn(),
  quoteStatus: vi.fn(),
  overviewMarket: vi.fn(async () => ({ emotion: { score: 50, label: '中性' } })),
  dataSources: vi.fn(async () => ({})),
  settings: vi.fn(async () => ({ onboarding_completed: true })),
  preferences: vi.fn(async () => ({})),
  capabilities: vi.fn(async () => ({ capabilities: {} })),
  pipelineJobs: vi.fn(async () => ({ active_id: null })),
  pipelineJob: vi.fn(),
  pipelineRun: vi.fn(),
  refreshCache: vi.fn(async () => ({})),
} }))
vi.mock('@/components/dashboard/useDashboardLayout', () => ({
  useDashboardLayout: () => ({ items: [], setItems: () => {} }),
}))
vi.mock('@/components/dashboard/DashboardGrid', () => ({ DashboardGrid: () => null }))
vi.mock('@/components/StockPreviewDialog', () => ({ StockPreviewDialog: () => null }))
vi.mock('@/components/DimensionMembersDialog', () => ({ DimensionMembersDialog: () => null }))
vi.mock('@/components/AdjFactorSyncGate', () => ({
  useAdjFactorSyncGate: () => ({ guard: (run: () => void) => run(), dialog: null }),
}))

let host: HTMLDivElement
let root: Root
let client: QueryClient

beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
  vi.useFakeTimers()
  vi.clearAllMocks()
  vi.mocked(api.quoteStatus).mockResolvedValue({ last_fetch_ms: null } as Awaited<ReturnType<typeof api.quoteStatus>>)
  sessionStorage.clear()
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
})

afterEach(async () => {
  await act(async () => root.unmount())
  client.clear()
  host.remove()
  vi.useRealTimers()
})

const busy = { indicators_ready: true, stats_pending: true, daily: null, enriched: null } as DataStatus

async function render() {
  await act(async () => root.render(
    <MemoryRouter><QueryClientProvider client={client}><Dashboard /></QueryClientProvider></MemoryRouter>,
  ))
  await tick(1)
}

async function tick(ms: number) {
  await act(async () => { await vi.advanceTimersByTimeAsync(ms) })
}

it('同步/修复期不弹获取数据, 完成后自动重查并停止轮询', async () => {
  vi.mocked(api.dataStatus).mockResolvedValueOnce(busy).mockResolvedValue({
    ...busy, stats_pending: false, daily: { trading_days: 240 },
  } as DataStatus)
  await render()
  expect(host.textContent).not.toContain('立即获取数据')
  expect(sessionStorage.getItem('tf_welcome_shown')).toBeNull()

  await tick(5_001)
  expect(api.dataStatus).toHaveBeenCalledTimes(2)
  expect(host.textContent).not.toContain('立即获取数据')
  expect(sessionStorage.getItem('tf_welcome_shown')).toBeNull()
  await tick(10_000)
  expect(api.dataStatus).toHaveBeenCalledTimes(2)
})

it('等统计可用后才为真正无数据的新用户弹出引导', async () => {
  vi.mocked(api.dataStatus).mockResolvedValueOnce(busy).mockResolvedValue({
    ...busy, stats_pending: false,
  })
  await render()
  expect(sessionStorage.getItem('tf_welcome_shown')).toBeNull()
  await tick(5_001)
  expect(host.textContent).toContain('立即获取数据')
  expect(host.textContent).toContain('欢迎首次使用')
  expect(sessionStorage.getItem('tf_welcome_shown')).toBe('1')
})

it('显示行情服务最后拉取时间, 页面重载不改写, 实时行情更新才推进', async () => {
  vi.setSystemTime(new Date('2026-11-15T04:00:00Z'))
  const lastFetch = Date.parse('2026-11-15T01:02:03Z')
  vi.mocked(api.quoteStatus).mockResolvedValue({ last_fetch_ms: lastFetch } as Awaited<ReturnType<typeof api.quoteStatus>>)
  vi.mocked(api.dataStatus).mockResolvedValue(busy)
  await render()
  const refreshedAt = () => host.querySelector('time[aria-label^="行情最近成功刷新"]')!
  expect(refreshedAt().textContent).toBe('刷新 09:02:03')
  expect(refreshedAt().getAttribute('datetime')).toBe('2026-11-15T01:02:03.000Z')
  expect(refreshedAt().previousElementSibling?.textContent).toBe('非实时')
  expect(refreshedAt().nextElementSibling?.textContent).toBe('重载')

  await tick(10_000)
  const reload = Array.from(host.querySelectorAll('button')).find(b => b.textContent === '重载')!
  await act(async () => reload.click())
  await tick(1)
  expect(api.refreshCache).toHaveBeenCalledTimes(1)
  expect(refreshedAt().textContent).toBe('刷新 09:02:03')

  // 和 SSE 相同, 只刷新共享行情状态; 不依赖看板请求或浏览器当前时间。
  vi.mocked(api.quoteStatus).mockResolvedValue({ last_fetch_ms: lastFetch + 3_000 } as Awaited<ReturnType<typeof api.quoteStatus>>)
  await act(async () => { await client.invalidateQueries({ queryKey: QK.quoteStatus }) })
  await tick(1)
  expect(refreshedAt().textContent).toBe('刷新 09:02:06')
})

it('行情状态加载中和失败时保留上次实际拉取时间', async () => {
  const lastFetch = Date.parse('2026-11-15T01:02:03Z')
  vi.mocked(api.quoteStatus).mockResolvedValue({ last_fetch_ms: lastFetch } as Awaited<ReturnType<typeof api.quoteStatus>>)
  vi.mocked(api.dataStatus).mockResolvedValue(busy)
  await render()
  const refreshedAt = () => host.querySelector('time[aria-label^="行情最近成功刷新"]')!
  let rejectRefresh!: (error: Error) => void
  vi.mocked(api.quoteStatus).mockImplementationOnce(() => new Promise((_, reject) => { rejectRefresh = reject }))
  await tick(10_000)
  let pending!: Promise<unknown>
  await act(async () => { pending = client.refetchQueries({ queryKey: QK.quoteStatus }) })
  expect(refreshedAt().textContent).toBe('刷新 09:02:03')
  await act(async () => { rejectRefresh(new Error('network failed')); await pending })
  await tick(1)
  expect(refreshedAt().textContent).toBe('刷新 09:02:03')
})

it('没有成功拉取记录时显示空值, 不用页面加载时间代替', async () => {
  vi.mocked(api.dataStatus).mockResolvedValue(busy)
  await render()
  const refreshedAt = host.querySelector('time[aria-label^="行情最近成功刷新"]')!
  expect(refreshedAt.textContent).toBe('刷新 —')
  expect(refreshedAt.hasAttribute('datetime')).toBe(false)
})
