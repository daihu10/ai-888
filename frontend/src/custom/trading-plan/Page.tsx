import { useEffect, useId, useRef, useState, type ReactNode } from 'react'
import { useSearchParams } from 'react-router-dom'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { AlertTriangle, Import, Loader2, RefreshCw, Save, ShieldAlert, Trash2 } from 'lucide-react'
import { api, type TradingPlan, type TradingPlanDraft, type TradingPlanReview, type TradingPlanQuote, type TradingPlanDayPrice } from '@/lib/api'
import { QK } from '@/lib/queryKeys'
import { fmtAssetPrice } from '@/lib/format'
import { openStockPreview } from '@/extensions/stockPreview'
import { PageHeader } from '@/components/PageHeader'
import { DatePicker } from '@/components/DatePicker'
import { StockFinancialSearch } from '@/components/financials/StockFinancialSearch'
import { toast } from '@/components/Toast'
import { ScoreCalendar } from './ScoreCalendar'

const inputClass = 'w-full min-w-0 rounded-btn border border-border/70 bg-base px-2 py-1.5 text-xs leading-4 text-foreground placeholder:text-muted focus:outline-none focus:ring-2 focus:ring-accent/40'
const buttonClass = 'inline-flex h-8 shrink-0 items-center justify-center gap-1.5 rounded-btn border border-border px-2.5 text-xs transition-colors hover:bg-elevated focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent disabled:opacity-50'
const holdingColumns = 'xl:grid-cols-[110px_repeat(2,108px)_repeat(3,112px)_minmax(0,1fr)_minmax(0,1fr)_28px]'
const reviewColumns = 'lg:grid-cols-[minmax(250px,1fr)_minmax(0,1fr)_minmax(0,1fr)_90px]'
const AUTO_SAVE_KEY = 'trading-plan-auto-save'

function today() {
  return new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date())
}

function defaultPlanDate() {
  const shanghaiTime = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Shanghai', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).format(new Date())
  const currentDay = today()
  return shanghaiTime >= '15:10' ? currentDay : previousDay(currentDay)
}

function previousDay(day: string) {
  const date = new Date(`${day}T00:00:00Z`)
  date.setUTCDate(date.getUTCDate() - 1)
  return date.toISOString().slice(0, 10)
}

function validDate(value: string | null): value is string {
  return !!value && /^\d{4}-\d{2}-\d{2}$/.test(value)
    && !Number.isNaN(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value
}

function draftOf(plan: TradingPlan): TradingPlanDraft {
  const { schema_version: _schema, date: _date, updated_at: _updated, overall_score: _score, ...draft } = plan
  return draft
}

function isTextEntry(target: EventTarget | null) {
  return target instanceof HTMLTextAreaElement || target instanceof HTMLInputElement
    && ['text', 'search', 'number', 'email', 'url', 'tel', 'password'].includes(target.type)
}

function PriceCell({ label, price, status, date, title, valueClassName }: { label: string; price?: number | null; status: string; date?: string | null; title?: string; valueClassName?: string }) {
  return <div aria-label={label} title={title} className="flex items-center justify-between gap-2 xl:block">
    <span className="text-xs text-secondary xl:hidden">{label}</span>
    <div>
      <div className="flex flex-wrap items-center gap-x-1.5">
        <p className={`font-mono text-sm tabular-nums text-foreground ${valueClassName ?? ''}`}>{fmtAssetPrice(price, 'stock')}</p>
        <span className="whitespace-nowrap text-[11px] text-muted">{status}</span>
      </div>
      {date && <p className="mt-0.5 whitespace-nowrap text-[11px] text-muted">{date}</p>}
    </div>
  </div>
}

function HoldingPrice({ quote, loading, error, valueClassName }: { quote?: TradingPlanQuote; loading: boolean; error: boolean; valueClassName?: string }) {
  const freshness = quote?.quote_freshness
  const status = loading ? '加载中…' : error ? '行情加载失败' : !quote || quote.price === null ? '暂无行情'
    : freshness?.state === 'live' ? '实时' : freshness?.state === 'historical' ? '最近行情' : '非实时'
  return <PriceCell label="当前价格" price={quote?.price} status={status} date={freshness?.data_date} title={freshness?.message} valueClassName={valueClassName} />
}

function PlanDayPrice({ day, latest, historical, loading, error, valueClassName }: { day: string; latest?: TradingPlanQuote; historical?: TradingPlanDayPrice; loading: boolean; error: boolean; valueClassName?: string }) {
  const isToday = day === today()
  const price = isToday ? latest?.quote_freshness.data_date === day ? latest.price : null : historical?.price
  const status = loading ? '加载中…' : error ? '价格加载失败' : price == null ? '暂无当日行情'
    : isToday ? latest?.quote_freshness.state === 'live' ? '实时' : latest?.quote_freshness.state === 'historical' ? '最近行情' : '非实时' : '收盘'
  return <PriceCell label="计划当日价" price={price} status={status} date={day} title={isToday ? latest?.quote_freshness.message : '所选计划日期的未复权收盘价'} valueClassName={valueClassName} />
}

function Section({ title, action, extra, children }: { title: string; action?: ReactNode; extra?: ReactNode; children: ReactNode }) {
  return <section className="min-w-0 rounded-r-card border-l-2 border-accent/25 bg-surface/70 px-3 py-2.5">
    <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
      <div className="flex min-w-0 max-w-full flex-wrap items-center gap-2"><h2 className="text-xs font-semibold text-foreground">{title}</h2>{action}</div>
      {extra}
    </div>
    {children}
  </section>
}

function YesNo({ label, displayLabel = label, value, onChange, hideLabel = false, dangerValue = false }: { label: string; displayLabel?: string; value: boolean | null; onChange: (value: boolean) => void; hideLabel?: boolean | 'xl'; dangerValue?: boolean }) {
  const name = useId()
  return <fieldset className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1.5" aria-label={label}>
    <legend className="sr-only">{label}</legend>
    <span aria-hidden="true" className={`text-xs ${value === dangerValue ? 'font-semibold text-red-700 dark:text-red-300' : 'text-secondary'} ${hideLabel === 'xl' ? 'xl:hidden' : hideLabel ? 'lg:hidden' : ''}`}>{displayLabel}</span>
    <div className="flex shrink-0 gap-1.5">
      {[true, false].map(answer => <label key={String(answer)} className={`inline-flex h-7 cursor-pointer items-center gap-1.5 rounded border px-2 text-xs transition-colors ${answer === dangerValue && value === answer
        ? 'border-danger bg-danger/15 font-bold text-red-700 ring-1 ring-danger dark:text-red-300'
        : 'border-border/60 text-secondary has-[:checked]:border-accent/40 has-[:checked]:bg-accent/10 has-[:checked]:text-accent'}`}>
        <input type="radio" name={name} checked={value === answer} onChange={() => onChange(answer)} className={`h-3 w-3 ${answer === dangerValue ? 'accent-danger' : 'accent-accent'}`} />
        {answer ? '是' : '否'}
      </label>)}
    </div>
  </fieldset>
}

function TextField({ label, value, onChange, placeholder, hideLabel = false }: { label: string; value: string; onChange: (value: string) => void; placeholder?: string; hideLabel?: boolean | 'xl' }) {
  return <label className="block min-w-0 space-y-1 text-xs text-secondary">
    <span className={hideLabel === 'xl' ? 'xl:sr-only' : hideLabel ? 'lg:sr-only' : ''}>{label}</span>
    <textarea aria-label={label} value={value} onChange={e => onChange(e.target.value)} maxLength={5000} rows={1} placeholder={placeholder} className={`${inputClass} block min-h-8 resize-y`} />
  </label>
}

function ReviewRow({ title, value, onChange, details = false, dangerValue = false }: { title: string; value: TradingPlanReview; onChange: (value: TradingPlanReview) => void; details?: boolean; dangerValue?: boolean }) {
  return <div className={`grid min-w-0 items-center gap-2 border-t border-border/50 py-2 ${reviewColumns}`}>
      <YesNo label={title} value={value.answer} onChange={answer => onChange({ ...value, answer })} dangerValue={dangerValue} />
    {details ? <>
      <TextField label={`${title} · 持股理由`} hideLabel value={value.reason} onChange={reason => onChange({ ...value, reason })} placeholder="持股理由" />
      <TextField label={`${title} · 什么时候无条件止损`} hideLabel value={value.stop_loss} onChange={stop_loss => onChange({ ...value, stop_loss })} placeholder="无条件止损的价格、时间或条件" />
    </> : <p className="text-xs text-muted lg:col-span-2">按当日实际执行情况评分</p>}
      <label className="min-w-0 text-xs text-secondary">
        <span className="mb-1 block lg:sr-only">{title} · 评分</span>
        <select aria-label={`${title}评分`} className={inputClass} value={value.score ?? ''} onChange={e => onChange({ ...value, score: e.target.value ? Number(e.target.value) : null })}>
          <option value="">未评分</option>
          {Array.from({ length: 10 }, (_, i) => <option key={i + 1} value={i + 1}>{i + 1} 分</option>)}
        </select>
      </label>
  </div>
}

function PlanEditor({ initial, autoSaveEnabled, onDirty, onPending, onNegativeCount, reload }: { initial: TradingPlan; autoSaveEnabled: boolean; onDirty: (value: boolean) => void; onPending: (value: boolean) => void; onNegativeCount: (value: number) => void; reload: () => void }) {
  const [draft, setDraft] = useState(() => draftOf(initial))
  const [feedback, setFeedback] = useState('')
  const [importDate, setImportDate] = useState(() => previousDay(initial.date))
  const [textEditing, setTextEditing] = useState(false)
  const [composing, setComposing] = useState(false)
  const lastAutoSaveAttempt = useRef<string | null>(null)
  const queryClient = useQueryClient()
  const symbols = draft.holdings.map(holding => holding.symbol).sort()
  const quotes = useQuery({
    queryKey: QK.tradingPlanQuotes(symbols), queryFn: () => api.tradingPlanQuotes(symbols),
    enabled: symbols.length > 0,
  })
  const quoteBySymbol = new Map(quotes.data?.rows.map(quote => [quote.symbol, quote]))
  const isHistorical = initial.date !== today()
  const dayPrices = useQuery({
    queryKey: QK.tradingPlanPrices(initial.date, symbols), queryFn: () => api.tradingPlanPrices(initial.date, symbols),
    enabled: isHistorical && symbols.length > 0, staleTime: 60_000,
  })
  const dayPriceBySymbol = new Map(dayPrices.data?.rows.map(price => [price.symbol, price]))
  const dirty = JSON.stringify(draft) !== JSON.stringify(draftOf(initial))
  const negativeCount = [draft.market_above_ma5, draft.matches_mode,
    draft.holding_execution_followed, draft.target_stocks_followed,
    ...draft.holdings.flatMap(holding => [holding.above_ma5, holding.above_ma10, holding.above_ma20]),
    draft.execution_review.answer,
  ].filter(answer => answer === false).length
    + [draft.ma5_review.answer, draft.ma20_review.answer].filter(answer => answer === true).length
  const scores = [draft.execution_review.score, draft.ma5_review.score, draft.ma20_review.score]
  const overall = scores.every((score): score is number => score !== null)
    ? (scores.reduce((sum, score) => sum + score, 0) / 3).toFixed(1) : null
  const save = useMutation({
    mutationFn: ({ snapshot }: { snapshot: TradingPlanDraft; origin: 'manual' | 'auto' }) => api.saveTradingPlan(initial.date, snapshot),
    onSuccess: (plan, { origin }) => {
      // A background save must not replace text entered while the request was in flight.
      setDraft(current => ({ ...current, revision: plan.revision }))
      queryClient.setQueryData(QK.tradingPlan(initial.date), plan)
      void queryClient.invalidateQueries({ queryKey: QK.tradingPlanDates })
      void queryClient.invalidateQueries({ queryKey: QK.tradingPlanScores(Number(initial.date.slice(0, 4))) })
      if (origin === 'manual') toast('交易计划已保存', 'success')
    },
  })
  const sync = useMutation({
    mutationFn: () => api.syncTradingPlan(initial.date, symbols),
    onSuccess: async result => {
      const key = QK.tradingPlanQuotes(symbols)
      await queryClient.cancelQueries({ queryKey: key })
      queryClient.setQueryData<{ rows: TradingPlanQuote[] }>(key, current => ({
        rows: symbols.flatMap(symbol => {
          const latest = result.rows.find(row => row.symbol === symbol && row.price !== null)
          const previous = current?.rows.find(row => row.symbol === symbol)
          return latest ? [latest] : previous ? [previous] : []
        }),
      }))
      const bySymbol = new Map(result.rows.map(row => [row.symbol, row]))
      setDraft(current => ({ ...current, holdings: current.holdings.map(holding => {
        const row = bySymbol.get(holding.symbol)
        if (!row) return holding
        return { ...holding, above_ma5: row.above_ma5 ?? holding.above_ma5,
          above_ma10: row.above_ma10 ?? holding.above_ma10, above_ma20: row.above_ma20 ?? holding.above_ma20 }
      }) }))
    },
  })
  const importHoldings = useMutation({
    mutationFn: async () => {
      if (!validDate(importDate) || importDate >= initial.date) throw new Error('请选择当前计划日期之前的日期')
      const source = await queryClient.fetchQuery({
        queryKey: QK.tradingPlan(importDate), queryFn: () => api.tradingPlan(importDate), staleTime: 0,
      })
      const existing = new Set(draft.holdings.map(holding => holding.symbol))
      const additions = source.holdings.filter(holding => !existing.has(holding.symbol))
      if (draft.holdings.length + additions.length > 100) throw new Error('导入后超过100只持仓标的，请先移除部分股票')
      return { sourceDate: importDate, total: source.holdings.length, additions }
    },
    onSuccess: ({ sourceDate, total, additions }) => {
      if (additions.length > 0) {
        setDraft(current => ({ ...current, holdings: [...current.holdings, ...additions.map(({ symbol, name, reason, stop_loss }) => ({
          symbol, name, reason, stop_loss, above_ma5: null, above_ma10: null, above_ma20: null,
        }))] }))
      }
      setFeedback(total === 0 ? `${sourceDate} 没有可导入的持仓标的，请选择其他日期。`
        : additions.length === 0 ? `${sourceDate} 的股票均已在当前持仓标的中，无需重复导入。`
        : `已从 ${sourceDate} 导入 ${additions.length} 只股票${total > additions.length ? `，跳过 ${total - additions.length} 只已有股票` : ''}，带入持仓理由和止损线。请确认均线状态后保存计划。`)
    },
  })
  const pending = save.isPending || sync.isPending || importHoldings.isPending
  const editingLocked = sync.isPending || importHoldings.isPending || save.isPending && save.variables?.origin === 'manual'
  const { mutate: saveDraft } = save
  useEffect(() => { onDirty(dirty) }, [dirty, onDirty])
  useEffect(() => { onPending(pending) }, [pending, onPending])
  useEffect(() => { onNegativeCount(negativeCount) }, [negativeCount, onNegativeCount])
  useEffect(() => {
    const snapshot = JSON.stringify(draft)
    if (!autoSaveEnabled || !dirty || pending || textEditing || composing || lastAutoSaveAttempt.current === snapshot) return
    const timer = window.setTimeout(() => {
      lastAutoSaveAttempt.current = snapshot
      saveDraft({ snapshot: draft, origin: 'auto' })
    }, 500)
    return () => window.clearTimeout(timer)
  }, [autoSaveEnabled, dirty, draft, pending, textEditing, composing, saveDraft])
  useEffect(() => {
    const warn = (event: BeforeUnloadEvent) => { if (dirty) { event.preventDefault(); event.returnValue = '' } }
    window.addEventListener('beforeunload', warn)
    return () => window.removeEventListener('beforeunload', warn)
  }, [dirty])

  function update<K extends keyof TradingPlanDraft>(key: K, value: TradingPlanDraft[K]) {
    setDraft(current => ({ ...current, [key]: value }))
  }

  return <form id="trading-plan-form" className="space-y-3"
    onFocusCapture={event => { setTextEditing(isTextEntry(event.target)) }}
    onBlurCapture={event => {
      setTextEditing(event.currentTarget.contains(event.relatedTarget) && isTextEntry(event.relatedTarget))
      setComposing(false)
    }}
    onCompositionStartCapture={() => setComposing(true)}
    onCompositionEndCapture={() => setComposing(false)}
    onSubmit={e => { e.preventDefault(); if (!pending) saveDraft({ snapshot: draft, origin: 'manual' }) }}>
      <div className="flex items-center gap-2 text-xs text-muted" role="status">
        <span aria-hidden="true" className={`h-1.5 w-1.5 rounded-full ${dirty ? 'bg-warning' : initial.revision ? 'bg-accent' : 'bg-muted/50'}`} />
        {save.isPending ? '正在保存…' : dirty ? `有未保存的修改${autoSaveEnabled && (textEditing || composing) ? ' · 输入结束并离开输入框后自动保存' : ''}` : initial.updated_at ? `已保存 · ${new Date(initial.updated_at).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false })}` : '当天暂无计划，可以开始填写；支持保存未填完的草稿。'}
      </div>
    {save.isError && <div role="alert" className="rounded-btn border border-danger/30 bg-danger/5 p-2 text-xs text-danger">
      保存失败：{save.error.message}。当前填写内容已保留。
      <button type="button" disabled={pending} className="ml-3 underline" onClick={() => { if (window.confirm('重新加载会丢弃当前未保存的修改，是否继续？')) reload() }}>重新加载已保存版本</button>
    </div>}
    <fieldset disabled={editingLocked} className="min-w-0 space-y-3 disabled:opacity-60">
      <Section title="市场环境" extra={<span className="text-xs text-muted">均线状态手动确认</span>}>
        <div className="flex flex-wrap items-center gap-x-5 gap-y-2">
          <YesNo label="大盘是否在5天线上" value={draft.market_above_ma5} onChange={v => update('market_above_ma5', v)} />
          <YesNo label="是否符合交易模式（大盘在5天线上）" value={draft.matches_mode} onChange={v => update('matches_mode', v)} />
          {(['highest_board_count', 'limit_up_count', 'limit_down_count'] as const).map((key, index) => <label key={key} className="flex w-[140px] min-w-0 items-center gap-2 text-xs text-secondary">
            <span className="shrink-0">{['最高板个数', '涨停板个数', '跌停数'][index]}</span>
            <input type="number" min={0} max={10000} step={1} value={draft[key] ?? ''} className={inputClass} placeholder="—" onChange={e => update(key, e.target.value === '' ? null : Number(e.target.value))} />
          </label>)}
          <label className="flex w-[160px] min-w-0 items-center gap-2 text-xs text-secondary">
            <span className="shrink-0">市场情绪</span>
            <select aria-label="市场情绪" value={draft.market_sentiment ?? ''} className={inputClass} onChange={e => update('market_sentiment', (e.target.value || null) as TradingPlanDraft['market_sentiment'])}>
              <option value="">请选择</option>
              {(['强势', '震荡', '弱势'] as const).map(value => <option key={value} value={value}>{value}</option>)}
            </select>
          </label>
        </div>
        <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-2">
          {(['core_theme', 'secondary_theme'] as const).map((key, index) => <label key={key} className="flex min-w-0 max-w-full items-center gap-3 text-xs text-secondary">
            <span className="w-12 shrink-0">{index === 0 ? '核心主流' : '次主流'}</span>
            <div className="w-[333px] max-w-full shrink-0"><input maxLength={500} value={draft[key]} className={inputClass} placeholder="填写板块或题材" onChange={e => update(key, e.target.value)} /></div>
          </label>)}
        </div>
      </Section>
      <Section title={`持仓标的 · ${draft.holdings.length} 只`} action={<>
        <button type="button" className={`${buttonClass} h-7 border-accent/40 text-accent`} disabled={pending || initial.date !== today() || symbols.length === 0} title="同步当天最新行情并回填5/10/20日线选项，随后请保存计划" onClick={() => sync.mutate()}>
          <RefreshCw aria-hidden="true" className={`h-3.5 w-3.5 ${sync.isPending ? 'animate-spin' : ''}`} />{sync.isPending ? '同步中…' : '同步'}
        </button>
        {initial.date !== today() && <span className="text-xs text-muted">仅当天可同步</span>}
        <div className="flex items-center gap-1.5 border-l border-border pl-2">
          <span className="text-xs text-muted">来源</span>
          <DatePicker ariaLabel="导入来源日期" value={importDate} max={previousDay(initial.date)} onChange={value => { setImportDate(value); importHoldings.reset(); setFeedback('') }} disabled={pending} buttonClassName="h-7" />
          <button type="button" className={`${buttonClass} h-7 border-accent/40 text-accent`} aria-busy={importHoldings.isPending} title="导入所选日期的持仓标的、理由和止损线，已有股票自动跳过" onClick={() => { if (!pending) { setFeedback(''); importHoldings.mutate() } }}>
            {importHoldings.isPending ? <Loader2 aria-hidden="true" className="h-3.5 w-3.5 animate-spin" /> : <Import aria-hidden="true" className="h-3.5 w-3.5" />}{importHoldings.isPending ? '导入中…' : '导入'}
          </button>
        </div>
        <StockFinancialSearch compact ariaLabel="添加持仓标的" assetTypes="stock" onSelect={(symbol, name) => {
          if (draft.holdings.some(holding => holding.symbol === symbol)) { setFeedback(`${name}已在持仓标的中`); return }
          if (draft.holdings.length >= 100) { setFeedback('最多添加100只持仓标的'); return }
          update('holdings', [...draft.holdings, { symbol, name, above_ma5: null, above_ma10: null, above_ma20: null, reason: '', stop_loss: '' }])
          setFeedback(`已添加${name}`)
        }} />
      </>}>
        {importHoldings.isError && <p role="alert" className="mb-2 text-xs text-danger">导入失败：{importHoldings.error.message}。原有填写内容已保留，可重新选择日期或重试。</p>}
        {sync.isError && <p role="alert" className="mb-2 text-xs text-danger">同步失败：{sync.error.message}。原有填写内容已保留，可重试。</p>}
        {sync.isSuccess && <div role="status" aria-label="持仓同步结果" className="mb-2 space-y-1 text-xs">
          <p className="text-accent">已更新 {sync.data.rows.filter(row => row.price !== null).length} 只股票当天价格，回填 {sync.data.rows.reduce((count, row) => count + [row.above_ma5, row.above_ma10, row.above_ma20].filter(value => value !== null).length, 0)} 项均线判断。请保存计划。</p>
          {sync.data.rows.filter(row => row.issues.length > 0).map(row => <p key={row.symbol} className="text-red-700 dark:text-red-300">{draft.holdings.find(holding => holding.symbol === row.symbol)?.name ?? row.symbol}：{row.issues.join('；')}</p>)}
        </div>}
        {draft.holdings.length > 0 && <div aria-hidden="true" className={`hidden items-center gap-3 border-b border-border/60 pb-1.5 text-xs text-muted xl:grid ${holdingColumns}`}>
          <span>股票 / 代码</span><span>计划当日价</span><span>当前价格</span><span>在5天线上</span><span>在10天线上</span><span>在20天线上</span><span>持仓理由</span><span>止损线</span><span />
        </div>}
        {draft.holdings.map(holding => {
          const holdingTextColor = holding.above_ma10 === false && holding.above_ma20 === false
            ? 'text-green-700 dark:text-green-300'
            : holding.above_ma20 === false ? 'text-red-700 dark:text-red-300'
              : holding.above_ma10 === false ? 'text-yellow-700 dark:text-yellow-300'
                : 'text-foreground'
          const priceClassName = holding.above_ma10 === false || holding.above_ma20 === false
            ? `font-bold ${holdingTextColor}`
            : 'font-medium text-foreground'
          return <div key={holding.symbol} className={`grid min-w-0 items-center gap-2 border-b border-border/40 py-2 last:border-0 lg:gap-3 ${holdingColumns}`}>
          <button type="button" aria-label={`查看${holding.name} ${holding.symbol}详情`} title="打开股票详情" className="group min-w-0 rounded-btn text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent" onClick={() => {
            if (!openStockPreview({ symbol: holding.symbol, name: holding.name, navList: draft.holdings.map(({ symbol, name }) => ({ symbol, name })) })) {
              toast('股票详情面板暂不可用，请刷新页面重试', 'error')
            }
          }}>
            <p className={`text-xs font-medium ${holdingTextColor} group-hover:underline`}>{holding.name}</p>
            <p className={`mt-0.5 font-mono text-[11px] ${holdingTextColor} group-hover:underline`}>{holding.symbol}</p>
          </button>
          <PlanDayPrice day={initial.date} latest={quoteBySymbol.get(holding.symbol)} historical={dayPriceBySymbol.get(holding.symbol)} loading={isHistorical ? dayPrices.isPending : quotes.isPending} error={isHistorical ? dayPrices.isError : quotes.isError} valueClassName={priceClassName} />
          <HoldingPrice quote={quoteBySymbol.get(holding.symbol)} loading={quotes.isPending} error={quotes.isError} valueClassName={priceClassName} />
          {([5, 10, 20] as const).map(days => {
            const key = `above_ma${days}` as const
            return <YesNo key={days} hideLabel="xl" label={`${holding.name}是否在${days}天线上`} value={holding[key]} onChange={value => update('holdings', draft.holdings.map(h => h.symbol === holding.symbol ? { ...h, [key]: value } : h))} />
          })}
          <TextField hideLabel="xl" label={`${holding.name} · 持仓理由`} value={holding.reason} onChange={value => update('holdings', draft.holdings.map(h => h.symbol === holding.symbol ? { ...h, reason: value } : h))} placeholder="填写持仓逻辑" />
          <TextField hideLabel="xl" label={`${holding.name} · 止损线`} value={holding.stop_loss} onChange={value => update('holdings', draft.holdings.map(h => h.symbol === holding.symbol ? { ...h, stop_loss: value } : h))} placeholder="止损价格或触发条件" />
          <button type="button" aria-label={`移除${holding.name}`} className="h-7 w-7 rounded-btn text-muted hover:bg-danger/10 hover:text-danger focus-visible:ring-2 focus-visible:ring-accent" onClick={() => { update('holdings', draft.holdings.filter(h => h.symbol !== holding.symbol)); setFeedback(`已移除${holding.name}`) }}>
            <Trash2 aria-hidden="true" className="mx-auto h-4 w-4" />
          </button>
        </div>
        })}
        {isHistorical && dayPrices.isError && symbols.length > 0 && <p role="alert" className="mt-1 text-xs text-danger">计划当日价格加载失败。<button type="button" className="ml-2 underline" onClick={() => void dayPrices.refetch()}>重试当日价格</button></p>}
        {quotes.isError && symbols.length > 0 && <p role="alert" className="mt-1 text-xs text-danger">行情加载失败{quotes.data ? '，已保留最近有效价格' : '，可继续填写计划'}。<button type="button" className="ml-2 underline" onClick={() => void quotes.refetch()}>重试行情</button></p>}
        <p role="status" className={feedback ? 'mt-1 text-xs text-accent' : draft.holdings.length === 0 ? 'py-3 text-center text-xs text-muted' : 'sr-only'}>{feedback || (draft.holdings.length === 0 ? '尚未添加持仓标的。' : '逐只填写均线状态、持仓理由与止损线。')}</p>
      </Section>
      <Section title="操作评分" extra={<div className="flex items-center gap-3 text-xs" role="status">
        <span className="text-muted">{overall ? '三项平均 · 满分10分' : `已完成 ${scores.filter(v => v !== null).length}/3 项评分`}</span>
        <span className="rounded bg-accent/10 px-2 py-1 text-accent">综合评分 <strong className="ml-1 font-mono text-sm">{overall ? `${overall} / 10` : '待完成'}</strong></span>
      </div>}>
        <div aria-hidden="true" className={`hidden items-center gap-2 pb-1 text-xs text-muted lg:grid ${reviewColumns}`}>
          <span>自查项目</span><span>持股理由</span><span>什么时候无条件止损</span><span>评分 · 1–10</span>
        </div>
        <ReviewRow title="1. 是否按照计划执行" value={draft.execution_review} onChange={v => update('execution_review', v)} />
        <ReviewRow title="2. 是否持有非5天线上个股" value={draft.ma5_review} onChange={v => update('ma5_review', v)} details dangerValue />
        <ReviewRow title="3. 是否持有非20天线上个股" value={draft.ma20_review} onChange={v => update('ma20_review', v)} details dangerValue />
      </Section>
      <Section title="自评与总结">
        <label className="block">
          <span className="sr-only">自评与总结</span>
          <textarea aria-label="自评与总结" maxLength={5000} rows={4} value={draft.self_assessment} onChange={event => update('self_assessment', event.target.value)} className={`${inputClass} resize-y leading-5`} placeholder="记录当日交易复盘、执行得失与改进方向" />
        </label>
      </Section>
      <Section title="明日交易计划">
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="flex min-w-0 flex-wrap items-end gap-2">
            <div className="min-w-0 flex-1 basis-[180px]"><TextField label="持股执行" value={draft.holding_execution} onChange={v => update('holding_execution', v)} placeholder="记录买入、持有、减仓与卖出的执行安排" /></div>
            <YesNo label="持股执行 · 是否执行" displayLabel="是否执行" value={draft.holding_execution_followed} onChange={v => update('holding_execution_followed', v)} />
          </div>
          <div className="flex min-w-0 flex-wrap items-end gap-2">
            <div className="min-w-0 flex-1 basis-[180px]"><TextField label="目标个股" value={draft.target_stocks} onChange={v => update('target_stocks', v)} placeholder="记录目标股票及观察、介入条件" /></div>
            <YesNo label="目标个股 · 是否执行" displayLabel="是否执行" value={draft.target_stocks_followed} onChange={v => update('target_stocks_followed', v)} />
          </div>
        </div>
      </Section>
    </fieldset>
  </form>
}

export function TradingPlanPage() {
  const [params, setParams] = useSearchParams()
  const day = validDate(params.get('date')) ? params.get('date')! : defaultPlanDate()
  const [autoSaveEnabled, setAutoSaveEnabled] = useState(() => {
    try { return window.localStorage.getItem(AUTO_SAVE_KEY) !== 'false' } catch { return true }
  })
  const [dirty, setDirty] = useState(false)
  const [pending, setPending] = useState(false)
  const [negativeCount, setNegativeCount] = useState(0)
  const dates = useQuery({ queryKey: QK.tradingPlanDates, queryFn: api.tradingPlanDates })
  const plan = useQuery({
    queryKey: QK.tradingPlan(day), queryFn: () => api.tradingPlan(day),
    staleTime: 0, refetchOnMount: 'always', refetchOnWindowFocus: false, refetchOnReconnect: false, retry: false,
  })
  useEffect(() => {
    try { window.localStorage.setItem(AUTO_SAVE_KEY, String(autoSaveEnabled)) } catch { /* local preference is optional */ }
  }, [autoSaveEnabled])
  function changeDate(next: string) {
    if (!validDate(next) || next === day || pending) return
    if (dirty && !window.confirm('当前计划尚未保存，切换日期将丢弃修改。是否继续？')) return
    setDirty(false)
    setNegativeCount(0)
    setParams({ date: next })
  }
  return <div className="flex h-full min-h-0 flex-col">
    <PageHeader className="grid shrink-0 grid-cols-1 gap-x-3 gap-y-2 bg-base py-2 pl-14 sm:pl-5 xl:grid-cols-[minmax(0,1fr)_auto] [&>div:first-child>div]:flex-wrap" title="交易计划" titleExtra={<>
      <aside aria-label="交易铁律" className="trading-plan-danger-frame flex min-w-0 max-w-full items-center gap-3 rounded-btn border border-danger/60 border-l-4 border-l-danger bg-danger/10 px-3 py-2 shadow-sm sm:ml-2">
        <div className="flex shrink-0 flex-col items-center gap-1 border-r border-danger/30 pr-3 text-red-700 dark:text-red-300">
          <ShieldAlert aria-hidden="true" className="h-5 w-5" strokeWidth={2.5} />
          <span className="whitespace-nowrap text-xs font-bold tracking-widest">交易铁律</span>
        </div>
        <p className="min-w-0 leading-6">
          <span className="block text-sm font-semibold text-red-800 dark:text-red-200">亏钱如烧纸，赚钱如吃屎。</span>
          <strong className="block text-base font-extrabold tracking-wide text-red-700 dark:text-red-300 sm:text-lg">保住本金，才是王道。</strong>
        </p>
      </aside>
      {!plan.isFetching && !plan.isPending && !plan.isError && negativeCount > 0 && <div role="status" aria-atomic="true" aria-label="模式检查提醒" className="trading-plan-danger-frame flex min-h-[66px] min-w-0 max-w-full flex-1 basis-[320px] items-center gap-3 rounded-btn border-2 border-danger/80 border-l-[6px] border-l-danger bg-danger/15 px-3 py-2 shadow-sm ring-1 ring-danger/10">
        <div aria-hidden="true" className="flex h-10 w-10 shrink-0 items-center justify-center rounded-btn bg-red-700 text-white dark:bg-red-400 dark:text-red-950">
          <AlertTriangle className="h-6 w-6" strokeWidth={2.5} />
        </div>
        <p className="min-w-0 text-[13px] font-semibold leading-5 text-red-800 dark:text-red-200"><strong className="block text-base font-extrabold leading-6 text-red-800 dark:text-red-200">存在不符合模式的交易 <span className="inline-block whitespace-nowrap rounded bg-red-700 px-1.5 font-mono text-white dark:bg-red-400 dark:text-red-950">{negativeCount} 项</span></strong>请认真核对，给出理由！防止下次再犯错！</p>
      </div>}
    </>} right={
        <div role="toolbar" aria-label="交易计划操作" className="ml-auto flex max-w-full flex-wrap items-center justify-end gap-1.5">
          <button type="button" role="switch" aria-checked={autoSaveEnabled} title="开启后，修改内容会自动保存；关闭后请手动保存计划" onClick={() => setAutoSaveEnabled(value => !value)} className={`${buttonClass} h-8 min-w-[116px] justify-between gap-2 px-2.5 ${autoSaveEnabled ? 'border-accent/50 bg-accent/10 font-semibold text-accent' : 'text-secondary'}`}>
            <span>自动保存</span>
            <span aria-hidden="true" className={`relative inline-flex h-[18px] w-8 shrink-0 rounded-full transition-colors ${autoSaveEnabled ? 'bg-accent' : 'bg-muted/50'}`}>
              <span className={`absolute top-[3px] h-3 w-3 rounded-full bg-white shadow-sm transition-[left] ${autoSaveEnabled ? 'left-[14px]' : 'left-[2px]'}`} />
            </span>
          </button>
          <DatePicker ariaLabel="计划日期" value={day} onChange={changeDate} disabled={pending} buttonClassName="h-8" />
          <button type="button" aria-pressed={day === previousDay(today())} className={`${buttonClass} ${day === previousDay(today()) ? 'border-accent bg-accent/10 font-semibold text-accent ring-1 ring-accent/40 disabled:opacity-100' : ''}`} disabled={pending || day === previousDay(today())} onClick={() => changeDate(previousDay(today()))}>昨天</button>
          <button type="button" aria-pressed={day === today()} className={`${buttonClass} ${day === today() ? 'border-accent bg-accent/10 font-semibold text-accent ring-1 ring-accent/40 disabled:opacity-100' : ''}`} disabled={pending || day === today()} onClick={() => changeDate(today())}>今天</button>
          <label className="min-w-0">
            <span className="sr-only">历史计划</span>
            <select aria-label="历史计划" value={dates.data?.dates.includes(day) ? day : ''} disabled={pending || !dates.data?.dates.length} onChange={e => changeDate(e.target.value)} className={`${inputClass} h-8 w-[120px]`}>
              <option value="">{dates.isPending ? '加载中…' : dates.isError ? '历史加载失败' : '选择已保存日期'}</option>
              {dates.data?.dates.map(date => <option key={date} value={date}>{date}</option>)}
            </select>
          </label>
          {dates.isError && <button type="button" className={buttonClass} onClick={() => void dates.refetch()}>重试历史</button>}
          <button type="submit" form="trading-plan-form" disabled={pending || plan.isFetching || !plan.data || plan.isError || (!dirty && !!plan.data.revision)} className={`${buttonClass} border-accent bg-accent text-white hover:bg-accent/90`}>
            {pending ? <Loader2 aria-hidden="true" className="h-3.5 w-3.5 animate-spin" /> : <Save aria-hidden="true" className="h-3.5 w-3.5" />}
            {pending ? '处理中…' : '保存计划'}
          </button>
        </div>
    } />
    <div className="min-h-0 flex-1 overflow-y-auto">
      <div className="space-y-3 px-4 py-3">
        {plan.isFetching || plan.isPending ? <div role="status" className="flex items-center justify-center gap-2 py-16 text-sm text-muted"><Loader2 aria-hidden="true" className="h-4 w-4 animate-spin" />正在加载 {day} 的计划…</div>
          : plan.isError ? <div role="alert" className="rounded-card border border-danger/30 p-5 text-sm text-danger">计划加载失败：{plan.error.message}<button type="button" className={`${buttonClass} ml-3`} onClick={() => void plan.refetch()}>重试</button></div>
            : <PlanEditor key={day} initial={plan.data} autoSaveEnabled={autoSaveEnabled} onDirty={setDirty} onPending={setPending} onNegativeCount={setNegativeCount} reload={() => { setDirty(false); setNegativeCount(0); void plan.refetch() }} />}
        <ScoreCalendar day={day} disabled={pending} onSelect={changeDate} />
      </div>
    </div>
  </div>
}
