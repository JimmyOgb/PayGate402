import { useState, useEffect, useRef } from 'react'
import {
  Plus,
  Server,
  ExternalLink,
  CheckCircle2,
  AlertCircle,
  Power,
  Sparkles,
  DollarSign,
  Activity,
  ShieldCheck,
  RefreshCw,
  FileJson,
} from 'lucide-react'
import { useAccount, useWriteContract, useWaitForTransactionReceipt, useSwitchChain } from 'wagmi'
import { ConnectKitButton } from 'connectkit'
import { toast } from 'sonner'
import {
  PAYGATE402,
  PROTOCOL_TREASURY_ADDRESS,
  ARC_MAINNET_CHAIN_ID,
  getContractConfig,
  isSupportedChain,
  MIN_SERVICE_PRICE_RAW,
  DEMO_SERVICES,
  ServiceData,
  formatUsdcAmount,
  formatUsdcExact,
  parseUsdcAmount,
  calculateFeeSplit,
  getTxExplorerUrl,
  getAddressExplorerUrl,
  truncAddr,
} from '@/lib/paygate402'
import { OnChainActivityItem } from '@/lib/usePayGateData'
import { decodeServiceRegisteredReceipt } from '@/lib/eventDecoder'

interface MyServicesProps {
  services: ServiceData[]
  myServices: ServiceData[]
  activities: OnChainActivityItem[]
  isLoading: boolean
  metrics: {
    myServicesCount: number
    myTotalCalls: bigint
    myGrossRevenue: bigint
    myNetEarnings: bigint
    myProtocolFees: bigint
  }
  onRefresh: () => void
  onRecordTx?: (item: Omit<OnChainActivityItem, 'id' | 'source'>) => void
}

export function MyServices({
  services,
  myServices,
  activities,
  isLoading,
  metrics,
  onRefresh,
  onRecordTx,
}: MyServicesProps) {
  const { address, isConnected, chainId } = useAccount()
  const { switchChain } = useSwitchChain()
  const verifiedWallet = Boolean(isConnected && address)

  // Registration form state
  const [form, setForm] = useState({
    name: '',
    desc: '',
    price: '0.10',
    preview: JSON.stringify(
      {
        status: 200,
        service: 'paygate402-protected-endpoint',
        data: { verified: true, signal: 'ALPHA_STREAM_READY' },
      },
      null,
      2
    ),
  })
  const [errors, setErrors] = useState<{
    name?: string
    desc?: string
    price?: string
    preview?: string
  }>({})
  const [submittedName, setSubmittedName] = useState('')
  const [submittedPrice, setSubmittedPrice] = useState<bigint>(0n)
  const [lastRegTxHash, setLastRegTxHash] = useState<`0x${string}` | undefined>()

  // Write hook for registerService
  const {
    writeContract: registerService,
    data: regHash,
    isPending: regWalletPending,
    isError: regError,
    error: regErrorDetails,
    reset: resetReg,
  } = useWriteContract()

  const { data: regReceipt, isLoading: regConfirming, isSuccess: regConfirmed } =
    useWaitForTransactionReceipt({ hash: regHash })

  // Write hook for setServiceActive
  const [togglingServiceId, setTogglingServiceId] = useState<bigint | null>(null)
  const [targetActiveState, setTargetActiveState] = useState<boolean>(true)
  const {
    writeContract: setServiceActive,
    data: toggleHash,
    isPending: togglePending,
    reset: resetToggle,
  } = useWriteContract()

  const { isLoading: toggleConfirming, isSuccess: toggleConfirmed } =
    useWaitForTransactionReceipt({ hash: toggleHash })

  // Handle registration confirmation
  const regHandledRef = useRef(false)
  useEffect(() => {
    if (regConfirmed && regHash && regReceipt && !regHandledRef.current) {
      regHandledRef.current = true
      const decodeResult = decodeServiceRegisteredReceipt(regReceipt, PAYGATE402.address)
      if (!decodeResult.success) {
        const errorMsg = decodeResult.error
        void Promise.resolve().then(() => {
          toast.error(`Registration event verification failed: ${errorMsg}`)
          setErrors(prev => ({ ...prev, name: `On-chain verification error: ${errorMsg}` }))
        })
        return
      }

      const { serviceId: assignedServiceId, name: eventServiceName, priceInUsdc: eventPrice, provider: eventProvider } =
        decodeResult.data

      void Promise.resolve().then(() => {
        setLastRegTxHash(regHash)
        toast.success(
          `Endpoint "${eventServiceName}" registered on-chain as Service #${assignedServiceId.toString()}!`
        )
        if (address) {
          onRecordTx?.({
            txHash: regHash,
            kind: 'ServiceRegistered',
            serviceId: assignedServiceId,
            serviceName: eventServiceName,
            actor: eventProvider,
            amountUsdc: eventPrice,
            timestamp: Date.now(),
          })
        }
        setForm({
          name: '',
          desc: '',
          price: '0.10',
          preview: JSON.stringify(
            {
              status: 200,
              service: 'paygate402-protected-endpoint',
              _notice: 'DEMO/SYNTHETIC SAMPLE — NOT LIVE MARKET DATA',
              data: { verified: true },
            },
            null,
            2
          ),
        })
        onRefresh()
      })
    }
    if (!regConfirmed) regHandledRef.current = false
  }, [
    regConfirmed,
    regHash,
    regReceipt,
    submittedName,
    submittedPrice,
    address,
    services.length,
    onRefresh,
    onRecordTx,
  ])

  // Handle status toggle confirmation
  const toggleHandledRef = useRef(false)
  useEffect(() => {
    if (toggleConfirmed && toggleHash && togglingServiceId !== null && !toggleHandledRef.current) {
      toggleHandledRef.current = true
      const sid = togglingServiceId
      const nextState = targetActiveState
      void Promise.resolve().then(() => {
        setTogglingServiceId(null)
        toast.success(`Service #${sid.toString()} marked ${nextState ? 'Active' : 'Paused'}`)
        if (address) {
          onRecordTx?.({
            txHash: toggleHash,
            kind: 'ServiceStatusUpdated',
            serviceId: sid,
            actor: address,
            activeStatus: nextState,
            timestamp: Date.now(),
          })
        }
        onRefresh()
      })
    }
    if (!toggleConfirmed) toggleHandledRef.current = false
  }, [toggleConfirmed, toggleHash, togglingServiceId, targetActiveState, address, onRefresh, onRecordTx])

  const validateForm = () => {
    const nextErrors: typeof errors = {}
    if (!form.name.trim()) {
      nextErrors.name = 'Service name is required.'
    } else if (form.name.trim().length < 3) {
      nextErrors.name = 'Service name must be at least 3 characters.'
    }

    if (!form.desc.trim()) {
      nextErrors.desc = 'Endpoint description and purpose are required.'
    } else if (form.desc.trim().length < 10) {
      nextErrors.desc = 'Provide at least 10 characters explaining what the endpoint returns.'
    }

    const parsedRaw = parseUsdcAmount(form.price)
    if (parsedRaw < MIN_SERVICE_PRICE_RAW) {
      nextErrors.price = 'Minimum price is 0.000020 USDC (20 base units) for the 95/5 fee split.'
    }

    if (form.preview.trim()) {
      try {
        JSON.parse(form.preview)
      } catch {
        nextErrors.preview = 'Payload preview should be valid JSON so callers can parse the response.'
      }
    }

    setErrors(nextErrors)
    return Object.keys(nextErrors).length === 0
  }

  const isSupported = isSupportedChain(chainId)
  const currentChainId = ARC_MAINNET_CHAIN_ID
  const contractConfig = getContractConfig(ARC_MAINNET_CHAIN_ID)

  const handleRegisterSubmit = (e: React.FormEvent) => {
    e.preventDefault()
    if (!verifiedWallet || !address) {
      toast.error('Connect your wallet first')
      return
    }
    if (!isSupported) {
      toast.error('Unsupported network. Please switch to Arc Mainnet (Chain ID 5042).')
      switchChain({ chainId: ARC_MAINNET_CHAIN_ID })
      return
    }
    if (!validateForm()) return

    resetReg()
    setLastRegTxHash(undefined)
    const rawPrice = parseUsdcAmount(form.price)
    setSubmittedName(form.name.trim())
    setSubmittedPrice(rawPrice)

    registerService({
      address: contractConfig.contractAddress,
      abi: contractConfig.abi,
      functionName: 'registerService',
      args: [form.name.trim(), form.desc.trim(), rawPrice, form.preview.trim()],
      chainId: currentChainId,
    })
  }

  const handleToggleActive = (svc: ServiceData) => {
    if (!verifiedWallet || !address) return
    if (!isSupported) {
      switchChain({ chainId: ARC_MAINNET_CHAIN_ID })
      return
    }
    resetToggle()
    setTogglingServiceId(svc.serviceId)
    setTargetActiveState(!svc.active)
    setServiceActive({
      address: contractConfig.contractAddress,
      abi: contractConfig.abi,
      functionName: 'setServiceActive',
      args: [svc.serviceId, !svc.active],
      chainId: currentChainId,
    })
  }

  const applyPreset = (idx: number) => {
    const preset = DEMO_SERVICES[idx]
    if (!preset) return
    setForm({
      name: preset.name,
      desc: preset.endpointDescription,
      price: (Number(preset.priceInUsdc) / 1_000_000).toFixed(2),
      preview: preset.gatedPayloadPreview,
    })
    setErrors({})
  }

  const formatPreviewJson = () => {
    try {
      const parsed: unknown = JSON.parse(form.preview)
      setForm(f => ({ ...f, preview: JSON.stringify(parsed, null, 2) }))
      setErrors(e => ({ ...e, preview: undefined }))
    } catch {
      setErrors(e => ({ ...e, preview: 'Invalid JSON syntax — cannot auto-format.' }))
    }
  }

  const rawPricePreview = parseUsdcAmount(form.price)
  const splitPreview = calculateFeeSplit(rawPricePreview)
  const isRegistering = regWalletPending || regConfirming

  // Filter payment history for provider's services
  const myServiceIds = new Set(myServices.map(s => s.serviceId.toString()))
  const providerPaymentEvents = activities.filter(
    a => a.kind === 'AccessGranted' && myServiceIds.has(a.serviceId.toString())
  )

  return (
    <div className="space-y-8">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <h1 className="display text-2xl font-bold text-white tracking-tight">
            My Services &amp; Provider Portal
          </h1>
          <p className="text-sm text-[#9CA3AF] mt-1">
            Register HTTP 402 endpoints on Arc Mainnet, manage active status, and monitor your 95% USDC revenue share.
          </p>
        </div>

        <button
          type="button"
          onClick={onRefresh}
          className="pg-btn-secondary px-3 py-2 text-xs self-start sm:self-auto"
        >
          <RefreshCw size={14} className={isLoading ? 'animate-spin text-[#A78BFA]' : ''} />
          <span>Sync Provider State</span>
        </button>
      </div>

      {/* Provider Earnings & Telemetry Strip */}
      <section className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        <div className="pg-card p-5">
          <div className="flex items-center justify-between mb-2">
            <span className="text-xs font-medium text-[#9CA3AF]">Your Endpoints</span>
            <Server size={14} className="text-[#A78BFA]" />
          </div>
          <div className="display text-2xl font-bold text-white mono tabular-nums">
            {verifiedWallet ? metrics.myServicesCount : '—'}
          </div>
          <div className="text-[11px] text-[#6B7280] mt-1">
            {verifiedWallet
              ? `${myServices.filter(s => s.active).length} active on PayGate402`
              : 'Connect wallet to view'}
          </div>
        </div>

        <div className="pg-card p-5">
          <div className="flex items-center justify-between mb-2">
            <span className="text-xs font-medium text-[#9CA3AF]">Calls to Your Endpoints</span>
            <Activity size={14} className="text-blue-400" />
          </div>
          <div className="display text-2xl font-bold text-white mono tabular-nums">
            {verifiedWallet ? Number(metrics.myTotalCalls).toLocaleString() : '—'}
          </div>
          <div className="text-[11px] text-[#6B7280] mt-1">
            Verified via <code className="mono">payForAccess()</code>
          </div>
        </div>

        <div className="pg-card p-5">
          <div className="flex items-center justify-between mb-2">
            <span className="text-xs font-medium text-[#9CA3AF]">Net Provider Earnings (95%)</span>
            <DollarSign size={14} className="text-emerald-400" />
          </div>
          <div className="display text-2xl font-bold text-emerald-400 mono tabular-nums">
            {verifiedWallet ? `${formatUsdcAmount(metrics.myNetEarnings)} USDC` : '—'}
          </div>
          <div className="text-[11px] text-[#6B7280] mt-1">
            Gross volume: {verifiedWallet ? `${formatUsdcAmount(metrics.myGrossRevenue)} USDC` : '0.00 USDC'}
          </div>
        </div>

        <div className="pg-card p-5">
          <div className="flex items-center justify-between mb-2">
            <span className="text-xs font-medium text-[#9CA3AF]">Protocol Treasury Fee (5%)</span>
            <ShieldCheck size={14} className="text-[#9CA3AF]" />
          </div>
          <div className="display text-2xl font-bold text-white mono tabular-nums">
            {verifiedWallet ? `${formatUsdcAmount(metrics.myProtocolFees)} USDC` : '500 BPS'}
          </div>
          <div className="text-[11px] text-[#6B7280] mt-1 mono">
            Treasury: {truncAddr(PROTOCOL_TREASURY_ADDRESS)}
          </div>
        </div>
      </section>

      {/* Two-Column Layout: Left = Register Endpoint Form, Right = Provider's Registered Services & Payment History */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 items-start">
        {/* Left Column (7 cols): Register New API Endpoint */}
        <section className="lg:col-span-7 pg-card p-6 sm:p-7 space-y-6">
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 border-b border-white/[0.08] pb-4">
            <div>
              <h2 className="display text-lg font-semibold text-white">
                Register New API Endpoint
              </h2>
              <p className="text-xs text-[#9CA3AF] mt-0.5">
                Deploys a new service entry on <code className="mono text-[#D1D5DB]">PayGate402</code> and assigns a unique on-chain <code className="mono text-[#D1D5DB]">serviceId</code>.
              </p>
            </div>

            {/* Quick-fill preset buttons */}
            <div className="flex items-center gap-1.5 flex-wrap">
              <button
                type="button"
                onClick={() => applyPreset(0)}
                className="px-2.5 py-1 rounded-md bg-white/[0.05] hover:bg-white/[0.1] border border-white/[0.08] text-[11px] text-[#D1D5DB] inline-flex items-center gap-1 transition-colors"
              >
                <Sparkles size={11} className="text-[#A78BFA]" />
                <span>Preset: Whale Feed</span>
              </button>
              <button
                type="button"
                onClick={() => applyPreset(1)}
                className="px-2.5 py-1 rounded-md bg-white/[0.05] hover:bg-white/[0.1] border border-white/[0.08] text-[11px] text-[#D1D5DB] inline-flex items-center gap-1 transition-colors"
              >
                <Sparkles size={11} className="text-[#A78BFA]" />
                <span>Preset: Security Audit</span>
              </button>
            </div>
          </div>

          <form onSubmit={handleRegisterSubmit} noValidate className="space-y-5">
            {/* Service Name */}
            <div>
              <label htmlFor="svc-name" className="block text-xs font-semibold text-[#E5E7EB] mb-1.5">
                Service Name <span className="text-rose-400">*</span>
              </label>
              <input
                id="svc-name"
                type="text"
                value={form.name}
                onChange={e => {
                  setForm(f => ({ ...f, name: e.target.value }))
                  if (errors.name) setErrors(err => ({ ...err, name: undefined }))
                }}
                placeholder="e.g. DeFi Whale Alpha Feed API"
                disabled={isRegistering}
                className="pg-input"
              />
              {errors.name ? (
                <p className="text-xs text-rose-400 mt-1 flex items-center gap-1">
                  <AlertCircle size={12} />
                  {errors.name}
                </p>
              ) : (
                <p className="text-[11px] text-[#6B7280] mt-1">
                  Public identifier displayed in the marketplace and returned in HTTP 402 headers.
                </p>
              )}
            </div>

            {/* Endpoint Description */}
            <div>
              <label htmlFor="svc-desc" className="block text-xs font-semibold text-[#E5E7EB] mb-1.5">
                Endpoint Description &amp; Documentation <span className="text-rose-400">*</span>
              </label>
              <textarea
                id="svc-desc"
                rows={3}
                value={form.desc}
                onChange={e => {
                  setForm(f => ({ ...f, desc: e.target.value }))
                  if (errors.desc) setErrors(err => ({ ...err, desc: undefined }))
                }}
                placeholder="Describe the HTTP route, expected parameters, and the response payload callers receive after payment…"
                disabled={isRegistering}
                className="pg-input resize-none"
              />
              {errors.desc && (
                <p className="text-xs text-rose-400 mt-1 flex items-center gap-1">
                  <AlertCircle size={12} />
                  {errors.desc}
                </p>
              )}
            </div>

            {/* Price in USDC */}
            <div>
              <label htmlFor="svc-price" className="block text-xs font-semibold text-[#E5E7EB] mb-1.5">
                Price Per Request (USDC) <span className="text-rose-400">*</span>
              </label>
              <div className="relative">
                <input
                  id="svc-price"
                  type="number"
                  step="0.000001"
                  min="0.000020"
                  value={form.price}
                  onChange={e => {
                    setForm(f => ({ ...f, price: e.target.value }))
                    if (errors.price) setErrors(err => ({ ...err, price: undefined }))
                  }}
                  placeholder="0.10"
                  disabled={isRegistering}
                  className="pg-input pr-20 mono tabular-nums"
                />
                <span className="absolute right-3.5 top-1/2 -translate-y-1/2 text-xs font-semibold mono text-[#9CA3AF]">
                  USDC
                </span>
              </div>
              {errors.price ? (
                <p className="text-xs text-rose-400 mt-1 flex items-center gap-1">
                  <AlertCircle size={12} />
                  {errors.price}
                </p>
              ) : (
                <p className="text-[11px] text-[#6B7280] mt-1 mono">
                  Raw base units (6 decimals): {rawPricePreview.toString()} · Contract minimum: 20 (0.000020 USDC)
                </p>
              )}
            </div>

            {/* Gated Payload Preview */}
            <div>
              <div className="flex items-center justify-between mb-1.5">
                <label htmlFor="svc-preview" className="block text-xs font-semibold text-[#E5E7EB]">
                  Gated Response Payload (JSON)
                </label>
                <button
                  type="button"
                  onClick={formatPreviewJson}
                  className="inline-flex items-center gap-1 text-[11px] text-[#A78BFA] hover:text-white mono"
                >
                  <FileJson size={12} />
                  <span>Format JSON</span>
                </button>
              </div>
              <textarea
                id="svc-preview"
                rows={5}
                value={form.preview}
                onChange={e => {
                  setForm(f => ({ ...f, preview: e.target.value }))
                  if (errors.preview) setErrors(err => ({ ...err, preview: undefined }))
                }}
                placeholder={`{\n  "status": 200,\n  "data": "protected response payload"\n}`}
                disabled={isRegistering}
                className="pg-input mono text-xs leading-5 resize-none bg-[#080A10]"
              />
              {errors.preview ? (
                <p className="text-xs text-rose-400 mt-1 flex items-center gap-1">
                  <AlertCircle size={12} />
                  {errors.preview}
                </p>
              ) : (
                <p className="text-[11px] text-[#6B7280] mt-1">
                  Delivered to callers after on-chain <code className="mono text-[#9CA3AF]">AccessGranted</code> settlement and gateway verification.
                </p>
              )}
            </div>

            {/* Live On-Chain Revenue Split Preview */}
            <div className="pg-panel p-4 space-y-2.5 border border-white/[0.08]">
              <div className="flex items-center justify-between">
                <span className="text-[11px] font-semibold uppercase tracking-wider text-[#9CA3AF]">
                  Contract Revenue Split Preview
                </span>
                <span className="text-[11px] mono text-[#A78BFA]">
                  PROTOCOL_FEE_BPS = 500 / 10000
                </span>
              </div>

              <div className="space-y-1.5 text-xs">
                <div className="flex items-center justify-between">
                  <span className="text-[#D1D5DB]">
                    Provider Payout (95% → {verifiedWallet && address ? truncAddr(address) : 'Your Wallet'})
                  </span>
                  <span className="mono font-semibold text-emerald-400 tabular-nums">
                    {formatUsdcExact(splitPreview.providerAmount)} USDC
                  </span>
                </div>
                <div className="flex items-center justify-between">
                  <span className="text-[#9CA3AF]">
                    Protocol Treasury (5% → {truncAddr(PROTOCOL_TREASURY_ADDRESS)})
                  </span>
                  <span className="mono text-[#9CA3AF] tabular-nums">
                    {formatUsdcExact(splitPreview.protocolFee)} USDC
                  </span>
                </div>
              </div>
            </div>

            {/* Submit / Connect Button */}
            {!verifiedWallet ? (
              <ConnectKitButton.Custom>
                {({ show }) => (
                  <button
                    type="button"
                    onClick={show}
                    className="w-full pg-btn-primary py-3 text-sm font-semibold"
                  >
                    Connect Wallet to Register Service
                  </button>
                )}
              </ConnectKitButton.Custom>
            ) : (
              <button
                type="submit"
                disabled={isRegistering}
                className="w-full pg-btn-primary py-3 text-sm font-semibold"
              >
                {isRegistering ? (
                  <>
                    <span className="w-4 h-4 rounded-full border-2 border-white/30 border-t-white animate-spin" />
                    <span>
                      {regWalletPending
                        ? 'Confirm registerService() in Wallet…'
                        : 'Confirming Registration on Arc Mainnet…'}
                    </span>
                  </>
                ) : (
                  <>
                    <Plus size={16} />
                    <span>Register Endpoint on Arc Mainnet</span>
                  </>
                )}
              </button>
            )}

            {/* Confirmation Banner */}
            {lastRegTxHash && (
              <div className="p-3.5 rounded-lg bg-emerald-500/10 border border-emerald-500/30 flex items-center justify-between gap-3 text-xs">
                <div className="flex items-center gap-2 text-emerald-300">
                  <CheckCircle2 size={15} className="text-emerald-400 flex-shrink-0" />
                  <span>Service registered on-chain!</span>
                </div>
                <a
                  href={getTxExplorerUrl(lastRegTxHash)}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center gap-1 mono text-emerald-300 hover:underline"
                >
                  View Tx ({truncAddr(lastRegTxHash)})
                  <ExternalLink size={11} />
                </a>
              </div>
            )}

            {/* Error Banner */}
            {regError && (
              <div className="p-3.5 rounded-lg bg-rose-500/10 border border-rose-500/30 flex items-start gap-2 text-xs text-rose-300">
                <AlertCircle size={15} className="text-rose-400 flex-shrink-0 mt-0.5" />
                <div>
                  <div className="font-medium">Registration transaction failed or was cancelled.</div>
                  {regErrorDetails && (
                    <div className="text-[11px] text-rose-300/80 mt-0.5 line-clamp-2">
                      {regErrorDetails.message.split('\n')[0]}
                    </div>
                  )}
                </div>
              </div>
            )}
          </form>
        </section>

        {/* Right Column (5 cols): Provider's Registered Endpoints & Payment History */}
        <div className="lg:col-span-5 space-y-6">
          {/* Provider Endpoints List */}
          <section className="pg-card p-6 space-y-4">
            <div className="flex items-center justify-between border-b border-white/[0.08] pb-3">
              <div>
                <h2 className="display text-base font-semibold text-white">
                  Your Registered Endpoints
                </h2>
                <p className="text-xs text-[#9CA3AF] mt-0.5">
                  Manage endpoint availability via <code className="mono text-[#D1D5DB]">setServiceActive()</code>
                </p>
              </div>
              <span className="pg-badge bg-white/[0.06] text-[#D1D5DB] mono">
                {myServices.length} total
              </span>
            </div>

            {!verifiedWallet ? (
              <div className="py-8 text-center space-y-2">
                <Server size={22} className="text-[#6B7280] mx-auto" />
                <div className="text-sm font-medium text-white">Wallet Not Connected</div>
                <p className="text-xs text-[#9CA3AF] max-w-xs mx-auto">
                  Connect your provider wallet to inspect your registered endpoints, toggle active status, and track revenue.
                </p>
              </div>
            ) : myServices.length === 0 ? (
              <div className="py-8 text-center space-y-2">
                <Server size={22} className="text-[#6B7280] mx-auto" />
                <div className="text-sm font-medium text-white">
                  No endpoints registered by {address ? truncAddr(address) : 'this wallet'}
                </div>
                <p className="text-xs text-[#9CA3AF] max-w-xs mx-auto">
                  Use the registration form to deploy your first HTTP 402 gated service on Arc Mainnet.
                </p>
              </div>
            ) : (
              <div className="space-y-3">
                {myServices.map(svc => {
                  const split = calculateFeeSplit(svc.totalRevenue)
                  const isTogglingThis =
                    togglingServiceId === svc.serviceId && (togglePending || toggleConfirming)

                  return (
                    <div
                      key={svc.serviceId.toString()}
                      className="pg-panel p-4 space-y-3 border border-white/[0.08]"
                    >
                      <div className="flex items-start justify-between gap-2">
                        <div>
                          <div className="flex items-center gap-2">
                            <span className="text-xs mono text-[#A78BFA] font-semibold">
                              #{svc.serviceId.toString()}
                            </span>
                            <h3 className="text-sm font-semibold text-white">{svc.name}</h3>
                          </div>
                          <div className="text-xs text-[#9CA3AF] mono mt-0.5">
                            Price: {formatUsdcAmount(svc.priceInUsdc)} USDC / call
                          </div>
                        </div>

                        <button
                          type="button"
                          onClick={() => handleToggleActive(svc)}
                          disabled={isTogglingThis}
                          className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md text-xs font-medium border transition-colors ${
                            svc.active
                              ? 'bg-emerald-500/10 text-emerald-300 border-emerald-500/30 hover:bg-rose-500/15 hover:text-rose-300 hover:border-rose-500/30'
                              : 'bg-rose-500/10 text-rose-300 border-rose-500/30 hover:bg-emerald-500/15 hover:text-emerald-300 hover:border-emerald-500/30'
                          }`}
                          title={svc.active ? 'Click to pause service' : 'Click to activate service'}
                        >
                          <Power size={11} />
                          <span>
                            {isTogglingThis
                              ? 'Updating…'
                              : svc.active
                                ? 'Active'
                                : 'Paused'}
                          </span>
                        </button>
                      </div>

                      <div className="grid grid-cols-3 gap-2 pt-2 border-t border-white/[0.06] text-xs">
                        <div>
                          <div className="text-[10px] text-[#6B7280] uppercase">Calls</div>
                          <div className="mono font-semibold text-white">
                            {Number(svc.totalCalls).toLocaleString()}
                          </div>
                        </div>
                        <div>
                          <div className="text-[10px] text-[#6B7280] uppercase">Gross Volume</div>
                          <div className="mono font-semibold text-white">
                            {formatUsdcAmount(svc.totalRevenue)} USDC
                          </div>
                        </div>
                        <div className="text-right">
                          <div className="text-[10px] text-[#6B7280] uppercase">Net (95%)</div>
                          <div className="mono font-semibold text-emerald-400">
                            {formatUsdcAmount(split.providerAmount)} USDC
                          </div>
                        </div>
                      </div>
                    </div>
                  )
                })}
              </div>
            )}
          </section>

          {/* Provider Payment History */}
          <section className="pg-card p-6 space-y-4">
            <div className="flex items-center justify-between border-b border-white/[0.08] pb-3">
              <div>
                <h2 className="display text-base font-semibold text-white">
                  Provider Payment History
                </h2>
                <p className="text-xs text-[#9CA3AF] mt-0.5">
                  On-chain <code className="mono text-[#D1D5DB]">AccessGranted</code> settlements for your endpoints
                </p>
              </div>
            </div>

            {providerPaymentEvents.length === 0 ? (
              <div className="py-6 text-center space-y-1.5">
                <div className="text-xs font-medium text-[#D1D5DB]">
                  No incoming payments recorded yet
                </div>
                <p className="text-[11px] text-[#6B7280]">
                  When callers execute <code className="mono">payForAccess()</code> on your services, each settlement and explorer proof will appear here.
                </p>
              </div>
            ) : (
              <div className="space-y-2.5">
                {providerPaymentEvents.slice(0, 6).map(ev => (
                  <div
                    key={ev.id}
                    className="pg-panel p-3 flex items-center justify-between gap-2 text-xs"
                  >
                    <div>
                      <div className="font-medium text-white">
                        {ev.serviceName || `Service #${ev.serviceId.toString()}`}
                      </div>
                      <div className="text-[11px] text-[#9CA3AF] mono">
                        Caller:{' '}
                        <a
                          href={getAddressExplorerUrl(ev.actor)}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="hover:text-white underline"
                        >
                          {truncAddr(ev.actor)}
                        </a>
                      </div>
                    </div>
                    <div className="text-right">
                      <div className="mono font-semibold text-emerald-400">
                        +{ev.amountUsdc ? formatUsdcAmount((ev.amountUsdc * 9500n) / 10000n) : '0.00'} USDC
                      </div>
                      <a
                        href={getTxExplorerUrl(ev.txHash)}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="inline-flex items-center gap-1 text-[11px] mono text-[#A78BFA] hover:underline"
                      >
                        {truncAddr(ev.txHash)}
                        <ExternalLink size={10} />
                      </a>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </section>
        </div>
      </div>
    </div>
  )
}
