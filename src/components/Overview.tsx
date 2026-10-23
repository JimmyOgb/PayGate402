import { AppRoute } from './Header'
import { MeridianHero } from './MeridianHero'

interface OverviewProps {
  onNavigate: (route: AppRoute) => void
  serviceCount?: number
  myServiceCount?: number
  usdcBalance?: bigint
  // Retained optional props for caller backward-compatibility
  isConnected?: boolean
  address?: string
  services?: unknown
  isLoading?: boolean
  activities?: unknown
  logsLoading?: boolean
  metrics?: unknown
  onRefresh?: () => void
}

/**
 * Overview component — Homepage-Only Cinematic Landing Hero
 *
 * Implements Stage 8.39 requirements:
 * - Clean, cinematic, full-viewport Meridian landing experience.
 * - Zero below-the-fold content: Marketplace, My Services, Transactions,
 *   Telemetry, and Developer Docs are strictly accessible via navigation/CTAs.
 */
export function Overview({
  onNavigate,
  serviceCount = 0,
  myServiceCount = 0,
  usdcBalance,
}: OverviewProps) {
  return (
    <div className="w-full flex-1 flex flex-col">
      <MeridianHero
        onNavigate={onNavigate}
        serviceCount={serviceCount}
        myServiceCount={myServiceCount}
        usdcBalance={usdcBalance}
      />
    </div>
  )
}
