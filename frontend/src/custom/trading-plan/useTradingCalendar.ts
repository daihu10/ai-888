import { useQuery } from '@tanstack/react-query'
import { api } from '@/lib/api'
import { QK } from '@/lib/queryKeys'

export function today() {
  return new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date())
}

export function useTradingCalendar(year: number) {
  return useQuery({
    queryKey: QK.tradingPlanCalendar(year, today()), queryFn: () => api.tradingPlanCalendar(year),
    staleTime: 60_000, refetchInterval: 60_000,
  })
}
