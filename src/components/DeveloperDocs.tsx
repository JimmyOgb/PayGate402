import { useState } from 'react'
import {
  BookOpen,
  Copy,
  Check,
  Terminal,
  ExternalLink,
  Code2,
  ShieldCheck,
  ArrowRight,
  Cpu,
} from 'lucide-react'
import {
  PAYGATE402_ADDRESS,
  PROTOCOL_TREASURY_ADDRESS,
  USDC_FACT,
  ARC_MAINNET_CHAIN_ID,
  DEPLOY_TX_HASH,
  getContractExplorerUrl,
  getAddressExplorerUrl,
  getTxExplorerUrl,
} from '@/lib/paygate402'
import { AppRoute } from './Header'

interface DeveloperDocsProps {
  onNavigate: (route: AppRoute) => void
}

type SdkLang = 'viem' | 'python' | 'curl' | 'solidity'

const SDK_SNIPPETS: Record<SdkLang, { title: string; filename: string; code: string }> = {
  viem: {
    title: 'TypeScript / Viem v2 SDK',
    filename: 'agent-client.ts',
    code: `/**
 * PayGate402 — Autonomous TypeScript / Viem v2 Client
 * Discovers HTTP 402 endpoints, settles 95/5 USDC split on Arc Mainnet,
 * and verifies on-chain access grant.
 */
import { createWalletClient, createPublicClient, http, parseUnits, keccak256, toHex, defineChain } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'

export const arcMainnet = defineChain({
  id: 5042,
  name: 'Arc',
  nativeCurrency: { name: 'USDC', symbol: 'USDC', decimals: 6 },
  rpcUrls: { default: { http: ['https://rpc.mainnet.arc.io'] } },
  blockExplorers: { default: { name: 'Arc Explorer', url: 'https://explorer.arc.io' } },
})

const PAYGATE402_ADDRESS = '${PAYGATE402_ADDRESS}' as const
const USDC_ADDRESS       = '${USDC_FACT.address}' as const
const RPC_URL            = 'https://rpc.mainnet.arc.io'

const account = privateKeyToAccount(process.env.AGENT_PRIVATE_KEY as \`0x\${string}\`)

const publicClient = createPublicClient({ chain: arcMainnet, transport: http(RPC_URL) })
const walletClient = createWalletClient({ account, chain: arcMainnet, transport: http(RPC_URL) })

const PAYGATE_ABI = [
  {
    name: 'payForAccess',
    type: 'function',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'serviceId', type: 'uint256' },
      { name: 'requestId', type: 'bytes32' },
    ],
    outputs: [],
  },
  {
    name: 'verifyAccess',
    type: 'function',
    stateMutability: 'view',
    inputs: [
      { name: 'serviceId', type: 'uint256' },
      { name: 'caller', type: 'address' },
    ],
    outputs: [{ name: '', type: 'bool' }],
  },
] as const

const ERC20_ABI = [
  {
    name: 'approve',
    type: 'function',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'spender', type: 'address' },
      { name: 'amount', type: 'uint256' },
    ],
    outputs: [{ name: '', type: 'bool' }],
  },
] as const

export async function payAndCallProtectedEndpoint(serviceId: bigint, priceUsdc: string) {
  // 1. Approve exact USDC (6 decimals) for PayGate402
  const amount = parseUnits(priceUsdc, 6)
  const approveHash = await walletClient.writeContract({
    address: USDC_ADDRESS,
    abi: ERC20_ABI,
    functionName: 'approve',
    args: [PAYGATE402_ADDRESS, amount],
  })
  await publicClient.waitForTransactionReceipt({ hash: approveHash })

  // 2. Generate replay-protected bytes32 requestId & execute 95/5 settlement
  const requestId = keccak256(toHex(\`req-\${serviceId.toString()}-\${Date.now()}\`))
  const payHash = await walletClient.writeContract({
    address: PAYGATE402_ADDRESS,
    abi: PAYGATE_ABI,
    functionName: 'payForAccess',
    args: [serviceId, requestId],
  })
  const receipt = await publicClient.waitForTransactionReceipt({ hash: payHash })

  // 3. Verify access on-chain before consuming protected resource
  const granted = await publicClient.readContract({
    address: PAYGATE402_ADDRESS,
    abi: PAYGATE_ABI,
    functionName: 'verifyAccess',
    args: [serviceId, account.address],
  })

  return { granted, payHash, blockNumber: receipt.blockNumber, requestId }
}`,
  },
  python: {
    title: 'Python AI Agent (web3.py)',
    filename: 'paygate_agent.py',
    code: `"""
PayGate402 — Autonomous Python AI Agent
Handles HTTP 402 responses by settling USDC on Arc Mainnet (Chain ID 5042).
"""
import os
import time
from web3 import Web3

RPC_URL            = "https://rpc.mainnet.arc.io"
PAYGATE402_ADDRESS = "${PAYGATE402_ADDRESS}"
USDC_ADDRESS       = "${USDC_FACT.address}"
CHAIN_ID           = 5042

w3   = Web3(Web3.HTTPProvider(RPC_URL))
acct = w3.eth.account.from_key(os.environ["AGENT_PRIVATE_KEY"])

ERC20_ABI = [{
    "name": "approve",
    "type": "function",
    "inputs": [{"name": "spender", "type": "address"}, {"name": "amount", "type": "uint256"}],
    "outputs": [{"type": "bool"}],
    "stateMutability": "nonpayable"
}]

PAYGATE_ABI = [
    {
        "name": "payForAccess",
        "type": "function",
        "inputs": [{"name": "serviceId", "type": "uint256"}, {"name": "requestId", "type": "bytes32"}],
        "outputs": [],
        "stateMutability": "nonpayable"
    },
    {
        "name": "verifyAccess",
        "type": "function",
        "inputs": [{"name": "serviceId", "type": "uint256"}, {"name": "caller", "type": "address"}],
        "outputs": [{"type": "bool"}],
        "stateMutability": "view"
    }
]

usdc = w3.eth.contract(address=Web3.to_checksum_address(USDC_ADDRESS), abi=ERC20_ABI)
gate = w3.eth.contract(address=Web3.to_checksum_address(PAYGATE402_ADDRESS), abi=PAYGATE_ABI)

def unlock_402_service(service_id: int, price_usdc: float) -> str:
    raw_amount = int(round(price_usdc * 1_000_000))  # 6 decimals

    # Step 1: Approve USDC transferFrom
    nonce = w3.eth.get_transaction_count(acct.address)
    approve_tx = usdc.functions.approve(PAYGATE402_ADDRESS, raw_amount).build_transaction({
        "from": acct.address,
        "nonce": nonce,
        "chainId": CHAIN_ID,
        "gas": 100_000,
        "maxFeePerGas": w3.to_wei("2", "gwei"),
        "maxPriorityFeePerGas": w3.to_wei("1", "gwei"),
    })
    signed_approve = acct.sign_transaction(approve_tx)
    approve_hash = w3.eth.send_raw_transaction(signed_approve.rawTransaction)
    w3.eth.wait_for_transaction_receipt(approve_hash)

    # Step 2: Settle 95/5 payment & record access grant
    request_id = w3.keccak(text=f"req-{service_id}-{int(time.time() * 1000)}")
    pay_tx = gate.functions.payForAccess(service_id, request_id).build_transaction({
        "from": acct.address,
        "nonce": nonce + 1,
        "chainId": CHAIN_ID,
        "gas": 220_000,
        "maxFeePerGas": w3.to_wei("2", "gwei"),
        "maxPriorityFeePerGas": w3.to_wei("1", "gwei"),
    })
    signed_pay = acct.sign_transaction(pay_tx)
    pay_hash = w3.eth.send_raw_transaction(signed_pay.rawTransaction)
    w3.eth.wait_for_transaction_receipt(pay_hash)

    # Step 3: Access confirmation
    # Note: Gateway verifies on-chain AccessGranted event receipt + EIP-712 caller authorization per call
    receipt = w3.eth.get_transaction_receipt(pay_hash)
    assert receipt["status"] == 1, "Payment transaction failed"
    return "0x" + pay_hash.hex()`,
  },
  curl: {
    title: 'cURL + Foundry Cast CLI',
    filename: 'paygate-402-flow.sh',
    code: `#!/usr/bin/env bash
# PayGate402 — HTTP 402 Command-Line Settlement Flow on Arc Mainnet
set -euo pipefail

RPC_URL="https://rpc.mainnet.arc.io"
PAYGATE="${PAYGATE402_ADDRESS}"
USDC="${USDC_FACT.address}"
SERVICE_ID=0
AMOUNT_RAW=100000 # 0.10 USDC (6 decimals)

# 1. Approve PayGate402 to spend 0.10 USDC
cast send "$USDC" \\
  "approve(address,uint256)" \\
  "$PAYGATE" \\
  "$AMOUNT_RAW" \\
  --rpc-url "$RPC_URL" \\
  --private-key "$PRIVATE_KEY"

# 2. Generate unique bytes32 requestId & call payForAccess(uint256,bytes32)
REQUEST_ID=$(cast keccak "req-$SERVICE_ID-$(date +%s)")
TX_HASH=$(cast send "$PAYGATE" \\
  "payForAccess(uint256,bytes32)" \\
  "$SERVICE_ID" \\
  "$REQUEST_ID" \\
  --rpc-url "$RPC_URL" \\
  --private-key "$PRIVATE_KEY" \\
  --json | jq -r '.transactionHash')

echo "Settlement Tx: $TX_HASH"

# 3. Check access grant
# Gateway validates on-chain AccessGranted receipt log & caller EIP-712 signature

# 4. Retry HTTP request with X-Payment-Tx proof header
curl -i -X POST "https://api.paygate402.arc/v1/services/$SERVICE_ID" \\
  -H "Content-Type: application/json" \\
  -H "X-Payment-Tx: $TX_HASH" \\
  -H "X-Request-Id: $REQUEST_ID"`,
  },
  solidity: {
    title: 'Solidity Contract Interface',
    filename: 'IPayGate402.sol',
    code: `// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/**
 * @title IPayGate402
 * @notice Deployed on Arc Mainnet at ${PAYGATE402_ADDRESS}
 * @dev Splits every payment 95% to service.provider and 5% to protocolTreasury (500 / 10000 BPS).
 */
interface IPayGate402 {
    struct Service {
        uint256 serviceId;
        address provider;
        string name;
        string endpointDescription;
        uint256 priceInUsdc;
        string gatedPayloadPreview;
        bool active;
        uint256 totalCalls;
        uint256 totalRevenue;
    }

    event ServiceRegistered(uint256 indexed serviceId, address indexed provider, string name, uint256 priceInUsdc);
    event AccessGranted(
        uint256 indexed serviceId,
        address indexed caller,
        bytes32 indexed requestId,
        uint256 amountPaid,
        uint256 timestamp
    );
    event ServiceStatusUpdated(uint256 indexed serviceId, bool active);

    function PROTOCOL_FEE_BPS() external view returns (uint256); // 500 (5.00%)
    function BPS_DENOMINATOR() external view returns (uint256);  // 10000
    function nextServiceId() external view returns (uint256);
    function protocolTreasury() external view returns (address);
    function usdcToken() external view returns (address);

    function registerService(
        string memory name,
        string memory endpointDescription,
        uint256 priceInUsdc,
        string memory gatedPayloadPreview
    ) external returns (uint256 serviceId);

    function payForAccess(uint256 serviceId, bytes32 requestId) external;

    // Legacy v1 interface view (superseded in PayGate402V2 by per-call AccessGranted events)
    function verifyAccess(uint256 serviceId, address caller) external view returns (bool);

    function setServiceActive(uint256 serviceId, bool active) external;
}`,
  },
}

function highlightCodeBlock(code: string): string {
  const escaped = code
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')

  return escaped
    .split('\n')
    .map(line => {
      const trimmed = line.trim()
      if (trimmed.startsWith('//') || trimmed.startsWith('#') || trimmed.startsWith('*') || trimmed.startsWith('/*') || trimmed.startsWith('*/')) {
        return `<span class="text-[#6B7280]">${line}</span>`
      }
      return line
        .replace(
          /\b(import|from|export|const|let|async|await|function|return|interface|struct|event|external|view|returns|pragma|solidity|def|assert)\b/g,
          '<span class="text-[#A78BFA] font-medium">$1</span>'
        )
        .replace(
          /('[^']*'|"[A-Za-z0-9_/:.\-\s=${}()]+")/g,
          '<span class="text-emerald-300">$1</span>'
        )
    })
    .join('\n')
}

export function DeveloperDocs({ onNavigate }: DeveloperDocsProps) {
  const [activeLang, setActiveLang] = useState<SdkLang>('viem')
  const [copiedCode, setCopiedCode] = useState(false)
  const [copiedAddr, setCopiedAddr] = useState<string | null>(null)

  const handleCopyCode = () => {
    void navigator.clipboard.writeText(SDK_SNIPPETS[activeLang].code)
    setCopiedCode(true)
    setTimeout(() => setCopiedCode(false), 1800)
  }

  const handleCopyValue = (val: string) => {
    void navigator.clipboard.writeText(val)
    setCopiedAddr(val)
    setTimeout(() => setCopiedAddr(null), 1500)
  }

  return (
    <div className="space-y-8">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <div className="flex items-center gap-2.5">
            <h1 className="display text-2xl font-bold text-white tracking-tight">
              Developer Documentation &amp; SDKs
            </h1>
            <span className="pg-badge bg-[#7C5CFF]/15 text-[#A78BFA] border border-[#7C5CFF]/30 mono">
              Solidity 0.8.28 · Viem v2
            </span>
          </div>
          <p className="text-sm text-[#9CA3AF] mt-1">
            Complete reference for integrating HTTP 402 micropayments, verifying access on Arc Mainnet, and building autonomous payment agents.
          </p>
        </div>

        <button
          type="button"
          onClick={() => onNavigate('cli')}
          className="pg-btn-primary px-3.5 py-2 text-xs self-start sm:self-auto mono"
        >
          <Terminal size={14} />
          <span>Open Interactive Agent CLI</span>
          <ArrowRight size={13} />
        </button>
      </div>

      {/* Protocol Overview & Architecture Grid */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
        {/* Left: Protocol Specification */}
        <section className="lg:col-span-7 pg-card p-6 space-y-4">
          <div className="flex items-center gap-2">
            <BookOpen size={16} className="text-[#A78BFA]" />
            <h2 className="display text-base font-semibold text-white">
              Understanding the PayGate402 Protocol
            </h2>
          </div>

          <p className="text-xs sm:text-sm text-[#9CA3AF] leading-relaxed">
            HTTP status code <code className="mono text-white bg-white/[0.06] px-1.5 py-0.5 rounded">402 Payment Required</code> was
            reserved in RFC 9110 for digital cash and micropayment systems. <strong className="text-white">PayGate402</strong> implements
            this specification on <strong className="text-white">Arc Mainnet</strong> using native 6-decimal ERC-20 USDC and deterministic smart contract settlement.
          </p>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 pt-1">
            <div className="pg-panel p-4 space-y-1.5 border border-white/[0.07]">
              <div className="text-xs font-semibold text-white flex items-center gap-1.5">
                <ShieldCheck size={14} className="text-emerald-400" />
                Deterministic 95% / 5% Revenue Split
              </div>
              <p className="text-xs text-[#9CA3AF] leading-relaxed">
                Every call to <code className="mono text-[#D1D5DB]">payForAccess(serviceId, requestId)</code> calculates{' '}
                <code className="mono text-[#D1D5DB]">fee = (price * 500) / 10000</code> and executes two atomic{' '}
                <code className="mono text-[#D1D5DB]">transferFrom</code> calls: 95% directly to the service provider and 5% to the protocol treasury.
              </p>
            </div>

            <div className="pg-panel p-4 space-y-1.5 border border-white/[0.07]">
              <div className="text-xs font-semibold text-white flex items-center gap-1.5">
                <Cpu size={14} className="text-[#A78BFA]" />
                Replay Protection Per Request
              </div>
              <p className="text-xs text-[#9CA3AF] leading-relaxed">
                The contract tracks <code className="mono text-[#D1D5DB]">usedRequestIds[serviceId][caller][requestId]</code>.
                Re-submitting a previously used <code className="mono text-[#D1D5DB]">bytes32 requestId</code> reverts with{' '}
                <code className="mono text-rose-300">&quot;Request already used&quot;</code>, preventing replay attacks.
              </p>
            </div>
          </div>
        </section>

        {/* Right: Deployed Contract Reference Table */}
        <section className="lg:col-span-5 pg-card p-6 space-y-4">
          <div className="flex items-center justify-between">
            <h2 className="display text-base font-semibold text-white">
              Deployed Contract Constants
            </h2>
            <span className="pg-badge bg-emerald-500/10 text-emerald-400 border border-emerald-500/25 mono">
              Chain {ARC_MAINNET_CHAIN_ID}
            </span>
          </div>

          <div className="divide-y divide-white/[0.06] text-xs">
            {[
              {
                label: 'PayGate402 Contract',
                value: PAYGATE402_ADDRESS,
                href: getContractExplorerUrl(),
              },
              {
                label: 'ERC-20 USDC (6 Decimals)',
                value: USDC_FACT.address,
                href: getAddressExplorerUrl(USDC_FACT.address),
              },
              {
                label: 'Protocol Treasury (5%)',
                value: PROTOCOL_TREASURY_ADDRESS,
                href: getAddressExplorerUrl(PROTOCOL_TREASURY_ADDRESS),
              },
              {
                label: 'Deployment Transaction',
                value: DEPLOY_TX_HASH,
                href: getTxExplorerUrl(DEPLOY_TX_HASH),
              },
            ].map(row => (
              <div key={row.label} className="py-2.5 flex items-center justify-between gap-2">
                <span className="text-[#9CA3AF]">{row.label}</span>
                <div className="inline-flex items-center gap-1.5 mono">
                  <a
                    href={row.href}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-[#A78BFA] hover:underline"
                  >
                    {row.value.slice(0, 8)}…{row.value.slice(-6)}
                  </a>
                  <button
                    type="button"
                    onClick={() => handleCopyValue(row.value)}
                    className="text-[#6B7280] hover:text-white"
                    title={`Copy ${row.label}`}
                  >
                    {copiedAddr === row.value ? (
                      <Check size={12} className="text-emerald-400" />
                    ) : (
                      <Copy size={12} />
                    )}
                  </button>
                  <a
                    href={row.href}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-[#6B7280] hover:text-white"
                  >
                    <ExternalLink size={11} />
                  </a>
                </div>
              </div>
            ))}

            <div className="py-2.5 flex items-center justify-between gap-2">
              <span className="text-[#9CA3AF]">RPC Endpoint</span>
              <span className="mono text-[#D1D5DB]">https://rpc.mainnet.arc.io</span>
            </div>

            <div className="pt-2.5 flex items-center justify-between gap-2">
              <span className="text-[#9CA3AF]">Fee Constants</span>
              <span className="mono text-emerald-400">PROTOCOL_FEE_BPS = 500 / 10000</span>
            </div>
          </div>
        </section>
      </div>

      {/* SDK Code Examples */}
      <section className="pg-card overflow-hidden">
        <div className="px-5 py-3.5 bg-[#0C0E15] border-b border-white/[0.08] flex flex-col sm:flex-row sm:items-center justify-between gap-3">
          <div className="flex items-center gap-1.5 flex-wrap">
            <Code2 size={15} className="text-[#A78BFA] mr-1" />
            {(['viem', 'python', 'curl', 'solidity'] as const).map(lang => (
              <button
                key={lang}
                type="button"
                onClick={() => setActiveLang(lang)}
                className={`px-3 py-1.5 rounded-md text-xs font-medium mono transition-colors border ${
                  activeLang === lang
                    ? 'bg-[#7C5CFF]/20 text-white border-[#7C5CFF]/45'
                    : 'bg-transparent text-[#9CA3AF] border-transparent hover:text-white hover:bg-white/[0.04]'
                }`}
              >
                {SDK_SNIPPETS[lang].title}
              </button>
            ))}
          </div>

          <div className="flex items-center gap-3 self-end sm:self-auto">
            <span className="text-[11px] mono text-[#6B7280]">
              {SDK_SNIPPETS[activeLang].filename}
            </span>
            <button
              type="button"
              onClick={handleCopyCode}
              className="pg-btn-secondary py-1.5 px-3 text-xs mono"
            >
              {copiedCode ? (
                <>
                  <Check size={12} className="text-emerald-400" />
                  <span className="text-emerald-300">Copied</span>
                </>
              ) : (
                <>
                  <Copy size={12} />
                  <span>Copy Code</span>
                </>
              )}
            </button>
          </div>
        </div>

        <div className="bg-[#07090E] overflow-x-auto max-h-[520px]">
          <pre
            className="p-5 mono text-xs leading-6 text-[#E5E7EB]"
            dangerouslySetInnerHTML={{
              __html: highlightCodeBlock(SDK_SNIPPETS[activeLang].code),
            }}
          />
        </div>
      </section>
    </div>
  )
}
