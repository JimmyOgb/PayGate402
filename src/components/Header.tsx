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
  ARC_TESTNET_CHAIN_ID,
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
  const isSupported = isSupportedChain(chainId)
  const isWrongNetwork = verifiedWallet && !isSupported
  const currentChainId = chainId === ARC_MAINNET_CHAIN_ID ? ARC_MAINNET_CHAIN_ID : ARC_TESTNET_CHAIN_ID
  const contractConfig = getContractConfig(currentChainId)

  const { data: usdcBalance } = useReadContract({
    address: USDC_FACT.address as `0x${string}`,
    abi: erc20Abi,
    functionName: 'balanceOf',
    args: verifiedWallet && address ? [address] : undefined,
    chainId: currentChainId,
    query: { enabled: verifiedWallet && isSupported },
  })

  const handleNav = (route: AppRoute) => {
    onNavigate(route)
    setMobileMenuOpen(false)
  }

  return (
    <header className="sticky top-0 z-50 border-b border-white/[0.08] bg-[#090A0F]/85 backdrop-blur-xl">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
        <div className="flex items-center justify-between h-16 gap-4">
          {/* Left: Brand identity + Desktop navigation */}
          <div className="flex items-center gap-4 min-w-0">
            <button
              type="button"
              onClick={() => handleNav('overview')}
              className="flex items-center gap-2.5 text-left group focus:outline-none flex-shrink-0"
            >
              <div className="w-8 h-8 rounded-lg bg-[#7C5CFF]/15 border border-[#7C5CFF]/35 flex items-center justify-center shadow-inner group-hover:border-[#7C5CFF]/60 transition-colors">
                <Shield size={16} className="text-[#A78BFA]" />
              </div>
              <div className="flex items-center gap-2">
                <span className="display text-base font-bold text-white tracking-tight whitespace-nowrap">
                  PayGate<span className="text-[#A78BFA]">402</span>
                </span>
                <span className="hidden sm:inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-semibold mono whitespace-nowrap bg-white/[0.06] text-[#9CA3AF] border border-white/[0.08]">
                  HTTP 402
                </span>
              </div>
            </button>

            {/* Primary Navigation — Desktop */}
            <nav aria-label="Main Navigation" className="hidden lg:flex items-center gap-0.5">
              {NAV_ITEMS.map(item => {
                const Icon = item.icon
                const isActive = activeRoute === item.id
                return (
                  <button
                    key={item.id}
                    type="button"
                    onClick={() => handleNav(item.id)}
                    aria-current={isActive ? 'page' : undefined}
                    className={`relative px-2.5 py-1.5 rounded-lg text-xs font-medium whitespace-nowrap transition-all flex items-center gap-1.5 ${
                      isActive
                        ? 'text-white bg-white/[0.07] shadow-sm'
                        : 'text-[#9CA3AF] hover:text-[#E5E7EB] hover:bg-white/[0.03]'
                    }`}
                  >
                    <Icon size={13} className={`flex-shrink-0 ${isActive ? 'text-[#A78BFA]' : 'text-[#6B7280]'}`} />
                    <span>{item.label}</span>
                    {item.id === 'explore' && serviceCount > 0 && (
                      <span className="ml-0.5 px-1.5 py-0.2 rounded text-[10px] mono bg-[#7C5CFF]/20 text-[#A78BFA]">
                        {serviceCount}
                      </span>
                    )}
                    {item.id === 'my-services' && verifiedWallet && myServiceCount > 0 && (
                      <span className="ml-0.5 px-1.5 py-0.2 rounded text-[10px] mono bg-emerald-500/20 text-emerald-300">
                        {myServiceCount}
                      </span>
                    )}
                    {isActive && (
                      <span className="absolute inset-x-2.5 -bottom-[15px] h-[2px] rounded-full bg-[#7C5CFF]" />
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
              className={`hidden sm:inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-xs font-medium whitespace-nowrap mono border transition-all ${
                activeRoute === 'cli'
                  ? 'bg-[#7C5CFF]/20 border-[#7C5CFF]/50 text-[#A78BFA]'
                  : 'bg-[#121520] border-white/[0.08] text-[#9CA3AF] hover:text-white hover:border-white/[0.16]'
              }`}
              title="Interactive AI Agent CLI Simulator"
            >
              <Terminal size={13} className="text-[#A78BFA] flex-shrink-0" />
              <span>Agent CLI</span>
            </button>

            {/* Persistent Network & Contract Indicator */}
            {isWrongNetwork ? (
              <div className="flex items-center gap-1.5">
                <button
                  type="button"
                  onClick={() => switchChain({ chainId: ARC_MAINNET_CHAIN_ID })}
                  className="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg bg-amber-500/15 border border-amber-500/35 text-amber-300 text-xs font-medium whitespace-nowrap hover:bg-amber-500/25 transition-colors"
                  title="Switch wallet to Arc Mainnet (Chain ID 5042)"
                >
                  <AlertTriangle size={13} className="text-amber-400 flex-shrink-0" />
                  <span className="hidden sm:inline">Switch to Mainnet</span>
                  <span className="sm:hidden">Mainnet</span>
                </button>
                <button
                  type="button"
                  onClick={() => switchChain({ chainId: ARC_TESTNET_CHAIN_ID })}
                  className="hidden md:inline-flex items-center gap-1.5 px-2 py-1.5 rounded-lg bg-white/[0.04] border border-white/[0.08] text-[#9CA3AF] text-xs font-medium whitespace-nowrap hover:bg-white/[0.08] transition-colors"
                  title="Switch wallet to Arc Testnet (Chain ID 5042002)"
                >
                  <span>Testnet</span>
                </button>
              </div>
            ) : (
              <div className="flex items-center gap-1.5">
                <a
                  href={getContractExplorerUrl(currentChainId)}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="hidden md:inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg bg-[#121520] border border-white/[0.08] hover:border-white/[0.16] text-xs text-[#D1D5DB] whitespace-nowrap transition-colors"
                  title={`View PayGate402 Contract (${contractConfig.contractAddress}) on ${contractConfig.chainName} Explorer`}
                >
                  <span
                    className={`w-1.5 h-1.5 rounded-full flex-shrink-0 ${
                      contractConfig.isMainnet ? 'bg-emerald-400 shadow-[0_0_8px_rgba(52,211,153,0.5)]' : 'bg-[#A78BFA]'
                    }`}
                  />
                  <span className="font-medium">{contractConfig.chainName}</span>
                  <span className="hidden 2xl:inline text-[#6B7280] mono text-[11px]">{truncAddr(contractConfig.contractAddress)}</span>
                  <ExternalLink size={11} className="text-[#6B7280] flex-shrink-0" />
                </a>

                {/* Network Switcher Toggle Button */}
                {verifiedWallet && (
                  <button
                    type="button"
                    onClick={() =>
                      switchChain({
                        chainId:
                          currentChainId === ARC_MAINNET_CHAIN_ID
                            ? ARC_TESTNET_CHAIN_ID
                            : ARC_MAINNET_CHAIN_ID,
                      })
                    }
                    className="inline-flex items-center px-2 py-1.5 rounded-lg bg-white/[0.04] border border-white/[0.08] hover:bg-white/[0.08] text-[11px] text-[#9CA3AF] hover:text-white transition-colors"
                    title={`Switch network to ${
                      currentChainId === ARC_MAINNET_CHAIN_ID ? 'Arc Testnet (5042002)' : 'Arc Mainnet (5042)'
                    }`}
                  >
                    {currentChainId === ARC_MAINNET_CHAIN_ID ? 'Testnet' : 'Mainnet'}
                  </button>
                )}
              </div>
            )}

            {/* Verified On-Chain USDC Balance */}
            {verifiedWallet && !isWrongNetwork && usdcBalance !== undefined && (
              <div
                className="hidden sm:flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg bg-[#121520] border border-white/[0.08]"
                title="Verified on-chain ERC-20 USDC balance on Arc Testnet"
              >
                <span className="text-xs font-semibold text-white tabular-nums mono">
                  {formatUsdcAmount(usdcBalance)}
                </span>
                <span className="text-[11px] font-medium text-[#9CA3AF] mono">USDC</span>
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
                    className={`inline-flex items-center gap-2 px-3 py-1.5 rounded-lg text-xs font-medium transition-all border ${
                      actuallyConnected
                        ? 'bg-[#151925] border-white/[0.12] text-[#F3F4F6] hover:bg-[#1C2130] hover:border-white/[0.2]'
                        : 'bg-[#7C5CFF] border-[#7C5CFF] text-white hover:bg-[#8B6EFF] shadow-sm'
                    }`}
                  >
                    <Wallet size={13} className={actuallyConnected ? 'text-[#A78BFA]' : 'text-white'} />
                    <span className={actuallyConnected ? 'mono' : ''}>
                      {actuallyConnected && ckAddr
                        ? `${ckAddr.slice(0, 6)}…${ckAddr.slice(-4)}`
                        : 'Connect Wallet'}
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
              <span>Arc Testnet (5042002)</span>
            </div>
            <a
              href={getContractExplorerUrl()}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1 mono text-[#A78BFA] hover:underline"
            >
              {truncAddr(PAYGATE402_ADDRESS)}
              <ExternalLink size={11} />
            </a>
          </div>
        </div>
      )}
    </header>
  )
}
