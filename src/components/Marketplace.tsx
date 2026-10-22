import { useState, useCallback, useEffect, useRef, useMemo } from 'react'
import {
  RefreshCw,
  Plus,
  Search,
  AlertCircle,
  Sparkles,
  Layers,
  Filter,
  SlidersHorizontal,
  Zap,
} from 'lucide-react'
import { useAccount, useWriteContract, useWaitForTransactionReceipt, useSwitchChain } from 'wagmi'
import { toast } from 'sonner'
import {
  PAYGATE402,
  ARC_TESTNET_CHAIN_ID,
  ARC_MAINNET_CHAIN_ID,
  getContractConfig,
  isSupportedChain,
  DEMO_SERVICES,
  DemoServiceTemplate,
  ServiceData,
  inferServiceCategory,
} from '@/lib/paygate402'
import { OnChainActivityItem } from '@/lib/usePayGateData'
import { decodeServiceRegisteredReceipt } from '@/lib/eventDecoder'
import { ServiceCard } from './ServiceCard'
import { FlowDashboard } from './FlowDashboard'
import { AppRoute } from './Header'

interface MarketplaceProps {
  services: ServiceData[]
  isLoading: boolean
  isError: boolean
  onRefresh: () => void
  onNavigate: (route: AppRoute) => void
  onRecordTx?: (item: Omit<OnChainActivityItem, 'id' | 'source'>) => void
}

type CategoryFilter = 'All' | 'DeFi & Signals' | 'Security & Audit' | 'AI & Agents' | 'Infrastructure'
type SourceFilter = 'all' | 'onchain' | 'templates'

const CATEGORIES: CategoryFilter[] = [
  'All',
  'DeFi & Signals',
  'Security & Audit',
  'AI & Agents',
  'Infrastructure',
]

export function Marketplace({
  services,
  isLoading,
  isError,
  onRefresh,
  onNavigate,
  onRecordTx,
}: MarketplaceProps) {
  const { address, isConnected, chainId } = useAccount()
  const { switchChain } = useSwitchChain()
  const verifiedWallet = Boolean(isConnected && address)

  const [viewMode, setViewMode] = useState<'flow' | 'registry'>('flow')
  const [searchQuery, setSearchQuery] = useState('')
  const [selectedCategory, setSelectedCategory] = useState<CategoryFilter>('All')
  const [sourceFilter, setSourceFilter] = useState<SourceFilter>('all')
  const [deployingTemplateId, setDeployingTemplateId] = useState<string | null>(null)
  const pendingTemplateRef = useRef<DemoServiceTemplate | null>(null)

  const {
    writeContract: registerSvc,
    data: seedHash,
    isPending: seedPending,
    reset: resetSeed,
  } = useWriteContract()

  const { data: seedReceipt, isLoading: seedConfirming, isSuccess: seedConfirmed } =
    useWaitForTransactionReceipt({ hash: seedHash })

  const isSupported = isSupportedChain(chainId)
  const currentChainId = chainId === ARC_MAINNET_CHAIN_ID ? ARC_MAINNET_CHAIN_ID : ARC_TESTNET_CHAIN_ID
  const contractConfig = getContractConfig(currentChainId)

  const handleDeployTemplate = useCallback(
    (template: DemoServiceTemplate) => {
      if (!verifiedWallet || !address) {
        toast.error(`Connect your wallet first to deploy a service on ${contractConfig.chainName}`)
        return
      }
      if (!isSupported) {
        switchChain({ chainId: ARC_MAINNET_CHAIN_ID })
        return
      }
      resetSeed()
      setDeployingTemplateId(template.id)
      pendingTemplateRef.current = template
      registerSvc({
        address: contractConfig.contractAddress,
        abi: contractConfig.abi,
        functionName: 'registerService',
        args: [
          template.name,
          template.endpointDescription,
          template.priceInUsdc,
          template.gatedPayloadPreview,
        ],
        chainId: currentChainId,
      })
    },
    [verifiedWallet, address, isSupported, currentChainId, contractConfig, switchChain, resetSeed, registerSvc]
  )

  const seedHandledRef = useRef(false)
  useEffect(() => {
    if (seedConfirmed && deployingTemplateId && seedReceipt && !seedHandledRef.current) {
      seedHandledRef.current = true
      const decodeResult = decodeServiceRegisteredReceipt(seedReceipt, PAYGATE402.address)
      if (!decodeResult.success) {
        const errorMsg = decodeResult.error
        void Promise.resolve().then(() => {
          toast.error(`Seed template registration failed on-chain verification: ${errorMsg}`)
          setDeployingTemplateId(null)
        })
        return
      }

      const { serviceId: assignedServiceId, name: eventServiceName, priceInUsdc: eventPrice, provider: eventProvider } =
        decodeResult.data

      void Promise.resolve().then(() => {
        setDeployingTemplateId(null)
        toast.success(
          `"${eventServiceName}" registered on-chain as Service #${assignedServiceId.toString()}!`
        )
        if (seedHash && address) {
          onRecordTx?.({
            txHash: seedHash,
            kind: 'ServiceRegistered',
            serviceId: assignedServiceId,
            serviceName: eventServiceName,
            actor: eventProvider,
            amountUsdc: eventPrice,
            timestamp: Date.now(),
          })
        }
        onRefresh()
      })
    }
    if (!seedConfirmed) seedHandledRef.current = false
  }, [
    seedConfirmed,
    deployingTemplateId,
    seedHash,
    seedReceipt,
    address,
    services.length,
    onRefresh,
    onRecordTx,
  ])

  // Determine which demo templates are not yet registered on-chain by name
  const unregisteredTemplates = useMemo(() => {
    const registeredNames = new Set(services.map(s => s.name.toLowerCase()))
    return DEMO_SERVICES.filter(d => !registeredNames.has(d.name.toLowerCase()))
  }, [services])

  // Filter on-chain services
  const filteredOnChain = useMemo(() => {
    if (sourceFilter === 'templates') return []
    return services.filter(svc => {
      const matchedDemo = DEMO_SERVICES.find(d => d.name.toLowerCase() === svc.name.toLowerCase())
      const tags = matchedDemo?.tags ?? []
      const cat =
        matchedDemo?.category ?? inferServiceCategory(svc.name, svc.endpointDescription, tags)

      if (selectedCategory !== 'All' && cat !== selectedCategory) return false

      if (searchQuery.trim()) {
        const q = searchQuery.toLowerCase()
        const matchName = svc.name.toLowerCase().includes(q)
        const matchDesc = svc.endpointDescription.toLowerCase().includes(q)
        const matchProv = svc.provider.toLowerCase().includes(q)
        const matchId = svc.serviceId.toString() === q.replace('#', '')
        const matchTags = tags.some(t => t.toLowerCase().includes(q))
        if (!matchName && !matchDesc && !matchProv && !matchId && !matchTags) return false
      }
      return true
    })
  }, [services, sourceFilter, selectedCategory, searchQuery])

  // Filter demo templates
  const filteredTemplates = useMemo(() => {
    if (sourceFilter === 'onchain') return []
    return unregisteredTemplates.filter(tpl => {
      if (selectedCategory !== 'All' && tpl.category !== selectedCategory) return false
      if (searchQuery.trim()) {
        const q = searchQuery.toLowerCase()
        const matchName = tpl.name.toLowerCase().includes(q)
        const matchDesc = tpl.endpointDescription.toLowerCase().includes(q)
        const matchTags = tpl.tags.some(t => t.toLowerCase().includes(q))
        if (!matchName && !matchDesc && !matchTags) return false
      }
      return true
    })
  }, [unregisteredTemplates, sourceFilter, selectedCategory, searchQuery])

  const getDemoMeta = (svc: ServiceData) => {
    const matched = DEMO_SERVICES.find(d => d.name.toLowerCase() === svc.name.toLowerCase())
    return {
      tags: matched?.tags ?? [],
      category: matched?.category ?? inferServiceCategory(svc.name, svc.endpointDescription),
      endpointPath: matched?.endpointPath ?? `/v1/services/${svc.serviceId.toString()}`,
      httpMethod: matched?.httpMethod ?? ('POST' as const),
      gatedPayload: svc.gatedPayloadPreview || matched?.gatedPayloadPreview,
    }
  }

  return (
    <div className="space-y-6">
      {/* Page Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <div className="flex items-center gap-2.5">
            <h1 className="display text-2xl font-bold text-white tracking-tight">
              Explore Services
            </h1>
            <span className="pg-badge bg-[#7C5CFF]/15 text-[#A78BFA] border border-[#7C5CFF]/30 mono">
              {services.length} On-Chain
            </span>
          </div>
          <p className="text-sm text-[#9CA3AF] mt-1">
            Discover HTTP 402 endpoints on Arc Testnet. Authorize per-call USDC micropayments with instant on-chain access verification.
          </p>
        </div>

        <div className="flex items-center gap-2.5 self-start sm:self-auto">
          <button
            type="button"
            onClick={onRefresh}
            className="pg-btn-secondary px-3 py-2 text-xs"
            title="Refresh on-chain services"
          >
            <RefreshCw size={14} className={isLoading ? 'animate-spin text-[#A78BFA]' : ''} />
            <span>Refresh</span>
          </button>

          <button
            type="button"
            onClick={() => onNavigate('my-services')}
            className="pg-btn-primary px-3.5 py-2 text-xs"
          >
            <Plus size={14} />
            <span>Register Endpoint</span>
          </button>
        </div>
      </div>

      {/* View Switcher: Interactive Flow Dashboard vs Full Registry */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 p-1.5 rounded-xl bg-[#0B0D14] border border-white/[0.08]">
        <div className="flex items-center gap-1.5">
          <button
            type="button"
            onClick={() => setViewMode('flow')}
            className={`flex items-center gap-2 px-3.5 py-2 rounded-lg text-xs font-semibold transition-all ${
              viewMode === 'flow'
                ? 'bg-blue-600 text-white shadow-md'
                : 'text-gray-400 hover:text-white hover:bg-white/[0.03]'
            }`}
          >
            <Zap size={14} className={viewMode === 'flow' ? 'text-white' : 'text-blue-400'} />
            <span>Interactive 402 Flow Dashboard</span>
          </button>

          <button
            type="button"
            onClick={() => setViewMode('registry')}
            className={`flex items-center gap-2 px-3.5 py-2 rounded-lg text-xs font-semibold transition-all ${
              viewMode === 'registry'
                ? 'bg-blue-600 text-white shadow-md'
                : 'text-gray-400 hover:text-white hover:bg-white/[0.03]'
            }`}
          >
            <Layers size={14} className={viewMode === 'registry' ? 'text-white' : 'text-purple-400'} />
            <span>Registry & Custom Endpoints ({services.length})</span>
          </button>
        </div>

        <div className="text-[11px] text-gray-500 px-2 flex items-center gap-2">
          <span className="w-1.5 h-1.5 rounded-full bg-emerald-400" />
          <span>HTTP 402 Micropayment Protocol</span>
        </div>
      </div>

      {viewMode === 'flow' ? (
        <FlowDashboard services={services} onNavigate={onNavigate} onRefresh={onRefresh} />
      ) : (
        <>
          {/* Search & Filter Bar */}
          <div className="pg-card p-4 space-y-3">
            <div className="flex flex-col md:flex-row gap-3">
          {/* Search input */}
          <div className="relative flex-1">
            <Search
              size={15}
              className="absolute left-3.5 top-1/2 -translate-y-1/2 text-[#6B7280] pointer-events-none"
            />
            <input
              type="search"
              value={searchQuery}
              onChange={e => setSearchQuery(e.target.value)}
              placeholder="Search by service name, endpoint, tag, provider address, or #ID…"
              aria-label="Search services"
              className="pg-input pl-9 pr-4 py-2 text-xs sm:text-sm"
            />
          </div>

          {/* Source Filter Segmented Control */}
          <div className="flex items-center gap-1 p-1 rounded-lg bg-[#0B0D14] border border-white/[0.08] self-start md:self-auto">
            {(
              [
                { id: 'all', label: 'All Views' },
                { id: 'onchain', label: `On-Chain (${services.length})` },
                { id: 'templates', label: `Demo Templates (${unregisteredTemplates.length})` },
              ] as const
            ).map(tab => (
              <button
                key={tab.id}
                type="button"
                onClick={() => setSourceFilter(tab.id)}
                className={`px-2.5 py-1 rounded-md text-xs font-medium transition-colors ${
                  sourceFilter === tab.id
                    ? 'bg-[#7C5CFF]/20 text-white border border-[#7C5CFF]/40'
                    : 'text-[#9CA3AF] hover:text-white border border-transparent'
                }`}
              >
                {tab.label}
              </button>
            ))}
          </div>
        </div>

        {/* Category Filter Pills */}
        <div className="flex items-center gap-1.5 flex-wrap pt-1">
          <span className="text-[11px] font-medium text-[#6B7280] flex items-center gap-1 mr-1">
            <Filter size={11} />
            Category:
          </span>
          {CATEGORIES.map(cat => (
            <button
              key={cat}
              type="button"
              onClick={() => setSelectedCategory(cat)}
              className={`px-2.5 py-1 rounded-md text-xs font-medium transition-colors border ${
                selectedCategory === cat
                  ? 'bg-white/[0.09] text-white border-white/[0.2]'
                  : 'bg-transparent text-[#9CA3AF] border-white/[0.06] hover:border-white/[0.14] hover:text-[#E5E7EB]'
              }`}
            >
              {cat}
            </button>
          ))}
        </div>
      </div>

      {/* Error State */}
      {isError && (
        <div className="pg-card p-5 border-rose-500/30 bg-rose-500/[0.05] flex items-center justify-between gap-4">
          <div className="flex items-center gap-3">
            <AlertCircle size={18} className="text-rose-400 flex-shrink-0" />
            <div>
              <h3 className="text-sm font-semibold text-white">
                Unable to reach Arc Testnet RPC
              </h3>
              <p className="text-xs text-[#9CA3AF] mt-0.5">
                Could not read <code className="mono">nextServiceId</code> from PayGate402. Check your network connection and retry.
              </p>
            </div>
          </div>
          <button type="button" onClick={onRefresh} className="pg-btn-secondary text-xs">
            Retry
          </button>
        </div>
      )}

      {/* Loading Skeletons */}
      {isLoading && (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-5">
          {[0, 1].map(idx => (
            <div key={idx} className="pg-card p-6 space-y-4 animate-pulse">
              <div className="flex justify-between">
                <div className="h-5 w-36 rounded bg-white/[0.06]" />
                <div className="h-5 w-20 rounded bg-white/[0.06]" />
              </div>
              <div className="h-6 w-3/4 rounded bg-white/[0.08]" />
              <div className="h-12 w-full rounded bg-white/[0.05]" />
              <div className="h-28 w-full rounded bg-white/[0.04]" />
              <div className="h-10 w-full rounded bg-white/[0.07]" />
            </div>
          ))}
        </div>
      )}

      {/* On-Chain Services Section */}
      {!isLoading && sourceFilter !== 'templates' && (
        <section className="space-y-4">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <Layers size={15} className="text-[#A78BFA]" />
              <h2 className="text-sm font-semibold text-white">
                On-Chain Registered Endpoints ({filteredOnChain.length})
              </h2>
            </div>
          </div>

          {services.length === 0 ? (
            <div className="pg-card p-6 sm:p-8 border-dashed border-white/[0.12] flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4">
              <div className="space-y-1 max-w-xl">
                <div className="inline-flex items-center gap-1.5 text-xs font-medium text-[#A78BFA] mono">
                  <span>nextServiceId = 0 on 0xcc69...9971</span>
                </div>
                <h3 className="display text-base font-semibold text-white">
                  No endpoints registered on-chain yet
                </h3>
                <p className="text-xs text-[#9CA3AF] leading-relaxed">
                  The deployed <code className="mono text-[#D1D5DB]">PayGate402</code> contract on Arc Testnet currently has 0 registered services.
                  You can deploy either of the reference templates below directly on-chain or register your own custom endpoint.
                </p>
              </div>
              <div className="flex items-center gap-2.5 flex-shrink-0">
                <button
                  type="button"
                  onClick={() => onNavigate('my-services')}
                  className="pg-btn-primary text-xs"
                >
                  <Plus size={14} />
                  <span>Register Custom Endpoint</span>
                </button>
              </div>
            </div>
          ) : filteredOnChain.length === 0 ? (
            <div className="pg-card p-8 text-center space-y-2">
              <SlidersHorizontal size={20} className="text-[#6B7280] mx-auto" />
              <div className="text-sm font-medium text-white">No on-chain services match your filter</div>
              <p className="text-xs text-[#9CA3AF]">
                Try clearing your search query or switching the category filter.
              </p>
            </div>
          ) : (
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-5">
              {filteredOnChain.map(svc => {
                const meta = getDemoMeta(svc)
                return (
                  <ServiceCard
                    key={svc.serviceId.toString()}
                    service={svc}
                    tags={meta.tags}
                    category={meta.category}
                    endpointPath={meta.endpointPath}
                    httpMethod={meta.httpMethod}
                    gatedPayload={meta.gatedPayload}
                    onRefresh={onRefresh}
                    onRecordTx={onRecordTx}
                  />
                )
              })}
            </div>
          )}
        </section>
      )}

      {/* Reference Demo Templates Section */}
      {!isLoading && sourceFilter !== 'onchain' && filteredTemplates.length > 0 && (
        <section className="space-y-4 pt-2">
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2 border-t border-white/[0.08] pt-6">
            <div>
              <div className="flex items-center gap-2">
                <Sparkles size={15} className="text-amber-400" />
                <h2 className="text-sm font-semibold text-white">
                  Reference Endpoint Templates (Demo — Not Yet Registered On-Chain)
                </h2>
              </div>
              <p className="text-xs text-[#9CA3AF] mt-0.5">
                Pre-configured PayGate402 blueprints preserved from the repository. Inspect their HTTP 402 headers and 95/5 fee split, or deploy them on-chain with one click.
              </p>
            </div>
          </div>

          <div className="grid grid-cols-1 lg:grid-cols-2 gap-5">
            {filteredTemplates.map((tpl, idx) => {
              const syntheticService: ServiceData = {
                serviceId: BigInt(idx),
                provider: address ?? '0x0000000000000000000000000000000000000000',
                name: tpl.name,
                endpointDescription: tpl.endpointDescription,
                priceInUsdc: tpl.priceInUsdc,
                gatedPayloadPreview: tpl.gatedPayloadPreview,
                active: true,
                totalCalls: 0n,
                totalRevenue: 0n,
              }
              const isDeployingThis =
                deployingTemplateId === tpl.id && (seedPending || seedConfirming)

              return (
                <ServiceCard
                  key={tpl.id}
                  service={syntheticService}
                  tags={tpl.tags}
                  category={tpl.category}
                  endpointPath={tpl.endpointPath}
                  httpMethod={tpl.httpMethod}
                  gatedPayload={tpl.gatedPayloadPreview}
                  isDemoTemplate={true}
                  isDeployingTemplate={isDeployingThis}
                  onDeployTemplate={() => handleDeployTemplate(tpl)}
                  onRefresh={onRefresh}
                />
              )
            })}
          </div>
        </section>
      )}
        </>
      )}
    </div>
  )
}
