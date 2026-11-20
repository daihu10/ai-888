import { useEffect, useId, useRef, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { CalendarDays, ChevronLeft, ChevronRight, LayoutGrid, Rows3 } from 'lucide-react'
import { api, type TradingPlanScore } from '@/lib/api'
import { QK } from '@/lib/queryKeys'

const control = 'inline-flex h-7 items-center justify-center gap-1 rounded-btn border border-border px-2 text-xs text-secondary hover:bg-elevated focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent disabled:opacity-40'
const levels = [
  { label: '符合模式', range: '9–10分', color: 'bg-red-600 text-white' },
  { label: '需要反省', range: '5–8分', color: 'bg-blue-600 text-white' },
  { label: '亏钱活该', range: '1–4分', color: 'bg-yellow-400 text-yellow-950' },
  { label: '暂无评分', range: '', color: 'border border-slate-300 bg-white text-slate-600' },
]

function levelOf(score: number | null | undefined) {
  return score == null ? levels[3] : score >= 9 ? levels[0] : score >= 5 ? levels[1] : levels[2]
}

function dayLabel(date: string, row?: TradingPlanScore) {
  return `${date} · ${row?.overall_score == null ? row ? '未完成评分' : '暂无计划' : `${row.overall_score.toFixed(1)}分 · ${levelOf(row.overall_score).label}`}`
}

export function ScoreCalendar({ day, disabled, onSelect }: { day: string; disabled: boolean; onSelect: (date: string) => void }) {
  const selectedYear = Number(day.slice(0, 4))
  const [year, setYear] = useState(selectedYear)
  const [expanded, setExpanded] = useState(false)
  const [inspected, setInspected] = useState<string | null>(null)
  const [tabStop, setTabStop] = useState<string | null>(null)
  const scrollRef = useRef<HTMLDivElement>(null)
  const monthRefs = useRef<(HTMLDivElement | null)[]>([])
  const dayRefs = useRef(new Map<string, HTMLButtonElement>())
  const id = useId()
  const scores = useQuery({
    queryKey: QK.tradingPlanScores(year), queryFn: () => api.tradingPlanScores(year), staleTime: 60_000,
  })
  const rows = new Map(scores.data?.rows.map(row => [row.date, row]))
  const focusDate = day.startsWith(`${year.toString().padStart(4, '0')}-`) ? day : `${year.toString().padStart(4, '0')}-01-01`
  useEffect(() => { setYear(selectedYear); setInspected(null) }, [selectedYear])
  useEffect(() => { setTabStop(null); setInspected(null) }, [day, year])
  useEffect(() => {
    if (expanded || !scrollRef.current) return
    const scroll = scrollRef.current
    const alignMonth = () => {
      const month = monthRefs.current[year === selectedYear ? Number(day.slice(5, 7)) - 1 : 11]
      if (month) scroll.scrollLeft = Math.max(0, month.offsetLeft - (scroll.clientWidth - month.clientWidth) / 2)
    }
    alignMonth()
    if (typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(alignMonth)
    observer.observe(scroll)
    return () => observer.disconnect()
  }, [day, year, selectedYear, expanded, scores.isPending])
  function moveFocus(date: string, key: string) {
    const delta = ({ ArrowLeft: -1, ArrowRight: 1, ArrowUp: -7, ArrowDown: 7 } as Record<string, number>)[key]
    if (delta === undefined) return false
    const next = new Date(`${date}T00:00:00Z`)
    next.setUTCDate(next.getUTCDate() + delta)
    if (next.getUTCFullYear() !== year) return true
    const nextDate = next.toISOString().slice(0, 10)
    dayRefs.current.get(nextDate)?.focus()
    return true
  }
  return <section aria-label="交易评分日历" className="min-w-0 rounded-card border border-border bg-surface/70 p-3">
    <div className="flex flex-wrap items-center justify-between gap-2">
      <h2 className="flex items-center gap-2 text-sm font-semibold text-foreground"><CalendarDays aria-hidden="true" className="h-4 w-4 text-accent" />评分日历</h2>
      <div className="flex flex-wrap items-center gap-1.5">
        <button type="button" className={control} aria-label="评分日历上一年" disabled={disabled || year <= 1} onClick={() => { setYear(year - 1); setInspected(null) }}><ChevronLeft aria-hidden="true" className="h-3.5 w-3.5" /></button>
        <span className="min-w-12 text-center font-mono text-xs text-foreground">{year}年</span>
        <button type="button" className={control} aria-label="评分日历下一年" disabled={disabled || year >= 9999} onClick={() => { setYear(year + 1); setInspected(null) }}><ChevronRight aria-hidden="true" className="h-3.5 w-3.5" /></button>
        <button type="button" className={control} aria-expanded={expanded} aria-controls={id} onClick={() => setExpanded(!expanded)}>
          {expanded ? <Rows3 aria-hidden="true" className="h-3.5 w-3.5" /> : <LayoutGrid aria-hidden="true" className="h-3.5 w-3.5" />}{expanded ? '收起月份' : '展开全部月份'}
        </button>
      </div>
    </div>
    <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-2 text-xs text-secondary" aria-label="评分颜色图例">
      {levels.map(level => <span key={level.label} className="inline-flex items-center gap-1.5"><span aria-hidden="true" className={`h-3 w-3 rounded-sm ${level.color}`} />{level.range} {level.label}</span>)}
    </div>
    {scores.isPending ? <p role="status" className="py-10 text-center text-xs text-muted">正在加载 {year} 年评分…</p>
      : scores.isError ? <p role="alert" className="py-6 text-xs text-danger">评分加载失败：{scores.error.message}<button type="button" className={`${control} ml-2`} onClick={() => void scores.refetch()}>重试评分</button></p>
        : <>
          <div ref={scrollRef} id={id} className={`relative mt-3 flex gap-5 px-1 py-2 ${expanded ? 'flex-wrap' : 'overflow-x-auto'}`}>
            {Array.from({ length: 12 }, (_, month) => {
              const yearText = String(year).padStart(4, '0')
              // Explicit ISO dates avoid browser time zones and JS's special treatment of years 0–99.
              const first = new Date(`${yearText}-${String(month + 1).padStart(2, '0')}-01T00:00:00Z`)
              const next = new Date(first)
              next.setUTCMonth(month + 1)
              next.setUTCDate(0)
              const count = next.getUTCDate()
              const offset = (first.getUTCDay() + 6) % 7
              return <div key={`${year}-${month}`} ref={element => { monthRefs.current[month] = element }} className="w-[186px] shrink-0" role="group" aria-label={`${year}年${month + 1}月评分`}>
                <h3 className="mb-2 text-xs font-medium text-foreground">{year}年{month + 1}月</h3>
                <div aria-hidden="true" className="mb-1 grid grid-cols-7 gap-[3px] text-center text-[11px] text-muted">{['一', '二', '三', '四', '五', '六', '日'].map(label => <span key={label}>{label}</span>)}</div>
                <div className="grid grid-cols-7 gap-[3px]">
                  {Array.from({ length: offset }, (_, i) => <span key={`empty-${i}`} aria-hidden="true" />)}
                  {Array.from({ length: count }, (_, i) => {
                    const date = `${yearText}-${String(month + 1).padStart(2, '0')}-${String(i + 1).padStart(2, '0')}`
                    const row = rows.get(date)
                    const label = dayLabel(date, row)
                    return <button key={date} type="button" ref={element => { if (element) dayRefs.current.set(date, element); else dayRefs.current.delete(date) }}
                      data-score-date={date} aria-label={label} title={label} aria-pressed={day === date} disabled={disabled}
                      tabIndex={date === (tabStop ?? focusDate) ? 0 : -1}
                      onMouseEnter={() => setInspected(date)} onFocus={() => { setInspected(date); setTabStop(date) }}
                      onKeyDown={event => { if (moveFocus(date, event.key)) event.preventDefault() }}
                      onClick={() => onSelect(date)}
                      className={`h-6 w-6 rounded text-[11px] font-medium tabular-nums transition-shadow hover:ring-2 hover:ring-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-1 disabled:cursor-not-allowed disabled:opacity-50 ${levelOf(row?.overall_score).color} ${day === date ? 'ring-2 ring-foreground ring-offset-1 ring-offset-surface' : ''}`}>
                      {i + 1}
                    </button>
                  })}
                </div>
              </div>
            })}
          </div>
          <p className="mt-2 text-xs leading-5 text-secondary">{dayLabel(inspected ?? focusDate, rows.get(inspected ?? focusDate))}。点击日期切换计划。</p>
          <p className="text-[11px] leading-5 text-muted">按已保存的三项平均分着色：≥9分为红色，≥5且＜9分为蓝色，＜5分为黄色；未完成评分或暂无计划为白色。</p>
        </>}
  </section>
}
