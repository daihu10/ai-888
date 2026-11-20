// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { ScoreCalendar } from './ScoreCalendar'

const scores = vi.hoisted(() => vi.fn())
vi.mock('@/lib/api', () => ({ api: { tradingPlanScores: scores } }))
let container: HTMLDivElement
let root: Root
let client: QueryClient
const select = vi.fn()
beforeEach(() => {
  vi.clearAllMocks()
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
  scores.mockImplementation(async (year: number) => ({ year, rows: [] }))
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
})
afterEach(async () => {
  await act(async () => root.unmount())
  client.clear()
  container.remove()
})
async function flush() { await act(async () => { await new Promise(resolve => setTimeout(resolve, 15)) }) }
async function render(day = '2024-02-29', disabled = false) {
  await act(async () => root.render(<QueryClientProvider client={client}><ScoreCalendar day={day} disabled={disabled} onSelect={select} /></QueryClientProvider>))
  await flush()
}
function date(day: string) { return container.querySelector<HTMLButtonElement>(`[data-score-date="${day}"]`)! }
function button(label: string) { return [...container.querySelectorAll('button')].find(button => button.getAttribute('aria-label') === label || button.textContent === label)! }
async function click(element: HTMLElement) { await act(async () => element.click()); await flush() }

it('colors saved scores at every boundary, keeping incomplete and missing days white', async () => {
  const values = [1, 4, 4.7, 5, 8, 8.7, 9, 10, null]
  scores.mockResolvedValue({ year: 2024, rows: values.map((score, i) => ({ date: `2024-02-${String(i + 1).padStart(2, '0')}`, overall_score: score })) })
  await render()
  for (const [index, value] of values.entries()) {
    const cell = date(`2024-02-${String(index + 1).padStart(2, '0')}`)
    const color = value == null ? 'white' : value >= 9 ? 'red-600' : value >= 5 ? 'blue-600' : 'yellow-400'
    expect(cell.className).toContain(`bg-${color}`)
    expect(cell.getAttribute('aria-label')).toContain(value == null ? '未完成评分' : `${value.toFixed(1)}分`)
  }
  expect(date('2024-02-10').className).toContain('bg-white')
  expect(date('2024-02-10').getAttribute('aria-label')).toContain('暂无计划')
  expect(container.querySelectorAll('[data-score-date]')).toHaveLength(366)
  expect(date('2024-02-29').getAttribute('aria-pressed')).toBe('true')
  await click(date('2024-02-01'))
  expect(select).toHaveBeenLastCalledWith('2024-02-01')
  await click(date('2024-02-10'))
  expect(select).toHaveBeenLastCalledWith('2024-02-10')
})

it('navigates years and supports leap day keyboard navigation and expansion', async () => {
  await render()
  await act(async () => date('2024-02-29').focus())
  await act(async () => date('2024-02-29').dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true, cancelable: true })))
  expect(document.activeElement).toBe(date('2024-03-01'))
  expect(date('2024-03-01').tabIndex).toBe(0)
  expect(container.textContent).toContain('2024-03-01 · 暂无计划')
  await click(button('展开全部月份'))
  expect(button('收起月份').getAttribute('aria-expanded')).toBe('true')
  await click(button('评分日历下一年'))
  expect(scores).toHaveBeenLastCalledWith(2025)
  expect(container.querySelectorAll('[data-score-date]')).toHaveLength(365)
  expect(date('2025-02-29')).toBeNull()
  await click(date('2025-01-01'))
  expect(select).toHaveBeenLastCalledWith('2025-01-01')
  await render('2026-11-19')
  expect(scores).toHaveBeenLastCalledWith(2026)
  expect(date('2026-11-19').getAttribute('aria-pressed')).toBe('true')
})

it('shows a distinct loading state then an explicit error and retries', async () => {
  let reject!: (reason: Error) => void
  scores.mockReturnValueOnce(new Promise((_, fail) => { reject = fail }))
  await render()
  expect(container.querySelector('[role="status"]')?.textContent).toContain('正在加载 2024 年评分')
  expect(container.querySelectorAll('[data-score-date]')).toHaveLength(0)
  await act(async () => reject(new Error('计划格式异常')))
  await flush()
  expect(container.querySelector('[role="alert"]')?.textContent).toContain('计划格式异常')
  expect(container.querySelectorAll('[data-score-date]')).toHaveLength(0)
  await click(button('重试评分'))
  expect(container.querySelectorAll('[data-score-date]')).toHaveLength(366)
})

it('disables date switching during pending operations and bounds the supported years', async () => {
  await render('0001-01-01', true)
  expect(date('0001-01-01').disabled).toBe(true)
  await click(date('0001-01-02'))
  expect(select).not.toHaveBeenCalled()
  await render('0001-01-01')
  expect(button('评分日历上一年').disabled).toBe(true)
  expect(date('0001-02-28')).not.toBeNull()
  await render('9999-12-31')
  expect(button('评分日历下一年').disabled).toBe(true)
  expect(date('9999-12-31')).not.toBeNull()
})
