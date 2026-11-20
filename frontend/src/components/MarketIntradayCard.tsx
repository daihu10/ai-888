import { useEffect, useMemo, useRef } from 'react'
import { useQuery } from '@tanstack/react-query'
import * as echarts from 'echarts'
import { api } from '@/lib/api'

/** 免费行情只展示上游返回的目标日期；不凭空生成板块异动标记。 */
export function MarketIntradayCard({ date }: { date?: string }) {
  const ref = useRef<HTMLDivElement>(null)
  const query = useQuery({
    queryKey: ['market-intraday', date],
    queryFn: () => api.marketIntraday(date!),
    enabled: Boolean(date),
    refetchInterval: 30_000,
  })
  const rows = useMemo(() => query.data?.rows ?? [], [query.data])
  useEffect(() => {
    if (!ref.current || !rows.length) return
    const chart = echarts.init(ref.current)
    chart.setOption({
      grid: { left: 55, right: 20, top: 20, bottom: 35 },
      tooltip: { trigger: 'axis' },
      xAxis: { type: 'category', data: rows.map(row => row.time), boundaryGap: false, axisLabel: { color: '#94a3b8', hideOverlap: true } },
      yAxis: { type: 'value', scale: true, axisLabel: { color: '#94a3b8' }, splitLine: { lineStyle: { color: 'rgba(148,163,184,.15)' } } },
      series: [{ name: '上证指数', type: 'line', data: rows.map(row => row.price), showSymbol: false, smooth: false, lineStyle: { color: '#ef4444', width: 2 } }],
    })
    const resize = () => chart.resize()
    window.addEventListener('resize', resize)
    return () => { window.removeEventListener('resize', resize); chart.dispose() }
  }, [rows])
  return (
    <section className="mb-4 rounded-lg border border-border bg-surface p-4" aria-label="大盘异动">
      <div className="flex flex-wrap items-center gap-2">
        <h2 className="font-semibold">大盘异动</h2>
        <span className="text-xs text-muted">上证指数 · {date || '等待选择交易日'} · 东方财富免费行情</span>
      </div>
      {rows.length > 0 ? <div ref={ref} className="h-64 w-full" role="img" aria-label={`${date} 上证指数分时走势`} /> : (
        <div className="flex h-48 items-center justify-center text-sm text-muted">
          {!date ? '请选择交易日' : query.isLoading ? '正在加载分时数据…' : query.isError || query.data?.status === 'unavailable' ? '免费行情暂时不可用，请稍后重试' : '该日期暂无分时数据，免费接口仅提供近期交易日'}
        </div>
      )}
      <p className="text-xs text-muted">板块异动时间标记暂不可用；当前免费接口仅提供当日累计统计。</p>
    </section>
  )
}
