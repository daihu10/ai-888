// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { MemoryRouter } from 'react-router-dom'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { TradingPlanPage } from './Page'
import type { TradingPlan, TradingPlanDraft } from '@/lib/api'

const mockApi = vi.hoisted(() => ({ tradingPlanCalendar: vi.fn(), tradingPlan: vi.fn(), tradingPlanDates: vi.fn(), tradingPlanScores: vi.fn(), saveTradingPlan: vi.fn(), tradingPlanQuotes: vi.fn(), tradingPlanPrices: vi.fn(), syncTradingPlan: vi.fn() }))
const openStockPreview = vi.hoisted(() => vi.fn(() => true))
vi.mock('@/extensions/stockPreview', () => ({ openStockPreview }))
vi.mock('@/lib/api', () => ({ api: mockApi }))
vi.mock('@/components/Toast', () => ({ toast: vi.fn() }))
vi.mock('@/components/financials/StockFinancialSearch', () => ({
  StockFinancialSearch: ({ onSelect }: { onSelect: (symbol: string, name: string) => void }) =>
    <button type="button" onClick={() => onSelect('600000.SH', '浦发银行')}>选择浦发银行</button>,
}))

let container: HTMLDivElement
let root: Root
let queryClient: QueryClient
const testStorage = new Map<string, string>()
const review = () => ({ answer: null, reason: '', stop_loss: '', score: null })
function empty(day = '2026-11-19'): TradingPlan {
  return {
    date: day, schema_version: 1, revision: null, updated_at: null, overall_score: null,
    market_above_ma5: null, matches_mode: null, holdings: [], highest_board_count: null,
    market_sentiment: null,
    limit_up_count: null, limit_down_count: null, core_theme: '', secondary_theme: '', holding_execution: '', target_stocks: '',
    holding_execution_followed: null, target_stocks_followed: null,
    execution_review: review(), ma5_review: review(), ma20_review: review(),
    self_assessment: '',
  }
}
beforeEach(() => {
  vi.clearAllMocks()
  testStorage.clear()
  Object.defineProperty(window, 'localStorage', { configurable: true, value: {
    getItem: (key: string) => testStorage.get(key) ?? null,
    setItem: (key: string, value: string) => { testStorage.set(key, String(value)) },
    removeItem: (key: string) => { testStorage.delete(key) },
  } })
  window.localStorage.setItem('trading-plan-auto-save', 'false')
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date('2026-11-19T15:10:00+08:00'))
  mockApi.tradingPlanCalendar.mockImplementation(async (year: number) => {
    const today = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Shanghai' }).format(new Date())
    const previous = new Date(`${today}T00:00:00Z`)
    previous.setUTCDate(previous.getUTCDate() - 1)
    return { year, today, today_is_trading: true, latest: today, previous: previous.toISOString().slice(0, 10), dates: ['2026-11-18', '2026-11-19'] }
  })
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
  mockApi.tradingPlan.mockImplementation(async (day: string) => empty(day))
  mockApi.tradingPlanDates.mockResolvedValue({ dates: [] })
  mockApi.tradingPlanScores.mockImplementation(async (year: number) => ({ year, rows: [] }))
  mockApi.tradingPlanQuotes.mockResolvedValue({ rows: [] })
  mockApi.tradingPlanPrices.mockResolvedValue({ date: '2026-11-18', rows: [] })
  mockApi.saveTradingPlan.mockImplementation(async (day: string, draft: TradingPlanDraft) => ({ ...empty(day), ...draft, revision: 'saved', updated_at: '2026-11-19T16:00:00+08:00' }))
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  queryClient = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })
})
afterEach(async () => {
  await act(async () => root.unmount())
  queryClient.clear()
  container.remove()
  vi.restoreAllMocks()
  vi.useRealTimers()
})
async function flush() { await act(async () => { await new Promise(resolve => setTimeout(resolve, 15)) }) }
async function render(day?: string) {
  const entry = day ? `/trading-plan?date=${day}` : '/trading-plan'
  await act(async () => root.render(<QueryClientProvider client={queryClient}><MemoryRouter initialEntries={[entry]}><TradingPlanPage /></MemoryRouter></QueryClientProvider>))
  await flush()
  // Calendar resolution enables the plan request, which can in turn request prices.
  await flush()
  await flush()
}
function button(text: string) { return [...container.querySelectorAll('button')].find(b => b.textContent === text)! }
async function click(element: HTMLElement) { await act(async () => element.click()); await flush() }
async function selectDate(day: string, label = '计划日期') {
  await click(container.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`)!)
  const popup = document.body.querySelector('button[aria-label="上个月"]')!.parentElement!.parentElement!
  const dateButton = [...popup.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent?.trim() === String(Number(day.slice(8))))!
  await click(dateButton)
}
async function change(element: HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement, value: string) {
  await act(async () => {
    const proto = element.tagName === 'SELECT' ? HTMLSelectElement.prototype : element.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype
    Object.getOwnPropertyDescriptor(proto, 'value')!.set!.call(element, value)
    element.dispatchEvent(new Event(element.tagName === 'SELECT' ? 'change' : 'input', { bubbles: true }))
  })
  await flush()
}

it('adds holdings once, edits stop loss and saves all three scores with the draft', async () => {
  await render()
  expect(mockApi.tradingPlanQuotes).not.toHaveBeenCalled()
  expect(mockApi.tradingPlanPrices).not.toHaveBeenCalled()
  expect(container.textContent).toContain('待完成')
  const toolbar = container.querySelector('[role="toolbar"]')!
  expect(toolbar.querySelector('button[aria-label="计划日期"]')).not.toBeNull()
  const toolbarButtons = [...toolbar.querySelectorAll('button')]
  const yesterdayIndex = toolbarButtons.findIndex(item => item.textContent === '昨天')
  expect(toolbarButtons[yesterdayIndex - 1]?.getAttribute('aria-label')).toBe('计划日期')
  expect(toolbarButtons[yesterdayIndex + 1]?.textContent).toBe('今天')
  expect(toolbar.querySelector('select[aria-label="历史计划"]')).not.toBeNull()
  expect(toolbar.contains(button('保存计划'))).toBe(true)
  expect(container.querySelectorAll('button[type="submit"]')).toHaveLength(1)
  const downCount = [...container.querySelectorAll<HTMLInputElement>('input[type="number"]')].find(input => input.closest('label')?.textContent === '跌停数')!
  expect(downCount.value).toBe('')
  await change(downCount, '12')
  await click(button('选择浦发银行'))
  await click(button('选择浦发银行'))
  expect(container.textContent).toContain('持仓标的 · 1 只')
  expect(container.textContent).toContain('浦发银行已在持仓标的中')
  for (const [days, answer] of [[5, 0], [10, 1], [20, 0]]) {
    await click(container.querySelectorAll<HTMLInputElement>(`fieldset[aria-label="浦发银行是否在${days}天线上"] input`)[answer])
  }
  const stop = container.querySelector<HTMLInputElement>('input[aria-label="浦发银行 · 止损线"]')!
  expect(stop.type).toBe('number')
  expect(stop.step).toBe('0.01')
  await act(async () => stop.focus())
  await change(stop, '10.2')
  expect(stop.value).toBe('10.2')
  await act(async () => stop.blur())
  expect(stop.value).toBe('10.20')
  await change(container.querySelector<HTMLTextAreaElement>('textarea[aria-label="浦发银行 · 明日计划"]')!, '回踩5日线加仓')
  await click(container.querySelectorAll<HTMLInputElement>('fieldset[aria-label="浦发银行 · 是否执行计划"] input')[1])
  const scores = container.querySelectorAll<HTMLSelectElement>('select[aria-label$="评分"]')
  for (const [index, value] of ['10', '8', '7'].entries()) await change(scores[index], value)
  expect(container.textContent).toContain('8.3 / 10')
  await click(button('保存计划'))
  expect(mockApi.saveTradingPlan).toHaveBeenCalledWith('2026-11-19', expect.objectContaining({
    limit_down_count: 12,
    self_assessment: '',
    holdings: [expect.objectContaining({ symbol: '600000.SH', stop_loss: '10.20', tomorrow_plan: '回踩5日线加仓', plan_followed: false, above_ma5: true, above_ma10: false, above_ma20: true })],
    execution_review: expect.objectContaining({ score: 10 }),
    ma5_review: expect.objectContaining({ score: 8 }), ma20_review: expect.objectContaining({ score: 7 }),
  }))
  expect(container.textContent).toContain('已保存')
  expect([...container.querySelectorAll<HTMLInputElement>('input[type="number"]')].find(input => input.closest('label')?.textContent === '跌停数')!.value).toBe('12')
})

it('saves the daily self-assessment and restores it when revisiting that date', async () => {
  const saved = new Map<string, TradingPlan>()
  mockApi.tradingPlan.mockImplementation(async (day: string) => saved.get(day) ?? empty(day))
  mockApi.saveTradingPlan.mockImplementation(async (day: string, draft: TradingPlanDraft) => {
    const plan = { ...empty(day), ...draft, revision: `saved-${day}` }
    saved.set(day, plan)
    return plan
  })
  await render()
  const summary = container.querySelector<HTMLTextAreaElement>('textarea[aria-label="自评与总结"]')!
  await change(summary, '计划执行偏差：追高买入。下次等待回踩确认后再操作。')
  await click(button('保存计划'))
  expect(mockApi.saveTradingPlan).toHaveBeenCalledWith('2026-11-19', expect.objectContaining({
    self_assessment: '计划执行偏差：追高买入。下次等待回踩确认后再操作。',
  }))

  vi.spyOn(window, 'confirm').mockReturnValue(true)
  await selectDate('2026-11-18')
  await selectDate('2026-11-19')
  expect(container.querySelector<HTMLTextAreaElement>('textarea[aria-label="自评与总结"]')!.value)
    .toBe('计划执行偏差：追高买入。下次等待回踩确认后再操作。')
})

it('restores holding plans per date and preserves legacy stop notes until a price is entered', async () => {
  const saved = new Map<string, TradingPlan>()
  mockApi.tradingPlan.mockImplementation(async (day: string) => saved.get(day) ?? { ...empty(day), holdings: [{
    symbol: '600000.SH', name: '浦发银行', above_ma5: null, above_ma10: null, above_ma20: null,
    reason: '', stop_loss: '跌破10元无条件离场',
  }] })
  mockApi.saveTradingPlan.mockImplementation(async (day: string, draft: TradingPlanDraft) => {
    const plan = { ...empty(day), ...draft, revision: `saved-${day}` }
    saved.set(day, plan)
    return plan
  })
  await render()
  const stop = () => container.querySelector<HTMLInputElement>('input[aria-label="浦发银行 · 止损线"]')!
  const tomorrow = () => container.querySelector<HTMLTextAreaElement>('textarea[aria-label="浦发银行 · 明日计划"]')!
  expect(stop().value).toBe('')
  expect(container.textContent).toContain('原止损说明：跌破10元无条件离场')
  await act(async () => { stop().focus(); stop().blur() })
  await change(tomorrow(), '回踩5日线加仓')
  await click(container.querySelector<HTMLInputElement>('fieldset[aria-label="浦发银行 · 是否执行计划"] input')!)
  await click(button('保存计划'))
  expect(saved.get('2026-11-19')!.holdings[0]).toMatchObject({
    tomorrow_plan: '回踩5日线加仓', plan_followed: true, stop_loss: '跌破10元无条件离场',
  })
  await click(button('昨天'))
  expect(tomorrow().value).toBe('')
  expect(container.querySelector('fieldset[aria-label="浦发银行 · 是否执行计划"] input:checked')).toBeNull()
  await click(button('今天'))
  expect(tomorrow().value).toBe('回踩5日线加仓')
  expect(container.querySelector<HTMLInputElement>('fieldset[aria-label="浦发银行 · 是否执行计划"] input')!.checked).toBe(true)
  await act(async () => stop().focus())
  await change(stop(), '9.125')
  await act(async () => stop().blur())
  expect(stop().value).toBe('9.13')
  expect(container.textContent).not.toContain('原止损说明：')
})

it('keeps the manual stop price and holding plan when sync has no valid MA5 price', async () => {
  window.localStorage.removeItem('trading-plan-auto-save')
  mockApi.tradingPlan.mockResolvedValueOnce({ ...empty(), holdings: [{
    symbol: '600000.SH', name: '浦发银行', above_ma5: true, above_ma10: null, above_ma20: null,
    reason: '', stop_loss: '9.00', tomorrow_plan: '等待突破', plan_followed: false,
  }] })
  mockApi.syncTradingPlan.mockResolvedValueOnce({ date: '2026-11-19', rows: [{
    symbol: '600000.SH', price: 10, ma5_price: null, above_ma5: null, above_ma10: true, above_ma20: true,
    quote_freshness: { state: 'live', data_date: '2026-11-19' }, issues: ['无法计算5日均线价格，保留原有止损线'],
  }] })
  await render()
  const stop = container.querySelector<HTMLInputElement>('input[aria-label="浦发银行 · 止损线"]')!
  await act(async () => stop.focus())
  await change(stop, '9.2')
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 600)) })
  expect(mockApi.saveTradingPlan).not.toHaveBeenCalled()
  await act(async () => stop.blur())
  expect(stop.value).toBe('9.20')
  await click(button('同步'))
  expect(stop.value).toBe('9.20')
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 600)) })
  await flush()
  expect(mockApi.saveTradingPlan).toHaveBeenLastCalledWith('2026-11-19', expect.objectContaining({
    holdings: [expect.objectContaining({ stop_loss: '9.20', above_ma5: true, tomorrow_plan: '等待突破', plan_followed: false })],
  }))
})

it('autosaves by default, remembers the setting, and retains manual save when disabled', async () => {
  window.localStorage.removeItem('trading-plan-auto-save')
  await render()
  const autoSave = () => container.querySelector<HTMLButtonElement>('[role="switch"]')!
  expect(autoSave().getAttribute('aria-checked')).toBe('true')
  expect(autoSave().className).toContain('min-w-[116px]')
  expect(autoSave().querySelector('[aria-hidden="true"]')?.className).toContain('w-8')
  expect(autoSave().querySelector('[aria-hidden="true"] span')?.className).toContain('left-[14px]')

  await change(container.querySelector<HTMLSelectElement>('select[aria-label="市场情绪"]')!, '强势')
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 600)) })
  expect(mockApi.saveTradingPlan).toHaveBeenCalledTimes(1)

  await click(autoSave())
  expect(autoSave().getAttribute('aria-checked')).toBe('false')
  expect(autoSave().querySelector('[aria-hidden="true"] span')?.className).toContain('left-[2px]')
  expect(window.localStorage.getItem('trading-plan-auto-save')).toBe('false')
  await change(container.querySelector<HTMLSelectElement>('select[aria-label="市场情绪"]')!, '震荡')
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 600)) })
  expect(mockApi.saveTradingPlan).toHaveBeenCalledTimes(1)

  await click(button('保存计划'))
  expect(mockApi.saveTradingPlan).toHaveBeenCalledTimes(2)
  expect(mockApi.saveTradingPlan).toHaveBeenLastCalledWith('2026-11-19', expect.objectContaining({ market_sentiment: '震荡' }))
})

it('waits until text editing ends before autosaving multiline text and IME input', async () => {
  window.localStorage.removeItem('trading-plan-auto-save')
  await render()
  const summary = container.querySelector<HTMLTextAreaElement>('textarea[aria-label="自评与总结"]')!
  await act(async () => {
    summary.focus()
    summary.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }))
  })
  await change(summary, '第一行\n第二行输入中')
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 600)) })
  expect(mockApi.saveTradingPlan).not.toHaveBeenCalled()
  expect(document.activeElement).toBe(summary)
  await act(async () => {
    summary.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true }))
  })
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 600)) })
  expect(mockApi.saveTradingPlan).not.toHaveBeenCalled()
  // Moving between text fields remains one editing session.
  const next = container.querySelector<HTMLTextAreaElement>('textarea[aria-label="持股执行"]')!
  await act(async () => { next.focus() })
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 600)) })
  expect(mockApi.saveTradingPlan).not.toHaveBeenCalled()
  await act(async () => { next.blur() })
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 600)) })
  expect(mockApi.saveTradingPlan).toHaveBeenCalledTimes(1)
  expect(mockApi.saveTradingPlan).toHaveBeenLastCalledWith('2026-11-19', expect.objectContaining({ self_assessment: '第一行\n第二行输入中' }))
})

it('keeps editing and focus intact when an earlier autosave finishes, then saves the latest draft with its new revision', async () => {
  window.localStorage.removeItem('trading-plan-auto-save')
  let finish!: (value: TradingPlan) => void
  mockApi.saveTradingPlan.mockImplementationOnce(() => new Promise<TradingPlan>(resolve => { finish = resolve }))
  await render()
  await change(container.querySelector<HTMLSelectElement>('select[aria-label="市场情绪"]')!, '强势')
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 600)) })
  expect(mockApi.saveTradingPlan).toHaveBeenCalledTimes(1)
  const summary = container.querySelector<HTMLTextAreaElement>('textarea[aria-label="自评与总结"]')!
  expect(summary.closest('fieldset[disabled]')).toBeNull()
  await act(async () => { summary.focus() })
  await change(summary, '保存期间继续写入的新内容')
  summary.setSelectionRange(3, 3)
  const submitted = mockApi.saveTradingPlan.mock.calls[0][1] as TradingPlanDraft
  await act(async () => finish({ ...empty(), ...submitted, revision: 'revision-1' }))
  await flush()
  expect(container.querySelector('textarea[aria-label="自评与总结"]')).toBe(summary)
  expect(document.activeElement).toBe(summary)
  expect(summary.selectionStart).toBe(3)
  expect(summary.value).toBe('保存期间继续写入的新内容')
  expect(container.textContent).toContain('有未保存的修改')
  await act(async () => { summary.blur() })
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 600)) })
  expect(mockApi.saveTradingPlan).toHaveBeenCalledTimes(2)
  expect(mockApi.saveTradingPlan).toHaveBeenLastCalledWith('2026-11-19', expect.objectContaining({ revision: 'revision-1', self_assessment: '保存期间继续写入的新内容' }))
})

it('cancels queued autosaves when disabled and retains failed drafts without retry loops', async () => {
  window.localStorage.removeItem('trading-plan-auto-save')
  await render()
  const sentiment = container.querySelector<HTMLSelectElement>('select[aria-label="市场情绪"]')!
  await change(sentiment, '强势')
  await click(container.querySelector<HTMLButtonElement>('[role="switch"]')!)
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 600)) })
  expect(mockApi.saveTradingPlan).not.toHaveBeenCalled()

  mockApi.saveTradingPlan.mockRejectedValueOnce(new Error('网络中断'))
  await click(container.querySelector<HTMLButtonElement>('[role="switch"]')!)
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 600)) })
  await flush()
  expect(mockApi.saveTradingPlan).toHaveBeenCalledTimes(1)
  expect(container.textContent).toContain('保存失败：网络中断')
  expect(sentiment.value).toBe('强势')
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 600)) })
  expect(mockApi.saveTradingPlan).toHaveBeenCalledTimes(1)
  await click(button('保存计划'))
  expect(mockApi.saveTradingPlan).toHaveBeenCalledTimes(2)
  expect(mockApi.saveTradingPlan).toHaveBeenLastCalledWith('2026-11-19', expect.objectContaining({ market_sentiment: '强势' }))
})

it('colors holding names and symbols by the 10-day and 20-day line status', async () => {
  const cases = [
    { symbol: '000001.SZ', name: '双线下方', above_ma10: false, above_ma20: false, color: 'text-green-700' },
    { symbol: '000002.SZ', name: '仅20日线下方', above_ma10: true, above_ma20: false, color: 'text-red-700' },
    { symbol: '000003.SZ', name: '仅10日线下方', above_ma10: false, above_ma20: true, color: 'text-yellow-700' },
    { symbol: '000004.SZ', name: '双线之上', above_ma10: true, above_ma20: true, color: 'text-foreground' },
    { symbol: '000005.SZ', name: '均线未选择', above_ma10: null, above_ma20: null, color: 'text-foreground' },
  ]
  mockApi.tradingPlan.mockResolvedValueOnce({ ...empty(), holdings: cases.map(({ color: _color, ...holding }) => ({
    ...holding, above_ma5: null, reason: '', stop_loss: '',
  })) })
  await render()

  const stockButtons = [...container.querySelectorAll<HTMLButtonElement>('button[title="打开股票详情"]')]
  expect(stockButtons).toHaveLength(cases.length)
  for (const [index, entry] of cases.entries()) {
    const paragraphs = stockButtons[index].querySelectorAll('p')
    expect(paragraphs[0].className).toContain(entry.color)
    expect(paragraphs[1].className).toContain(entry.color)
  }
})

it('highlights both plan and current prices for holdings below a moving average', async () => {
  mockApi.tradingPlan.mockResolvedValueOnce({ ...empty(), holdings: [{
    symbol: '600000.SH', name: '浦发银行', above_ma5: false, above_ma10: false, above_ma20: false, reason: '', stop_loss: '',
  }] })
  mockApi.tradingPlanQuotes.mockResolvedValueOnce({ rows: [{
    symbol: '600000.SH', price: 8.23, quote_freshness: { state: 'live', data_date: '2026-11-19', message: '实时行情' },
  }] })
  await render()

  for (const label of ['计划当日价', '当前价格']) {
    const price = container.querySelector(`[aria-label="${label}"] p.font-mono`)!
    expect(price.className).toContain('font-bold')
    expect(price.className).toContain('text-green-700')
  }
})

it('switches to yesterday with unsaved confirmation, disables yesterday when selected, and handles year boundaries', async () => {
  await render()
  await click(button('选择浦发银行'))
  const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false)
  await click(button('昨天'))
  expect(confirm).toHaveBeenCalledTimes(1)
  expect(mockApi.tradingPlan).toHaveBeenLastCalledWith('2026-11-19')
  expect(container.querySelector('button[aria-label="计划日期"]')?.textContent).toContain('2026-11-19')
  confirm.mockReturnValue(true)
  await click(button('昨天'))
  expect(mockApi.tradingPlan).toHaveBeenLastCalledWith('2026-11-18')
  expect(container.querySelector('button[aria-label="计划日期"]')?.textContent).toContain('2026-11-18')
  expect(button('昨天').disabled).toBe(true)

  vi.setSystemTime(new Date('2027-01-01T10:00:00+08:00'))
  await render('2027-01-01')
  await click(button('昨天'))
  expect(mockApi.tradingPlan).toHaveBeenLastCalledWith('2026-12-31')
  expect(container.querySelector('button[aria-label="计划日期"]')?.textContent).toContain('2026-12-31')
})

it('defaults to and highlights yesterday before 15:10 Beijing time', async () => {
  vi.setSystemTime(new Date('2026-11-19T15:09:00+08:00'))
  await render()
  expect(mockApi.tradingPlan).toHaveBeenLastCalledWith('2026-11-18')
  expect(button('昨天').getAttribute('aria-pressed')).toBe('true')
  expect(button('昨天').className).toContain('ring-accent/40')
  expect(button('今天').getAttribute('aria-pressed')).toBe('false')
})

it('defaults to and highlights today starting at 15:10 Beijing time', async () => {
  vi.setSystemTime(new Date('2026-11-19T15:10:00+08:00'))
  await render()
  expect(mockApi.tradingPlan).toHaveBeenLastCalledWith('2026-11-19')
  expect(button('今天').getAttribute('aria-pressed')).toBe('true')
  expect(button('今天').className).toContain('ring-accent/40')
  expect(button('昨天').getAttribute('aria-pressed')).toBe('false')
})

it.each(['2026-11-23T09:00:00+08:00', '2026-11-23T15:10:00+08:00'])(
  'uses actual trading dates around the Monday cutoff: %s', async timestamp => {
    vi.setSystemTime(new Date(timestamp))
    mockApi.tradingPlanCalendar.mockResolvedValue({ year: 2026, today: '2026-11-23', today_is_trading: true,
      dates: ['2026-11-20', '2026-11-23'], previous: '2026-11-20', latest: '2026-11-23' })
    await render()
    const expected = timestamp.includes('09:00') ? '2026-11-20' : '2026-11-23'
    expect(mockApi.tradingPlan).toHaveBeenLastCalledWith(expected)
    expect(mockApi.tradingPlan).not.toHaveBeenCalledWith('2026-11-22')
    expect(button(expected === '2026-11-20' ? '昨天' : '今天').getAttribute('aria-pressed')).toBe('true')
    await click(button(expected === '2026-11-20' ? '今天' : '昨天'))
    expect(mockApi.tradingPlan).toHaveBeenLastCalledWith(expected === '2026-11-20' ? '2026-11-23' : '2026-11-20')
  },
)

it('uses the latest trading day over a holiday with only one highlighted shortcut', async () => {
  vi.setSystemTime(new Date('2026-10-07T16:00:00+08:00'))
  mockApi.tradingPlanCalendar.mockResolvedValue({ year: 2026, today: '2026-10-07', today_is_trading: false,
    dates: ['2026-09-30'], previous: '2026-09-30', latest: '2026-09-30' })
  await render()
  expect(mockApi.tradingPlan).toHaveBeenLastCalledWith('2026-09-30')
  expect(button('昨天').getAttribute('aria-pressed')).toBe('true')
  expect(button('今天').getAttribute('aria-pressed')).toBe('false')
  expect(button('昨天').title).toContain('2026-09-30')
})

it('does not guess a default date when the calendar fails, and recovers on retry', async () => {
  mockApi.tradingPlanCalendar.mockRejectedValueOnce(new Error('日历不可用'))
  await render()
  expect(mockApi.tradingPlan).not.toHaveBeenCalled()
  expect(container.textContent).toContain('交易日历加载失败')
  await click(button('重试交易日历'))
  expect(mockApi.tradingPlan).toHaveBeenLastCalledWith('2026-11-19')
})

it('saves market sentiment selections per date without adding mode warnings', async () => {
  const saved = new Map<string, TradingPlan>()
  mockApi.tradingPlan.mockImplementation(async (day: string) => saved.get(day) ?? empty(day))
  mockApi.saveTradingPlan.mockImplementation(async (day: string, draft: TradingPlanDraft) => {
    const plan = { ...empty(day), ...draft, revision: String(mockApi.saveTradingPlan.mock.calls.length) }
    saved.set(day, plan)
    return plan
  })
  await render()
  const sentiment = () => container.querySelector<HTMLSelectElement>('select[aria-label="市场情绪"]')!
  expect(sentiment().value).toBe('')
  expect([...sentiment().options].map(option => option.text)).toEqual(['请选择', '强势', '震荡', '弱势'])
  for (const value of ['强势', '震荡', '弱势']) {
    await change(sentiment(), value)
    expect(container.querySelector('[aria-label="模式检查提醒"]')).toBeNull()
    await click(button('保存计划'))
    expect(mockApi.saveTradingPlan).toHaveBeenLastCalledWith('2026-11-19', expect.objectContaining({ market_sentiment: value }))
    expect(sentiment().value).toBe(value)
  }
  await selectDate('2026-11-18')
  expect(sentiment().value).toBe('')
  await selectDate('2026-11-19')
  expect(sentiment().value).toBe('弱势')
})

it('keeps both market themes on one wrapping row with fixed 333px inputs', async () => {
  await render()
  const inputs = [...container.querySelectorAll<HTMLInputElement>('input[placeholder="填写板块或题材"]')]
  expect(inputs).toHaveLength(2)
  const row = inputs[0].closest('div.mt-2')!
  expect(row.className).toContain('flex-wrap')
  expect(row.contains(inputs[1])).toBe(true)
  expect(inputs.map(input => input.parentElement!.className)).toEqual(['w-[333px] max-w-full shrink-0', 'w-[333px] max-w-full shrink-0'])
  expect(inputs.map(input => input.closest('label')?.querySelector('span')?.textContent)).toEqual(['核心主流', '次主流'])
})

it('shows latest quote provenance and opens the host detail with the holding navigation list', async () => {
  mockApi.tradingPlanQuotes.mockResolvedValue({ rows: [{ symbol: '600000.SH', price: 12.36,
    quote_freshness: { state: 'historical', data_date: '2026-11-18', message: '历史行情，按实际数据日期显示' } }] })
  await render()
  await click(button('选择浦发银行'))
  expect(mockApi.tradingPlanQuotes).toHaveBeenCalledWith(['600000.SH'])
  expect(container.textContent).toContain('12.36')
  expect(container.querySelector('[aria-label="当前价格"]')?.textContent).toContain('最近行情2026-11-18')
  await click(container.querySelector<HTMLButtonElement>('button[aria-label="查看浦发银行 600000.SH详情"]')!)
  expect(openStockPreview).toHaveBeenCalledWith({ symbol: '600000.SH', name: '浦发银行', navList: [{ symbol: '600000.SH', name: '浦发银行' }] })
  expect(mockApi.saveTradingPlan).not.toHaveBeenCalled()
})

it('shows selected day close alongside current quotes, isolating historical date caches', async () => {
  mockApi.tradingPlanQuotes.mockResolvedValue({ rows: [{ symbol: '600000.SH', price: 12.36,
    quote_freshness: { state: 'live', data_date: '2026-11-19', message: '实时行情' } }] })
  mockApi.tradingPlanPrices.mockImplementation(async (day: string) => ({ date: day,
    rows: [{ symbol: '600000.SH', price: day === '2026-11-18' ? 11.25 : null, data_date: day === '2026-11-18' ? day : null }] }))
  mockApi.tradingPlan.mockImplementation(async (day: string) => ({ ...empty(day), holdings: [{
    symbol: '600000.SH', name: '浦发银行', above_ma5: false, above_ma10: null, above_ma20: null, reason: '', stop_loss: '',
  }] }))
  await render()
  await flush()
  expect(container.querySelector('[aria-label="计划当日价"]')?.textContent).toContain('12.36实时2026-11-19')
  expect(mockApi.tradingPlanPrices).not.toHaveBeenCalled()
  await selectDate('2026-11-18')
  await flush()
  const historical = () => container.querySelector('[aria-label="计划当日价"]')?.textContent
  expect(historical()).toContain('11.25收盘2026-11-18')
  expect(container.querySelector('[aria-label="当前价格"]')?.textContent).toContain('12.36实时2026-11-19')
  expect(mockApi.tradingPlanPrices).toHaveBeenCalledWith('2026-11-18', ['600000.SH'])
  await selectDate('2026-11-15')
  await flush()
  expect(historical()).toContain('暂无当日行情2026-11-15')
  expect(historical()).not.toContain('11.25')
  expect(container.querySelector('[aria-label="当前价格"]')?.textContent).toContain('12.36')
  expect(container.querySelector<HTMLInputElement>('fieldset[aria-label="浦发银行是否在5天线上"] input:checked')?.closest('label')?.textContent).toContain('否')
})

it('keeps current prices available when historical prices fail and retries independently', async () => {
  mockApi.tradingPlanPrices.mockRejectedValueOnce(new Error('历史读取失败'))
  mockApi.tradingPlanPrices.mockResolvedValueOnce({ date: '2026-11-18', rows: [{ symbol: '600000.SH', price: 11.25, data_date: '2026-11-18' }] })
  mockApi.tradingPlanQuotes.mockResolvedValue({ rows: [{ symbol: '600000.SH', price: 12.36,
    quote_freshness: { state: 'live', data_date: '2026-11-19', message: '实时行情' } }] })
  await render()
  await selectDate('2026-11-18')
  await click(button('选择浦发银行'))
  expect(container.textContent).toContain('计划当日价格加载失败')
  expect(container.querySelector('[aria-label="当前价格"]')?.textContent).toContain('12.36')
  expect(button('保存计划').disabled).toBe(false)
  await click(button('重试当日价格'))
  expect(container.querySelector('[aria-label="计划当日价"]')?.textContent).toContain('11.25收盘')
})

it('keeps the plan editable when quotes fail and retries to show missing prices explicitly', async () => {
  mockApi.tradingPlanQuotes.mockRejectedValueOnce(new Error('行情不可用'))
  await render()
  await click(button('选择浦发银行'))
  expect(container.textContent).toContain('行情加载失败')
  expect(button('保存计划').disabled).toBe(false)
  await click(button('重试行情'))
  expect(container.querySelector('[aria-label="当前价格"]')?.textContent).toContain('暂无行情')
  await click(button('保存计划'))
  expect(mockApi.saveTradingPlan).toHaveBeenCalledTimes(1)
})

it('highlights unsafe answers with reversed non-MA review polarity, preserves them after save and clears corrected warnings', async () => {
  await render()
  const warning = () => container.querySelector('[aria-label="模式检查提醒"]')
  expect(warning()).toBeNull()
  await click(button('选择浦发银行'))
  const groups = [...container.querySelectorAll<HTMLFieldSetElement>('fieldset[aria-label]')]
  expect(groups).toHaveLength(11)
  for (const [index, group] of groups.entries()) {
    const unsafe = group.querySelectorAll<HTMLInputElement>('input[type="radio"]')[group.getAttribute('aria-label')?.includes('是否持有非') ? 0 : 1]
    await click(unsafe)
    expect(unsafe.closest('label')!.className).toContain('border-danger')
    expect(unsafe.className).toContain('accent-danger')
    expect(warning()?.textContent).toContain(`存在不符合模式的交易 ${index + 1} 项`)
  }
  await click(button('保存计划'))
  expect(warning()?.textContent).toBe('存在不符合模式的交易 11 项请认真核对，给出理由！防止下次再犯错！')
  expect(warning()?.closest('header')).not.toBeNull()
  expect(warning()?.className).toContain('trading-plan-danger-frame')
  expect(container.querySelector('aside')?.className).toContain('trading-plan-danger-frame')
  expect(container.querySelector('form')!.contains(warning())).toBe(false)
  expect(container.textContent).toContain('已保存')
  expect(mockApi.saveTradingPlan).toHaveBeenCalledWith('2026-11-19', expect.objectContaining({
    holding_execution_followed: false, target_stocks_followed: false,
    ma5_review: expect.objectContaining({ answer: true }), ma20_review: expect.objectContaining({ answer: true }),
  }))
  for (const group of container.querySelectorAll<HTMLFieldSetElement>('fieldset[aria-label]')) {
    const safe = group.querySelectorAll<HTMLInputElement>('input[type="radio"]')[group.getAttribute('aria-label')?.includes('是否持有非') ? 1 : 0]
    await click(safe)
    expect(safe.closest('label')!.className).not.toContain('border-danger')
    expect(group.querySelector('input:checked')!.closest('label')!.className).not.toContain('border-danger')
  }
  expect(warning()).toBeNull()
  await click(container.querySelectorAll<HTMLInputElement>('fieldset[aria-label="大盘是否在5天线上"] input')[1])
  expect(warning()).not.toBeNull()
  vi.spyOn(window, 'confirm').mockReturnValue(true)
  await selectDate('2026-11-18')
  expect(warning()).toBeNull()
})

it('syncs today prices and MA choices together while retaining missing choices and manual notes', async () => {
  let resolve!: (result: unknown) => void
  mockApi.syncTradingPlan.mockReturnValue(new Promise(done => { resolve = done }))
  await render()
  expect(button('同步').disabled).toBe(true)
  await click(button('选择浦发银行'))
  await click(container.querySelectorAll<HTMLInputElement>('fieldset[aria-label="浦发银行是否在20天线上"] input')[0])
  await change(container.querySelector<HTMLTextAreaElement>('textarea[aria-label="浦发银行 · 持仓理由"]')!, '等待突破')
  await click(button('同步'))
  expect(mockApi.syncTradingPlan).toHaveBeenCalledWith('2026-11-19', ['600000.SH'])
  expect(button('同步中…').matches(':disabled')).toBe(true)
  expect(button('处理中…').disabled).toBe(true)
  expect(container.querySelector<HTMLButtonElement>('[aria-label="计划日期"]')!.disabled).toBe(true)
  await act(async () => resolve({ date: '2026-11-19', rows: [{
    symbol: '600000.SH', price: 8.23, ma5_price: 8.5, above_ma5: false, above_ma10: true, above_ma20: null,
    quote_freshness: { state: 'live', data_date: '2026-11-19', message: '实时行情' },
    issues: ['缺少20日均线数据，保留原有勾选'],
  }] }))
  await flush()
  expect([...container.querySelectorAll<HTMLInputElement>('fieldset[aria-label="浦发银行是否在5天线上"] input')].map(input => input.checked)).toEqual([false, true])
  for (const days of [10, 20]) expect(container.querySelector<HTMLInputElement>(`fieldset[aria-label="浦发银行是否在${days}天线上"] input`)!.checked).toBe(true)
  expect(container.textContent).toContain('8.23')
  expect(container.textContent).toContain('回填 2 项均线判断')
  expect(container.textContent).toContain('缺少20日均线数据')
  expect(container.querySelector<HTMLTextAreaElement>('textarea[aria-label="浦发银行 · 持仓理由"]')!.value).toBe('等待突破')
  expect(mockApi.saveTradingPlan).not.toHaveBeenCalled()
  const stop = container.querySelector<HTMLInputElement>('input[aria-label="浦发银行 · 止损线"]')!
  expect(stop.value).toBe('8.50')
  await act(async () => stop.focus())
  await change(stop, '8.3')
  await act(async () => stop.blur())
  expect(stop.value).toBe('8.30')
  await click(button('保存计划'))
  expect(mockApi.saveTradingPlan).toHaveBeenCalledWith('2026-11-19', expect.objectContaining({
    holdings: [expect.objectContaining({ above_ma5: false, above_ma10: true, above_ma20: true, reason: '等待突破', stop_loss: '8.30' })],
  }))
})

it('keeps MA choices on sync failure and allows retry', async () => {
  mockApi.syncTradingPlan.mockRejectedValueOnce(new Error('本次未取得最新行情'))
  mockApi.syncTradingPlan.mockResolvedValueOnce({ date: '2026-11-19', rows: [] })
  await render()
  await click(button('选择浦发银行'))
  await click(container.querySelector<HTMLInputElement>('fieldset[aria-label="浦发银行是否在5天线上"] input')!)
  await click(button('同步'))
  expect(container.textContent).toContain('同步失败：本次未取得最新行情')
  expect(container.querySelector<HTMLInputElement>('fieldset[aria-label="浦发银行是否在5天线上"] input')!.checked).toBe(true)
  await click(button('同步'))
  expect(mockApi.syncTradingPlan).toHaveBeenCalledTimes(2)
  expect(container.textContent).not.toContain('同步失败：')
})

it('disables syncing historical plans so today quotes cannot overwrite history', async () => {
  await render()
  await selectDate('2026-11-18')
  await click(button('选择浦发银行'))
  expect(button('同步').disabled).toBe(true)
  expect(container.textContent).toContain('仅当天可同步')
  expect(mockApi.syncTradingPlan).not.toHaveBeenCalled()
})

it('preserves unsaved edits when date switching is cancelled and resets after accepting', async () => {
  await render()
  await click(button('选择浦发银行'))
  const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false)
  const date = container.querySelector<HTMLButtonElement>('button[aria-label="计划日期"]')!
  await selectDate('2026-11-20')
  expect(confirm).toHaveBeenCalled()
  expect(container.textContent).toContain('持仓标的 · 1 只')
  expect(date.textContent).toContain('2026-11-19')
  confirm.mockReturnValue(true)
  await selectDate('2026-11-20')
  expect(mockApi.tradingPlan).toHaveBeenLastCalledWith('2026-11-20')
  expect(container.textContent).toContain('持仓标的 · 0 只')
})

it('keeps edits and allows retry after a failed save', async () => {
  mockApi.saveTradingPlan.mockRejectedValueOnce(new Error('磁盘不可写'))
  await render()
  await click(button('选择浦发银行'))
  await click(button('保存计划'))
  expect(container.textContent).toContain('磁盘不可写')
  expect(container.textContent).toContain('持仓标的 · 1 只')
  await click(button('保存计划'))
  expect(mockApi.saveTradingPlan).toHaveBeenCalledTimes(2)
  expect(container.textContent).toContain('已保存')
})

it('blocks editing on load failure and supports retry', async () => {
  mockApi.tradingPlan.mockRejectedValueOnce(new Error('计划版本不兼容'))
  await render()
  expect(container.textContent).toContain('计划版本不兼容')
  expect(button('保存计划').disabled).toBe(true)
  await click(button('重试'))
  expect(container.textContent).toContain('当天暂无计划')
})

it('shows loading without a writable form until the plan arrives', async () => {
  let resolve!: (value: TradingPlan) => void
  mockApi.tradingPlan.mockReturnValue(new Promise<TradingPlan>(done => { resolve = done }))
  await render()
  expect(container.textContent).toContain('正在加载')
  expect(button('保存计划').disabled).toBe(true)
  await act(async () => resolve(empty()))
  await flush()
  expect(container.textContent).toContain('当天暂无计划')
})

it('imports stocks and notes from the selected date, preserving duplicates and leaving MA choices unselected', async () => {
  const holding = { symbol: '600000.SH', name: '浦发银行', above_ma5: true, above_ma10: false, above_ma20: true, reason: '当前理由', stop_loss: '当前止损', tomorrow_plan: '', plan_followed: null }
  mockApi.tradingPlan.mockImplementation(async (day: string) => ({ ...empty(day), holdings: day === '2026-11-19' ? [holding] : [
    { ...holding, reason: '旧理由', stop_loss: '旧止损' },
    { ...holding, symbol: '000001.SZ', name: '平安银行', reason: '历史持仓逻辑', stop_loss: '跌破9元' },
  ], core_theme: day === '2026-11-19' ? '当前题材' : '历史题材' }))
  await render()
  expect(container.querySelector('button[aria-label="导入来源日期"]')!.textContent).toBe('2026-11-18')
  await selectDate('2026-11-17', '导入来源日期')
  await click(button('导入'))
  expect(mockApi.tradingPlan).toHaveBeenLastCalledWith('2026-11-17')
  expect(container.textContent).toContain('已从 2026-11-17 导入 1 只股票，跳过 1 只已有股票')
  expect(container.textContent).toContain('有未保存的修改')
  expect(container.querySelectorAll('fieldset[aria-label^="平安银行是否"] input:checked')).toHaveLength(0)
  expect(mockApi.saveTradingPlan).not.toHaveBeenCalled()
  expect(mockApi.syncTradingPlan).not.toHaveBeenCalled()
  expect(mockApi.tradingPlanQuotes).toHaveBeenLastCalledWith(['000001.SZ', '600000.SH'])
  await click(button('导入'))
  expect(container.textContent).toContain('无需重复导入')
  expect(container.textContent).toContain('持仓标的 · 2 只')
  await click(button('保存计划'))
  expect(mockApi.saveTradingPlan).toHaveBeenCalledWith('2026-11-19', expect.objectContaining({
    core_theme: '当前题材', execution_review: review(),
    holdings: [holding, { symbol: '000001.SZ', name: '平安银行', reason: '历史持仓逻辑', stop_loss: '跌破9元', above_ma5: null, above_ma10: null, above_ma20: null, tomorrow_plan: '', plan_followed: null }],
  }))
})

it('defaults the import date to the previous calendar day across year boundaries and resets when switching plans', async () => {
  await render('2027-01-01')
  expect(container.querySelector('button[aria-label="导入来源日期"]')!.textContent).toBe('2026-12-31')
  await click(button('今天'))
  expect(container.querySelector('button[aria-label="导入来源日期"]')!.textContent).toBe('2026-11-18')
  await click(container.querySelector<HTMLButtonElement>('button[aria-label="导入来源日期"]')!)
  const popup = document.body.querySelector('button[aria-label="上个月"]')!.parentElement!.parentElement!
  expect([...popup.querySelectorAll<HTMLButtonElement>('button')].find(b => b.textContent?.trim() === '19')!.disabled).toBe(true)
})

it('reports an empty source without changing the draft or saving', async () => {
  await render()
  await click(button('选择浦发银行'))
  await click(button('导入'))
  expect(container.textContent).toContain('2026-11-18 没有可导入的持仓标的')
  expect(container.textContent).toContain('持仓标的 · 1 只')
  expect(mockApi.saveTradingPlan).not.toHaveBeenCalled()
})

it('locks editing and date switching while importing, preserves edits after failure and allows retry', async () => {
  let reject!: (error: Error) => void
  await render()
  await click(button('选择浦发银行'))
  const reason = container.querySelector<HTMLTextAreaElement>('textarea[aria-label="浦发银行 · 持仓理由"]')!
  await change(reason, '保留当前理由')
  mockApi.tradingPlan.mockReturnValueOnce(new Promise<TradingPlan>((_, fail) => { reject = fail }))
  await click(button('导入'))
  expect(container.querySelector<HTMLButtonElement>('button[aria-label="计划日期"]')!.disabled).toBe(true)
  expect(container.querySelector<HTMLButtonElement>('button[aria-label="导入来源日期"]')!.disabled).toBe(true)
  expect(container.querySelector<HTMLButtonElement>('button[type="submit"]')!.disabled).toBe(true)
  expect(reason.closest('fieldset[disabled]')).not.toBeNull()
  expect(container.querySelector<HTMLButtonElement>('[data-score-date="2026-11-18"]')!.disabled).toBe(true)
  await act(async () => reject(new Error('历史计划读取失败')))
  await flush()
  expect(container.textContent).toContain('导入失败：历史计划读取失败')
  expect(reason.value).toBe('保留当前理由')
  expect(button('保存计划').disabled).toBe(false)
  await click(button('导入'))
  expect(container.textContent).toContain('没有可导入的持仓标的')
  expect(container.textContent).not.toContain('导入失败')
})

it('rejects importing beyond 100 holdings without partially modifying the draft', async () => {
  await render()
  await click(button('选择浦发银行'))
  mockApi.tradingPlan.mockResolvedValueOnce({ ...empty('2026-11-18'), holdings: Array.from({ length: 100 }, (_, index) => ({
    symbol: `${String(index + 1).padStart(6, '0')}.SZ`, name: `股票${index}`, above_ma5: true, above_ma10: true, above_ma20: true, reason: '', stop_loss: '',
  })) })
  await click(button('导入'))
  expect(container.textContent).toContain('导入后超过100只持仓标的')
  expect(container.textContent).toContain('持仓标的 · 1 只')
  expect(mockApi.saveTradingPlan).not.toHaveBeenCalled()
})

it('switches from a white calendar day while respecting unsaved changes', async () => {
  await render()
  await click(button('选择浦发银行'))
  const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false)
  const date = () => container.querySelector<HTMLButtonElement>('[data-score-date="2026-11-18"]')!
  expect(date().className).toContain('bg-white')
  await click(date())
  expect(confirm).toHaveBeenCalledTimes(1)
  expect(mockApi.tradingPlan).toHaveBeenLastCalledWith('2026-11-19')
  expect(container.textContent).toContain('持仓标的 · 1 只')
  confirm.mockReturnValue(true)
  await click(date())
  expect(mockApi.tradingPlan).toHaveBeenLastCalledWith('2026-11-18')
  expect(container.textContent).toContain('持仓标的 · 0 只')
  expect(date().getAttribute('aria-pressed')).toBe('true')
})

it('refreshes saved calendar scores after save and locks dates during save', async () => {
  let score: number | null = null
  let resolve!: (value: TradingPlan) => void
  mockApi.tradingPlanScores.mockImplementation(async (year: number) => ({ year, rows: [{ date: '2026-11-19', overall_score: score }] }))
  mockApi.saveTradingPlan.mockImplementation((_day: string, draft: TradingPlanDraft) => new Promise<TradingPlan>(done => {
    resolve = value => { score = 9; done({ ...value, ...draft }) }
  }))
  await render()
  const date = () => container.querySelector<HTMLButtonElement>('[data-score-date="2026-11-19"]')!
  for (const select of container.querySelectorAll<HTMLSelectElement>('select[aria-label$="评分"]')) await change(select, '9')
  expect(date().className).toContain('bg-white')
  await click(button('保存计划'))
  expect(date().disabled).toBe(true)
  await act(async () => resolve({ ...empty(), revision: 'saved', overall_score: 9 }))
  await flush()
  expect(mockApi.tradingPlanScores).toHaveBeenCalledTimes(2)
  expect(date().className).toContain('bg-red-600')
  expect(date().getAttribute('aria-label')).toContain('9.0分 · 符合模式')
})
