import {
  ArrowRight,
  Plus,
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
} from 'lucide-react'
import {
  PAYGATE402_ADDRESS,
  PROTOCOL_TREASURY_ADDRESS,
  USDC_FACT,
  DEPLOY_TX_HASH,
  formatUsdcAmount,
  getContractExplorerUrl,
  getAddressExplorerUrl,
  getTxExplorerUrl,
  truncAddr,
  ServiceData,
} from '@/lib/paygate402'
import { OnChainActivityItem } from '@/lib/usePayGateData'
import { AppRoute } from './Header'

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
}

const PROTOCOL_STEPS = [
  {
    step: '01',
    title: 'Client Requests Resource',
    code: 'POST /v1/signals/whale-accumulation',
    desc: 'Consumer or autonomous AI agent calls a PayGate402-protected HTTP endpoint without a valid payment proof.',
  },
  {
    step: '02',
    title: 'Service Returns HTTP 402',
    code: 'HTTP/1.1 402 Payment Required',
    desc: 'Gateway responds with WWW-Authenticate: PayGate402, serviceId, required USDC amount, and contract address.',
  },
  {
    step: '03',
    title: 'Client Authorizes USDC',
    code: 'USDC.approve(PayGate402, amount)',
    desc: 'Caller approves the PayGate402 contract to transfer the exact ERC-20 USDC (6 decimals) call price.',
  },
  {
    step: '04',
    title: 'Atomic 95/5 Settlement',
    code: 'payForAccess(serviceId, requestId)',
    desc: 'Contract enforces replay protection on requestId, sends 95% to provider, 5% to treasury, and records access.',
  },
  {
    step: '05',
    title: 'Verified 200 OK Delivery',
    code: 'AccessGranted(serviceId, caller, requestId) → 200 OK',
    desc: 'Gateway verifies on-chain AccessGranted event and caller EIP-712 authorization, returning the unlocked JSON payload.',
  },
]

export function Overview({
  isConnected,
  address,
  isLoading,
  activities,
  logsLoading,
  metrics,
  onNavigate,
  onRefresh,
}: OverviewProps) {
  return (
    <div className="space-y-8">
      {/* Hero Banner */}
      <section className="pg-card p-6 sm:p-8 relative overflow-hidden">
        <div
          aria-hidden="true"
          className="pointer-events-none absolute -top-24 -right-24 w-96 h-96 rounded-full bg-[#7C5CFF]/[0.07] blur-3xl"
        />

        <div className="relative z-10 flex flex-col lg:flex-row lg:items-center lg:justify-between gap-6">
          <div className="max-w-2xl space-y-4">
            <div className="inline-flex items-center gap-2 px-2.5 py-1 rounded-md bg-[#7C5CFF]/10 border border-[#7C5CFF]/25 text-[#A78BFA] text-xs font-medium mono">
              <span className="w-1.5 h-1.5 rounded-full bg-[#7C5CFF]" />
              <span>HTTP 402 PROTOCOL · ARC TESTNET (5042002)</span>
            </div>

            <h1 className="display text-2xl sm:text-3xl lg:text-4xl font-bold text-white tracking-tight leading-[1.15]">
              Programmable USDC Micropayments for APIs &amp; Autonomous Agents
            </h1>

            <p className="text-sm sm:text-base text-[#9CA3AF] leading-relaxed">
              Monetize any HTTP endpoint, data stream, or AI inference route with per-request USDC settlement on Arc.
              The <code className="mono text-xs text-[#D1D5DB] bg-white/[0.06] px-1.5 py-0.5 rounded">PayGate402</code> smart contract
              verifies access on-chain with replay protection and splits every payment{' '}
              <span className="text-white font-medium">95% to the provider</span> and{' '}
              <span className="text-white font-medium">5% to the protocol treasury</span>.
            </p>

            <div className="pt-1 flex flex-wrap items-center gap-3">
              <button
                type="button"
                onClick={() => onNavigate('explore')}
                className="pg-btn-primary px-4 py-2.5 text-sm"
              >
                <span>Explore Services</span>
                <ArrowRight size={15} />
              </button>

              <button
                type="button"
                onClick={() => onNavigate('my-services')}
                className="pg-btn-secondary px-4 py-2.5 text-sm"
              >
                <Plus size={15} className="text-[#A78BFA]" />
                <span>Register a Service</span>
              </button>

              <button
                type="button"
                onClick={() => onNavigate('cli')}
                className="pg-btn-secondary px-3.5 py-2.5 text-sm mono"
              >
                <Terminal size={14} className="text-[#A78BFA]" />
                <span>Launch Agent CLI</span>
              </button>
            </div>
          </div>

          {/* Right Contract Verification Card */}
          <div className="lg:w-80 flex-shrink-0 pg-panel p-4 space-y-3 border border-white/[0.08]">
            <div className="flex items-center justify-between">
              <span className="text-[11px] font-semibold uppercase tracking-wider text-[#9CA3AF]">
                On-Chain Contract Specs
              </span>
              <span className="inline-flex items-center gap-1 text-[11px] font-medium text-emerald-400 mono">
                <ShieldCheck size={12} />
                Verified
              </span>
            </div>

            <div className="space-y-2 text-xs">
              <div className="flex items-center justify-between py-1.5 border-b border-white/[0.06]">
                <span className="text-[#9CA3AF]">PayGate402</span>
                <a
                  href={getContractExplorerUrl()}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="mono text-[#A78BFA] hover:underline inline-flex items-center gap-1"
                >
                  {truncAddr(PAYGATE402_ADDRESS)}
                  <ExternalLink size={10} />
                </a>
              </div>

              <div className="flex items-center justify-between py-1.5 border-b border-white/[0.06]">
                <span className="text-[#9CA3AF]">Settlement Token</span>
                <a
                  href={getAddressExplorerUrl(USDC_FACT.address)}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="mono text-[#D1D5DB] hover:text-white inline-flex items-center gap-1"
                >
                  USDC ({truncAddr(USDC_FACT.address)})
                  <ExternalLink size={10} />
                </a>
              </div>

              <div className="flex items-center justify-between py-1.5 border-b border-white/[0.06]">
                <span className="text-[#9CA3AF]">Protocol Treasury</span>
                <a
                  href={getAddressExplorerUrl(PROTOCOL_TREASURY_ADDRESS)}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="mono text-[#D1D5DB] hover:text-white inline-flex items-center gap-1"
                >
                  {truncAddr(PROTOCOL_TREASURY_ADDRESS)}
                  <ExternalLink size={10} />
                </a>
              </div>

              <div className="flex items-center justify-between pt-1">
                <span className="text-[#9CA3AF]">Revenue Split</span>
                <span className="mono font-medium text-emerald-400">95% Provider / 5% Fee</span>
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* Live On-Chain Metrics Grid */}
      <section aria-label="On-Chain Protocol Metrics">
        <div className="flex items-center justify-between mb-3">
          <div className="flex items-center gap-2">
            <h2 className="text-xs font-semibold uppercase tracking-wider text-[#9CA3AF]">
              Live On-Chain Telemetry
            </h2>
            <span className="text-[11px] text-[#6B7280] mono">
              (Read directly from PayGate402 on Arc Testnet)
            </span>
          </div>
          <button
            type="button"
            onClick={onRefresh}
            className="inline-flex items-center gap-1.5 text-xs text-[#9CA3AF] hover:text-white transition-colors"
            title="Refresh on-chain state"
          >
            <RefreshCw size={12} className={isLoading ? 'animate-spin text-[#A78BFA]' : ''} />
            <span>Sync State</span>
          </button>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
          {/* Metric 1: Registered Services */}
          <div className="pg-card p-5">
            <div className="flex items-center justify-between mb-3">
              <span className="text-xs font-medium text-[#9CA3AF]">Registered Services</span>
              <div className="w-7 h-7 rounded-lg bg-[#7C5CFF]/10 border border-[#7C5CFF]/25 flex items-center justify-center">
                <Layers size={14} className="text-[#A78BFA]" />
              </div>
            </div>
            {isLoading ? (
              <div className="h-8 w-20 rounded bg-white/[0.06] animate-pulse my-1" />
            ) : (
              <div className="display text-2xl font-bold text-white tabular-nums mono">
                {metrics.totalServices}
              </div>
            )}
            <div className="mt-2 flex items-center justify-between text-[11px] text-[#6B7280]">
              <span>{metrics.activeServicesCount} active on-chain</span>
              <span className="mono text-[#9CA3AF]">+ 2 demo templates</span>
            </div>
          </div>

          {/* Metric 2: Payment Volume */}
          <div className="pg-card p-5">
            <div className="flex items-center justify-between mb-3">
              <span className="text-xs font-medium text-[#9CA3AF]">On-Chain Payment Volume</span>
              <div className="w-7 h-7 rounded-lg bg-emerald-500/10 border border-emerald-500/25 flex items-center justify-center">
                <DollarSign size={14} className="text-emerald-400" />
              </div>
            </div>
            {isLoading ? (
              <div className="h-8 w-28 rounded bg-white/[0.06] animate-pulse my-1" />
            ) : (
              <div className="display text-2xl font-bold text-white tabular-nums mono">
                {formatUsdcAmount(metrics.totalVolumeUsdc)}{' '}
                <span className="text-sm font-normal text-[#9CA3AF]">USDC</span>
              </div>
            )}
            <div className="mt-2 flex items-center justify-between text-[11px] text-[#6B7280]">
              <span>Provider share (95%)</span>
              <span className="mono text-emerald-400">
                {formatUsdcAmount(metrics.totalProviderPayoutUsdc)} USDC
              </span>
            </div>
          </div>

          {/* Metric 3: Successful Accesses */}
          <div className="pg-card p-5">
            <div className="flex items-center justify-between mb-3">
              <span className="text-xs font-medium text-[#9CA3AF]">Verified API Accesses</span>
              <div className="w-7 h-7 rounded-lg bg-blue-500/10 border border-blue-500/25 flex items-center justify-center">
                <CheckCircle2 size={14} className="text-blue-400" />
              </div>
            </div>
            {isLoading ? (
              <div className="h-8 w-20 rounded bg-white/[0.06] animate-pulse my-1" />
            ) : (
              <div className="display text-2xl font-bold text-white tabular-nums mono">
                {Number(metrics.totalCalls).toLocaleString()}
              </div>
            )}
            <div className="mt-2 flex items-center justify-between text-[11px] text-[#6B7280]">
              <span>Replay protection</span>
              <span className="mono text-[#9CA3AF]">bytes32 requestId</span>
            </div>
          </div>

          {/* Metric 4: Provider Earnings */}
          <div className="pg-card p-5">
            <div className="flex items-center justify-between mb-3">
              <span className="text-xs font-medium text-[#9CA3AF]">
                {isConnected ? 'Your Provider Earnings' : 'Protocol Revenue Split'}
              </span>
              <div className="w-7 h-7 rounded-lg bg-amber-500/10 border border-amber-500/25 flex items-center justify-center">
                <Activity size={14} className="text-amber-400" />
              </div>
            </div>
            {isConnected && isLoading ? (
              <div className="h-8 w-28 rounded bg-white/[0.06] animate-pulse my-1" />
            ) : isConnected ? (
              <>
                <div className="display text-2xl font-bold text-white tabular-nums mono">
                  {formatUsdcAmount(metrics.myNetEarnings)}{' '}
                  <span className="text-sm font-normal text-[#9CA3AF]">USDC</span>
                </div>
                <div className="mt-2 flex items-center justify-between text-[11px] text-[#6B7280]">
                  <span>Your endpoints: {metrics.myServicesCount}</span>
                  <span className="mono text-[#9CA3AF]">{Number(metrics.myTotalCalls)} calls</span>
                </div>
              </>
            ) : (
              <>
                <div className="display text-2xl font-bold text-white tabular-nums mono">
                  95% <span className="text-sm font-normal text-[#9CA3AF]">/ 5%</span>
                </div>
                <div className="mt-2 flex items-center justify-between text-[11px] text-[#6B7280]">
                  <span>Connect wallet for earnings</span>
                  <span className="mono text-[#A78BFA]">500 BPS fee</span>
                </div>
              </>
            )}
          </div>
        </div>
      </section>

      {/* HTTP 402 Lifecycle & Architecture */}
      <section className="pg-card p-6">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2 mb-5">
          <div>
            <h2 className="display text-base font-semibold text-white">
              How HTTP 402 On-Chain Settlement Works
            </h2>
            <p className="text-xs text-[#9CA3AF] mt-0.5">
              Five-step verifiable micropayment handshake between HTTP clients, AI agents, and the PayGate402 smart contract.
            </p>
          </div>
          <button
            type="button"
            onClick={() => onNavigate('docs')}
            className="inline-flex items-center gap-1.5 text-xs font-medium text-[#A78BFA] hover:text-white transition-colors self-start sm:self-auto"
          >
            <Code2 size={14} />
            <span>View SDK Integration Code</span>
            <ArrowRight size={12} />
          </button>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-5 gap-3">
          {PROTOCOL_STEPS.map(item => (
            <div
              key={item.step}
              className="pg-panel p-4 flex flex-col justify-between border border-white/[0.07] hover:border-white/[0.14] transition-colors"
            >
              <div>
                <div className="flex items-center justify-between mb-2">
                  <span className="text-[11px] font-semibold mono text-[#A78BFA] px-1.5 py-0.5 rounded bg-[#7C5CFF]/15 border border-[#7C5CFF]/30">
                    STEP {item.step}
                  </span>
                </div>
                <h3 className="text-sm font-semibold text-white mb-1.5">{item.title}</h3>
                <p className="text-xs text-[#9CA3AF] leading-relaxed mb-3">{item.desc}</p>
              </div>
              <div className="px-2.5 py-1.5 rounded bg-[#08090E] border border-white/[0.06] text-[11px] mono text-[#D1D5DB] truncate">
                {item.code}
              </div>
            </div>
          ))}
        </div>
      </section>

      {/* Recent On-Chain Activity Table */}
      <section className="pg-card overflow-hidden">
        <div className="p-5 sm:px-6 border-b border-white/[0.08] flex flex-col sm:flex-row sm:items-center justify-between gap-3">
          <div>
            <div className="flex items-center gap-2">
              <h2 className="display text-base font-semibold text-white">Recent On-Chain Activity</h2>
              <span className="pg-badge bg-emerald-500/10 text-emerald-400 border border-emerald-500/25 mono">
                Live Contract Events
              </span>
            </div>
            <p className="text-xs text-[#9CA3AF] mt-0.5">
              Real-time events emitted by <code className="mono text-[#D1D5DB]">{truncAddr(PAYGATE402_ADDRESS)}</code> on Arc Testnet.
              No synthetic or simulated transactions are shown here.
            </p>
          </div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => onNavigate('transactions')}
              className="pg-btn-secondary py-1.5 px-3 text-xs"
            >
              <span>View All Transactions</span>
              <ArrowRight size={13} />
            </button>
          </div>
        </div>

        <div className="overflow-x-auto">
          <table className="w-full text-left border-collapse">
            <thead>
              <tr className="border-b border-white/[0.06] bg-[#0C0E15] text-[11px] font-semibold uppercase tracking-wider text-[#9CA3AF]">
                <th className="py-3 px-5">Event / State</th>
                <th className="py-3 px-4">Service</th>
                <th className="py-3 px-4">Caller / Provider</th>
                <th className="py-3 px-4">Amount (USDC)</th>
                <th className="py-3 px-5 text-right">Explorer Proof</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-white/[0.06] text-xs">
              {activities.slice(0, 6).map(item => (
                <tr key={item.id} className="hover:bg-white/[0.02] transition-colors">
                  <td className="py-3.5 px-5">
                    <span
                      className={`pg-badge ${
                        item.kind === 'AccessGranted'
                          ? 'bg-emerald-500/15 text-emerald-300 border border-emerald-500/30'
                          : item.kind === 'ServiceRegistered'
                            ? 'bg-[#7C5CFF]/15 text-[#A78BFA] border border-[#7C5CFF]/30'
                            : 'bg-amber-500/15 text-amber-300 border border-amber-500/30'
                      }`}
                    >
                      {item.kind === 'AccessGranted'
                        ? 'AccessGranted (402 Paid)'
                        : item.kind === 'ServiceRegistered'
                          ? 'ServiceRegistered'
                          : 'ServiceStatusUpdated'}
                    </span>
                  </td>
                  <td className="py-3.5 px-4 font-medium text-white">
                    {item.serviceName ? (
                      <span>
                        {item.serviceName}{' '}
                        <span className="text-[#6B7280] mono text-[11px]">#{item.serviceId.toString()}</span>
                      </span>
                    ) : (
                      <span className="mono text-[#D1D5DB]">Service #{item.serviceId.toString()}</span>
                    )}
                  </td>
                  <td className="py-3.5 px-4 mono text-[#9CA3AF]">
                    {item.actor ? (
                      <a
                        href={getAddressExplorerUrl(item.actor)}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="hover:text-white inline-flex items-center gap-1"
                      >
                        {truncAddr(item.actor)}
                        <ExternalLink size={10} />
                      </a>
                    ) : (
                      '—'
                    )}
                  </td>
                  <td className="py-3.5 px-4 mono tabular-nums text-white">
                    {item.amountUsdc !== undefined ? `${formatUsdcAmount(item.amountUsdc)} USDC` : '—'}
                  </td>
                  <td className="py-3.5 px-5 text-right">
                    <a
                      href={getTxExplorerUrl(item.txHash)}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="inline-flex items-center gap-1 mono text-[#A78BFA] hover:underline"
                    >
                      {truncAddr(item.txHash)}
                      <ExternalLink size={11} />
                    </a>
                  </td>
                </tr>
              ))}

              {/* Verified Contract Deployment Genesis Record */}
              <tr className="bg-white/[0.01] hover:bg-white/[0.02] transition-colors">
                <td className="py-3.5 px-5">
                  <span className="pg-badge bg-white/[0.06] text-[#D1D5DB] border border-white/[0.12]">
                    Contract Deployed
                  </span>
                </td>
                <td className="py-3.5 px-4 text-[#D1D5DB]">
                  PayGate402 Core Contract
                </td>
                <td className="py-3.5 px-4 mono text-[#9CA3AF]">
                  <a
                    href={getContractExplorerUrl()}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="hover:text-white inline-flex items-center gap-1"
                  >
                    {truncAddr(PAYGATE402_ADDRESS)}
                    <ExternalLink size={10} />
                  </a>
                </td>
                <td className="py-3.5 px-4 mono text-[#6B7280]">500 BPS Fee Split</td>
                <td className="py-3.5 px-5 text-right">
                  <a
                    href={getTxExplorerUrl(DEPLOY_TX_HASH)}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex items-center gap-1 mono text-[#A78BFA] hover:underline"
                  >
                    {truncAddr(DEPLOY_TX_HASH)}
                    <ExternalLink size={11} />
                  </a>
                </td>
              </tr>
            </tbody>
          </table>
        </div>

        {/* Helpful Empty State when no service/payment events exist yet */}
        {activities.length === 0 && !logsLoading && (
          <div className="p-6 border-t border-white/[0.06] bg-[#0B0D14]/60 flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4">
            <div className="flex items-start gap-3">
              <div className="w-8 h-8 rounded-lg bg-[#7C5CFF]/10 border border-[#7C5CFF]/25 flex items-center justify-center flex-shrink-0 mt-0.5">
                <Sparkles size={15} className="text-[#A78BFA]" />
              </div>
              <div>
                <h3 className="text-xs font-semibold text-white">
                  No recent service calls or registrations recorded in the current block window
                </h3>
                <p className="text-xs text-[#9CA3AF] mt-0.5">
                  {address
                    ? 'You can deploy a reference service template or register a custom API endpoint on Arc Testnet to generate live on-chain events.'
                    : 'Connect your wallet on Arc Testnet to deploy a reference service or pay for API access.'}
                </p>
              </div>
            </div>
            <div className="flex items-center gap-2 flex-shrink-0">
              <button
                type="button"
                onClick={() => onNavigate('explore')}
                className="pg-btn-secondary py-1.5 px-3 text-xs"
              >
                <Lock size={12} className="text-[#A78BFA]" />
                <span>Inspect Demo Templates</span>
              </button>
              <button
                type="button"
                onClick={() => onNavigate('my-services')}
                className="pg-btn-primary py-1.5 px-3 text-xs"
              >
                <Plus size={12} />
                <span>Register Endpoint</span>
              </button>
            </div>
          </div>
        )}
      </section>
    </div>
  )
}
