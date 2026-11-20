import { lazy } from 'react'
import { ClipboardList } from 'lucide-react'
import type { FrontendExtension } from '@/extensions/types'

const TradingPlanPage = lazy(() => import('./Page').then(m => ({ default: m.TradingPlanPage })))

const extension: FrontendExtension = {
  id: 'official.trading-plan',
  apiVersion: 1,
  routes: [{ id: 'trading-plan', path: '/trading-plan', component: TradingPlanPage }],
  navigation: [{ id: 'trading-plan', routeId: 'trading-plan', label: '交易计划', icon: ClipboardList, order: 1000 }],
}

export default extension
