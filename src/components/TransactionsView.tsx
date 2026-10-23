import { useState, useMemo } from 'react'
import {
  Activity,
  ExternalLink,
  Copy,
  Check,
  Search,
  RefreshCw,
  ShieldCheck,
  Filter,
  ArrowUpRight,
} from 'lucide-react'
import {
  PAYGATE402_ADDRESS,
  PROTOCOL_TREASURY_ADDRESS,
  DEPLOY_TX_HASH,
  formatUsdcAmount,
  formatUsdcExact,
  calculateFeeSplit,
  getContractExplorerUrl,
  getAddressExplorerUrl,
  getTxExplorerUrl,
  truncAddr,
} from '@/lib/paygate402'
import { OnChainActivityItem } from '@/lib/usePayGateData'
import { AppRoute } from './Header'

interface TransactionsViewProps {
  activities: OnChainActivityItem[]
  logsLoading: boolean
  logsError: string | null
  onRefresh: () => void
  onNavigate: (route: AppRoute) => void
  metrics?: {
    totalServices: number
    activeServicesCount: number
    totalCalls: bigint
    totalVolumeUsdc: bigint
    totalProviderPayoutUsdc: bigint
    totalProtocolFeeUsdc: bigint
    myServicesCount?: number
    myTotalCalls?: bigint
    myGrossRevenue?: bigint
    myNetEarnings?: bigint
    myProtocolFees?: bigint
  }
}

type EventKindFilter = 'all' | 'AccessGranted' | 'ServiceRegistered' | 'ServiceStatusUpdated'

export function TransactionsView({
  activities,
  logsLoading,
  logsError,
  onRefresh,
  onNavigate,
  metrics,
}: TransactionsViewProps) {
  const [kindFilter, setKindFilter] = useState<EventKindFilter>('all')
  const [search, setSearch] = useState('')
  const [copiedHash, setCopiedHash] = useState<string | null>(null)

  const handleCopyHash = (hash: string) => {
    void navigator.clipboard.writeText(hash)
    setCopiedHash(hash)
    setTimeout(() => setCopiedHash(null), 1500)
  }

  const filteredActivities = useMemo(() => {
    return activities.filter(item => {
      if (kindFilter !== 'all' && item.kind !== kindFilter) return false
      if (search.trim()) {
        const q = search.toLowerCase()
        const matchHash = item.txHash.toLowerCase().includes(q)
        const matchActor = item.actor.toLowerCase().includes(q)
        const matchName = (item.serviceName ?? '').toLowerCase().includes(q)
        const matchId = item.serviceId.toString() === q.replace('#', '')
        if (!matchHash && !matchActor && !matchName && !matchId) return false
      }
      return true
    })
  }, [activities, kindFilter, search])

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <div className="flex items-center gap-2.5">
            <h1 className="display text-2xl font-bold text-white tracking-tight">
              On-Chain Transactions
            </h1>
            <span className="pg-badge bg-emerald-500/10 text-emerald-400 border border-emerald-500/25 mono">
              Arc Mainnet · 5042
            </span>
          </div>
          <p className="text-sm text-[#9CA3AF] mt-1">
            Verifiable event log for <code className="mono text-[#D1D5DB]">{PAYGATE402_ADDRESS}</code>. Every hash links directly to the Arc block explorer.
          </p>
        </div>

        <div className="flex items-center gap-2.5 self-start sm:self-auto">
          <button
            type="button"
            onClick={onRefresh}
            className="pg-btn-secondary px-3 py-2 text-xs"
          >
            <RefreshCw size={14} className={logsLoading ? 'animate-spin text-[#A78BFA]' : ''} />
            <span>Query Latest Blocks</span>
          </button>
          <a
            href={getContractExplorerUrl()}
            target="_blank"
            rel="noopener noreferrer"
            className="pg-btn-secondary px-3 py-2 text-xs"
          >
            <span>Contract on Explorer</span>
            <ExternalLink size={13} />
          </a>
        </div>
      </div>

      {/* On-Chain Protocol Metrics Summary */}
      {metrics && (
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
          <div className="pg-card p-4">
            <div className="text-[11px] font-mono text-[#9CA3AF]">Registered Services</div>
            <div className="text-xl font-bold font-mono text-white mt-1 tabular-nums">
              {metrics.totalServices}
            </div>
            <div className="text-[10px] mono text-emerald-400 mt-1">
              {metrics.activeServicesCount} active on Arc Mainnet
            </div>
          </div>
          <div className="pg-card p-4">
            <div className="text-[11px] font-mono text-[#9CA3AF]">Settled Volume</div>
            <div className="text-xl font-bold font-mono text-white mt-1 tabular-nums">
              {formatUsdcAmount(metrics.totalVolumeUsdc)} <span className="text-xs font-normal text-[#9CA3AF]">USDC</span>
            </div>
            <div className="text-[10px] mono text-[#9CA3AF] mt-1">
              Provider Share (95%): {formatUsdcAmount(metrics.totalProviderPayoutUsdc)} USDC
            </div>
          </div>
          <div className="pg-card p-4">
            <div className="text-[11px] font-mono text-[#9CA3AF]">Verified Access Grants</div>
            <div className="text-xl font-bold font-mono text-white mt-1 tabular-nums">
              {Number(metrics.totalCalls).toLocaleString()}
            </div>
            <div className="text-[10px] mono text-blue-400 mt-1">
              Single-use Replay Protected
            </div>
          </div>
          <div className="pg-card p-4">
            <div className="text-[11px] font-mono text-[#9CA3AF]">Protocol Fee (5%)</div>
            <div className="text-xl font-bold font-mono text-white mt-1 tabular-nums">
              {formatUsdcAmount(metrics.totalProtocolFeeUsdc)} <span className="text-xs font-normal text-[#9CA3AF]">USDC</span>
            </div>
            <div className="text-[10px] mono text-[var(--peach)] mt-1">
              500 BPS Treasury Split
            </div>
          </div>
        </div>
      )}

      {/* Filter Bar */}
      <div className="pg-card p-4 flex flex-col md:flex-row gap-3 items-stretch md:items-center justify-between">
        <div className="relative flex-1">
          <Search
            size={15}
            className="absolute left-3.5 top-1/2 -translate-y-1/2 text-[#6B7280] pointer-events-none"
          />
          <input
            type="search"
            value={search}
            onChange={e => setSearch(e.target.value)}
            placeholder="Filter by transaction hash (0x…), caller/provider address, or service name…"
            aria-label="Filter transactions"
            className="pg-input pl-9 pr-4 py-2 text-xs sm:text-sm"
          />
        </div>

        <div className="flex items-center gap-1.5 flex-wrap">
          <span className="text-[11px] font-medium text-[#6B7280] flex items-center gap-1 mr-1">
            <Filter size={11} />
            Event:
          </span>
          {(
            [
              { id: 'all', label: 'All Events' },
              { id: 'AccessGranted', label: '402 Payments' },
              { id: 'ServiceRegistered', label: 'Registrations' },
              { id: 'ServiceStatusUpdated', label: 'Status Updates' },
            ] as const
          ).map(f => (
            <button
              key={f.id}
              type="button"
              onClick={() => setKindFilter(f.id)}
              className={`px-2.5 py-1 rounded-md text-xs font-medium transition-colors border ${
                kindFilter === f.id
                  ? 'bg-[#7C5CFF]/20 text-white border-[#7C5CFF]/40'
                  : 'bg-transparent text-[#9CA3AF] border-white/[0.08] hover:text-white'
              }`}
            >
              {f.label}
            </button>
          ))}
        </div>
      </div>

      {logsError && (
        <div className="pg-card p-4 border-amber-500/30 bg-amber-500/[0.05] text-xs text-amber-200">
          RPC log query notice: {logsError}
        </div>
      )}

      {/* Transactions Table */}
      <div className="pg-card overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-left border-collapse">
            <thead>
              <tr className="border-b border-white/[0.08] bg-[#0C0E15] text-[11px] font-semibold uppercase tracking-wider text-[#9CA3AF]">
                <th className="py-3.5 px-5">Transaction Hash</th>
                <th className="py-3.5 px-4">Event Type</th>
                <th className="py-3.5 px-4">Service</th>
                <th className="py-3.5 px-4">Actor (Caller / Provider)</th>
                <th className="py-3.5 px-4">Settlement &amp; 95/5 Split</th>
                <th className="py-3.5 px-5 text-right">Block / Explorer</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-white/[0.06] text-xs">
              {filteredActivities.map(item => {
                const split =
                  item.kind === 'AccessGranted' && item.amountUsdc
                    ? calculateFeeSplit(item.amountUsdc)
                    : null

                return (
                  <tr key={item.id} className="hover:bg-white/[0.02] transition-colors">
                    <td className="py-4 px-5 mono">
                      <div className="inline-flex items-center gap-1.5">
                        <a
                          href={getTxExplorerUrl(item.txHash)}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="text-[#A78BFA] hover:underline font-medium"
                        >
                          {truncAddr(item.txHash)}
                        </a>
                        <button
                          type="button"
                          onClick={() => handleCopyHash(item.txHash)}
                          className="text-[#6B7280] hover:text-white"
                          title="Copy full transaction hash"
                        >
                          {copiedHash === item.txHash ? (
                            <Check size={12} className="text-emerald-400" />
                          ) : (
                            <Copy size={12} />
                          )}
                        </button>
                      </div>
                    </td>

                    <td className="py-4 px-4">
                      <span
                        className={`pg-badge ${
                          item.kind === 'AccessGranted'
                            ? 'bg-emerald-500/15 text-emerald-300 border border-emerald-500/30'
                            : item.kind === 'ServiceRegistered'
                              ? 'bg-[#7C5CFF]/15 text-[#A78BFA] border border-[#7C5CFF]/30'
                              : 'bg-amber-500/15 text-amber-300 border border-amber-500/30'
                        }`}
                      >
                        {item.kind}
                      </span>
                    </td>

                    <td className="py-4 px-4">
                      <div className="font-medium text-white">
                        {item.serviceName || `Service #${item.serviceId.toString()}`}
                      </div>
                      <div className="text-[11px] text-[#6B7280] mono">
                        serviceId: {item.serviceId.toString()}
                      </div>
                    </td>

                    <td className="py-4 px-4 mono">
                      {item.actor ? (
                        <a
                          href={getAddressExplorerUrl(item.actor)}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="text-[#D1D5DB] hover:text-white inline-flex items-center gap-1"
                        >
                          {truncAddr(item.actor)}
                          <ExternalLink size={10} className="text-[#6B7280]" />
                        </a>
                      ) : (
                        <span className="text-[#6B7280]">—</span>
                      )}
                    </td>

                    <td className="py-4 px-4 mono">
                      {item.amountUsdc !== undefined ? (
                        <div>
                          <div className="font-semibold text-white">
                            {formatUsdcAmount(item.amountUsdc)} USDC
                          </div>
                          {split ? (
                            <div className="text-[10px] text-[#9CA3AF]">
                              95%: {formatUsdcExact(split.providerAmount)} · 5%:{' '}
                              {formatUsdcExact(split.protocolFee)}
                            </div>
                          ) : (
                            <div className="text-[10px] text-[#6B7280]">Price per call</div>
                          )}
                        </div>
                      ) : item.activeStatus !== undefined ? (
                        <span className="text-[#D1D5DB]">
                          active = {String(item.activeStatus)}
                        </span>
                      ) : (
                        '—'
                      )}
                    </td>

                    <td className="py-4 px-5 text-right mono">
                      {item.blockNumber !== undefined && (
                        <div className="text-[11px] text-[#9CA3AF] mb-0.5">
                          Block #{item.blockNumber.toString()}
                        </div>
                      )}
                      <a
                        href={getTxExplorerUrl(item.txHash)}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="inline-flex items-center gap-1 text-[11px] text-[#A78BFA] hover:underline"
                      >
                        Explorer <ArrowUpRight size={11} />
                      </a>
                    </td>
                  </tr>
                )
              })}

              {/* Always show the verified Contract Deployment Transaction when viewing All Events */}
              {kindFilter === 'all' && !search.trim() && (
                <tr className="bg-white/[0.015] hover:bg-white/[0.025] transition-colors">
                  <td className="py-4 px-5 mono">
                    <div className="inline-flex items-center gap-1.5">
                      <a
                        href={getTxExplorerUrl(DEPLOY_TX_HASH)}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-[#A78BFA] hover:underline font-medium"
                      >
                        {truncAddr(DEPLOY_TX_HASH)}
                      </a>
                      <button
                        type="button"
                        onClick={() => handleCopyHash(DEPLOY_TX_HASH)}
                        className="text-[#6B7280] hover:text-white"
                        title="Copy deployment transaction hash"
                      >
                        {copiedHash === DEPLOY_TX_HASH ? (
                          <Check size={12} className="text-emerald-400" />
                        ) : (
                          <Copy size={12} />
                        )}
                      </button>
                    </div>
                  </td>

                  <td className="py-4 px-4">
                    <span className="pg-badge bg-white/[0.07] text-[#E5E7EB] border border-white/[0.14]">
                      <ShieldCheck size={11} className="text-emerald-400" />
                      Contract Deployment
                    </span>
                  </td>

                  <td className="py-4 px-4">
                    <div className="font-medium text-white">PayGate402 Core Protocol</div>
                    <div className="text-[11px] text-[#6B7280] mono">
                      Contract: {truncAddr(PAYGATE402_ADDRESS)}
                    </div>
                  </td>

                  <td className="py-4 px-4 mono">
                    <a
                      href={getAddressExplorerUrl(PROTOCOL_TREASURY_ADDRESS)}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-[#D1D5DB] hover:text-white inline-flex items-center gap-1"
                    >
                      Treasury: {truncAddr(PROTOCOL_TREASURY_ADDRESS)}
                      <ExternalLink size={10} className="text-[#6B7280]" />
                    </a>
                  </td>

                  <td className="py-4 px-4 mono">
                    <div className="text-white font-medium">95% / 5% Split Configured</div>
                    <div className="text-[10px] text-[#6B7280]">
                      PROTOCOL_FEE_BPS = 500
                    </div>
                  </td>

                  <td className="py-4 px-5 text-right mono">
                    <a
                      href={getTxExplorerUrl(DEPLOY_TX_HASH)}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="inline-flex items-center gap-1 text-[11px] text-[#A78BFA] hover:underline"
                    >
                      Verify on Explorer <ArrowUpRight size={11} />
                    </a>
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>

        {filteredActivities.length === 0 && (
          <div className="p-8 text-center border-t border-white/[0.06] space-y-3">
            <Activity size={22} className="text-[#6B7280] mx-auto" />
            <div className="space-y-1">
              <h3 className="text-sm font-semibold text-white">
                {logsLoading
                  ? 'Querying recent blocks on Arc Mainnet…'
                  : 'No recent service or payment transactions in the queried block window'}
              </h3>
              <p className="text-xs text-[#9CA3AF] max-w-md mx-auto">
                PayGate402 never fabricates transaction hashes or historical activity. Register an endpoint or unlock an active service on Arc Mainnet to record live transactions here.
              </p>
            </div>
            <div className="flex items-center justify-center gap-2.5 pt-1">
              <button
                type="button"
                onClick={() => onNavigate('explore')}
                className="pg-btn-secondary text-xs"
              >
                Explore Services
              </button>
              <button
                type="button"
                onClick={() => onNavigate('my-services')}
                className="pg-btn-primary text-xs"
              >
                Register Endpoint
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
