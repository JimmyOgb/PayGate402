import { useState } from 'react'
import {
  Shield,
  ExternalLink,
  Terminal,
  Menu,
  X,
  AlertTriangle,
  LayoutDashboard,
  Compass,
  Server,
  Activity,
  BookOpen,
  Wallet,
} from 'lucide-react'
import { ConnectKitButton } from 'connectkit'
import { useAccount, useReadContract, useSwitchChain } from 'wagmi'
import { erc20Abi } from 'viem'
import {
  USDC_FACT,
  ARC_MAINNET_CHAIN_ID,
  PAYGATE402_ADDRESS,
  getContractConfig,
  getContractExplorerUrl,
  isSupportedChain,
  formatUsdcAmount,
  truncAddr,
} from '@/lib/paygate402'

export type AppRoute = 'overview' | 'explore' | 'my-services' | 'transactions' | 'docs' | 'cli'

interface HeaderProps {
  activeRoute: AppRoute
  onNavigate: (route: AppRoute) => void
  serviceCount?: number
  myServiceCount?: number
}

const NAV_ITEMS: { id: AppRoute; label: string; icon: typeof LayoutDashboard }[] = [
  { id: 'overview', label: 'Overview', icon: LayoutDashboard },
  { id: 'explore', label: 'Explore Services', icon: Compass },
  { id: 'my-services', label: 'My Services', icon: Server },
  { id: 'transactions', label: 'Transactions', icon: Activity },
  { id: 'docs', label: 'Developer Docs', icon: BookOpen },
]

export function Header({ activeRoute, onNavigate, serviceCount = 0, myServiceCount = 0 }: HeaderProps) {
  const { address, isConnected, chainId } = useAccount()
  const { switchChain } = useSwitchChain()
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false)

  const verifiedWallet = Boolean(isConnected && address)
  const isCorrectChain = chainId === ARC_MAINNET_CHAIN_ID
  const isWrongNetwork = verifiedWallet && !isCorrectChain
  const currentChainId = ARC_MAINNET_CHAIN_ID
  const contractConfig = getContractConfig(ARC_MAINNET_CHAIN_ID)

  const { data: usdcBalance } = useReadContract({
    address: USDC_FACT.address as `0x${string}`,
    abi: erc20Abi,
    functionName: 'balanceOf',
    args: verifiedWallet && address ? [address] : undefined,
    chainId: ARC_MAINNET_CHAIN_ID,
    query: { enabled: verifiedWallet && isCorrectChain },
  })

  const handleNav = (route: AppRoute) => {
    onNavigate(route)
    setMobileMenuOpen(false)
  }

  return (
    <header className="sticky top-0 z-50 border-b border-white/10 bg-[#020816]/90 backdrop-blur-[14px]">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
        <div className="flex items-center justify-between h-14 gap-4">
          {/* Left: Brand identity + Desktop navigation */}
          <div className="flex items-center gap-6 min-w-0">
            <button
              type="button"
              onClick={() => handleNav('overview')}
              className="flex items-center gap-2.5 text-left group focus:outline-none flex-shrink-0"
              aria-label="PayGate402 home"
            >
              <div className="w-7 h-7 flex items-center justify-center">
                <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="#fff">
                  <circle cx="12.2" cy="11.9" r="8.45" strokeWidth="2" />
                  <path d="M12.2 0.1V24" strokeWidth="1.9" />
                  <path d="M0 11.9H24.4" strokeWidth="1.95" />
                </svg>
              </div>
              <div className="flex items-center gap-2">
                <span className="font-sans text-lg font-bold text-white tracking-tight whitespace-nowrap">
                  PayGate<span style={{ color: 'var(--peach)' }}>402</span>
                </span>
                <span className="hidden sm:inline-flex items-center px-1.5 py-0.5 text-[10px] font-mono whitespace-nowrap bg-white/10 text-[#cfd3e0] border border-white/10">
                  HTTP 402
                </span>
              </div>
            </button>

            {/* Primary Navigation — Desktop */}
            <nav aria-label="Main Navigation" className="hidden lg:flex items-center gap-1">
              {NAV_ITEMS.map(item => {
                const Icon = item.icon
                const isActive = activeRoute === item.id
                return (
                  <button
                    key={item.id}
                    type="button"
                    onClick={() => handleNav(item.id)}
                    aria-current={isActive ? 'page' : undefined}
                    className={`relative px-3 py-1.5 text-xs font-mono font-medium whitespace-nowrap transition-all flex items-center gap-1.5 ${
                      isActive
                        ? 'text-white bg-white/10'
                        : 'text-[#989eac] hover:text-white hover:bg-white/[0.04]'
                    }`}
                  >
                    <Icon size={13} className={`flex-shrink-0 ${isActive ? 'text-[var(--peach)]' : 'text-[#989eac]'}`} />
                    <span>{item.label}</span>
                    {item.id === 'explore' && serviceCount > 0 && (
                      <span className="ml-1 px-1.5 py-0.2 text-[10px] mono bg-[var(--peach)]/20 text-[var(--peach)]">
                        {serviceCount}
                      </span>
                    )}
                    {item.id === 'my-services' && verifiedWallet && myServiceCount > 0 && (
                      <span className="ml-1 px-1.5 py-0.2 text-[10px] mono bg-emerald-500/20 text-emerald-300">
                        {myServiceCount}
                      </span>
                    )}
                    {isActive && (
                      <span className="absolute inset-x-0 bottom-0 h-[2px] bg-[var(--peach)]" />
                    )}
                  </button>
                )
              })}
            </nav>
          </div>

          {/* Right: Agent CLI shortcut, Network status, USDC balance, Wallet */}
          <div className="flex items-center gap-2 flex-shrink-0">
            {/* Agent CLI Simulator button */}
            <button
              type="button"
              onClick={() => handleNav(activeRoute === 'cli' ? 'overview' : 'cli')}
              aria-current={activeRoute === 'cli' ? 'page' : undefined}
              className={`hidden sm:inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-mono whitespace-nowrap border transition-all ${
                activeRoute === 'cli'
                  ? 'bg-[var(--peach)]/20 border-[var(--peach)]/50 text-[var(--peach)]'
                  : 'bg-[#33344a]/60 backdrop-blur-[14px] border-white/10 text-[#cfd3e0] hover:text-white hover:border-white/20'
              }`}
              title="Interactive AI Agent CLI Simulator"
            >
              <Terminal size={13} className="text-[var(--peach)] flex-shrink-0" />
              <span>Agent CLI</span>
            </button>

            {/* Persistent Network & Contract Indicator */}
            {isWrongNetwork ? (
              <div className="flex items-center gap-1.5">
                <button
                  type="button"
                  onClick={() => switchChain({ chainId: ARC_MAINNET_CHAIN_ID })}
                  className="inline-flex items-center gap-1.5 px-3 py-1.5 bg-amber-500/20 border border-amber-500/40 text-amber-300 text-xs font-mono font-medium hover:bg-amber-500/30 transition-colors"
                  title="Switch wallet to Arc Mainnet (Chain ID 5042)"
                >
                  <AlertTriangle size={13} className="text-amber-400 flex-shrink-0" />
                  <span className="hidden sm:inline">Switch to Arc Mainnet (5042)</span>
                  <span className="sm:hidden">Switch to 5042</span>
                </button>
              </div>
            ) : (
              <div className="flex items-center gap-1.5">
                <a
                  href={getContractExplorerUrl(ARC_MAINNET_CHAIN_ID)}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="hidden md:inline-flex items-center gap-1.5 px-3 py-1.5 bg-[#33344a]/60 backdrop-blur-[14px] border border-white/10 hover:border-white/20 text-xs text-[#cfd3e0] whitespace-nowrap transition-colors"
                  title={`View PayGate402 Contract (${contractConfig.contractAddress}) on Arc Mainnet Explorer`}
                >
                  <span className="w-1.5 h-1.5 rounded-full flex-shrink-0 bg-emerald-400 shadow-[0_0_8px_rgba(52,211,153,0.5)]" />
                  <span className="font-medium font-sans">Arc Mainnet</span>
                  <span className="hidden 2xl:inline text-[#989eac] mono text-[11px]">{truncAddr(contractConfig.contractAddress)}</span>
                  <ExternalLink size={11} className="text-[#989eac] flex-shrink-0" />
                </a>
              </div>
            )}

            {/* Verified On-Chain USDC Balance */}
            {verifiedWallet && !isWrongNetwork && usdcBalance !== undefined && (
              <div
                className="hidden sm:flex items-center gap-1.5 px-3 py-1.5 bg-[#33344a]/60 backdrop-blur-[14px] border border-white/10"
                title="Verified on-chain ERC-20 USDC balance on Arc Mainnet"
              >
                <span className="text-xs font-semibold text-white tabular-nums mono">
                  {formatUsdcAmount(usdcBalance)}
                </span>
                <span className="text-[11px] font-medium text-[#989eac] mono">USDC</span>
              </div>
            )}

            {/* Wallet Connect Button */}
            <ConnectKitButton.Custom>
              {({ isConnected: ckConnected, show, address: ckAddr }) => {
                const actuallyConnected = Boolean(ckConnected && ckAddr)
                return (
                  <button
                    type="button"
                    onClick={show}
                    className={`inline-flex items-center gap-2 px-3 py-1.5 text-xs font-mono font-medium transition-all border ${
                      actuallyConnected
                        ? 'bg-[#33344a]/60 backdrop-blur-[14px] border-white/15 text-white hover:bg-[#424260]/66'
                        : 'bg-[#f93f28] border-[#f93f28] text-[#331200] hover:brightness-105'
                    }`}
                  >
                    <Wallet size={13} className={actuallyConnected ? 'text-[var(--peach)]' : 'text-[#331200]'} />
                    <span>
                      {actuallyConnected && ckAddr
                        ? `${ckAddr.slice(0, 6)}…${ckAddr.slice(-4)}`
                        : 'Connect'}
                    </span>
                  </button>
                )
              }}
            </ConnectKitButton.Custom>

            {/* Mobile Hamburger Toggle */}
            <button
              type="button"
              onClick={() => setMobileMenuOpen(o => !o)}
              aria-expanded={mobileMenuOpen}
              aria-label="Toggle navigation menu"
              className="lg:hidden p-2 rounded-lg bg-[#121520] border border-white/[0.08] text-[#D1D5DB] hover:text-white"
            >
              {mobileMenuOpen ? <X size={18} /> : <Menu size={18} />}
            </button>
          </div>
        </div>
      </div>

      {/* Responsive Mobile Navigation Drawer */}
      {mobileMenuOpen && (
        <div className="lg:hidden border-t border-white/[0.08] bg-[#0B0D14] px-4 pt-3 pb-4 space-y-3">
          <nav aria-label="Mobile Navigation" className="grid grid-cols-1 gap-1">
            {NAV_ITEMS.map(item => {
              const Icon = item.icon
              const isActive = activeRoute === item.id
              return (
                <button
                  key={item.id}
                  type="button"
                  onClick={() => handleNav(item.id)}
                  className={`flex items-center justify-between px-3 py-2.5 rounded-lg text-sm font-medium transition-colors ${
                    isActive
                      ? 'bg-[#7C5CFF]/15 text-white border border-[#7C5CFF]/35'
                      : 'text-[#9CA3AF] hover:text-white hover:bg-white/[0.04] border border-transparent'
                  }`}
                >
                  <span className="flex items-center gap-2.5">
                    <Icon size={16} className={isActive ? 'text-[#A78BFA]' : 'text-[#6B7280]'} />
                    {item.label}
                  </span>
                  {item.id === 'explore' && (
                    <span className="text-xs mono text-[#9CA3AF]">{serviceCount} on-chain</span>
                  )}
                </button>
              )
            })}
            <button
              type="button"
              onClick={() => handleNav('cli')}
              className={`flex items-center justify-between px-3 py-2.5 rounded-lg text-sm font-medium transition-colors ${
                activeRoute === 'cli'
                  ? 'bg-[#7C5CFF]/15 text-white border border-[#7C5CFF]/35'
                  : 'text-[#9CA3AF] hover:text-white hover:bg-white/[0.04] border border-transparent'
              }`}
            >
              <span className="flex items-center gap-2.5">
                <Terminal size={16} className="text-[#A78BFA]" />
                AI Agent CLI Simulator
              </span>
              <span className="text-[11px] mono px-1.5 py-0.5 rounded bg-white/[0.06] text-[#A78BFA]">
                Interactive
              </span>
            </button>
          </nav>

          {/* Mobile network & contract footer */}
          <div className="pt-2 border-t border-white/[0.08] flex items-center justify-between text-xs text-[#9CA3AF]">
            <div className="flex items-center gap-2">
              <span className={`w-2 h-2 rounded-full ${verifiedWallet ? 'bg-emerald-400' : 'bg-[#A78BFA]'}`} />
              <span>Arc Mainnet (5042)</span>
            </div>
            <a
              href={getContractExplorerUrl(ARC_MAINNET_CHAIN_ID)}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1 mono text-[#A78BFA] hover:underline"
            >
              {truncAddr(contractConfig.contractAddress)}
              <ExternalLink size={11} />
            </a>
          </div>
        </div>
      )}
    </header>
  )
}
