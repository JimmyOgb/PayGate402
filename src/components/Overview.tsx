import {
  ArrowRight,
  ExternalLink,
  RefreshCw,
  ShieldCheck,
  Terminal,
  Layers,
  Activity,
  DollarSign,
  CheckCircle2,
  Lock,
  Sparkles,
  Code2,
  Compass,
} from 'lucide-react'
import {
  PAYGATE402_ADDRESS,
  PROTOCOL_TREASURY_ADDRESS,
  USDC_FACT,
  formatUsdcAmount,
  getContractExplorerUrl,
  getAddressExplorerUrl,
  getTxExplorerUrl,
  truncAddr,
  ServiceData,
} from '@/lib/paygate402'
import { OnChainActivityItem } from '@/lib/usePayGateData'
import { AppRoute } from './Header'
import { MeridianHero } from './MeridianHero'

interface OverviewProps {
  isConnected: boolean
  address?: string
  services: ServiceData[]
  isLoading: boolean
  activities: OnChainActivityItem[]
  logsLoading: boolean
  metrics: {
    totalServices: number
    activeServicesCount: number
    totalCalls: bigint
    totalVolumeUsdc: bigint
    totalProviderPayoutUsdc: bigint
    totalProtocolFeeUsdc: bigint
    myServicesCount: number
    myTotalCalls: bigint
    myGrossRevenue: bigint
    myNetEarnings: bigint
    myProtocolFees: bigint
  }
  onNavigate: (route: AppRoute) => void
  onRefresh: () => void
  serviceCount?: number
  myServiceCount?: number
  usdcBalance?: bigint
}

const PROTOCOL_STEPS = [
  {
    step: '01',
    title: 'Unauthenticated Request',
    code: 'GET /v1/telemetry/arc-mainnet',
    desc: 'Client or AI Agent requests a protected API endpoint without active access credentials.',
  },
  {
    step: '02',
    title: 'HTTP 402 Challenge',
    code: '402 Payment Required + ticket',
    desc: 'Gateway responds with 402 status, service price, 15-min expiry, and unique bytes32 requestId.',
  },
  {
    step: '03',
    title: 'ERC-20 USDC Approval',
    code: 'usdc.approve(paygate, price)',
    desc: 'Payer grants PayGate402 exact allowance for quoted price (e.g. 20,000 base units = 0.02 USDC).',
  },
  {
    step: '04',
    title: 'On-Chain Settlement',
    code: 'paygate.payForAccess(id, reqId)',
    desc: 'Smart contract executes 95/5 split (95% provider, 5% treasury), marks requestId consumed, and emits AccessGranted.',
  },
  {
    step: '05',
    title: 'Verified 200 OK Delivery',
    code: 'AccessGranted receipt → 200 OK',
    desc: 'Gateway verifies on-chain AccessGranted event and caller EIP-712 authorization, returning the unlocked JSON payload.',
  },
]

export function Overview({
  isConnected,
  address,
  services,
  isLoading,
  activities,
  logsLoading,
  metrics,
  onNavigate,
  onRefresh,
  serviceCount = 0,
  myServiceCount = 0,
  usdcBalance,
}: OverviewProps) {
  return (
    <div className="space-y-12">
      {/* ─────────────────────────────────────────────────────────────────────────────
       * Meridian Cinematic 1280×800 Landing Hero
       * ───────────────────────────────────────────────────────────────────────────── */}
      <MeridianHero
        onNavigate={onNavigate}
        serviceCount={serviceCount}
        myServiceCount={myServiceCount}
        usdcBalance={usdcBalance}
      />

      {/* ─────────────────────────────────────────────────────────────────────────────
       * Below Hero: Real Arc Mainnet Telemetry & Developer Portal
       * ───────────────────────────────────────────────────────────────────────────── */}
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 space-y-10">
        {/* Live On-Chain Telemetry Header */}
        <section aria-label="On-Chain Protocol Metrics">
          <div className="flex items-center justify-between mb-4 border-b border-white/10 pb-3">
            <div className="flex items-center gap-2.5">
              <span className="w-2 h-2 rounded-full bg-emerald-400 shadow-[0_0_8px_rgba(52,211,153,0.6)]" />
              <h2 className="text-xs font-mono font-semibold uppercase tracking-wider text-white">
                Live On-Chain Telemetry · Arc Mainnet (5042)
              </h2>
              <span className="text-[11px] text-[#989eac] mono hidden sm:inline">
                (Contract: {truncAddr(PAYGATE402_ADDRESS)})
              </span>
            </div>
            <button
              type="button"
              onClick={onRefresh}
              className="inline-flex items-center gap-1.5 text-xs text-[#cfd3e0] hover:text-white transition-colors mono"
              title="Refresh on-chain state"
            >
              <RefreshCw size={12} className={isLoading ? 'animate-spin text-[var(--peach)]' : ''} />
              <span>Sync State</span>
            </button>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
            {/* Metric 1: Registered Services */}
            <div className="bg-[#12182B]/80 backdrop-blur-[14px] border border-white/10 p-5">
              <div className="flex items-center justify-between mb-3">
                <span className="text-xs font-mono text-[#989eac]">Registered Services</span>
                <div className="w-7 h-7 bg-[var(--peach)]/10 border border-[var(--peach)]/30 flex items-center justify-center">
                  <Layers size={14} className="text-[var(--peach)]" />
                </div>
              </div>
              {isLoading ? (
                <div className="h-8 w-20 bg-white/10 animate-pulse my-1" />
              ) : (
                <div className="font-mono text-3xl font-bold text-white tabular-nums">
                  {metrics.totalServices}
                </div>
              )}
              <div className="mt-2 flex items-center justify-between text-[11px] text-[#989eac] mono">
                <span>{metrics.activeServicesCount} active on Arc</span>
                <span className="text-emerald-400">Verifiable</span>
              </div>
            </div>

            {/* Metric 2: Payment Volume */}
            <div className="bg-[#12182B]/80 backdrop-blur-[14px] border border-white/10 p-5">
              <div className="flex items-center justify-between mb-3">
                <span className="text-xs font-mono text-[#989eac]">On-Chain Volume</span>
                <div className="w-7 h-7 bg-emerald-500/10 border border-emerald-500/30 flex items-center justify-center">
                  <DollarSign size={14} className="text-emerald-400" />
                </div>
              </div>
              {isLoading ? (
                <div className="h-8 w-28 bg-white/10 animate-pulse my-1" />
              ) : (
                <div className="font-mono text-3xl font-bold text-white tabular-nums">
                  {formatUsdcAmount(metrics.totalVolumeUsdc)}{' '}
                  <span className="text-sm font-normal text-[#989eac]">USDC</span>
                </div>
              )}
              <div className="mt-2 flex items-center justify-between text-[11px] text-[#989eac] mono">
                <span>Provider share (95%)</span>
                <span className="text-emerald-400">
                  {formatUsdcAmount(metrics.totalProviderPayoutUsdc)} USDC
                </span>
              </div>
            </div>

            {/* Metric 3: Successful Accesses */}
            <div className="bg-[#12182B]/80 backdrop-blur-[14px] border border-white/10 p-5">
              <div className="flex items-center justify-between mb-3">
                <span className="text-xs font-mono text-[#989eac]">Verified Access Grants</span>
                <div className="w-7 h-7 bg-blue-500/10 border border-blue-500/30 flex items-center justify-center">
                  <CheckCircle2 size={14} className="text-blue-400" />
                </div>
              </div>
              {isLoading ? (
                <div className="h-8 w-20 bg-white/10 animate-pulse my-1" />
              ) : (
                <div className="font-mono text-3xl font-bold text-white tabular-nums">
                  {Number(metrics.totalCalls).toLocaleString()}
                </div>
              )}
              <div className="mt-2 flex items-center justify-between text-[11px] text-[#989eac] mono">
                <span>Replay protection</span>
                <span className="text-white">Single-use</span>
              </div>
            </div>

            {/* Metric 4: Provider Earnings */}
            <div className="bg-[#12182B]/80 backdrop-blur-[14px] border border-white/10 p-5">
              <div className="flex items-center justify-between mb-3">
                <span className="text-xs font-mono text-[#989eac]">
                  {isConnected ? 'Your Provider Payout' : 'Protocol Revenue Split'}
                </span>
                <div className="w-7 h-7 bg-[var(--cta)]/10 border border-[var(--cta)]/30 flex items-center justify-center">
                  <Activity size={14} className="text-[var(--cta)]" />
                </div>
              </div>
              {isConnected && isLoading ? (
                <div className="h-8 w-28 bg-white/10 animate-pulse my-1" />
              ) : isConnected ? (
                <>
                  <div className="font-mono text-3xl font-bold text-white tabular-nums">
                    {formatUsdcAmount(metrics.myNetEarnings)}{' '}
                    <span className="text-sm font-normal text-[#989eac]">USDC</span>
                  </div>
                  <div className="mt-2 flex items-center justify-between text-[11px] text-[#989eac] mono">
                    <span>Endpoints: {metrics.myServicesCount}</span>
                    <span className="text-white">{Number(metrics.myTotalCalls)} calls</span>
                  </div>
                </>
              ) : (
                <>
                  <div className="font-mono text-3xl font-bold text-white tabular-nums">
                    95% <span className="text-sm font-normal text-[#989eac]">/ 5%</span>
                  </div>
                  <div className="mt-2 flex items-center justify-between text-[11px] text-[#989eac] mono">
                    <span>95% Provider / 5% Fee</span>
                    <span className="text-[var(--peach)]">500 BPS</span>
                  </div>
                </>
              )}
            </div>
          </div>
        </section>

        {/* Live Mainnet Service Spotlight: Service 0 */}
        {services.length > 0 && (
          <section className="bg-[#12182B]/80 backdrop-blur-[14px] border border-white/10 p-6 sm:p-7">
            <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-6">
              <div className="space-y-3 max-w-2xl">
                <div className="inline-flex items-center gap-2 px-2.5 py-1 bg-emerald-500/10 border border-emerald-500/30 text-emerald-400 text-xs mono">
                  <span className="w-1.5 h-1.5 rounded-full bg-emerald-400" />
                  <span>LIVE SERVICE #0 · ARC MAINNET</span>
                </div>
                <h3 className="font-display text-2xl font-bold text-white">
                  {services[0].name}
                </h3>
                <p className="text-sm text-[#cfd3e0] leading-relaxed font-sans">
                  {services[0].endpointDescription} — Real-time HTTP 402 telemetry feed directly monetized on Arc Mainnet at{' '}
                  <span className="text-white font-medium mono">
                    {formatUsdcAmount(services[0].priceInUsdc)} USDC
                  </span> per call. Verified on-chain via PayGate402.
                </p>
                <div className="flex flex-wrap items-center gap-4 text-xs font-mono text-[#989eac] pt-1">
                  <span>Provider: <code className="text-white">{truncAddr(services[0].provider)}</code></span>
                  <span>Calls: <code className="text-emerald-400">{services[0].totalCalls.toString()}</code></span>
                  <span>Revenue: <code className="text-emerald-400">{formatUsdcAmount(services[0].totalRevenue)} USDC</code></span>
                </div>
              </div>

              <div className="flex flex-col sm:flex-row lg:flex-col gap-3 flex-shrink-0">
                <button
                  type="button"
                  onClick={() => onNavigate('explore')}
                  className="px-5 py-3 bg-[var(--cta)] text-[#331200] font-mono font-bold text-xs hover:brightness-105 transition-all text-center flex items-center justify-center gap-2"
                >
                  <span>PAY &amp; UNLOCK (0.02 USDC)</span>
                  <ArrowRight size={14} />
                </button>
                <button
                  type="button"
                  onClick={() => onNavigate('cli')}
                  className="px-5 py-3 bg-[#33344a]/60 backdrop-blur-[14px] text-white border border-white/10 font-mono text-xs hover:bg-[#424260]/66 transition-all text-center flex items-center justify-center gap-2"
                >
                  <Terminal size={14} className="text-[var(--peach)]" />
                  <span>SIMULATE VIA AGENT CLI</span>
                </button>
              </div>
            </div>
          </section>
        )}

        {/* HTTP 402 Architecture Handshake Workflow */}
        <section className="bg-[#12182B]/80 backdrop-blur-[14px] border border-white/10 p-6 sm:p-7">
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 mb-6">
            <div>
              <h2 className="font-display text-lg font-bold text-white">
                HTTP 402 On-Chain Micropayment Handshake
              </h2>
              <p className="text-xs text-[#989eac] mt-1 font-sans">
                Five-step verifiable settlement protocol between HTTP clients, autonomous agents, and the Arc Mainnet smart contract.
              </p>
            </div>
            <button
              type="button"
              onClick={() => onNavigate('docs')}
              className="inline-flex items-center gap-1.5 text-xs font-mono text-[var(--peach)] hover:text-white transition-colors"
            >
              <Code2 size={14} />
              <span>Integration SDKs</span>
              <ArrowRight size={12} />
            </button>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-5 gap-3">
            {PROTOCOL_STEPS.map(item => (
              <div
                key={item.step}
                className="bg-[#070B16] border border-white/10 p-4 flex flex-col justify-between hover:border-white/20 transition-colors"
              >
                <div>
                  <div className="mb-2">
                    <span className="text-[10px] font-mono font-bold text-[var(--peach)] px-1.5 py-0.5 bg-[var(--peach)]/10 border border-[var(--peach)]/30">
                      STEP {item.step}
                    </span>
                  </div>
                  <h3 className="text-xs font-bold text-white mb-1.5">{item.title}</h3>
                  <p className="text-[11px] text-[#cfd3e0] leading-relaxed mb-3 font-sans">{item.desc}</p>
                </div>
                <div className="px-2 py-1 bg-[#020816] border border-white/10 text-[10px] font-mono text-[#989eac] truncate">
                  {item.code}
                </div>
              </div>
            ))}
          </div>
        </section>

        {/* Recent On-Chain Activity Table */}
        <section className="bg-[#12182B]/80 backdrop-blur-[14px] border border-white/10 overflow-hidden">
          <div className="p-5 sm:px-6 border-b border-white/10 flex flex-col sm:flex-row sm:items-center justify-between gap-3">
            <div>
              <div className="flex items-center gap-2">
                <h2 className="font-display text-base font-bold text-white">Recent Arc Mainnet Activity</h2>
                <span className="px-2 py-0.5 text-[10px] font-mono bg-emerald-500/10 text-emerald-400 border border-emerald-500/30">
                  Live Contract Events
                </span>
              </div>
              <p className="text-xs text-[#989eac] mt-0.5 font-sans">
                Real-time event logs emitted by <code className="mono text-white">{truncAddr(PAYGATE402_ADDRESS)}</code> on Arc Mainnet.
              </p>
            </div>
            <button
              type="button"
              onClick={() => onNavigate('transactions')}
              className="px-3 py-1.5 bg-[#33344a]/60 backdrop-blur-[14px] border border-white/10 hover:border-white/20 text-xs font-mono text-white inline-flex items-center gap-1.5 transition-colors self-start sm:self-auto"
            >
              <span>View All Transactions</span>
              <ArrowRight size={12} />
            </button>
          </div>

          <div className="overflow-x-auto">
            <table className="w-full text-left border-collapse">
              <thead>
                <tr className="border-b border-white/10 bg-[#070B16] text-[10px] font-mono uppercase tracking-wider text-[#989eac]">
                  <th className="py-3 px-5">Event</th>
                  <th className="py-3 px-4">Service</th>
                  <th className="py-3 px-4">Caller / Provider</th>
                  <th className="py-3 px-4">Amount (USDC)</th>
                  <th className="py-3 px-5 text-right">Proof</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-white/10 text-xs">
                {activities.slice(0, 6).map(item => (
                  <tr key={item.id} className="hover:bg-white/[0.02] transition-colors">
                    <td className="py-3 px-5">
                      <span
                        className={`inline-block px-2 py-0.5 font-mono text-[10px] ${
                          item.kind === 'AccessGranted'
                            ? 'bg-emerald-500/15 text-emerald-300 border border-emerald-500/30'
                            : item.kind === 'ServiceRegistered'
                              ? 'bg-[var(--peach)]/15 text-[var(--peach)] border border-[var(--peach)]/30'
                              : 'bg-amber-500/15 text-amber-300 border border-amber-500/30'
                        }`}
                      >
                        {item.kind}
                      </span>
                    </td>
                    <td className="py-3 px-4 font-medium text-white">
                      {item.serviceName ? (
                        <span>{item.serviceName}</span>
                      ) : (
                        <span className="mono text-[#989eac]">Service #{item.serviceId.toString()}</span>
                      )}
                    </td>
                    <td className="py-3 px-4 mono text-[#cfd3e0]">
                      {item.actor ? (
                        <a
                          href={getAddressExplorerUrl(item.actor)}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="hover:text-white hover:underline"
                        >
                          {truncAddr(item.actor)}
                        </a>
                      ) : (
                        <span className="text-[#6B7280]">—</span>
                      )}
                    </td>
                    <td className="py-3 px-4 mono tabular-nums text-white">
                      {item.amountUsdc !== undefined ? (
                        <span>{formatUsdcAmount(item.amountUsdc)} USDC</span>
                      ) : (
                        <span className="text-[#6B7280]">—</span>
                      )}
                    </td>
                    <td className="py-3 px-5 text-right">
                      {item.txHash ? (
                        <a
                          href={getTxExplorerUrl(item.txHash)}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="inline-flex items-center gap-1 mono text-[11px] text-[var(--peach)] hover:underline"
                        >
                          <span>{truncAddr(item.txHash)}</span>
                          <ExternalLink size={10} />
                        </a>
                      ) : (
                        <span className="text-[#6B7280] mono text-[11px]">pending</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {activities.length === 0 && !logsLoading && (
            <div className="p-8 text-center space-y-2 border-t border-white/10">
              <Sparkles size={20} className="text-[#989eac] mx-auto" />
              <div className="text-xs font-mono text-white">No on-chain events in current block window</div>
              <p className="text-xs text-[#989eac] max-w-md mx-auto font-sans">
                {address
                  ? 'Register a service or execute a 402 payment on Arc Mainnet to generate live event logs.'
                  : 'Connect your wallet on Arc Mainnet to execute a micropayment or register an endpoint.'}
              </p>
            </div>
          )}
        </section>

        {/* Verified Arc Mainnet Architecture Card */}
        <section className="bg-[#12182B]/80 backdrop-blur-[14px] border border-white/10 p-6 flex flex-col md:flex-row items-start md:items-center justify-between gap-4">
          <div className="space-y-1 max-w-2xl">
            <div className="flex items-center gap-2">
              <ShieldCheck size={16} className="text-emerald-400" />
              <h3 className="font-display text-base font-bold text-white">
                Verifiable Arc Mainnet Smart Contract Invariants
              </h3>
            </div>
            <p className="text-xs text-[#cfd3e0] leading-relaxed font-sans">
              Deployed on Arc Mainnet (<code className="mono text-white">{truncAddr(PAYGATE402_ADDRESS)}</code>).
              Enforces contract-wide single-use <code className="mono">usedRequestIds</code>, OpenZeppelin ReentrancyGuard,
              Checks-Effects-Interactions (CEI), deterministic 95/5 revenue split, and verifiable off-chain HTTP 402 gateway authorization.
            </p>
          </div>

          <div className="flex items-center gap-3 flex-shrink-0">
            <a
              href={getContractExplorerUrl()}
              target="_blank"
              rel="noopener noreferrer"
              className="px-4 py-2 bg-[#33344a]/60 backdrop-blur-[14px] border border-white/10 text-xs font-mono text-white hover:bg-[#424260]/66 inline-flex items-center gap-1.5 transition-colors"
            >
              <span>View Bytecode on Explorer</span>
              <ExternalLink size={11} />
            </a>
          </div>
        </section>
      </div>
    </div>
  )
}
