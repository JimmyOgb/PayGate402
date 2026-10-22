import { Component, ErrorInfo, ReactNode, useState, useEffect, useCallback } from 'react'
import { ExternalLink, Shield, AlertTriangle } from 'lucide-react'
import { Header, AppRoute } from '@/components/Header'
import { Overview } from '@/components/Overview'
import { Marketplace } from '@/components/Marketplace'
import { MyServices } from '@/components/MyServices'
import { TransactionsView } from '@/components/TransactionsView'
import { DeveloperDocs } from '@/components/DeveloperDocs'
import { AgentCLI } from '@/components/AgentCLI'
import { usePayGateData } from '@/lib/usePayGateData'
import {
  USDC_FACT,
  getContractConfig,
  getContractExplorerUrl,
  getAddressExplorerUrl,
  truncAddr,
} from '@/lib/paygate402'

const VALID_ROUTES: AppRoute[] = [
  'overview',
  'explore',
  'my-services',
  'transactions',
  'docs',
  'cli',
]

function parseHashRoute(): AppRoute {
  if (typeof window === 'undefined') return 'overview'
  const raw = window.location.hash.replace(/^#\/?/, '').trim().toLowerCase()
  if (VALID_ROUTES.includes(raw as AppRoute)) {
    return raw as AppRoute
  }
  return 'overview'
}

interface ErrorBoundaryState {
  hasError: boolean
  error: Error | null
}

class AppErrorBoundary extends Component<{ children: ReactNode }, ErrorBoundaryState> {
  constructor(props: { children: ReactNode }) {
    super(props)
    this.state = { hasError: false, error: null }
  }

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { hasError: true, error }
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error('[PayGate402 ErrorBoundary]', error, info)
  }

  render() {
    if (this.state.hasError) {
      return (
        <div className="min-h-dvh flex items-center justify-center p-6 bg-[#090A0F] text-white">
          <div className="pg-card max-w-md w-full p-6 space-y-4 text-center">
            <AlertTriangle size={28} className="text-rose-400 mx-auto" />
            <h1 className="display text-lg font-bold">Application Interface Error</h1>
            <p className="text-xs text-[#9CA3AF]">
              {this.state.error?.message || 'An unexpected rendering error occurred.'}
            </p>
            <button
              type="button"
              onClick={() => {
                this.setState({ hasError: false, error: null })
                window.location.hash = '#overview'
              }}
              className="pg-btn-primary w-full"
            >
              Return to Overview
            </button>
          </div>
        </div>
      )
    }
    return this.props.children
  }
}

export default function App() {
  const [activeRoute, setActiveRoute] = useState<AppRoute>(parseHashRoute)

  const {
    address,
    isConnected,
    currentChainId,
    services,
    myServices,
    serviceCount,
    isLoading,
    isError,
    activities,
    logsLoading,
    logsError,
    metrics,
    refetchAll,
    recordSessionTx,
  } = usePayGateData()

  const handleNavigate = useCallback((route: AppRoute) => {
    setActiveRoute(route)
    if (typeof window !== 'undefined') {
      window.history.replaceState(null, '', `#${route}`)
      window.scrollTo({ top: 0, behavior: 'smooth' })
    }
  }, [])

  useEffect(() => {
    const onHashChange = () => {
      setActiveRoute(parseHashRoute())
    }
    window.addEventListener('hashchange', onHashChange)
    return () => window.removeEventListener('hashchange', onHashChange)
  }, [])

  return (
    <AppErrorBoundary>
      <div className="min-h-dvh flex flex-col bg-[#090A0F] text-[#F3F4F6]">
        <Header
          activeRoute={activeRoute}
          onNavigate={handleNavigate}
          serviceCount={serviceCount}
          myServiceCount={myServices.length}
        />

        <main className="flex-1 max-w-7xl w-full mx-auto px-4 sm:px-6 lg:px-8 py-8">
          {activeRoute === 'overview' && (
            <Overview
              isConnected={isConnected}
              address={address}
              services={services}
              isLoading={isLoading}
              activities={activities}
              logsLoading={logsLoading}
              metrics={metrics}
              onNavigate={handleNavigate}
              onRefresh={refetchAll}
            />
          )}

          {activeRoute === 'explore' && (
            <Marketplace
              services={services}
              isLoading={isLoading}
              isError={isError}
              onRefresh={refetchAll}
              onNavigate={handleNavigate}
              onRecordTx={recordSessionTx}
            />
          )}

          {activeRoute === 'my-services' && (
            <MyServices
              services={services}
              myServices={myServices}
              activities={activities}
              isLoading={isLoading}
              metrics={metrics}
              onRefresh={refetchAll}
              onRecordTx={recordSessionTx}
            />
          )}

          {activeRoute === 'transactions' && (
            <TransactionsView
              activities={activities}
              logsLoading={logsLoading}
              logsError={logsError}
              onRefresh={refetchAll}
              onNavigate={handleNavigate}
            />
          )}

          {activeRoute === 'docs' && <DeveloperDocs onNavigate={handleNavigate} />}

          {activeRoute === 'cli' && (
            <AgentCLI services={services} onNavigate={handleNavigate} />
          )}
        </main>

        {/* Footer */}
        <footer className="border-t border-white/[0.07] bg-[#07080D] mt-16">
          <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-6 flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4 text-xs text-[#6B7280]">
            <div className="flex items-center gap-2.5">
              <div className="w-6 h-6 rounded-md bg-[#7C5CFF]/15 border border-[#7C5CFF]/30 flex items-center justify-center">
                <Shield size={12} className="text-[#A78BFA]" />
              </div>
              <span className="font-semibold text-[#D1D5DB]">PayGate402</span>
              <span>·</span>
              <span>HTTP 402 Micropayment Gateway on Arc ({getContractConfig(currentChainId).chainName} {currentChainId})</span>
            </div>

            <div className="flex flex-wrap items-center gap-4 mono text-[11px]">
              <a
                href={getContractExplorerUrl(currentChainId)}
                target="_blank"
                rel="noopener noreferrer"
                className="text-[#9CA3AF] hover:text-white inline-flex items-center gap-1"
              >
                Contract: {truncAddr(getContractConfig(currentChainId).contractAddress)}
                <ExternalLink size={10} />
              </a>
              <a
                href={getAddressExplorerUrl(USDC_FACT.address, currentChainId)}
                target="_blank"
                rel="noopener noreferrer"
                className="text-[#9CA3AF] hover:text-white inline-flex items-center gap-1"
              >
                USDC: {truncAddr(USDC_FACT.address)}
                <ExternalLink size={10} />
              </a>
              <a
                href={getAddressExplorerUrl(getContractConfig(currentChainId).treasuryAddress, currentChainId)}
                target="_blank"
                rel="noopener noreferrer"
                className="text-[#9CA3AF] hover:text-white inline-flex items-center gap-1"
              >
                Treasury (5%): {truncAddr(getContractConfig(currentChainId).treasuryAddress)}
                <ExternalLink size={10} />
              </a>
            </div>
          </div>
        </footer>
      </div>
    </AppErrorBoundary>
  )
}
