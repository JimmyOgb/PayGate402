import { useState, useCallback, useEffect, useRef } from 'react'
import {
  Copy,
  Check,
  ExternalLink,
  Lock,
  Unlock,
  Terminal,
  ChevronRight,
  ChevronDown,
  ChevronUp,
  ShieldCheck,
  Sparkles,
  AlertCircle,
  CheckCircle2,
  ArrowUpRight,
} from 'lucide-react'
import {
  useAccount,
  usePublicClient,
  useReadContract,
  useWriteContract,
  useWaitForTransactionReceipt,
  useSwitchChain,
  useSignTypedData,
} from 'wagmi'
import { erc20Abi } from 'viem'
import { toast } from 'sonner'
import {
  PAYGATE402_ADDRESS,
  PROTOCOL_TREASURY_ADDRESS,
  USDC_FACT,
  ARC_MAINNET_CHAIN_ID,
  getContractConfig,
  isSupportedChain,
  getTxExplorerUrl,
  getAddressExplorerUrl,
  formatUsdcAmount,
  formatUsdcExact,
  calculateFeeSplit,
  inferServiceCategory,
  truncAddr,
  ServiceData,
} from '@/lib/paygate402'
import {
  authorizeConfirmedPaymentWithGateway,
  checkGatewayStatus,
  prepareLivePaymentChallenge,
  type ChallengeData,
  type GatewayHealthStatus,
} from '@/lib/gatewayClient'
import { OnChainActivityItem } from '@/lib/usePayGateData'

export interface ServiceCardProps {
  service: ServiceData
  tags?: string[]
  category?: string
  endpointPath?: string
  httpMethod?: 'GET' | 'POST'
  gatedPayload?: string
  isDemoTemplate?: boolean
  onDeployTemplate?: () => void
  isDeployingTemplate?: boolean
  onRefresh?: () => void
  onRecordTx?: (item: Omit<OnChainActivityItem, 'id' | 'source'>) => void
}

function syntaxHighlightJson(json: string): string {
  return json
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/("[\w_]+")\s*:/g, '<span class="json-key">$1</span>:')
    .replace(/:\s*(".*?")/g, ': <span class="json-str">$1</span>')
    .replace(/:\s*(\d+\.?\d*)/g, ': <span class="json-num">$1</span>')
    .replace(/:\s*(true|false)/g, ': <span class="json-bool">$1</span>')
}

export function ServiceCard({
  service,
  tags = [],
  category,
  endpointPath,
  httpMethod = 'POST',
  gatedPayload,
  isDemoTemplate = false,
  onDeployTemplate,
  isDeployingTemplate = false,
  onRefresh,
  onRecordTx,
}: ServiceCardProps) {
  const { address, isConnected, chainId } = useAccount()
  const { switchChain } = useSwitchChain()
  const verifiedWallet = Boolean(isConnected && address)
  const isSupported = chainId === ARC_MAINNET_CHAIN_ID
  const currentChainId = ARC_MAINNET_CHAIN_ID
  const contractConfig = getContractConfig(ARC_MAINNET_CHAIN_ID)
  const publicClient = usePublicClient({ chainId: ARC_MAINNET_CHAIN_ID })

  const [copiedAddr, setCopiedAddr] = useState(false)
  const [copiedHttp, setCopiedHttp] = useState(false)
  const [showBreakdown, setShowBreakdown] = useState(false)
  const [showDemoSchema, setShowDemoSchema] = useState(false)
  const [payTxHash, setPayTxHash] = useState<`0x${string}` | undefined>()
  const [step, setStep] = useState<
    'idle' | 'challenging' | 'approving' | 'paying' | 'paid_pending_auth' | 'authorizing' | 'done'
  >('idle')
  const [gatewayAuthorized, setGatewayAuthorized] = useState(false)
  const [activeChallenge, setActiveChallenge] = useState<ChallengeData | null>(null)
  const [gatewayHealth, setGatewayHealth] = useState<GatewayHealthStatus | null>(null)
  const [isSmartAccountWallet, setIsSmartAccountWallet] = useState<boolean>(false)
  const [preflightError, setPreflightError] = useState<string | null>(null)
  const [authError, setAuthError] = useState<string | null>(null)
  const [unlockedPayload, setUnlockedPayload] = useState<string | null>(null)
  const { signTypedDataAsync, isPending: isSigning } = useSignTypedData()

  // Inspect gateway health/mode and consumer wallet EOA compatibility
  useEffect(() => {
    if (isDemoTemplate) return
    void checkGatewayStatus().then(setGatewayHealth)
  }, [isDemoTemplate])

  useEffect(() => {
    if (!verifiedWallet || !address || !publicClient || isDemoTemplate) {
      void Promise.resolve().then(() => setIsSmartAccountWallet(false))
      return
    }
    void publicClient
      .getBytecode({ address })
      .then(code => {
        setIsSmartAccountWallet(Boolean(code && code !== '0x' && code.length > 2))
      })
      .catch(() => {
        setIsSmartAccountWallet(false)
      })
  }, [verifiedWallet, address, publicClient, isDemoTemplate])

  const resolvedCategory =
    category ?? inferServiceCategory(service.name, service.endpointDescription, tags)
  const resolvedEndpoint =
    endpointPath ?? `/v1/services/${isDemoTemplate ? 'demo' : service.serviceId.toString()}`
  const split = calculateFeeSplit(service.priceInUsdc)

  // Read current USDC allowance (only for real on-chain services)
  const { data: allowance, refetch: refetchAllowance } = useReadContract({
    address: USDC_FACT.address as `0x${string}`,
    abi: erc20Abi,
    functionName: 'allowance',
    args: verifiedWallet && address ? [address, contractConfig.contractAddress] : undefined,
    chainId: currentChainId,
    query: { enabled: verifiedWallet && !isDemoTemplate && isSupported },
  })

  // Read current USDC balance (raw base units, 6 decimals)
  const {
    data: usdcBalance,
    isLoading: isBalanceLoading,
    isError: isBalanceError,
    refetch: refetchBalance,
  } = useReadContract({
    address: USDC_FACT.address as `0x${string}`,
    abi: erc20Abi,
    functionName: 'balanceOf',
    args: verifiedWallet && address ? [address] : undefined,
    chainId: currentChainId,
    query: { enabled: verifiedWallet && !isDemoTemplate && isSupported },
  })

  // Contract V2 on Mainnet removes permanent hasAccess mapping in favor of per-request AccessGranted verification
  const isPermanentAccessFlag = false

  // Write hooks for approve + payForAccess
  const {
    writeContract: approve,
    data: approveHash,
    isPending: approveWalletPending,
    isError: approveError,
    reset: resetApprove,
  } = useWriteContract()

  const {
    writeContract: pay,
    data: payHash,
    isPending: payWalletPending,
    isError: payError,
    reset: resetPay,
  } = useWriteContract()

  const { isLoading: approveConfirming, isSuccess: approveConfirmed } =
    useWaitForTransactionReceipt({ hash: approveHash })

  const { isLoading: payConfirming, isSuccess: payConfirmed } =
    useWaitForTransactionReceipt({ hash: payHash })

  const payHashRef = useRef(payTxHash)
  useEffect(() => {
    if (payHash && payHash !== payHashRef.current) {
      payHashRef.current = payHash
      void Promise.resolve().then(() => setPayTxHash(payHash))
    }
  }, [payHash])

  // Move from approving -> paying once approval receipt confirms
  const approveHandledRef = useRef(false)
  useEffect(() => {
    if (approveConfirmed && step === 'approving' && !approveHandledRef.current) {
      approveHandledRef.current = true
      void Promise.resolve().then(() => {
        setStep('paying')
        void refetchAllowance()
      })
    }
    if (!approveConfirmed) approveHandledRef.current = false
  }, [approveConfirmed, step, refetchAllowance])

  // Auto-broadcast payForAccess after approval is confirmed on-chain using ONLY the authoritative gateway challenge
  const autoPaidRef = useRef(false)
  useEffect(() => {
    if (
      approveConfirmed &&
      !payWalletPending &&
      !payConfirming &&
      !payConfirmed &&
      verifiedWallet &&
      !isDemoTemplate &&
      !autoPaidRef.current
    ) {
      autoPaidRef.current = true
      if (!activeChallenge) {
        void Promise.resolve().then(() => {
          setPreflightError(
            'Missing authoritative gateway challenge after approval; payment blocked fail-closed.'
          )
          setStep('idle')
        })
        return
      }
      pay({
        address: contractConfig.contractAddress,
        abi: contractConfig.abi,
        functionName: 'payForAccess',
        args: [BigInt(activeChallenge.serviceId), activeChallenge.requestId],
        chainId: currentChainId,
      })
    }
    if (!approveConfirmed) autoPaidRef.current = false
  }, [
    approveConfirmed,
    payWalletPending,
    payConfirming,
    payConfirmed,
    verifiedWallet,
    isDemoTemplate,
    activeChallenge,
    pay,
    contractConfig.contractAddress,
    contractConfig.abi,
    currentChainId,
  ])

  // Move to paid_pending_auth only when on-chain payForAccess receipt is confirmed
  // Note: Receipt confirmation alone NEVER unlocks the service; gateway EIP-712 authorization is required.
  const payDoneRef = useRef(false)
  useEffect(() => {
    if (payConfirmed && step === 'paying' && !payDoneRef.current) {
      payDoneRef.current = true
      void Promise.resolve().then(() => {
        setStep('paid_pending_auth')
        toast.info(
          'Payment receipt confirmed on Arc Mainnet. Click "Sign EIP-712 & Authorize" to complete gateway verification.'
        )
        if (payHash && address) {
          onRecordTx?.({
            txHash: payHash,
            kind: 'AccessGranted',
            serviceId: service.serviceId,
            serviceName: service.name,
            actor: address,
            amountUsdc: activeChallenge ? BigInt(activeChallenge.quotedPrice) : service.priceInUsdc,
            timestamp: Date.now(),
          })
        }
        onRefresh?.()
      })
    }
    if (!payConfirmed) payDoneRef.current = false
  }, [payConfirmed, step, payHash, address, service, activeChallenge, onRefresh, onRecordTx])

  // Explicit user-initiated EIP-712 signature & gateway authorization using authoritative challenge fields
  const handleAuthorizeGateway = useCallback(async () => {
    if (!activeChallenge || !payTxHash || !address) {
      toast.error('Missing authoritative gateway challenge or payment transaction hash')
      return
    }
    setStep('authorizing')
    setAuthError(null)

    try {
      const res = await authorizeConfirmedPaymentWithGateway({
        challenge: activeChallenge,
        txHash: payTxHash,
        payerAddress: address,
        body: '',
        signTypedData: args => signTypedDataAsync(args),
      })

      if (res.status === 200) {
        setUnlockedPayload(JSON.stringify(res.payload, null, 2))
        setGatewayAuthorized(true)
        setStep('done')
        toast.success(`Access verified & authorized by Gateway for "${service.name}"`)
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err)
      setAuthError(msg)
      setStep('paid_pending_auth')
      toast.error(`Gateway authorization failed: ${msg}`)
    }
  }, [activeChallenge, payTxHash, address, service.name, signTypedDataAsync])

  const handlePayFlow = useCallback(async () => {
    if (isDemoTemplate) {
      toast.info('Deploy this reference template on-chain first to enable live USDC payments.')
      return
    }
    if (!verifiedWallet || !address) {
      toast.error('Connect your wallet first')
      return
    }
    if (!service.active) {
      toast.error('This service is currently marked inactive by its provider')
      return
    }
    if (!isSupported) {
      switchChain({ chainId: ARC_MAINNET_CHAIN_ID })
      return
    }

    setPreflightError(null)
    setAuthError(null)
    setActiveChallenge(null)
    setStep('challenging')

    // 1. Obtain authoritative HTTP 402 challenge from gateway and check EOA / Mock Mode constraints
    let challenge: ChallengeData
    try {
      const preflight = await prepareLivePaymentChallenge({
        serviceId: service.serviceId,
        subPath: resolvedEndpoint,
        method: httpMethod,
        body: '',
        payerAddress: address,
        getBytecode: addr =>
          publicClient ? publicClient.getBytecode({ address: addr }) : Promise.resolve(undefined),
      })
      challenge = preflight.challenge
      setGatewayHealth(preflight.health)
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err)
      setPreflightError(msg)
      setStep('idle')
      toast.error(msg)
      return
    }

    const requiredPrice = BigInt(challenge.quotedPrice)

    // 2. Revalidate live USDC balance against authoritative challenge quotedPrice
    let currentBalance = usdcBalance
    try {
      const balanceResult = await refetchBalance()
      if (balanceResult.data !== undefined) {
        currentBalance = balanceResult.data
      }
    } catch {
      // Fall back to currentBalance if RPC refresh has a transient issue
    }

    if (currentBalance === undefined) {
      const msg = `Unable to verify USDC balance from ${contractConfig.chainName} RPC. Please retry.`
      setPreflightError(msg)
      setStep('idle')
      toast.error(msg)
      return
    }

    if (currentBalance < requiredPrice) {
      const msg = `Insufficient USDC balance. You hold ${formatUsdcAmount(currentBalance)} USDC, but this challenge requires ${formatUsdcAmount(requiredPrice)} USDC.`
      setPreflightError(msg)
      setStep('idle')
      toast.error(msg)
      return
    }

    resetApprove()
    resetPay()
    setActiveChallenge(challenge)

    const sufficient = allowance !== undefined && allowance >= requiredPrice

    if (!sufficient) {
      setStep('approving')
      approve({
        address: USDC_FACT.address as `0x${string}`,
        abi: erc20Abi,
        functionName: 'approve',
        args: [contractConfig.contractAddress, requiredPrice],
        chainId: currentChainId,
      })
    } else {
      setStep('paying')
      pay({
        address: contractConfig.contractAddress,
        abi: contractConfig.abi,
        functionName: 'payForAccess',
        args: [BigInt(challenge.serviceId), challenge.requestId],
        chainId: currentChainId,
      })
    }
  }, [
    isDemoTemplate,
    verifiedWallet,
    address,
    service,
    isSupported,
    resolvedEndpoint,
    httpMethod,
    publicClient,
    usdcBalance,
    refetchBalance,
    allowance,
    approve,
    pay,
    switchChain,
    resetApprove,
    resetPay,
    contractConfig,
    currentChainId,
  ])

  const copyProviderAddr = () => {
    if (isDemoTemplate) return
    void navigator.clipboard.writeText(service.provider)
    setCopiedAddr(true)
    setTimeout(() => setCopiedAddr(false), 1500)
  }

  // Auto-reset step if approval or payment encounters an error/rejection
  useEffect(() => {
    if (approveError || payError) {
      void Promise.resolve().then(() => setStep('idle'))
    }
  }, [approveError, payError])

  // Strictly verified unlock state — only unlocked when payment confirmed AND authorized by gateway for this request
  const isFreshlyPaid = Boolean(!isDemoTemplate && step === 'done' && payConfirmed && gatewayAuthorized)
  const isUnlocked = isFreshlyPaid // Strict per-call security: on-chain receipt + gateway EIP-712
  const isWorking =
    !isDemoTemplate &&
    (step === 'challenging' || step === 'approving' || step === 'paying') &&
    !(approveError || payError)
  const requiredAmountForSplit = activeChallenge ? BigInt(activeChallenge.quotedPrice) : service.priceInUsdc
  const needsApproval = allowance === undefined || allowance < requiredAmountForSplit
  const isMockGateway = Boolean(gatewayHealth?.mockRpc)

  const isWrongNetwork = Boolean(verifiedWallet && chainId !== ARC_MAINNET_CHAIN_ID)
  // Compare raw integer units (6 decimals)
  const hasInsufficientBalance = Boolean(
    !isDemoTemplate &&
      verifiedWallet &&
      !isWrongNetwork &&
      usdcBalance !== undefined &&
      usdcBalance < requiredAmountForSplit
  )

  const http402Snippet = `HTTP/1.1 402 Payment Required
Content-Type: application/json
WWW-Authenticate: PayGate402 serviceId=${isDemoTemplate ? '<deploy-first>' : service.serviceId.toString()}, chainId=${ARC_MAINNET_CHAIN_ID}
X-PayGate-Contract: ${contractConfig.contractAddress}
X-Payment-Token: ${USDC_FACT.address} (USDC)
X-Required-Amount: ${formatUsdcAmount(service.priceInUsdc)} USDC (${service.priceInUsdc.toString()} base units)
X-Revenue-Split: 95% Provider / 5% Protocol Treasury

{ "error": "HTTP 402 Payment Required", "service": "${service.name}" }`

  const copyHttpPanel = () => {
    const textToCopy = isUnlocked && gatedPayload ? gatedPayload : http402Snippet
    void navigator.clipboard.writeText(textToCopy)
    setCopiedHttp(true)
    setTimeout(() => setCopiedHttp(false), 1600)
  }

  // Determine active step in the 5-step HTTP 402 lifecycle bar
  const currentLifecycleStep = isUnlocked
    ? 5
    : step === 'paid_pending_auth' || step === 'authorizing'
      ? 5
      : step === 'paying'
        ? 4
        : step === 'approving'
          ? 3
          : 2

  return (
    <article
      className={`pg-card flex flex-col justify-between overflow-hidden transition-all ${
        isUnlocked
          ? 'border-emerald-500/35 bg-gradient-to-b from-emerald-500/[0.04] to-[#10131C]'
          : isDemoTemplate
            ? 'border-amber-500/25 bg-[#10131C]'
            : 'pg-card-interactive'
      }`}
    >
      <div className="p-5 sm:p-6 space-y-4">
        {/* Top Status & Category Bar */}
        <div className="flex items-center justify-between gap-2 flex-wrap">
          <div className="flex items-center gap-1.5 flex-wrap">
            {isDemoTemplate ? (
              <span className="pg-badge bg-amber-500/15 text-amber-300 border border-amber-500/30 mono">
                <Sparkles size={11} />
                DEMO TEMPLATE · NOT ON-CHAIN
              </span>
            ) : (
              <>
                <span className="pg-badge bg-[#7C5CFF]/15 text-[#A78BFA] border border-[#7C5CFF]/30 mono">
                  ON-CHAIN · ID #{service.serviceId.toString()}
                </span>
                <span
                  className={`pg-badge mono ${
                    service.active
                      ? 'bg-emerald-500/10 text-emerald-400 border border-emerald-500/25'
                      : 'bg-rose-500/10 text-rose-400 border border-rose-500/25'
                  }`}
                >
                  {service.active ? 'Active' : 'Paused'}
                </span>
              </>
            )}
            <span className="pg-badge bg-white/[0.05] text-[#9CA3AF] border border-white/[0.08]">
              {resolvedCategory}
            </span>
          </div>

          {isFreshlyPaid && (
            <span className="pg-badge bg-emerald-500/15 text-emerald-300 border border-emerald-500/35 mono">
              <ShieldCheck size={12} />
              Session Verified On-Chain
            </span>
          )}
          {isPermanentAccessFlag && (
            <span
              className="pg-badge bg-amber-500/15 text-amber-300 border border-amber-500/30 mono"
              title="Permanent wallet-level hasAccess flag on contract. Gateway verification required for genuine per-request authorization."
            >
              <AlertCircle size={11} />
              Permanent hasAccess · Unverified Session
            </span>
          )}
        </div>

        {/* Service Title, Endpoint, & Price */}
        <div className="flex items-start justify-between gap-4">
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2 mb-1">
              {isUnlocked ? (
                <Unlock size={15} className="text-emerald-400 flex-shrink-0" />
              ) : (
                <Lock size={15} className="text-[#9CA3AF] flex-shrink-0" />
              )}
              <h3 className="display text-lg font-semibold text-white truncate" title={service.name}>
                {service.name}
              </h3>
            </div>

            <div className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded bg-[#0A0C12] border border-white/[0.06] text-[11px] mono text-[#9CA3AF] mb-2">
              <span className="text-[#A78BFA] font-semibold">{httpMethod}</span>
              <span className="truncate">{resolvedEndpoint}</span>
            </div>

            <p className="text-xs sm:text-[13px] text-[#9CA3AF] leading-relaxed line-clamp-2">
              {service.endpointDescription}
            </p>
          </div>

          {/* Price Box */}
          <div className="text-right flex-shrink-0 pg-panel px-3 py-2 border border-white/[0.08]">
            <div className="display text-xl font-bold text-white tabular-nums mono leading-none">
              {formatUsdcAmount(service.priceInUsdc)}
            </div>
            <div className="text-[10px] font-semibold text-[#A78BFA] uppercase tracking-wider mono mt-1">
              USDC / Call
            </div>
          </div>
        </div>

        {/* Tags */}
        {tags.length > 0 && (
          <div className="flex flex-wrap gap-1.5">
            {tags.map(tag => (
              <span
                key={tag}
                className="text-[11px] font-medium px-2 py-0.5 rounded bg-white/[0.04] text-[#D1D5DB] border border-white/[0.07]"
              >
                {tag}
              </span>
            ))}
          </div>
        )}

        {/* Telemetry & Provider Row */}
        <div className="grid grid-cols-3 gap-2 pt-3 pb-3 border-y border-white/[0.07] text-xs">
          <div>
            <div className="text-[10px] font-medium text-[#6B7280] uppercase tracking-wider">
              {isDemoTemplate ? 'On-Chain Calls' : 'Verified Calls'}
            </div>
            <div className="font-semibold text-white tabular-nums mono mt-0.5">
              {isDemoTemplate ? 'Not Deployed' : Number(service.totalCalls).toLocaleString()}
            </div>
          </div>

          <div>
            <div className="text-[10px] font-medium text-[#6B7280] uppercase tracking-wider">
              {isDemoTemplate ? 'On-Chain Volume' : 'Gross Volume'}
            </div>
            <div className="font-semibold text-white tabular-nums mono mt-0.5">
              {isDemoTemplate ? '—' : `${formatUsdcAmount(service.totalRevenue)} USDC`}
            </div>
          </div>

          <div className="text-right">
            <div className="text-[10px] font-medium text-[#6B7280] uppercase tracking-wider">
              Provider (95%)
            </div>
            {isDemoTemplate ? (
              <div className="font-medium text-amber-300/90 mono mt-0.5 text-[11px]">
                Deployer Wallet
              </div>
            ) : (
              <div className="inline-flex items-center justify-end gap-1 mt-0.5">
                <button
                  type="button"
                  onClick={copyProviderAddr}
                  className="inline-flex items-center gap-1 font-medium text-[#A78BFA] hover:text-white transition-colors mono text-xs"
                  title={`Copy provider address: ${service.provider}`}
                >
                  {truncAddr(service.provider)}
                  {copiedAddr ? <Check size={11} className="text-emerald-400" /> : <Copy size={11} />}
                </button>
                <a
                  href={getAddressExplorerUrl(service.provider)}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-[#6B7280] hover:text-white"
                  title="View provider on Arc Explorer"
                >
                  <ExternalLink size={11} />
                </a>
              </div>
            )}
          </div>
        </div>

        {/* 5-Step HTTP 402 Handshake Progress Indicator */}
        <div className="space-y-1.5">
          <div className="flex items-center justify-between text-[11px]">
            <span className="font-medium text-[#9CA3AF]">HTTP 402 Handshake State</span>
            <span className="mono text-[11px] text-[#D1D5DB]">
              {isUnlocked
                ? 'Step 5/5 · 200 OK Verified'
                : step === 'paid_pending_auth' || step === 'authorizing'
                  ? 'Step 5/5 · Awaiting EIP-712 Sign'
                  : step === 'paying'
                    ? 'Step 4/5 · Settling 95/5 Split'
                    : step === 'approving'
                      ? 'Step 3/5 · Approving USDC'
                      : 'Step 2/5 · 402 Payment Required'}
            </span>
          </div>
          <div className="grid grid-cols-5 gap-1">
            {[
              { idx: 1, label: '1. Req' },
              { idx: 2, label: '2. 402' },
              { idx: 3, label: '3. Approve' },
              { idx: 4, label: '4. Pay 95/5' },
              { idx: 5, label: '5. 200 OK' },
            ].map(s => {
              const active = currentLifecycleStep >= s.idx
              return (
                <div key={s.idx} className="space-y-1">
                  <div
                    className={`h-1 rounded-full transition-colors ${
                      isUnlocked
                        ? 'bg-emerald-400'
                        : active
                          ? 'bg-[#7C5CFF]'
                          : 'bg-white/[0.08]'
                    }`}
                  />
                  <div
                    className={`text-[10px] mono truncate ${
                      active ? 'text-[#D1D5DB]' : 'text-[#6B7280]'
                    }`}
                  >
                    {s.label}
                  </div>
                </div>
              )
            })}
          </div>
        </div>

        {/* HTTP 402 Challenge or Unlocked 200 OK Code Panel */}
        {!isUnlocked ? (
          <div className="rounded-lg overflow-hidden border border-white/[0.08] bg-[#080A10]">
            <div className="flex items-center justify-between px-3 py-2 bg-[#0D1018] border-b border-white/[0.07]">
              <div className="flex items-center gap-2">
                <Terminal size={12} className="text-rose-400" />
                <span className="text-[11px] font-semibold mono text-rose-400">
                  HTTP/1.1 402 Payment Required
                </span>
              </div>
              <button
                type="button"
                onClick={copyHttpPanel}
                className="inline-flex items-center gap-1 text-[11px] text-[#9CA3AF] hover:text-white mono"
              >
                {copiedHttp ? (
                  <>
                    <Check size={11} className="text-emerald-400" />
                    <span>Copied</span>
                  </>
                ) : (
                  <>
                    <Copy size={11} />
                    <span>Copy</span>
                  </>
                )}
              </button>
            </div>
            <div className="p-3 mono text-[11px] leading-5 text-[#9CA3AF] overflow-x-auto">
              <div>
                WWW-Authenticate:{' '}
                <span className="text-[#A78BFA]">
                  PayGate402 serviceId={isDemoTemplate ? '<unregistered>' : service.serviceId.toString()}
                </span>
              </div>
              <div>
                X-Required-Amount:{' '}
                <span className="text-amber-300">{formatUsdcAmount(service.priceInUsdc)} USDC</span>{' '}
                <span className="text-[#6B7280]">
                  (95% Provider: {formatUsdcExact(split.providerAmount)} / 5% Fee: {formatUsdcExact(split.protocolFee)})
                </span>
              </div>
              <div>
                X-PayGate-Contract:{' '}
                <span className="text-[#D1D5DB]">{truncAddr(PAYGATE402_ADDRESS)}</span>
              </div>
              <div className="mt-1 text-[#D1D5DB]">
                {`{ "error": "Payment required — call payForAccess(serviceId, requestId)" }`}
              </div>
              {isPermanentAccessFlag && (
                <div className="mt-2 p-2 rounded bg-amber-500/10 border border-amber-500/20 text-amber-300 text-[10px] flex items-center gap-1.5">
                  <AlertCircle size={11} className="flex-shrink-0" />
                  <span>Contract hasAccess is permanently true for this wallet, but gateway requires fresh payment per HTTP request.</span>
                </div>
              )}
            </div>
          </div>
        ) : (
          <div className={`rounded-lg overflow-hidden border ${isFreshlyPaid ? 'border-emerald-500/30 bg-[#080D0C]' : 'border-amber-500/30 bg-[#0D0B08]'}`}>
            <div className={`flex items-center justify-between px-3 py-2 border-b ${isFreshlyPaid ? 'bg-emerald-500/10 border-emerald-500/25' : 'bg-amber-500/10 border-amber-500/25'}`}>
              <div className="flex items-center gap-2">
                <CheckCircle2 size={13} className={isFreshlyPaid ? 'text-emerald-400' : 'text-amber-400'} />
                <span className={`text-[11px] font-semibold mono ${isFreshlyPaid ? 'text-emerald-300' : 'text-amber-300'}`}>
                  {isFreshlyPaid
                    ? 'HTTP/1.1 200 OK — Session Verified On-Chain'
                    : 'HTTP/1.1 200 (Contract Preview) — Permanent hasAccess Flag Detected'}
                </span>
              </div>
              <div className="flex items-center gap-2.5">
                {payTxHash && (
                  <a
                    href={getTxExplorerUrl(payTxHash)}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex items-center gap-1 text-[11px] mono text-emerald-300 hover:underline"
                  >
                    Receipt Tx <ExternalLink size={10} />
                  </a>
                )}
                <button
                  type="button"
                  onClick={copyHttpPanel}
                  className="inline-flex items-center gap-1 text-[11px] text-[#9CA3AF] hover:text-white mono"
                >
                  {copiedHttp ? <Check size={11} className="text-emerald-400" /> : <Copy size={11} />}
                </button>
              </div>
            </div>
            {isPermanentAccessFlag && (
              <div className="px-3 py-1.5 bg-amber-500/10 border-b border-amber-500/20 text-[10px] mono text-amber-200/80 flex items-center gap-1.5">
                <AlertCircle size={11} className="flex-shrink-0 text-amber-400" />
                <span>Notice: Contract `hasAccess` is permanent. Production APIs must verify per-call via PayGate402 Gateway.</span>
              </div>
            )}
            <pre
              className="p-3 mono text-[11px] leading-5 overflow-x-auto text-[#F3F4F6] max-h-48"
              dangerouslySetInnerHTML={{
                __html: syntaxHighlightJson(
                  unlockedPayload ||
                    gatedPayload ||
                    `{ "status": 200, "access": "verified", "serviceId": ${service.serviceId.toString()} }`
                ),
              }}
            />
          </div>
        )}

        {/* Pre-Payment Fee & Settlement Breakdown Accordion */}
        <div className="rounded-lg border border-white/[0.07] bg-[#0B0D14]/90 overflow-hidden">
          <button
            type="button"
            onClick={() => setShowBreakdown(b => !b)}
            className="w-full px-3 py-2 flex items-center justify-between text-xs text-[#9CA3AF] hover:text-white transition-colors"
          >
            <span className="font-medium">
              Pre-Payment Settlement Breakdown (95% / 5% Split)
            </span>
            <span className="inline-flex items-center gap-1 mono text-[11px] text-[#A78BFA]">
              {formatUsdcAmount(service.priceInUsdc)} USDC
              {showBreakdown ? <ChevronUp size={13} /> : <ChevronDown size={13} />}
            </span>
          </button>

          {showBreakdown && (
            <div className="px-3 pb-3 pt-1 border-t border-white/[0.06] space-y-1.5 text-[11px]">
              <div className="flex items-center justify-between">
                <span className="text-[#9CA3AF]">Network</span>
                <span className="mono text-white">Arc Mainnet (Chain ID 5042)</span>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-[#9CA3AF]">Token Contract</span>
                <span className="mono text-[#D1D5DB]">USDC ({truncAddr(USDC_FACT.address)})</span>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-[#9CA3AF]">
                  Provider Share (95% · {isDemoTemplate ? 'Deployer' : truncAddr(service.provider)})
                </span>
                <span className="mono font-medium text-emerald-400">
                  {formatUsdcExact(split.providerAmount)} USDC
                </span>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-[#9CA3AF]">
                  Protocol Treasury (5% · {truncAddr(PROTOCOL_TREASURY_ADDRESS)})
                </span>
                <span className="mono text-[#D1D5DB]">
                  {formatUsdcExact(split.protocolFee)} USDC
                </span>
              </div>
              {!isDemoTemplate && verifiedWallet && (
                <>
                  <div className="flex items-center justify-between pt-1 border-t border-white/[0.05]">
                    <span className="text-[#9CA3AF]">Your USDC Balance</span>
                    <span
                      className={`mono font-medium ${
                        hasInsufficientBalance
                          ? 'text-rose-400'
                          : isWrongNetwork
                            ? 'text-[#6B7280]'
                            : 'text-[#D1D5DB]'
                      }`}
                    >
                      {isWrongNetwork
                        ? 'Wrong Network'
                        : isBalanceLoading
                          ? 'Checking…'
                          : isBalanceError
                            ? 'Error loading'
                            : usdcBalance !== undefined
                              ? `${formatUsdcExact(usdcBalance)} USDC`
                              : '—'}
                    </span>
                  </div>
                  <div className="flex items-center justify-between">
                    <span className="text-[#9CA3AF]">Your USDC Allowance</span>
                    <span className="mono text-[#A78BFA]">
                      {allowance !== undefined
                        ? allowance >= service.priceInUsdc
                          ? 'Approved ✓'
                          : 'Requires Approval (Step 1/2)'
                        : 'Checking…'}
                    </span>
                  </div>
                </>
              )}
            </div>
          )}
        </div>

        {/* For Demo Templates: Optional Sample Schema Preview (explicitly labeled Demo) */}
        {isDemoTemplate && gatedPayload && (
          <div className="rounded-lg border border-amber-500/20 bg-amber-500/[0.03] overflow-hidden">
            <button
              type="button"
              onClick={() => setShowDemoSchema(s => !s)}
              className="w-full px-3 py-2 flex items-center justify-between text-xs text-amber-200/90 hover:text-amber-100 transition-colors"
            >
              <span className="font-medium flex items-center gap-1.5">
                <Sparkles size={12} className="text-amber-400" />
                Inspect Template Response Schema (Demo Preview)
              </span>
              {showDemoSchema ? <ChevronUp size={13} /> : <ChevronDown size={13} />}
            </button>
            {showDemoSchema && (
              <div className="border-t border-amber-500/20 bg-[#080A10] p-3">
                <div className="text-[10px] mono text-amber-300/80 mb-1.5">
                  // Demo template preview — deploy on-chain to gate behind real verifyAccess()
                </div>
                <pre
                  className="mono text-[11px] leading-5 overflow-x-auto text-[#D1D5DB]"
                  dangerouslySetInnerHTML={{ __html: syntaxHighlightJson(gatedPayload) }}
                />
              </div>
            )}
          </div>
        )}
      </div>

      {/* Card Footer CTA */}
      <div className="px-5 pb-5 sm:px-6 sm:pb-6 pt-1">
        {isDemoTemplate ? (
          <div className="space-y-2">
            <button
              type="button"
              onClick={onDeployTemplate}
              disabled={isDeployingTemplate || !verifiedWallet}
              className={`w-full py-2.5 px-4 rounded-lg text-xs font-semibold border transition-all flex items-center justify-center gap-2 ${
                !verifiedWallet
                  ? 'bg-white/[0.04] border-white/[0.1] text-[#9CA3AF] cursor-not-allowed'
                  : 'bg-[#7C5CFF] border-[#7C5CFF] text-white hover:bg-[#8B6EFF] shadow-sm'
              }`}
            >
              {!verifiedWallet ? (
                <span>Connect Wallet to Deploy Template On-Chain</span>
              ) : isDeployingTemplate ? (
                <>
                  <span className="w-3.5 h-3.5 rounded-full border-2 border-white/30 border-t-white animate-spin" />
                  <span>Deploying to Arc Mainnet…</span>
                </>
              ) : (
                <>
                  <span>Deploy Template On-Chain ({formatUsdcAmount(service.priceInUsdc)} USDC/call)</span>
                  <ArrowUpRight size={14} />
                </>
              )}
            </button>
            <p className="text-[11px] text-[#6B7280] text-center">
              Calls <code className="mono text-[#9CA3AF]">registerService()</code> on PayGate402 so callers can pay &amp; unlock on-chain.
            </p>
          </div>
        ) : step === 'paid_pending_auth' || step === 'authorizing' ? (
          <div className="space-y-2">
            {authError && (
              <div className="p-2.5 rounded-lg bg-rose-500/10 border border-rose-500/30 text-rose-300 text-xs flex items-start gap-2">
                <AlertCircle size={14} className="text-rose-400 flex-shrink-0 mt-0.5" />
                <div className="text-[11px] leading-4">
                  <span className="font-semibold text-rose-200">Gateway Authorization Failed: </span>
                  {authError}
                </div>
              </div>
            )}
            <button
              type="button"
              onClick={() => void handleAuthorizeGateway()}
              disabled={step === 'authorizing' || isSigning}
              className="w-full py-2.5 px-4 rounded-lg text-xs font-semibold bg-emerald-600 hover:bg-emerald-500 disabled:opacity-50 text-white transition-all flex items-center justify-center gap-2 shadow-sm"
            >
              {step === 'authorizing' || isSigning ? (
                <>
                  <span className="w-3.5 h-3.5 rounded-full border-2 border-white/30 border-t-white animate-spin" />
                  <span>Authorizing with Gateway...</span>
                </>
              ) : (
                <>
                  <ShieldCheck size={14} />
                  <span>Sign EIP-712 & Authorize with Gateway</span>
                </>
              )}
            </button>
            <p className="text-[11px] text-[#6B7280] text-center">
              Arc Mainnet transaction confirmed. Sign the EIP-712 challenge to authorize request execution on the gateway.
            </p>
          </div>
        ) : !isUnlocked ? (
          <div className="space-y-2">
            {isSmartAccountWallet && (
              <div className="p-2.5 rounded-lg bg-rose-500/10 border border-rose-500/30 text-rose-300 text-xs flex items-start gap-2">
                <AlertCircle size={14} className="text-rose-400 flex-shrink-0 mt-0.5" />
                <div className="text-[11px] leading-4">
                  <span className="font-semibold text-rose-200">EOA Wallet Required: </span>
                  Smart contract / ERC-4337 bundler wallets are unsupported for consumer payments because the Gateway verifier enforces direct EOA sender binding (<code className="mono">tx.from == caller</code>, <code className="mono">tx.to == PayGate402</code>). Connect a standard EOA wallet.
                </div>
              </div>
            )}

            {isMockGateway && (
              <div className="p-2.5 rounded-lg bg-amber-500/10 border border-amber-500/30 text-amber-300 text-xs flex items-start gap-2">
                <AlertCircle size={14} className="text-amber-400 flex-shrink-0 mt-0.5" />
                <div className="text-[11px] leading-4">
                  <span className="font-semibold text-amber-200">
                    SIMULATED DEMO — NOT ON-CHAIN AUTHORIZED:{' '}
                  </span>
                  Gateway is running in Mock RPC mode. Live wallet payments are blocked so real USDC is never spent against offline mock fixtures.
                </div>
              </div>
            )}

            {preflightError && (
              <div className="p-2.5 rounded-lg bg-rose-500/10 border border-rose-500/30 text-rose-300 text-xs flex items-start gap-2">
                <AlertCircle size={14} className="text-rose-400 flex-shrink-0 mt-0.5" />
                <div className="text-[11px] leading-4">
                  <span className="font-semibold text-rose-200">Payment Blocked: </span>
                  {preflightError}
                </div>
              </div>
            )}

            <button
              type="button"
              onClick={() => {
                void handlePayFlow()
              }}
              disabled={
                isWorking ||
                !verifiedWallet ||
                !service.active ||
                isWrongNetwork ||
                isSmartAccountWallet ||
                isMockGateway ||
                hasInsufficientBalance ||
                isBalanceLoading ||
                isBalanceError
              }
              className={`w-full py-2.5 px-4 rounded-lg text-xs font-semibold border transition-all flex items-center justify-center gap-2 ${
                !verifiedWallet ||
                !service.active ||
                isWrongNetwork ||
                isSmartAccountWallet ||
                isMockGateway ||
                hasInsufficientBalance ||
                isBalanceLoading ||
                isBalanceError
                  ? 'bg-white/[0.04] border-white/[0.1] text-[#9CA3AF] cursor-not-allowed'
                  : isWorking
                    ? 'bg-[#7C5CFF]/15 border-[#7C5CFF]/40 text-[#A78BFA] cursor-wait'
                    : 'bg-[#7C5CFF] border-[#7C5CFF] text-white hover:bg-[#8B6EFF] shadow-sm'
              }`}
            >
              {!verifiedWallet ? (
                'Connect Wallet to Authorize USDC Payment'
              ) : isWrongNetwork ? (
                'Switch to Arc Mainnet to Pay'
              ) : isSmartAccountWallet ? (
                'Smart Account Unsupported — Connect Standard EOA'
              ) : isMockGateway ? (
                'Gateway in Mock Mode — Live Payments Blocked'
              ) : !service.active ? (
                'Endpoint Currently Paused by Provider'
              ) : isBalanceLoading ? (
                <>
                  <span className="w-3.5 h-3.5 rounded-full border-2 border-[#9CA3AF]/30 border-t-[#9CA3AF] animate-spin" />
                  <span>Verifying USDC Balance…</span>
                </>
              ) : isBalanceError ? (
                'Unable to Verify USDC Balance (Check RPC)'
              ) : hasInsufficientBalance ? (
                `Insufficient USDC (${usdcBalance !== undefined ? formatUsdcAmount(usdcBalance) : '0.00'} / ${formatUsdcAmount(requiredAmountForSplit)} USDC)`
              ) : isWorking ? (
                <>
                  <span className="w-3.5 h-3.5 rounded-full border-2 border-[#A78BFA]/30 border-t-[#A78BFA] animate-spin" />
                  <span>
                    {step === 'challenging'
                      ? 'Step 0/2: Requesting HTTP 402 Challenge from Gateway…'
                      : step === 'approving'
                        ? approveWalletPending
                          ? 'Step 1/2: Confirm USDC Approval in Wallet…'
                          : approveConfirming
                            ? 'Step 1/2: Confirming USDC Approval on Arc…'
                            : 'Preparing payment…'
                        : payWalletPending
                          ? 'Step 2/2: Confirm payForAccess() in Wallet…'
                          : payConfirming
                            ? 'Step 2/2: Confirming Access Grant on Arc…'
                            : 'Processing on-chain…'}
                  </span>
                </>
              ) : (
                <>
                  <span>
                    {needsApproval ? 'Request 402 Challenge, Approve & Pay' : 'Request 402 Challenge & Pay'}{' '}
                    {formatUsdcAmount(requiredAmountForSplit)} USDC
                  </span>
                  <ChevronRight size={14} />
                </>
              )}
            </button>

            {hasInsufficientBalance && (
              <div className="flex items-center justify-center gap-1.5 text-xs text-amber-400">
                <AlertCircle size={12} />
                <span>
                  Insufficient balance: you hold {usdcBalance !== undefined ? formatUsdcAmount(usdcBalance) : '0.00'} USDC (needs {formatUsdcAmount(service.priceInUsdc)} USDC).
                </span>
              </div>
            )}

            {isBalanceError && !isDemoTemplate && verifiedWallet && !isWrongNetwork && (
              <div className="flex items-center justify-center gap-1.5 text-xs text-rose-400">
                <AlertCircle size={12} />
                <span>Could not retrieve USDC balance from Arc Mainnet RPC.</span>
              </div>
            )}

            {isWrongNetwork && (
              <div className="flex items-center justify-center gap-1.5 text-xs text-amber-400">
                <AlertCircle size={12} />
                <span>Connected network is not Arc Mainnet (Chain ID 5042).</span>
              </div>
            )}

            {(approveError || payError) && (
              <div className="flex items-center justify-center gap-1.5 text-xs text-rose-400">
                <AlertCircle size={12} />
                <span>Transaction rejected or failed. No USDC was spent.</span>
              </div>
            )}
          </div>
        ) : (
          <div className="flex items-center justify-between px-3 py-2 rounded-lg bg-emerald-500/10 border border-emerald-500/25 text-xs">
            <span className="text-emerald-300 font-medium flex items-center gap-1.5">
              <CheckCircle2 size={14} className="text-emerald-400" />
              On-chain access verified for { address ? truncAddr(address) : 'your wallet' }
            </span>
            {payTxHash && (
              <a
                href={getTxExplorerUrl(payTxHash)}
                target="_blank"
                rel="noopener noreferrer"
                className="mono text-emerald-300 hover:underline inline-flex items-center gap-1"
              >
                Explorer <ExternalLink size={11} />
              </a>
            )}
          </div>
        )}
      </div>
    </article>
  )
}
