import { useState, useRef, useEffect, useCallback } from 'react'
import { Terminal as TerminalIcon, ChevronRight, ArrowLeft } from 'lucide-react'
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
import {
  PAYGATE402,
  PAYGATE402_ADDRESS,
  PROTOCOL_TREASURY_ADDRESS,
  USDC_FACT,
  ARC_TESTNET_CHAIN_ID,
  ARC_MAINNET_CHAIN_ID,
  getContractConfig,
  isSupportedChain,
  DEMO_SERVICES,
  getTxExplorerUrl,
  formatUsdcAmount,
  formatUsdcExact,
  parseUsdcAmount,
  calculateFeeSplit,
  ServiceData,
} from '@/lib/paygate402'
import {
  authorizeConfirmedPaymentWithGateway,
  prepareLivePaymentChallenge,
  type ChallengeData,
} from '@/lib/gatewayClient'
import { AppRoute } from './Header'

interface Line {
  id: number
  text: string
  type: 'input' | 'output' | 'success' | 'error' | 'system' | 'dim'
}

let lineId = 0
const mkLine = (text: string, type: Line['type'] = 'output'): Line => ({
  id: lineId++,
  text,
  type,
})

const HELP_TEXT = [
  mkLine('PayGate402 Autonomous Agent CLI v1.2.0', 'system'),
  mkLine('──────────────────────────────────────────────────────────────', 'dim'),
  mkLine('Available commands:', 'output'),
  mkLine('  list                 List on-chain services & demo templates', 'dim'),
  mkLine('  pay --id <n>         Approve USDC & call payForAccess(id, reqId)', 'dim'),
  mkLine('  verify --id <n>      Call verifyAccess(id, wallet) on-chain', 'dim'),
  mkLine('  split --usdc <amt>   Calculate 95% provider / 5% treasury split', 'dim'),
  mkLine('  status               Show wallet, network & ERC-20 USDC balance', 'dim'),
  mkLine('  contract             Show deployed PayGate402 & USDC addresses', 'dim'),
  mkLine('  clear                Clear terminal output', 'dim'),
  mkLine('  help                 Show this command reference', 'dim'),
]

interface AgentCLIProps {
  services?: ServiceData[]
  onNavigate?: (route: AppRoute) => void
}

export function AgentCLI({ services: propServices, onNavigate }: AgentCLIProps) {
  const { address, isConnected, chainId } = useAccount()
  const isSupported = isSupportedChain(chainId)
  const currentChainId = chainId === ARC_MAINNET_CHAIN_ID ? ARC_MAINNET_CHAIN_ID : ARC_TESTNET_CHAIN_ID
  const contractConfig = getContractConfig(currentChainId)
  const publicClient = usePublicClient({ chainId: currentChainId })
  const { switchChain } = useSwitchChain()
  const { signTypedDataAsync } = useSignTypedData()
  const verifiedWallet = Boolean(isConnected && address)
  const isCorrectChain = isSupported

  const [lines, setLines] = useState<Line[]>([
    mkLine(`PayGate402 Agent Runtime — ${contractConfig.chainName} (Chain ID ${currentChainId})`, 'system'),
    mkLine(`Target Contract: ${contractConfig.contractAddress}`, 'dim'),
    mkLine('Type `help` or click a quick command below to inspect or execute.', 'dim'),
  ])
  const [input, setInput] = useState('')
  const [busy, setBusy] = useState(false)
  const [history, setHistory] = useState<string[]>([])
  const [histIdx, setHistIdx] = useState(-1)
  const [activeServiceId, setActiveServiceId] = useState<number | null>(null)
  const termRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)

  // Fallback contract reads if propServices not provided
  const { data: nextServiceId } = useReadContract({
    address: contractConfig.contractAddress,
    abi: contractConfig.abi,
    functionName: 'nextServiceId',
    chainId: currentChainId,
  })
  const serviceCount = Number(nextServiceId ?? 0n)
  const { data: s0 } = useReadContract({
    address: contractConfig.contractAddress,
    abi: contractConfig.abi,
    functionName: 'services',
    args: [0n],
    chainId: currentChainId,
    query: { enabled: !propServices && serviceCount > 0 },
  })
  const { data: s1 } = useReadContract({
    address: contractConfig.contractAddress,
    abi: contractConfig.abi,
    functionName: 'services',
    args: [1n],
    chainId: currentChainId,
    query: { enabled: !propServices && serviceCount > 1 },
  })

  type RawTuple = readonly [bigint, string, string, string, bigint, string, boolean, bigint, bigint]
  const fallbackServices: ServiceData[] = [s0, s1]
    .slice(0, serviceCount)
    .filter((x): x is RawTuple => Boolean(x))
    .map(r => ({
      serviceId: r[0],
      provider: r[1],
      name: r[2],
      endpointDescription: r[3],
      priceInUsdc: r[4],
      gatedPayloadPreview: r[5],
      active: r[6],
      totalCalls: r[7],
      totalRevenue: r[8],
    }))

  const services = propServices ?? fallbackServices

  // USDC balance & allowance
  const { data: usdcBalance } = useReadContract({
    address: USDC_FACT.address as `0x${string}`,
    abi: erc20Abi,
    functionName: 'balanceOf',
    args: verifiedWallet && address ? [address] : undefined,
    chainId: currentChainId,
    query: { enabled: verifiedWallet },
  })

  const { data: usdcAllowance, refetch: refetchAllowance } = useReadContract({
    address: USDC_FACT.address as `0x${string}`,
    abi: erc20Abi,
    functionName: 'allowance',
    args: verifiedWallet && address ? [address, contractConfig.contractAddress] : undefined,
    chainId: currentChainId,
    query: { enabled: verifiedWallet },
  })

  // Access check (informational on-chain mapping only on Testnet V1)
  const { data: hasAccess, refetch: refetchAccess } = useReadContract({
    address: contractConfig.contractAddress,
    abi: contractConfig.abi,
    functionName: 'verifyAccess',
    args:
      verifiedWallet && address && activeServiceId !== null
        ? [BigInt(activeServiceId), address]
        : undefined,
    chainId: currentChainId,
    query: { enabled: verifiedWallet && activeServiceId !== null && currentChainId === ARC_TESTNET_CHAIN_ID },
  })

  // Pay flow
  const { writeContract: approve, data: approveHash, isPending: approvePending } = useWriteContract()
  const { writeContract: pay, data: payHash, isPending: payPending } = useWriteContract()
  const { isLoading: approveConfirming, isSuccess: approveConfirmed } =
    useWaitForTransactionReceipt({ hash: approveHash })
  const { isLoading: payConfirming, isSuccess: payConfirmed } =
    useWaitForTransactionReceipt({ hash: payHash })

  const addLines = useCallback((...newLines: Line[]) => {
    setLines(prev => [...prev, ...newLines])
  }, [])

  useEffect(() => {
    termRef.current?.scrollTo({ top: termRef.current.scrollHeight, behavior: 'smooth' })
  }, [lines])

  const streamText = useCallback((text: string, type: Line['type'] = 'output', delay = 0) => {
    return new Promise<void>(resolve => {
      setTimeout(() => {
        setLines(prev => [...prev, mkLine(text, type)])
        resolve()
      }, delay)
    })
  }, [])

  // Stores the authoritative HTTP 402 challenge obtained from the gateway before any wallet tx
  const pendingChallengeRef = useRef<ChallengeData | null>(null)

  useEffect(() => {
    if (
      approveConfirmed &&
      pendingChallengeRef.current &&
      !payPending &&
      !payConfirming &&
      !payConfirmed
    ) {
      const challenge = pendingChallengeRef.current
      void refetchAllowance().then(() => {
        addLines(
          mkLine(
            `[TX] Approval confirmed. Broadcasting payForAccess(${challenge.serviceId}, ${challenge.requestId})…`,
            'dim'
          )
        )
        pay({
          address: PAYGATE402.address,
          abi: PAYGATE402.abi,
          functionName: 'payForAccess',
          args: [BigInt(challenge.serviceId), challenge.requestId],
          chainId: currentChainId,
        })
      })
    }
  }, [approveConfirmed, payPending, payConfirming, payConfirmed, pay, refetchAllowance, addLines])

  const payHandledRef = useRef(false)
  useEffect(() => {
    if (payConfirmed && payHash && busy && !payHandledRef.current) {
      payHandledRef.current = true
      const challenge = pendingChallengeRef.current
      void Promise.resolve().then(async () => {
        void refetchAccess()
        addLines(
          mkLine('[OK] On-chain payment transaction confirmed on Arc Mainnet.', 'output'),
          mkLine(`[TX] ${payHash}`, 'dim'),
          mkLine(`[>]  Explorer: ${getTxExplorerUrl(payHash)}`, 'dim'),
          mkLine(
            '[GATEWAY] Transaction receipt alone does NOT unlock protected data. Signing EIP-712 authorization and verifying with Gateway…',
            'dim'
          )
        )

        if (!challenge || !address) {
          addLines(
            mkLine(
              '[ERR] Fail-closed: Missing authoritative gateway challenge or wallet address for post-payment verification.',
              'error'
            )
          )
          setBusy(false)
          return
        }

        try {
          const result = await authorizeConfirmedPaymentWithGateway({
            challenge,
            txHash: payHash,
            payerAddress: address,
            body: '',
            signTypedData: args => signTypedDataAsync(args),
          })

          addLines(
            mkLine(
              `[200] Gateway verified payment & EIP-712 signature (Block ${result.blockNumber}). Protected payload unlocked:`,
              'success'
            ),
            mkLine(JSON.stringify(result.payload, null, 2), 'output')
          )
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : String(err)
          addLines(
            mkLine(`[ERR] Gateway authorization failed (fail-closed): ${msg}`, 'error')
          )
        } finally {
          pendingChallengeRef.current = null
          setBusy(false)
        }
      })
    }
    if (!payConfirmed) payHandledRef.current = false
  }, [payConfirmed, payHash, busy, address, signTypedDataAsync, refetchAccess, addLines])

  const processCommand = useCallback(
    async (cmd: string) => {
      const trimmed = cmd.trim()
      if (!trimmed) return

      addLines(mkLine(`$ ${trimmed}`, 'input'))
      setHistory(h => [trimmed, ...h.slice(0, 49)])
      setHistIdx(-1)

      const parts = trimmed.split(/\s+/)
      const base = parts[0].toLowerCase()

      if (base === 'clear') {
        setLines([mkLine('Terminal cleared.', 'dim')])
        return
      }

      if (base === 'help') {
        addLines(...HELP_TEXT)
        return
      }

      if (base === 'contract') {
        addLines(
          mkLine(`[CONTRACT] PayGate402 : ${PAYGATE402_ADDRESS}`, 'output'),
          mkLine(`[TOKEN]    USDC (6d)  : ${USDC_FACT.address}`, 'output'),
          mkLine(`[TREASURY] 5% Fee     : ${PROTOCOL_TREASURY_ADDRESS}`, 'output'),
          mkLine(`[SPLIT]    95% Provider / 5% Protocol Treasury (500 / 10000 BPS)`, 'dim')
        )
        return
      }

      if (base === 'split') {
        const flagIdx = parts.indexOf('--usdc')
        const val = flagIdx !== -1 ? parts[flagIdx + 1] : parts[1]
        const raw = parseUsdcAmount(val || '0.10')
        const s = calculateFeeSplit(raw)
        addLines(
          mkLine(`[SPLIT] Total Call Price  : ${formatUsdcExact(s.total)} USDC (${s.total.toString()} base units)`, 'output'),
          mkLine(`        Provider (95%)    : ${formatUsdcExact(s.providerAmount)} USDC`, 'success'),
          mkLine(`        Treasury Fee (5%) : ${formatUsdcExact(s.protocolFee)} USDC`, 'dim')
        )
        return
      }

      if (base === 'status') {
        if (!verifiedWallet || !address) {
          addLines(
            mkLine('[STATUS] Wallet: Disconnected (Read-only RPC mode)', 'error'),
            mkLine(`[CHAIN]  Target: Arc Mainnet (Chain ID ${ARC_MAINNET_CHAIN_ID})`, 'dim'),
            mkLine('         Connect your wallet in the top bar to sign transactions.', 'dim')
          )
          return
        }
        addLines(
          mkLine(`[WALLET] ${address}`, 'output'),
          mkLine(
            `[CHAIN]  ${isCorrectChain ? `Arc Mainnet (${ARC_MAINNET_CHAIN_ID}) — Verified` : `Chain ID ${chainId} (Switch to ${ARC_MAINNET_CHAIN_ID})`}`,
            isCorrectChain ? 'success' : 'error'
          ),
          mkLine(
            `[USDC]   ${usdcBalance !== undefined ? formatUsdcAmount(usdcBalance) : '0.00'} USDC`,
            'success'
          )
        )
        return
      }

      if (base === 'list') {
        addLines(
          mkLine(`[ON-CHAIN] nextServiceId = ${services.length} on ${PAYGATE402_ADDRESS}`, 'output')
        )
        if (services.length === 0) {
          addLines(
            mkLine('  No services currently registered on-chain.', 'dim'),
            mkLine('[DEMO TEMPLATES] (Not registered on-chain — deploy in Explore Services):', 'system')
          )
          DEMO_SERVICES.forEach((d, idx) => {
            addLines(
              mkLine(`  [template-${idx}] ${d.name} (${formatUsdcAmount(d.priceInUsdc)} USDC/call)`, 'dim')
            )
          })
          return
        }
        services.forEach(s => {
          addLines(
            mkLine(`  [#${s.serviceId.toString()}] ${s.name}`, 'output'),
            mkLine(
              `       Price: ${formatUsdcAmount(s.priceInUsdc)} USDC | Calls: ${s.totalCalls.toString()} | Active: ${s.active}`,
              'dim'
            )
          )
        })
        return
      }

      if (base === 'pay') {
        const idFlag = parts.indexOf('--id')
        const serviceIdx = idFlag !== -1 ? parseInt(parts[idFlag + 1], 10) : NaN
        if (services.length === 0) {
          addLines(
            mkLine(
              '[ERR] 0 services are registered on-chain right now. Deploy a template or register an endpoint first.',
              'error'
            )
          )
          return
        }
        if (isNaN(serviceIdx) || serviceIdx < 0 || serviceIdx >= services.length) {
          addLines(
            mkLine(`[ERR] Usage: pay --id <serviceId> (0 to ${services.length - 1})`, 'error')
          )
          return
        }
        if (!verifiedWallet || !address) {
          addLines(mkLine('[ERR] No wallet connected. Connect wallet in the header first.', 'error'))
          return
        }
        if (!isCorrectChain) {
          addLines(mkLine('[ERR] Unsupported network. Switching to Arc Mainnet…', 'error'))
          switchChain({ chainId: ARC_MAINNET_CHAIN_ID })
          return
        }

        const svc = services[serviceIdx]
        setBusy(true)
        setActiveServiceId(serviceIdx)

        await streamText(
          `[AGENT] Requesting authoritative HTTP 402 challenge from Gateway for Service #${svc.serviceId.toString()} ("${svc.name}")…`,
          'output'
        )

        let challenge: ChallengeData
        try {
          const preflight = await prepareLivePaymentChallenge({
            serviceId: svc.serviceId,
            subPath: '/',
            method: 'POST',
            body: '',
            payerAddress: address,
            getBytecode: publicClient ? addr => publicClient.getBytecode({ address: addr }) : undefined,
          })
          challenge = preflight.challenge
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : String(err)
          addLines(
            mkLine(`[ERR] Challenge preflight blocked (fail-closed): ${msg}`, 'error')
          )
          setBusy(false)
          return
        }

        const requiredPrice = BigInt(challenge.quotedPrice)
        const split = calculateFeeSplit(requiredPrice)
        pendingChallengeRef.current = challenge

        await streamText(
          `[402] Challenge issued: requestId=${challenge.requestId} | bodyDigest=${challenge.bodyDigest}`,
          'dim',
          80
        )
        await streamText(
          `[SPLIT] ${formatUsdcAmount(requiredPrice)} USDC -> ${formatUsdcExact(split.providerAmount)} USDC (95% Provider) + ${formatUsdcExact(split.protocolFee)} USDC (5% Treasury)`,
          'dim',
          80
        )

        const currentAllowance = usdcAllowance ?? 0n
        if (currentAllowance < requiredPrice) {
          await streamText(
            `[AGENT] Requesting exact ERC-20 USDC approval (${formatUsdcAmount(requiredPrice)} USDC) in wallet…`,
            'output',
            120
          )
          approve({
            address: USDC_FACT.address as `0x${string}`,
            abi: erc20Abi,
            functionName: 'approve',
            args: [contractConfig.contractAddress, requiredPrice],
            chainId: currentChainId,
          })
          return
        }

        await streamText(
          `[AGENT] Sufficient USDC allowance found. Broadcasting payForAccess(${challenge.serviceId}, ${challenge.requestId})…`,
          'output',
          120
        )
        pay({
          address: contractConfig.contractAddress,
          abi: contractConfig.abi,
          functionName: 'payForAccess',
          args: [BigInt(challenge.serviceId), challenge.requestId],
          chainId: currentChainId,
        })
        return
      }

      if (base === 'verify') {
        const idFlag = parts.indexOf('--id')
        const serviceIdx = idFlag !== -1 ? parseInt(parts[idFlag + 1], 10) : NaN
        if (isNaN(serviceIdx) || serviceIdx < 0) {
          addLines(mkLine('[ERR] Usage: verify --id <serviceId>', 'error'))
          return
        }
        if (!verifiedWallet || !address) {
          addLines(mkLine('[ERR] Connect your wallet to verify caller access on-chain.', 'error'))
          return
        }
        setActiveServiceId(serviceIdx)
        setTimeout(() => {
          if (hasAccess) {
            addLines(
              mkLine(
                `[INFO] On-chain verifyAccess(${serviceIdx}, ${address}) => true (historical contract flag; per-request Gateway HTTP 200 verification is still required to unlock API data).`,
                'output'
              )
            )
          } else {
            addLines(
              mkLine(
                `[402] verifyAccess(${serviceIdx}, ${address}) => false (No historical payment recorded on-chain)`,
                'error'
              )
            )
          }
        }, 180)
        return
      }

      addLines(
        mkLine(`[ERR] Unknown command: "${base}". Type "help" for available commands.`, 'error')
      )
    },
    [
      verifiedWallet,
      address,
      isCorrectChain,
      chainId,
      services,
      usdcBalance,
      usdcAllowance,
      hasAccess,
      publicClient,
      approve,
      pay,
      switchChain,
      addLines,
      streamText,
      currentChainId,
      contractConfig.abi,
      contractConfig.contractAddress,
    ]
  )

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      const cmd = input.trim()
      setInput('')
      void processCommand(cmd)
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      const newIdx = Math.min(histIdx + 1, history.length - 1)
      setHistIdx(newIdx)
      setInput(history[newIdx] ?? '')
    } else if (e.key === 'ArrowDown') {
      e.preventDefault()
      const newIdx = Math.max(histIdx - 1, -1)
      setHistIdx(newIdx)
      setInput(newIdx === -1 ? '' : history[newIdx])
    }
  }

  const lineClass = (type: Line['type']) => {
    switch (type) {
      case 'input':
        return 'text-[#A78BFA] font-medium'
      case 'success':
        return 'text-emerald-400'
      case 'error':
        return 'text-rose-400'
      case 'system':
        return 'text-white font-semibold'
      case 'dim':
        return 'text-[#6B7280]'
      default:
        return 'text-[#D1D5DB]'
    }
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <div className="flex items-center gap-2.5">
            {onNavigate && (
              <button
                type="button"
                onClick={() => onNavigate('overview')}
                className="p-1.5 rounded-lg bg-white/[0.04] border border-white/[0.08] text-[#9CA3AF] hover:text-white"
                title="Back to Overview"
              >
                <ArrowLeft size={15} />
              </button>
            )}
            <h1 className="display text-2xl font-bold text-white flex items-center gap-2">
              <TerminalIcon size={20} className="text-[#A78BFA]" />
              AI Agent CLI Simulator
            </h1>
          </div>
          <p className="text-sm text-[#9CA3AF] mt-1">
            Interactive command-line environment for inspecting PayGate402 state, testing 95/5 fee splits, and executing on-chain agent calls.
          </p>
        </div>

        {/* Honest Wallet & Network Status Indicator */}
        <div className="flex items-center gap-2 self-start sm:self-auto px-3 py-1.5 rounded-lg bg-[#10131C] border border-white/[0.08]">
          <span
            className={`w-2 h-2 rounded-full ${
              verifiedWallet && isCorrectChain
                ? 'bg-emerald-400'
                : verifiedWallet
                  ? 'bg-amber-400'
                  : 'bg-[#6B7280]'
            }`}
          />
          <span className="text-xs font-medium mono text-[#D1D5DB]">
            {verifiedWallet && isCorrectChain
              ? 'Wallet Connected · Arc Mainnet'
              : verifiedWallet
                ? 'Wrong Network · Switch to Arc Mainnet'
                : 'Wallet Disconnected · Read-Only RPC'}
          </span>
        </div>
      </div>

      {/* Terminal Window */}
      <div
        className="pg-card overflow-hidden bg-[#07090E] border-white/[0.1] shadow-elevated"
        onClick={() => inputRef.current?.focus()}
      >
        {/* Window Chrome */}
        <div className="flex items-center justify-between px-4 py-2.5 bg-[#0C0E15] border-b border-white/[0.08]">
          <div className="flex items-center gap-2">
            <span className="w-2.5 h-2.5 rounded-full bg-rose-500/70" />
            <span className="w-2.5 h-2.5 rounded-full bg-amber-400/70" />
            <span className="w-2.5 h-2.5 rounded-full bg-emerald-500/70" />
          </div>
          <div className="text-[11px] text-[#9CA3AF] mono">
            paygate402-agent-cli — rpc.mainnet.arc.io
          </div>
          <div className="text-[11px] text-[#6B7280] mono">5042</div>
        </div>

        {/* Output Area */}
        <div ref={termRef} className="h-[380px] overflow-y-auto px-5 py-4 space-y-1">
          {lines.map(line => (
            <div
              key={line.id}
              className={`mono text-xs sm:text-[13px] leading-6 whitespace-pre-wrap break-all ${lineClass(
                line.type
              )}`}
            >
              {line.text}
            </div>
          ))}

          {busy && (approvePending || approveConfirming || payPending || payConfirming) && (
            <div className="flex items-center gap-2 mono text-xs text-[#A78BFA] pt-1">
              <span className="w-3 h-3 rounded-full border border-[#A78BFA]/40 border-t-[#A78BFA] animate-spin" />
              <span>
                {approvePending
                  ? 'Waiting for wallet approval signature…'
                  : approveConfirming
                    ? 'Confirming USDC approval on Arc Mainnet…'
                    : payPending
                      ? 'Waiting for payForAccess() signature…'
                      : 'Confirming 95/5 settlement on Arc Mainnet…'}
              </span>
            </div>
          )}
        </div>

        {/* Input Row */}
        <div className="flex items-center gap-2 px-5 py-3 bg-[#0B0D14] border-t border-white/[0.08]">
          <ChevronRight size={14} className="text-[#A78BFA] flex-shrink-0" />
          <input
            ref={inputRef}
            type="text"
            value={input}
            onChange={e => setInput(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="Enter a command (e.g. help, list, status, split --usdc 0.25)…"
            aria-label="Agent CLI Command Input"
            disabled={busy}
            className="flex-1 bg-transparent text-white mono text-xs sm:text-[13px] outline-none placeholder-[#6B7280] disabled:opacity-50"
            autoComplete="off"
            spellCheck={false}
          />
          <span className="cursor-blink text-[#A78BFA] text-sm leading-none">▋</span>
        </div>
      </div>

      {/* Quick Commands */}
      <div className="flex items-center gap-2 flex-wrap">
        <span className="text-xs text-[#6B7280] mr-1">Quick run:</span>
        {[
          'help',
          'list',
          'contract',
          'split --usdc 0.25',
          'status',
          'verify --id 0',
          'pay --id 0',
          'clear',
        ].map(cmd => (
          <button
            key={cmd}
            type="button"
            onClick={() => {
              setInput('')
              void processCommand(cmd)
            }}
            disabled={busy}
            className="px-2.5 py-1.5 rounded-lg bg-[#121520] border border-white/[0.08] text-xs text-[#D1D5DB] mono hover:border-[#7C5CFF]/50 hover:text-white transition-colors disabled:opacity-40"
          >
            $ {cmd}
          </button>
        ))}
      </div>
    </div>
  )
}
