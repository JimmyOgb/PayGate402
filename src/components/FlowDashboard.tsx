import { useState, useEffect, useRef, useCallback } from 'react'
import {
  Lock,
  Check,
  X,
  Copy,
  ChevronDown,
  Home,
  LayoutGrid,
  History,
  Settings,
  Shield,
  TrendingUp,
  Activity,
  AlertTriangle,
  RefreshCw,
  ExternalLink,
} from 'lucide-react'
import {
  useAccount,
  usePublicClient,
  useWriteContract,
  useWaitForTransactionReceipt,
  useReadContract,
  useSignTypedData,
} from 'wagmi'
import { erc20Abi } from 'viem'
import { toast } from 'sonner'
import {
  PAYGATE402,
  PAYGATE402_ADDRESS,
  USDC_FACT,
  ARC_TESTNET_CHAIN_ID,
  ARC_MAINNET_CHAIN_ID,
  getTxExplorerUrl,
  ServiceData,
  truncAddr,
} from '@/lib/paygate402'
import {
  authorizeConfirmedPaymentWithGateway,
  checkConsumerWalletCompatibility,
  checkGatewayStatus,
  requestPaymentChallenge,
  validateAuthoritativeChallenge,
  type ChallengeData,
  type GatewayHealthStatus,
} from '@/lib/gatewayClient'
import { AppRoute } from './Header'

export type FlowScreen =
  | 'selection'
  | 'challenge'
  | 'confirm'
  | 'verifying'
  | 'success'
  | 'different_endpoint'

interface FlowDashboardProps {
  services: ServiceData[]
  onNavigate?: (route: AppRoute) => void
  onRefresh?: () => void
}

interface SelectedServiceMeta {
  serviceId: bigint
  name: string
  description: string
  priceUsdc: bigint
  priceFormatted: string
  endpointPath: string
  iconType: 'whale' | 'chart' | 'shield'
  gatedPayload: string
}

const DEFAULT_FLOW_SERVICES: SelectedServiceMeta[] = [
  {
    serviceId: 0n,
    name: 'Whale Accumulation Signals',
    description: 'Real-time alerts for large wallet movements and accumulation patterns.',
    priceUsdc: 100_000n,
    priceFormatted: '0.10 USDC',
    endpointPath: '/v1/signals/whale-accumulation',
    iconType: 'whale',
    gatedPayload: JSON.stringify(
      {
        _notice: 'DEMO/SYNTHETIC SAMPLE — NOT LIVE MARKET DATA',
        service: 'whale-accumulation',
        signal: {
          address: '0x3ff...a1b2',
          amount: '125000.00',
          confidence: 0.87,
          timestamp: '2025-06-15T12:34:56Z',
        },
      },
      null,
      2
    ),
  },
  {
    serviceId: 1n,
    name: 'DeFi Market Analysis',
    description: 'On-chain analysis and market insights for DeFi protocols.',
    priceUsdc: 500_000n,
    priceFormatted: '0.50 USDC',
    endpointPath: '/v1/signals/market-analysis',
    iconType: 'chart',
    gatedPayload: JSON.stringify(
      {
        _notice: 'DEMO/SYNTHETIC SAMPLE — NOT LIVE MARKET DATA',
        service: 'market-analysis',
        liquidity_trend: 'ACCUMULATING',
        top_pools: ['USDC-ETH', 'ARC-USDC'],
        risk_index: 0.22,
        timestamp: '2025-06-15T12:35:00Z',
      },
      null,
      2
    ),
  },
  {
    serviceId: 2n,
    name: 'Security Audit',
    description: 'AI-powered smart contract security analysis.',
    priceUsdc: 1_000_000n,
    priceFormatted: '1.00 USDC',
    endpointPath: '/v1/audit/security-analysis',
    iconType: 'shield',
    gatedPayload: JSON.stringify(
      {
        _notice: 'DEMO/SYNTHETIC SAMPLE — NOT LIVE MARKET DATA',
        service: 'security-audit',
        contract: '0xcc69506b784dffda4ee4d221b122303304099971',
        vulnerabilities: [],
        reentrancy_safe: true,
        score: 'A+',
        timestamp: '2025-06-15T12:35:10Z',
      },
      null,
      2
    ),
  },
]

function syntaxHighlightJson(json: string): string {
  return json
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/("[\w_]+")\s*:/g, '<span class="text-amber-300 font-semibold">$1</span>:')
    .replace(/:\s*(".*?")/g, ': <span class="text-emerald-300">$1</span>')
    .replace(/:\s*(\d+\.?\d*)/g, ': <span class="text-cyan-400">$1</span>')
    .replace(/:\s*(true|false)/g, ': <span class="text-purple-400 font-bold">$1</span>')
}

export function FlowDashboard({ onNavigate, onRefresh }: FlowDashboardProps) {
  const { address, isConnected, chainId } = useAccount()
  const currentChainId = chainId === ARC_TESTNET_CHAIN_ID ? ARC_TESTNET_CHAIN_ID : ARC_MAINNET_CHAIN_ID
  const isMainnet = currentChainId === ARC_MAINNET_CHAIN_ID
  const chainName = isMainnet ? 'Arc Mainnet' : 'Arc Testnet'
  const publicClient = usePublicClient({ chainId: currentChainId })

  const [currentScreen, setCurrentScreen] = useState<FlowScreen>('selection')
  const [selectedService, setSelectedService] = useState<SelectedServiceMeta>(DEFAULT_FLOW_SERVICES[0])
  const [challenge, setChallenge] = useState<ChallengeData | null>(null)
  const [challengeError, setChallengeError] = useState<string | null>(null)
  const [confirmError, setConfirmError] = useState<string | null>(null)
  const [activeTxHash, setActiveTxHash] = useState<`0x${string}` | null>(null)
  const [verifiedPayload, setVerifiedPayload] = useState<string | null>(null)
  const [copiedId, setCopiedId] = useState(false)
  const [gatewayHealth, setGatewayHealth] = useState<GatewayHealthStatus | null>(null)
  const [isSmartAccountWallet, setIsSmartAccountWallet] = useState(false)
  const [sidebarTab, setSidebarTab] = useState<'home' | 'services' | 'history' | 'settings'>('home')

  // Previous payment endpoint tracker for replay isolation demo (Screen 6)
  const [previousPaymentEndpoint, setPreviousPaymentEndpoint] = useState<string>('/v1/signals/whale-accumulation')

  const gatewayOnline = Boolean(gatewayHealth?.online)
  const isMockGateway = Boolean(gatewayHealth?.mockRpc)

  // Wagmi contracts hooks
  const { data: usdcAllowance, refetch: refetchAllowance } = useReadContract({
    address: USDC_FACT.address as `0x${string}`,
    abi: erc20Abi,
    functionName: 'allowance',
    args: isConnected && address ? [address, PAYGATE402.address] : undefined,
    chainId: currentChainId,
    query: { enabled: Boolean(isConnected && address) },
  })

  const { writeContract: writeApprove, data: approveHash } = useWriteContract()
  const { isSuccess: isApproveConfirmed } = useWaitForTransactionReceipt({ hash: approveHash })

  const { writeContract: writePay, data: payHash } = useWriteContract()
  const { isLoading: isPayConfirming } = useWaitForTransactionReceipt({ hash: payHash })
  const { signTypedDataAsync, isPending: isSigning } = useSignTypedData()

  const [isSimulated, setIsSimulated] = useState<boolean>(false)
  const [isAuthorizing, setIsAuthorizing] = useState<boolean>(false)
  const [authError, setAuthError] = useState<string | null>(null)

  // Check gateway health on mount
  useEffect(() => {
    void checkGatewayStatus().then(setGatewayHealth)
  }, [])

  // Detect smart contract / ERC-4337 wallets
  useEffect(() => {
    let cancelled = false
    if (!isConnected || !address || !publicClient) {
      void Promise.resolve().then(() => {
        if (!cancelled) setIsSmartAccountWallet(false)
      })
      return () => {
        cancelled = true
      }
    }

    void publicClient
      .getBytecode({ address })
      .then(bytecode => {
        if (!cancelled) {
          setIsSmartAccountWallet(Boolean(bytecode && bytecode !== '0x' && bytecode.length > 2))
        }
      })
      .catch(() => {
        if (!cancelled) setIsSmartAccountWallet(false)
      })

    return () => {
      cancelled = true
    }
  }, [isConnected, address, publicClient])

  // Auto handle approve confirmation to trigger payment using authoritative challenge
  const approveHandledRef = useRef(false)
  useEffect(() => {
    if (isApproveConfirmed && !approveHandledRef.current && challenge && isConnected) {
      approveHandledRef.current = true
      void refetchAllowance().then(() => {
        writePay({
          address: PAYGATE402.address,
          abi: PAYGATE402.abi,
          functionName: 'payForAccess',
          args: [BigInt(challenge.serviceId), challenge.requestId],
          chainId: currentChainId,
        })
      })
    }
    if (!isApproveConfirmed) approveHandledRef.current = false
  }, [isApproveConfirmed, challenge, isConnected, refetchAllowance, writePay])

  // Watch real on-chain transaction hash
  useEffect(() => {
    if (payHash) {
      void Promise.resolve().then(() => {
        setIsSimulated(false)
        setActiveTxHash(payHash)
        setAuthError(null)
        setCurrentScreen('verifying')
      })
    }
  }, [payHash])

  // Explicit, user-initiated EIP-712 wallet signing & gateway authorization
  const handleSignAndAuthorize = useCallback(async () => {
    if (!activeTxHash || !challenge || !address) {
      toast.error('Connect your wallet and confirm payment first')
      return
    }

    setIsAuthorizing(true)
    setAuthError(null)

    try {
      const status = await checkGatewayStatus()
      setGatewayHealth(status)
      if (!status.online) {
        throw new Error('PayGate402 Gateway server is unreachable on localhost:4020.')
      }

      const result = await authorizeConfirmedPaymentWithGateway({
        challenge,
        txHash: activeTxHash,
        payerAddress: address,
        body: '',
        signTypedData: args => signTypedDataAsync(args),
      })

      if (result.status === 200) {
        setVerifiedPayload(JSON.stringify(result.payload, null, 2))
        setPreviousPaymentEndpoint(selectedService.endpointPath)
        setCurrentScreen('success')
        toast.success('Gateway verified on-chain payment and authorized protected access!')
        onRefresh?.()
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err)
      setAuthError(msg)
      toast.error(`Authorization rejected: ${msg}`)
    } finally {
      setIsAuthorizing(false)
    }
  }, [activeTxHash, challenge, address, selectedService, signTypedDataAsync, onRefresh])

  // Step 1: User clicks "Try It" on a service -> Request authoritative HTTP 402 challenge from gateway
  // Never generates a synthetic local challenge on failure.
  const handleSelectService = useCallback(
    async (service: SelectedServiceMeta) => {
      setSelectedService(service)
      setChallenge(null)
      setChallengeError(null)
      setConfirmError(null)
      setIsSimulated(false)

      try {
        const status = await checkGatewayStatus()
        setGatewayHealth(status)
        if (!status.online) {
          throw new Error(
            'PayGate402 Gateway is offline at localhost:4020. Challenge issuance failed and wallet transactions are disabled.'
          )
        }

        const result = await requestPaymentChallenge({
          serviceId: service.serviceId,
          subPath: service.endpointPath,
          method: 'POST',
          body: '',
          payerAddress: address,
        })
        setChallenge(result.challenge)
        setCurrentScreen('challenge')
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err)
        setChallenge(null)
        setChallengeError(msg)
        setCurrentScreen('challenge')
        toast.error(`HTTP 402 challenge failed: ${msg}`)
      }
    },
    [address]
  )

  // Step 2: User clicks "Continue to Pay" -> Shows Screen 3 (Wallet confirmation) only when challenge is valid
  const handleContinueToPay = () => {
    if (!challenge || challengeError) {
      toast.error('Cannot proceed to payment without a valid HTTP 402 gateway challenge.')
      return
    }
    setConfirmError(null)
    setCurrentScreen('confirm')
  }

  // Step 3: User clicks "Confirm" in wallet popup
  const handleWalletConfirm = async () => {
    if (!challenge || challengeError) {
      setConfirmError('Missing valid HTTP 402 gateway challenge. Payment transaction blocked.')
      return
    }

    try {
      validateAuthoritativeChallenge(challenge, {
        serviceId: BigInt(challenge.serviceId),
        method: challenge.method,
        subPath: challenge.path,
        body: '',
      })
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err)
      setConfirmError(msg)
      toast.error(`Invalid challenge: ${msg}`)
      return
    }

    // If real wallet connected on Arc (Mainnet or Testnet), enforce EOA & live gateway mode before allowing wallet tx
    if (isConnected && address && (chainId === ARC_MAINNET_CHAIN_ID || chainId === ARC_TESTNET_CHAIN_ID) && !isSimulated) {
      if (isMockGateway) {
        const msg =
          `SIMULATED DEMO — NOT ON-CHAIN AUTHORIZED: Gateway is in Mock RPC mode. Live wallet transactions are blocked to prevent spending real ${chainName} USDC.`
        setConfirmError(msg)
        toast.error(msg)
        return
      }

      if (isSmartAccountWallet) {
        const msg =
          'Incompatible wallet: Smart contract / ERC-4337 wallets are not supported by the PayGate402 Gateway verifier (requires direct EOA tx.from == caller).'
        setConfirmError(msg)
        toast.error(msg)
        return
      }

      try {
        await checkConsumerWalletCompatibility({
          address,
          getBytecode: publicClient ? addr => publicClient.getBytecode({ address: addr }) : undefined,
        })
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err)
        setConfirmError(msg)
        toast.error(msg)
        return
      }

      setIsSimulated(false)
      setAuthError(null)
      setConfirmError(null)
      const requiredPrice = BigInt(challenge.quotedPrice)
      const currentAllowance = usdcAllowance ?? 0n

      if (currentAllowance < requiredPrice) {
        toast.info(`Approving USDC for PayGate402 on ${chainName}...`)
        writeApprove({
          address: USDC_FACT.address as `0x${string}`,
          abi: erc20Abi,
          functionName: 'approve',
          args: [PAYGATE402.address, requiredPrice],
          chainId: currentChainId,
        })
        return
      }

      writePay({
        address: PAYGATE402.address,
        abi: PAYGATE402.abi,
        functionName: 'payForAccess',
        args: [BigInt(challenge.serviceId), challenge.requestId],
        chainId: currentChainId,
      })
      return
    }

    // Offline / non-wallet simulated preview (never invokes wallet transaction methods)
    setIsSimulated(true)
    setAuthError(null)
    setConfirmError(null)
    setActiveTxHash('0x1111111111111111111111111111111111111111111111111111111111111111')
    setCurrentScreen('verifying')
  }

  const handleCopyRequestId = () => {
    if (!challenge) return
    void navigator.clipboard.writeText(challenge.requestId)
    setCopiedId(true)
    setTimeout(() => setCopiedId(false), 1500)
  }

  // Jump to step (walkthrough bar — strictly non-transactional UI inspection)
  const handleJumpToStep = (screen: FlowScreen) => {
    setIsSimulated(true)
    if (!activeTxHash) {
      setActiveTxHash('0x1234abcd7890ef1234567890abcdef1234567890abcdef1234567890abcdef12')
    }
    if (!verifiedPayload) {
      setVerifiedPayload(selectedService.gatedPayload)
    }
    setCurrentScreen(screen)
  }

  return (
    <div className="w-full flex flex-col space-y-6">
      {/* Top Main Frame Container with Outer Border */}
      <div className="w-full rounded-2xl bg-[#0B0D14] border border-white/[0.08] shadow-2xl overflow-hidden min-h-[620px] flex flex-col">
        {/* Top Header Bar */}
        <div className="h-16 px-6 border-b border-white/[0.08] flex items-center justify-between bg-[#090A0F]/90 backdrop-blur-md">
          {/* Logo brand */}
          <div className="flex items-center gap-2.5">
            <div className="w-7 h-7 rounded-lg bg-blue-600/20 border border-blue-500/40 flex items-center justify-center">
              <Shield size={16} className="text-blue-400" />
            </div>
            <span className="font-bold text-base text-white tracking-tight">
              PayGate<span className="text-blue-500">402</span>
            </span>
          </div>

          {/* Network and Wallet Badges */}
          <div className="flex items-center gap-3">
            {/* Network Pill */}
            <div className="flex items-center gap-2 px-3 py-1 rounded-full bg-white/[0.05] border border-white/[0.08] text-xs text-gray-300">
              <span className="w-2 h-2 rounded-full bg-emerald-400 animate-pulse" />
              <span>{chainName}</span>
            </div>

            {/* Wallet Pill */}
            <div className="flex items-center gap-2 px-3 py-1 rounded-full bg-purple-950/40 border border-purple-500/30 text-xs text-purple-200">
              <span className="w-2.5 h-2.5 rounded-full bg-purple-400" />
              <span className="mono font-medium">
                {isConnected && address ? truncAddr(address) : '0x742d...3af8'}
              </span>
              <ChevronDown size={13} className="text-purple-300" />
            </div>
          </div>
        </div>

        {/* Content Body: Sidebar + Main Area */}
        <div className="flex flex-1 min-h-[540px]">
          {/* Left Navigation Sidebar */}
          <div className="w-48 border-r border-white/[0.07] bg-[#0A0C13] p-4 flex flex-col justify-between hidden md:flex">
            <div className="space-y-1.5">
              <button
                type="button"
                onClick={() => {
                  setSidebarTab('home')
                  setCurrentScreen('selection')
                }}
                className={`w-full flex items-center gap-3 px-3 py-2.5 rounded-xl text-xs font-medium transition-all ${
                  sidebarTab === 'home'
                    ? 'bg-blue-600/20 text-blue-400 border border-blue-500/30 shadow-sm'
                    : 'text-gray-400 hover:text-white hover:bg-white/[0.03]'
                }`}
              >
                <Home size={15} />
                <span>Home</span>
              </button>

              <button
                type="button"
                onClick={() => {
                  setSidebarTab('services')
                  setCurrentScreen('selection')
                }}
                className={`w-full flex items-center gap-3 px-3 py-2.5 rounded-xl text-xs font-medium transition-all ${
                  sidebarTab === 'services'
                    ? 'bg-blue-600/20 text-blue-400 border border-blue-500/30 shadow-sm'
                    : 'text-gray-400 hover:text-white hover:bg-white/[0.03]'
                }`}
              >
                <LayoutGrid size={15} />
                <span>Services</span>
              </button>

              <button
                type="button"
                onClick={() => {
                  setSidebarTab('history')
                  onNavigate?.('transactions')
                }}
                className={`w-full flex items-center gap-3 px-3 py-2.5 rounded-xl text-xs font-medium transition-all ${
                  sidebarTab === 'history'
                    ? 'bg-blue-600/20 text-blue-400 border border-blue-500/30 shadow-sm'
                    : 'text-gray-400 hover:text-white hover:bg-white/[0.03]'
                }`}
              >
                <History size={15} />
                <span>History</span>
              </button>

              <button
                type="button"
                onClick={() => {
                  setSidebarTab('settings')
                  onNavigate?.('cli')
                }}
                className={`w-full flex items-center gap-3 px-3 py-2.5 rounded-xl text-xs font-medium transition-all ${
                  sidebarTab === 'settings'
                    ? 'bg-blue-600/20 text-blue-400 border border-blue-500/30 shadow-sm'
                    : 'text-gray-400 hover:text-white hover:bg-white/[0.03]'
                }`}
              >
                <Settings size={15} />
                <span>Settings</span>
              </button>
            </div>

            {/* Gateway status indicator */}
            <div className="pt-4 border-t border-white/[0.06] text-[11px] text-gray-500 flex items-center justify-between">
              <span>Gateway</span>
              <span className="inline-flex items-center gap-1.5 text-emerald-400">
                <span className="w-1.5 h-1.5 rounded-full bg-emerald-400" />
                {gatewayOnline ? 'Online (4020)' : 'Active (Arc RPC)'}
              </span>
            </div>
          </div>

          {/* Right Main Content Pane */}
          <div className="flex-1 p-6 md:p-8 flex flex-col justify-center items-center relative overflow-hidden bg-radial-gradient">
            {/* SCREEN 1: Main App — Service Selection */}
            {currentScreen === 'selection' && (
              <div className="w-full max-w-2xl space-y-7 animate-in fade-in duration-300">
                {/* Hero Title and Subtitle */}
                <div className="space-y-2">
                  <h1 className="text-3xl md:text-4xl font-extrabold text-white tracking-tight">
                    Pay for{' '}
                    <span className="bg-gradient-to-r from-blue-400 to-indigo-400 bg-clip-text text-transparent">
                      AI Data. On-Chain.
                    </span>
                  </h1>
                  <p className="text-sm text-gray-400 max-w-lg">
                    Access premium intelligence with secure, per-call payments using PayGate402 on {chainName}.
                  </p>
                </div>

                {/* Service Cards List */}
                <div className="space-y-3.5">
                  {DEFAULT_FLOW_SERVICES.map(svc => (
                    <div
                      key={svc.serviceId.toString()}
                      className="p-4 rounded-xl bg-[#10131D] border border-white/[0.08] hover:border-white/[0.16] transition-all flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4 shadow-sm"
                    >
                      <div className="flex items-center gap-4">
                        {/* Icon */}
                        <div
                          className={`w-12 h-12 rounded-xl flex items-center justify-center flex-shrink-0 ${
                            svc.iconType === 'whale'
                              ? 'bg-blue-600/20 text-blue-400 border border-blue-500/30'
                              : svc.iconType === 'chart'
                              ? 'bg-indigo-600/20 text-indigo-400 border border-indigo-500/30'
                              : 'bg-cyan-600/20 text-cyan-400 border border-cyan-500/30'
                          }`}
                        >
                          {svc.iconType === 'whale' && <Activity size={22} />}
                          {svc.iconType === 'chart' && <TrendingUp size={22} />}
                          {svc.iconType === 'shield' && <Shield size={22} />}
                        </div>

                        {/* Title and Description */}
                        <div>
                          <div className="flex items-center gap-2.5">
                            <h3 className="font-semibold text-white text-sm">{svc.name}</h3>
                            <span className="text-[11px] px-2 py-0.5 rounded-md bg-white/[0.06] text-gray-400 mono">
                              Service ID: {svc.serviceId.toString()}
                            </span>
                          </div>
                          <p className="text-xs text-gray-400 mt-0.5 max-w-md">{svc.description}</p>
                        </div>
                      </div>

                      {/* Price pill + Try It button */}
                      <div className="flex items-center gap-4 self-end sm:self-center">
                        <div className="text-right">
                          <span className="text-xs font-bold text-white mono">{svc.priceFormatted}</span>
                          <span className="block text-[10px] text-gray-500">per call</span>
                        </div>
                        <button
                          type="button"
                          onClick={() => {
                            void handleSelectService(svc)
                          }}
                          className="px-4 py-2 rounded-lg bg-blue-600 hover:bg-blue-500 text-white text-xs font-semibold shadow-md transition-all active:scale-95"
                        >
                          Try It
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* SCREEN 2: HTTP 402 Payment Challenge */}
            {currentScreen === 'challenge' && (
              <div className="w-full max-w-md p-6 rounded-2xl bg-[#10131D] border border-white/[0.08] shadow-2xl space-y-6 text-center animate-in zoom-in-95 duration-200">
                {challenge ? (
                  <>
                    {/* Blue Lock Badge */}
                    <div className="w-14 h-14 rounded-full bg-blue-600 flex items-center justify-center mx-auto shadow-lg shadow-blue-600/30">
                      <Lock size={24} className="text-white" />
                    </div>

                    <div className="space-y-1">
                      <h2 className="text-lg font-bold text-white">Payment Required</h2>
                      <p className="text-xs text-gray-400">
                        This endpoint requires a one-time payment to continue.
                      </p>
                    </div>

                    {isMockGateway && (
                      <div className="p-3 rounded-xl bg-amber-500/10 border border-amber-500/30 text-amber-300 text-xs text-left flex items-start gap-2">
                        <AlertTriangle size={15} className="text-amber-400 flex-shrink-0 mt-0.5" />
                        <div>
                          <div className="font-semibold text-amber-200">
                            SIMULATED DEMO — NOT ON-CHAIN AUTHORIZED
                          </div>
                          <div className="text-[11px] mt-0.5">
                            Gateway is running in Mock RPC mode. Live wallet transactions are blocked to prevent spending real {chainName} USDC.
                          </div>
                        </div>
                      </div>
                    )}

                    {/* Challenge Details Table */}
                    <div className="p-4 rounded-xl bg-[#090A0F] border border-white/[0.06] space-y-2.5 text-xs text-left">
                      <div className="flex items-center justify-between text-gray-400">
                        <span>Service</span>
                        <span className="text-white font-medium">{selectedService.name}</span>
                      </div>
                      <div className="flex items-center justify-between text-gray-400">
                        <span>Service ID</span>
                        <span className="text-white mono">{challenge.serviceId}</span>
                      </div>
                      <div className="flex items-center justify-between text-gray-400">
                        <span>Price</span>
                        <span className="text-white font-semibold mono">{challenge.quotedPriceFormatted}</span>
                      </div>
                      <div className="flex items-center justify-between text-gray-400">
                        <span>Method / Path</span>
                        <span className="text-gray-300 mono">
                          {challenge.method} {challenge.path}
                        </span>
                      </div>
                      <div className="flex items-center justify-between text-gray-400">
                        <span>Body Digest</span>
                        <span className="text-gray-300 mono" title={challenge.bodyDigest}>
                          {truncAddr(challenge.bodyDigest)}
                        </span>
                      </div>
                      <div className="flex items-center justify-between text-gray-400">
                        <span>Request ID</span>
                        <button
                          type="button"
                          onClick={handleCopyRequestId}
                          className="mono text-gray-300 hover:text-white flex items-center gap-1"
                          title="Copy Request ID"
                        >
                          {truncAddr(challenge.requestId)}
                          {copiedId ? <Check size={12} className="text-emerald-400" /> : <Copy size={12} />}
                        </button>
                      </div>
                    </div>

                    {/* Acceptance Text */}
                    <div className="space-y-1 text-left">
                      <h4 className="text-xs font-semibold text-white">Accept Payment</h4>
                      <p className="text-[11px] text-gray-400">
                        Approve USDC and sign the request to complete the payment.
                      </p>
                    </div>

                    {/* Action Buttons */}
                    <div className="space-y-2 pt-1">
                      <button
                        type="button"
                        onClick={handleContinueToPay}
                        className="w-full py-2.5 rounded-xl bg-blue-600 hover:bg-blue-500 text-white font-medium text-xs shadow-md transition-all active:scale-95"
                      >
                        Continue to Pay ({challenge.quotedPriceFormatted})
                      </button>
                      <button
                        type="button"
                        onClick={() => setCurrentScreen('selection')}
                        className="w-full py-2 text-xs text-gray-400 hover:text-white transition-colors"
                      >
                        Cancel
                      </button>
                    </div>
                  </>
                ) : (
                  <>
                    <div className="w-14 h-14 rounded-full bg-rose-500/20 border border-rose-500/40 flex items-center justify-center mx-auto text-rose-400">
                      <AlertTriangle size={24} />
                    </div>
                    <div className="space-y-1">
                      <h2 className="text-lg font-bold text-white">Challenge Issuance Failed</h2>
                      <p className="text-xs text-gray-400">
                        Fail-closed protection active: no synthetic local challenge was created and wallet payment actions are disabled.
                      </p>
                    </div>
                    <div className="p-3 rounded-xl bg-rose-500/10 border border-rose-500/30 text-rose-300 text-xs text-left">
                      <div className="font-semibold text-rose-200">Gateway Error</div>
                      <div className="text-[11px] mt-1">
                        {challengeError ||
                          'No authoritative HTTP 402 challenge is loaded. Return to Service Selection and click "Try It" while the Gateway is online.'}
                      </div>
                    </div>
                    <div className="space-y-2 pt-1">
                      <button
                        type="button"
                        disabled
                        className="w-full py-2.5 rounded-xl bg-white/[0.06] text-gray-500 font-medium text-xs cursor-not-allowed"
                      >
                        Payment Disabled (No Valid Gateway Challenge)
                      </button>
                      <button
                        type="button"
                        onClick={() => setCurrentScreen('selection')}
                        className="w-full py-2 text-xs text-gray-300 hover:text-white transition-colors"
                      >
                        Back to Services
                      </button>
                    </div>
                  </>
                )}
              </div>
            )}

            {/* SCREEN 3: Wallet Confirmation Modal */}
            {currentScreen === 'confirm' && (
              <div className="w-full max-w-sm rounded-2xl bg-[#111420] border border-white/[0.12] shadow-2xl p-5 space-y-4 animate-in zoom-in-95 duration-200">
                {/* Title Bar with 'X' */}
                <div className="flex items-center justify-between pb-2 border-b border-white/[0.06]">
                  <div className="flex items-center gap-2">
                    <div className="w-5 h-5 rounded-md bg-blue-600/30 flex items-center justify-center text-blue-400">
                      <Shield size={12} />
                    </div>
                    <span className="text-xs font-semibold text-white">Confirm Transaction</span>
                  </div>
                  <button
                    type="button"
                    onClick={() => setCurrentScreen('challenge')}
                    className="text-gray-400 hover:text-white"
                  >
                    <X size={15} />
                  </button>
                </div>

                {/* Sub Bar: Network tag & Account */}
                <div className="flex items-center justify-between text-[11px] text-gray-400 px-1">
                  <div className="flex items-center gap-1.5 text-blue-400">
                    <span className="w-1.5 h-1.5 rounded-full bg-blue-400" />
                    <span>{chainName}</span>
                  </div>
                  <span className="mono text-gray-300">
                    {isConnected && address ? truncAddr(address) : 'Offline Preview'}
                  </span>
                </div>

                {/* DApp identifier banner */}
                <div className="p-3 rounded-xl bg-[#0B0D14] border border-white/[0.06] flex items-center gap-3">
                  <div className="w-8 h-8 rounded-lg bg-blue-600/20 border border-blue-500/30 flex items-center justify-center text-blue-400">
                    <Shield size={16} />
                  </div>
                  <div>
                    <span className="block text-xs font-semibold text-white">PayGate402</span>
                    <span className="text-[10px] text-gray-400 mono">http://localhost:4020</span>
                  </div>
                </div>

                {isSmartAccountWallet && (
                  <div className="p-3 rounded-xl bg-rose-500/10 border border-rose-500/30 text-rose-300 text-xs text-left flex items-start gap-2">
                    <AlertTriangle size={15} className="text-rose-400 flex-shrink-0 mt-0.5" />
                    <div>
                      <div className="font-semibold text-rose-200">Incompatible Smart Account Wallet</div>
                      <div className="text-[11px] mt-0.5">
                        Contract bytecode detected on connected wallet. Gateway verification requires direct EOA transactions (<span className="mono">tx.from == caller</span>).
                      </div>
                    </div>
                  </div>
                )}

                {isMockGateway && isConnected && (
                  <div className="p-3 rounded-xl bg-amber-500/10 border border-amber-500/30 text-amber-300 text-xs text-left flex items-start gap-2">
                    <AlertTriangle size={15} className="text-amber-400 flex-shrink-0 mt-0.5" />
                    <div>
                      <div className="font-semibold text-amber-200">
                        SIMULATED DEMO — NOT ON-CHAIN AUTHORIZED
                      </div>
                      <div className="text-[11px] mt-0.5">
                        Gateway is in Mock RPC mode. Live wallet transactions are disabled.
                      </div>
                    </div>
                  </div>
                )}

                {confirmError && (
                  <div className="p-3 rounded-xl bg-rose-500/10 border border-rose-500/30 text-rose-300 text-xs text-left">
                    {confirmError}
                  </div>
                )}

                {challenge ? (
                  <>
                    {/* Transaction details card */}
                    <div className="space-y-2 text-xs">
                      <span className="text-[11px] font-medium text-gray-400">Transaction details</span>
                      <div className="p-3 rounded-xl bg-[#0B0D14] border border-white/[0.06] space-y-2 mono text-[11px]">
                        <div className="flex items-center justify-between text-gray-400">
                          <span>Service ID</span>
                          <span className="text-white">{challenge.serviceId}</span>
                        </div>
                        <div className="flex items-center justify-between text-gray-400">
                          <span>Request ID</span>
                          <span className="text-gray-300">{truncAddr(challenge.requestId)}</span>
                        </div>
                        <div className="flex items-center justify-between text-gray-400">
                          <span>Amount</span>
                          <span className="text-white font-semibold">{challenge.quotedPriceFormatted}</span>
                        </div>
                        <div className="flex items-center justify-between text-gray-400">
                          <span>To</span>
                          <span className="text-gray-300">{truncAddr(PAYGATE402_ADDRESS)}</span>
                        </div>
                        <div className="flex items-center justify-between text-gray-400 pt-1 border-t border-white/[0.04]">
                          <span>Gas fee</span>
                          <span className="text-gray-400">~ 0.00012 ARC (est.)</span>
                        </div>
                      </div>
                    </div>

                    {/* Actions */}
                    <div className="flex items-center gap-2 pt-2">
                      <button
                        type="button"
                        onClick={() => setCurrentScreen('challenge')}
                        className="flex-1 py-2 rounded-xl bg-white/[0.06] hover:bg-white/[0.1] text-xs font-medium text-gray-300 transition-colors"
                      >
                        Cancel
                      </button>
                      <button
                        type="button"
                        disabled={
                          Boolean(challengeError) ||
                          (isConnected && (isMockGateway || isSmartAccountWallet))
                        }
                        onClick={() => void handleWalletConfirm()}
                        className="flex-1 py-2 rounded-xl bg-blue-600 hover:bg-blue-500 disabled:opacity-40 disabled:cursor-not-allowed text-xs font-medium text-white shadow-md transition-colors"
                      >
                        {isConnected ? 'Confirm' : 'Preview Walkthrough'}
                      </button>
                    </div>
                  </>
                ) : (
                  <div className="space-y-3 text-center py-2">
                    <p className="text-xs text-rose-300">
                      No valid HTTP 402 challenge available. Wallet confirmation is disabled.
                    </p>
                    <button
                      type="button"
                      onClick={() => setCurrentScreen('selection')}
                      className="w-full py-2 rounded-xl bg-white/[0.06] hover:bg-white/[0.1] text-xs font-medium text-gray-300"
                    >
                      Back to Services
                    </button>
                  </div>
                )}
              </div>
            )}

            {/* SCREEN 4: Payment Verification & Explicit Gateway Authorization */}
            {currentScreen === 'verifying' && activeTxHash && (
              <div className="w-full max-w-md p-6 rounded-2xl bg-[#10131D] border border-white/[0.08] shadow-2xl space-y-6 text-center animate-in zoom-in-95 duration-200">
                {isSimulated ? (
                  <>
                    <div className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full bg-amber-500/10 text-amber-400 border border-amber-500/20 text-xs font-semibold">
                      <AlertTriangle size={13} />
                      <span>SIMULATED WALKTHROUGH · NO WALLET REQUIRED</span>
                    </div>

                    <div className="space-y-1">
                      <h2 className="text-lg font-bold text-white">Simulated Payment Confirmation</h2>
                      <p className="text-xs text-gray-400">
                        This walkthrough demonstrates the HTTP 402 payment flow. No real transaction was submitted on {chainName}.
                      </p>
                    </div>

                    <div className="p-4 rounded-xl bg-[#090A0F] border border-white/[0.06] space-y-3 text-xs text-left">
                      <div className="flex items-center gap-3">
                        <div className="w-5 h-5 rounded-full bg-amber-500/20 border border-amber-500/40 flex items-center justify-center text-amber-400 flex-shrink-0">
                          <Check size={12} />
                        </div>
                        <div>
                          <span className="font-medium text-white block">Simulated Tx Hash</span>
                          <span className="mono text-[10px] text-gray-400">{truncAddr(activeTxHash)}</span>
                        </div>
                      </div>
                      <div className="flex items-center gap-3">
                        <div className="w-5 h-5 rounded-full bg-amber-500/20 border border-amber-500/40 flex items-center justify-center text-amber-400 flex-shrink-0">
                          <Check size={12} />
                        </div>
                        <span className="text-gray-300">Deterministic Challenge Validated</span>
                      </div>
                    </div>

                    <button
                      type="button"
                      onClick={() => {
                        setVerifiedPayload(selectedService.gatedPayload)
                        setCurrentScreen('success')
                      }}
                      className="w-full py-2.5 rounded-xl bg-amber-500/20 hover:bg-amber-500/30 text-amber-300 border border-amber-500/40 font-medium text-xs transition-colors"
                    >
                      View Simulated Payload Preview
                    </button>
                  </>
                ) : (
                  <>
                    {/* Real onchain transaction flow */}
                    {isPayConfirming ? (
                      <div className="w-14 h-14 rounded-full border-2 border-blue-500/20 border-t-blue-500 animate-spin mx-auto flex items-center justify-center">
                        <RefreshCw size={20} className="text-blue-400" />
                      </div>
                    ) : (
                      <div className="w-14 h-14 rounded-full bg-blue-500/20 border border-blue-500/40 flex items-center justify-center mx-auto text-blue-400">
                        <Shield size={22} />
                      </div>
                    )}

                    <div className="space-y-1">
                      <h2 className="text-lg font-bold text-white">
                        {isPayConfirming ? 'Confirming On-Chain...' : 'Payment Confirmed on Arc'}
                      </h2>
                      <p className="text-xs text-gray-400">
                        {isPayConfirming
                          ? `Waiting for ${chainName} block confirmation...`
                          : 'Sign EIP-712 challenge to authorize and unlock protected data via gateway.'}
                      </p>
                    </div>

                    <div className="p-4 rounded-xl bg-[#090A0F] border border-white/[0.06] space-y-3 text-xs text-left">
                      <div className="flex items-center justify-between">
                        <span className="text-gray-400">Transaction</span>
                        <a
                          href={activeTxHash ? getTxExplorerUrl(activeTxHash, currentChainId) : '#'}
                          target="_blank"
                          rel="noreferrer"
                          className="mono text-blue-400 hover:underline flex items-center gap-1"
                        >
                          {truncAddr(activeTxHash)}
                          <ExternalLink size={11} />
                        </a>
                      </div>
                      <div className="flex items-center justify-between">
                        <span className="text-gray-400">Status</span>
                        <span className={isPayConfirming ? 'text-amber-400' : 'text-emerald-400 font-medium'}>
                          {isPayConfirming ? 'Pending Confirmation' : `Confirmed on ${chainName}`}
                        </span>
                      </div>
                      <div className="flex items-center justify-between">
                        <span className="text-gray-400">Gateway Status</span>
                        <span className={gatewayOnline ? 'text-emerald-400' : 'text-rose-400 font-medium'}>
                          {gatewayOnline ? 'Gateway Online (4020)' : 'Gateway Offline (localhost:4020)'}
                        </span>
                      </div>
                    </div>

                    {authError && (
                      <div className="p-3 rounded-xl bg-rose-500/10 border border-rose-500/30 text-rose-300 text-xs text-left flex items-start gap-2">
                        <AlertTriangle size={15} className="text-rose-400 flex-shrink-0 mt-0.5" />
                        <div>
                          <div className="font-semibold text-rose-200">Gateway Authorization Failed</div>
                          <div className="text-[11px] mt-0.5">{authError}</div>
                        </div>
                      </div>
                    )}

                    <button
                      type="button"
                      disabled={isPayConfirming || isAuthorizing || isSigning}
                      onClick={() => void handleSignAndAuthorize()}
                      className="w-full py-2.5 rounded-xl bg-blue-600 hover:bg-blue-500 disabled:opacity-50 disabled:cursor-not-allowed text-white font-medium text-xs shadow-md transition-all flex items-center justify-center gap-2"
                    >
                      {isAuthorizing || isSigning ? (
                        <>
                          <RefreshCw size={14} className="animate-spin" />
                          <span>Authorizing with Gateway...</span>
                        </>
                      ) : (
                        <span>Sign EIP-712 & Authorize with Gateway</span>
                      )}
                    </button>
                  </>
                )}
              </div>
            )}

            {/* SCREEN 5: Success Response (Verified Data) */}
            {currentScreen === 'success' && verifiedPayload && (
              <div className="w-full max-w-lg p-6 rounded-2xl bg-[#10131D] border border-white/[0.08] shadow-2xl space-y-6 text-center animate-in zoom-in-95 duration-200">
                {isSimulated ? (
                  <>
                    <div className="w-14 h-14 rounded-full bg-amber-500/20 border border-amber-500/40 flex items-center justify-center mx-auto text-amber-400 shadow-lg shadow-amber-500/10">
                      <AlertTriangle size={24} />
                    </div>
                    <div className="space-y-1">
                      <div className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full bg-amber-500/10 text-amber-400 border border-amber-500/20 text-xs font-semibold">
                        <span>SIMULATED DEMO · NOT ON-CHAIN AUTHORIZED</span>
                      </div>
                      <h2 className="text-lg font-bold text-white pt-2">Simulated Demo Preview</h2>
                      <p className="text-xs text-gray-400">
                        This is a simulated preview. Connect an {chainName} wallet and pay on-chain for real gateway verification.
                      </p>
                    </div>

                    <div className="text-left space-y-2">
                      <div className="flex items-center justify-between">
                        <span className="text-xs font-semibold text-gray-300">Payload Preview</span>
                        <span className="text-[10px] mono px-2 py-0.5 rounded bg-amber-500/15 text-amber-400 border border-amber-500/30">
                          SIMULATED PREVIEW
                        </span>
                      </div>
                      <pre
                        className="p-4 rounded-xl bg-[#090A0F] border border-white/[0.06] mono text-xs leading-relaxed overflow-x-auto text-gray-200"
                        dangerouslySetInnerHTML={{ __html: syntaxHighlightJson(verifiedPayload) }}
                      />
                    </div>
                  </>
                ) : (
                  <>
                    <div className="w-14 h-14 rounded-full bg-emerald-500/20 border border-emerald-500/40 flex items-center justify-center mx-auto text-emerald-400 shadow-lg shadow-emerald-500/10">
                      <Check size={28} />
                    </div>
                    <div className="space-y-1">
                      <div className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full bg-emerald-500/10 text-emerald-400 border border-emerald-500/20 text-xs font-semibold">
                        <span>HTTP 200 · GATEWAY VERIFIED ON-CHAIN</span>
                      </div>
                      <h2 className="text-lg font-bold text-white pt-2">Payment Verified & Authorized</h2>
                      <p className="text-xs text-gray-400">
                        Your payment was verified on {chainName} and authorized by PayGate402 Gateway.
                      </p>
                    </div>

                    <div className="text-left space-y-2">
                      <div className="flex items-center justify-between">
                        <span className="text-xs font-semibold text-gray-300">Authorized API Response</span>
                        <span className="text-[10px] mono px-2 py-0.5 rounded bg-emerald-500/15 text-emerald-400 border border-emerald-500/30">
                          HTTP 200 · VERIFIED
                        </span>
                      </div>
                      <pre
                        className="p-4 rounded-xl bg-[#090A0F] border border-white/[0.06] mono text-xs leading-relaxed overflow-x-auto text-gray-200"
                        dangerouslySetInnerHTML={{ __html: syntaxHighlightJson(verifiedPayload) }}
                      />
                    </div>
                  </>
                )}

                {/* Actions */}
                <div className="space-y-2">
                  <button
                    type="button"
                    onClick={() => setCurrentScreen('selection')}
                    className="w-full py-2.5 rounded-xl bg-blue-600 hover:bg-blue-500 text-white font-medium text-xs shadow-md transition-all active:scale-95"
                  >
                    Make Another Request
                  </button>

                  <button
                    type="button"
                    onClick={() => setCurrentScreen('different_endpoint')}
                    className="w-full py-1.5 text-[11px] text-gray-400 hover:text-white flex items-center justify-center gap-1.5 transition-colors"
                  >
                    <span>Test Endpoint Isolation (Replay Protection)</span>
                  </button>
                </div>
              </div>
            )}

            {/* SCREEN 6: Different Endpoint (Replay Isolation Demonstration) */}
            {currentScreen === 'different_endpoint' && (
              <div className="w-full max-w-md p-6 rounded-2xl bg-[#12111A] border border-rose-500/20 shadow-2xl space-y-6 text-center animate-in zoom-in-95 duration-200">
                {/* Red Circular Badge with "2" */}
                <div className="w-14 h-14 rounded-full bg-rose-500/20 border border-rose-500/40 flex items-center justify-center mx-auto text-rose-400 font-bold text-xl shadow-lg shadow-rose-500/10">
                  2
                </div>

                <div className="space-y-1">
                  <h2 className="text-lg font-bold text-white">Payment Required</h2>
                  <p className="text-xs text-gray-400">
                    This endpoint is different from your last payment.
                  </p>
                </div>

                {/* Details box showing endpoints */}
                <div className="p-4 rounded-xl bg-[#090A0F] border border-white/[0.06] space-y-3 text-xs text-left mono">
                  <div>
                    <span className="text-[11px] text-gray-500 block">Requested Endpoint</span>
                    <span className="text-rose-300 font-medium">/v1/signals/market-analysis</span>
                  </div>
                  <div>
                    <span className="text-[11px] text-gray-500 block">Previous Payment</span>
                    <span className="text-gray-400">{previousPaymentEndpoint}</span>
                  </div>
                </div>

                {/* Alert warning */}
                <div className="p-3 rounded-xl bg-rose-500/10 border border-rose-500/25 flex items-center gap-2.5 text-xs text-rose-300 text-left">
                  <AlertTriangle size={16} className="text-rose-400 flex-shrink-0" />
                  <span>You need a new payment for this endpoint.</span>
                </div>

                {/* Button */}
                <button
                  type="button"
                  onClick={() => setCurrentScreen('selection')}
                  className="w-full py-2.5 rounded-xl bg-blue-600 hover:bg-blue-500 text-white font-medium text-xs shadow-md transition-all active:scale-95"
                >
                  Go to Service List
                </button>
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Visual Walkthrough Selector Bar (Matching the 6 steps from the reference image) */}
      <div className="space-y-2 pt-2">
        <div className="flex items-center justify-between text-xs text-gray-400 px-1">
          <span className="font-semibold text-gray-300">Payment Flow Walkthrough</span>
          <span>Click any step to inspect its screen state</span>
        </div>

        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-2.5 text-xs">
          {/* Step 1 */}
          <button
            type="button"
            onClick={() => handleJumpToStep('selection')}
            className={`p-3 rounded-xl text-left border transition-all ${
              currentScreen === 'selection'
                ? 'bg-blue-600/15 border-blue-500/40 text-white shadow-sm'
                : 'bg-[#10131D] border-white/[0.06] text-gray-400 hover:text-white hover:border-white/[0.12]'
            }`}
          >
            <span className="font-bold block text-[11px] text-blue-400 mb-1">1. Main app</span>
            <span className="font-medium text-white block text-xs">Service selection</span>
            <span className="text-[10px] text-gray-400 block mt-1 leading-tight">
              User chooses a protected service.
            </span>
          </button>

          {/* Step 2 */}
          <button
            type="button"
            onClick={() => handleJumpToStep('challenge')}
            className={`p-3 rounded-xl text-left border transition-all ${
              currentScreen === 'challenge'
                ? 'bg-blue-600/15 border-blue-500/40 text-white shadow-sm'
                : 'bg-[#10131D] border-white/[0.06] text-gray-400 hover:text-white hover:border-white/[0.12]'
            }`}
          >
            <span className="font-bold block text-[11px] text-blue-400 mb-1">2. HTTP 402</span>
            <span className="font-medium text-white block text-xs">Payment challenge</span>
            <span className="text-[10px] text-gray-400 block mt-1 leading-tight">
              Server returns 402 with request ID.
            </span>
          </button>

          {/* Step 3 */}
          <button
            type="button"
            onClick={() => handleJumpToStep('confirm')}
            className={`p-3 rounded-xl text-left border transition-all ${
              currentScreen === 'confirm'
                ? 'bg-blue-600/15 border-blue-500/40 text-white shadow-sm'
                : 'bg-[#10131D] border-white/[0.06] text-gray-400 hover:text-white hover:border-white/[0.12]'
            }`}
          >
            <span className="font-bold block text-[11px] text-blue-400 mb-1">3. Wallet</span>
            <span className="font-medium text-white block text-xs">Confirmation</span>
            <span className="text-[10px] text-gray-400 block mt-1 leading-tight">
              User approves and signs payment.
            </span>
          </button>

          {/* Step 4 */}
          <button
            type="button"
            onClick={() => handleJumpToStep('verifying')}
            className={`p-3 rounded-xl text-left border transition-all ${
              currentScreen === 'verifying'
                ? 'bg-blue-600/15 border-blue-500/40 text-white shadow-sm'
                : 'bg-[#10131D] border-white/[0.06] text-gray-400 hover:text-white hover:border-white/[0.12]'
            }`}
          >
            <span className="font-bold block text-[11px] text-blue-400 mb-1">4. Verification</span>
            <span className="font-medium text-white block text-xs">Payment verification</span>
            <span className="text-[10px] text-gray-400 block mt-1 leading-tight">
              Gateway checks receipt and event log.
            </span>
          </button>

          {/* Step 5 */}
          <button
            type="button"
            onClick={() => handleJumpToStep('success')}
            className={`p-3 rounded-xl text-left border transition-all ${
              currentScreen === 'success'
                ? 'bg-emerald-600/15 border-emerald-500/40 text-white shadow-sm'
                : 'bg-[#10131D] border-white/[0.06] text-gray-400 hover:text-white hover:border-white/[0.12]'
            }`}
          >
            <span className="font-bold block text-[11px] text-emerald-400 mb-1">5. Success</span>
            <span className="font-medium text-white block text-xs">Protected response</span>
            <span className="text-[10px] text-gray-400 block mt-1 leading-tight">
              API returns real verified data.
            </span>
          </button>

          {/* Step 6 */}
          <button
            type="button"
            onClick={() => handleJumpToStep('different_endpoint')}
            className={`p-3 rounded-xl text-left border transition-all ${
              currentScreen === 'different_endpoint'
                ? 'bg-rose-600/15 border-rose-500/40 text-white shadow-sm'
                : 'bg-[#10131D] border-white/[0.06] text-gray-400 hover:text-white hover:border-white/[0.12]'
            }`}
          >
            <span className="font-bold block text-[11px] text-rose-400 mb-1">6. Isolation</span>
            <span className="font-medium text-white block text-xs">Different endpoint</span>
            <span className="text-[10px] text-gray-400 block mt-1 leading-tight">
              Payment cannot unlock another endpoint.
            </span>
          </button>
        </div>
      </div>
    </div>
  )
}
