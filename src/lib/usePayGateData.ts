import { useState, useEffect, useCallback, useMemo } from 'react'
import { useAccount, useReadContract, useReadContracts, usePublicClient } from 'wagmi'
import { parseAbiItem, Abi } from 'viem'
import {
  ARC_TESTNET_CHAIN_ID,
  ARC_MAINNET_CHAIN_ID,
  getContractConfig,
  ServiceData,
  DEMO_SERVICES,
  calculateFeeSplit,
  inferServiceCategory,
} from './paygate402'

export interface OnChainActivityItem {
  id: string
  txHash: string
  kind: 'AccessGranted' | 'ServiceRegistered' | 'ServiceStatusUpdated'
  serviceId: bigint
  serviceName?: string
  actor: string
  amountUsdc?: bigint
  requestId?: string
  activeStatus?: boolean
  blockNumber?: bigint
  timestamp?: number
  source: 'onchain-log' | 'session-tx'
}

const ACCESS_GRANTED_EVENT = parseAbiItem(
  'event AccessGranted(uint256 indexed serviceId, address indexed caller, bytes32 indexed requestId, uint256 amountPaid, uint256 timestamp)'
)
const SERVICE_REGISTERED_EVENT = parseAbiItem(
  'event ServiceRegistered(uint256 indexed serviceId, address indexed provider, string name, uint256 priceInUsdc)'
)
const SERVICE_STATUS_EVENT = parseAbiItem(
  'event ServiceStatusUpdated(uint256 indexed serviceId, bool active)'
)

type RawServiceTuple = readonly [
  bigint,
  string,
  string,
  string,
  bigint,
  string,
  boolean,
  bigint,
  bigint,
]

export function usePayGateData() {
  const { address, isConnected, chainId } = useAccount()
  const currentChainId = chainId === ARC_MAINNET_CHAIN_ID ? ARC_MAINNET_CHAIN_ID : ARC_TESTNET_CHAIN_ID
  const contractConfig = getContractConfig(currentChainId)
  const publicClient = usePublicClient({ chainId: currentChainId })

  const [sessionTxs, setSessionTxs] = useState<OnChainActivityItem[]>([])
  const [logItems, setLogItems] = useState<OnChainActivityItem[]>([])
  const [logsLoading, setLogsLoading] = useState(false)
  const [logsError, setLogsError] = useState<string | null>(null)
  const [refreshTick, setRefreshTick] = useState(0)

  const {
    data: nextServiceId,
    isLoading: isCountLoading,
    isError: isCountError,
    refetch: refetchCount,
  } = useReadContract({
    address: contractConfig.contractAddress,
    abi: contractConfig.abi,
    functionName: 'nextServiceId',
    chainId: currentChainId,
  })

  const serviceCount = Number(nextServiceId ?? 0n)
  const clampedCount = Math.min(serviceCount, 25)

  const serviceContracts = useMemo(
    () =>
      Array.from({ length: clampedCount }, (_, idx) => ({
        address: contractConfig.contractAddress,
        abi: contractConfig.abi as Abi,
        functionName: 'services' as const,
        args: [BigInt(idx)] as const,
        chainId: currentChainId,
      })),
    [clampedCount, contractConfig.contractAddress, contractConfig.abi, currentChainId]
  )

  const {
    data: rawServicesData,
    isLoading: isServicesLoading,
    isError: isServicesError,
    refetch: refetchServices,
  } = useReadContracts({
    contracts: serviceContracts,
    query: {
      enabled: clampedCount > 0,
    },
  })

  const services: ServiceData[] = useMemo(() => {
    if (!rawServicesData || clampedCount === 0) return []
    const parsed: ServiceData[] = []
    for (const item of rawServicesData) {
      if (item.status === 'success' && item.result) {
        const r = item.result as unknown as RawServiceTuple
        parsed.push({
          serviceId: r[0],
          provider: r[1],
          name: r[2],
          endpointDescription: r[3],
          priceInUsdc: r[4],
          gatedPayloadPreview: r[5],
          active: r[6],
          totalCalls: r[7],
          totalRevenue: r[8],
        })
      }
    }
    return parsed
  }, [rawServicesData, clampedCount])

  const serviceNameById = useMemo(() => {
    const map = new Map<string, string>()
    for (const s of services) {
      map.set(s.serviceId.toString(), s.name)
    }
    return map
  }, [services])

  // Fetch recent on-chain logs safely
  const fetchRecentLogs = useCallback(async () => {
    if (!publicClient) return
    await Promise.resolve()
    setLogsLoading(true)
    setLogsError(null)
    try {
      const latestBlock = await publicClient.getBlockNumber()
      const lookback = 9500n
      const fromBlock = latestBlock > lookback ? latestBlock - lookback : 0n

      const [accessLogs, regLogs, statusLogs] = await Promise.all([
        publicClient
          .getLogs({
            address: contractConfig.contractAddress,
            event: ACCESS_GRANTED_EVENT,
            fromBlock,
            toBlock: latestBlock,
          })
          .catch(() => []),
        publicClient
          .getLogs({
            address: contractConfig.contractAddress,
            event: SERVICE_REGISTERED_EVENT,
            fromBlock,
            toBlock: latestBlock,
          })
          .catch(() => []),
        publicClient
          .getLogs({
            address: contractConfig.contractAddress,
            event: SERVICE_STATUS_EVENT,
            fromBlock,
            toBlock: latestBlock,
          })
          .catch(() => []),
      ])

      const items: OnChainActivityItem[] = []

      for (const log of accessLogs) {
        if (!log.transactionHash) continue
        const sid = log.args.serviceId ?? 0n
        items.push({
          id: `${log.transactionHash}-${log.logIndex ?? 0}`,
          txHash: log.transactionHash,
          kind: 'AccessGranted',
          serviceId: sid,
          serviceName: serviceNameById.get(sid.toString()),
          actor: log.args.caller ?? '',
          amountUsdc: log.args.amountPaid,
          requestId: log.args.requestId,
          blockNumber: log.blockNumber ?? undefined,
          timestamp: log.args.timestamp ? Number(log.args.timestamp) * 1000 : undefined,
          source: 'onchain-log',
        })
      }

      for (const log of regLogs) {
        if (!log.transactionHash) continue
        const sid = log.args.serviceId ?? 0n
        items.push({
          id: `${log.transactionHash}-${log.logIndex ?? 0}`,
          txHash: log.transactionHash,
          kind: 'ServiceRegistered',
          serviceId: sid,
          serviceName: log.args.name || serviceNameById.get(sid.toString()),
          actor: log.args.provider ?? '',
          amountUsdc: log.args.priceInUsdc,
          blockNumber: log.blockNumber ?? undefined,
          source: 'onchain-log',
        })
      }

      for (const log of statusLogs) {
        if (!log.transactionHash) continue
        const sid = log.args.serviceId ?? 0n
        items.push({
          id: `${log.transactionHash}-${log.logIndex ?? 0}`,
          txHash: log.transactionHash,
          kind: 'ServiceStatusUpdated',
          serviceId: sid,
          serviceName: serviceNameById.get(sid.toString()),
          actor: '',
          activeStatus: log.args.active,
          blockNumber: log.blockNumber ?? undefined,
          source: 'onchain-log',
        })
      }

      items.sort((a, b) => Number((b.blockNumber ?? 0n) - (a.blockNumber ?? 0n)))
      setLogItems(items)
    } catch (err) {
      setLogsError(err instanceof Error ? err.message : 'Unable to query event logs')
    } finally {
      setLogsLoading(false)
    }
  }, [publicClient, serviceNameById, contractConfig.contractAddress])

  useEffect(() => {
    const t = setTimeout(() => {
      void fetchRecentLogs()
    }, 0)
    return () => clearTimeout(t)
  }, [fetchRecentLogs, refreshTick])

  const recordSessionTx = useCallback((item: Omit<OnChainActivityItem, 'id' | 'source'>) => {
    setSessionTxs(prev => {
      if (prev.some(x => x.txHash.toLowerCase() === item.txHash.toLowerCase() && x.kind === item.kind)) {
        return prev
      }
      return [
        {
          ...item,
          id: `session-${item.txHash}-${Date.now()}`,
          source: 'session-tx',
        },
        ...prev,
      ]
    })
  }, [])

  const activities = useMemo(() => {
    const seenHashes = new Set<string>()
    const merged: OnChainActivityItem[] = []

    for (const item of [...sessionTxs, ...logItems]) {
      const key = `${item.txHash.toLowerCase()}-${item.kind}`
      if (!seenHashes.has(key)) {
        seenHashes.add(key)
        merged.push({
          ...item,
          serviceName: item.serviceName || serviceNameById.get(item.serviceId.toString()),
        })
      }
    }
    return merged
  }, [sessionTxs, logItems, serviceNameById])

  const refetchAll = useCallback(() => {
    void refetchCount()
    if (clampedCount > 0) {
      void refetchServices()
    }
    setRefreshTick(t => t + 1)
  }, [refetchCount, refetchServices, clampedCount])

  // Strictly on-chain derived metrics
  const metrics = useMemo(() => {
    let totalCalls = 0n
    let totalVolumeUsdc = 0n
    let activeCount = 0
    let myServicesCount = 0
    let myTotalCalls = 0n
    let myGrossRevenue = 0n

    const normalizedAddr = address?.toLowerCase()

    for (const s of services) {
      totalCalls += s.totalCalls
      totalVolumeUsdc += s.totalRevenue
      if (s.active) activeCount += 1

      if (normalizedAddr && s.provider.toLowerCase() === normalizedAddr) {
        myServicesCount += 1
        myTotalCalls += s.totalCalls
        myGrossRevenue += s.totalRevenue
      }
    }

    const totalSplit = calculateFeeSplit(totalVolumeUsdc)
    const mySplit = calculateFeeSplit(myGrossRevenue)

    return {
      totalServices: serviceCount,
      activeServicesCount: activeCount,
      totalCalls,
      totalVolumeUsdc,
      totalProviderPayoutUsdc: totalSplit.providerAmount,
      totalProtocolFeeUsdc: totalSplit.protocolFee,
      myServicesCount,
      myTotalCalls,
      myGrossRevenue,
      myNetEarnings: mySplit.providerAmount,
      myProtocolFees: mySplit.protocolFee,
    }
  }, [services, serviceCount, address])

  const myServices = useMemo(() => {
    if (!address) return []
    const lower = address.toLowerCase()
    return services.filter(s => s.provider.toLowerCase() === lower)
  }, [services, address])

  const getServiceMeta = useCallback((service: ServiceData) => {
    const matchedDemo = DEMO_SERVICES.find(
      d => d.name.toLowerCase() === service.name.toLowerCase()
    )
    const tags = matchedDemo?.tags ?? []
    const category = matchedDemo?.category ?? inferServiceCategory(service.name, service.endpointDescription, tags)
    const gatedPayload = service.gatedPayloadPreview || matchedDemo?.gatedPayloadPreview
    const endpointPath = matchedDemo?.endpointPath ?? `/v1/services/${service.serviceId.toString()}`
    const httpMethod = matchedDemo?.httpMethod ?? 'POST'
    return { tags, category, gatedPayload, endpointPath, httpMethod }
  }, [])

  return {
    address,
    isConnected: Boolean(isConnected && address),
    chainId,
    currentChainId,
    isMainnet: currentChainId === ARC_MAINNET_CHAIN_ID,
    isCorrectChain: chainId === ARC_MAINNET_CHAIN_ID || chainId === ARC_TESTNET_CHAIN_ID,
    services,
    myServices,
    serviceCount,
    isLoading: isCountLoading || (clampedCount > 0 && isServicesLoading),
    isError: isCountError || isServicesError,
    activities,
    logsLoading,
    logsError,
    metrics,
    refetchAll,
    recordSessionTx,
    getServiceMeta,
  }
}
