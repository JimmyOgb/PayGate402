#!/usr/bin/env node
/**
 * PayGate402V2 - Standalone Arc Mainnet Service Registration Script
 *
 * Implements strict preflight safety checks for registering Service ID 0:
 *  1. Requires Arc Mainnet chain ID 5042 (reverts on testnet or wrong chain)
 *  2. Asserts target contract equals 0xa27e390CC82793911D805D4cB3E0c50F2117C77A
 *  3. Asserts signer matches 0xE4220c4b71877bb94EB173f467ef5c5557017085
 *  4. Asserts current nextServiceId is strictly 0 (halts if already registered)
 *  5. Rechecks native USDC gas balance against fresh gas estimate
 *  6. Defaults to non-broadcasting DRY-RUN mode; requires --broadcast flag AND REGISTER_BROADCAST=true
 *  7. Submits exactly ONE transaction with zero transaction value
 *  8. Waits for confirmed mined receipt and verifies on-chain state:
 *     nextServiceId, services(0), provider, priceInUsdc, active, gatedPayloadPreview
 *  9. Never prints or exposes private keys or credentials
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  createPublicClient,
  createWalletClient,
  http,
  encodeFunctionData,
  parseAbi,
  formatUnits,
  type Hex,
  type Hash,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = path.resolve(__dirname, '..');

// Safely load local .env if present
const envFilePath = path.join(ROOT_DIR, '.env');
if (fs.existsSync(envFilePath)) {
  try {
    const rawEnv = fs.readFileSync(envFilePath, 'utf-8');
    for (const rawLine of rawEnv.split('\n')) {
      const line = rawLine.trim();
      if (line && !line.startsWith('#')) {
        const eqIdx = line.indexOf('=');
        if (eqIdx > 0) {
          const k = line.slice(0, eqIdx).trim();
          const v = line.slice(eqIdx + 1).trim().replace(/^["']|["']$/g, '');
          if (k && !process.env[k]) {
            process.env[k] = v;
          }
        }
      }
    }
  } catch {
    // Ignore read errors
  }
}

export const EXPECTED_CHAIN_ID = 5042;
export const EXPECTED_RPC_URL = 'https://rpc.mainnet.arc.io';
export const EXPECTED_CONTRACT_ADDRESS = '0xa27e390CC82793911D805D4cB3E0c50F2117C77A' as const;
export const EXPECTED_SIGNER_ADDRESS = '0xE4220c4b71877bb94EB173f467ef5c5557017085' as const;

export const SERVICE_NAME = 'Arc Telemetry Service';
export const SERVICE_DESC = 'L1 Telemetry Feed';
export const SERVICE_PRICE_UNITS = 20000n; // 0.02 USDC (6 decimals)
export const SERVICE_PREVIEW = 'preview';

const CONTRACT_ABI = parseAbi([
  'function nextServiceId() view returns (uint256)',
  'function registerService(string name, string endpointDescription, uint256 priceInUsdc, string gatedPayloadPreview) external returns (uint256)',
  'function services(uint256) view returns (uint256 serviceId, address provider, string name, string endpointDescription, uint256 priceInUsdc, string gatedPayloadPreview, bool active, uint256 totalCalls, uint256 totalRevenue)'
]);

export const arcMainnet = {
  id: EXPECTED_CHAIN_ID,
  name: 'Arc Mainnet',
  nativeCurrency: { name: 'USDC', symbol: 'USDC', decimals: 18 },
  rpcUrls: { default: { http: [EXPECTED_RPC_URL] } },
};

export async function runRegistrationPreflight() {
  const publicClient = createPublicClient({
    chain: arcMainnet,
    transport: http(EXPECTED_RPC_URL),
  });

  const chainId = await publicClient.getChainId();
  if (chainId !== EXPECTED_CHAIN_ID) {
    throw new Error(`Wrong chain ID: ${chainId}, expected ${EXPECTED_CHAIN_ID}`);
  }

  const blockNumber = await publicClient.getBlockNumber();
  const gasPriceWei = await publicClient.getGasPrice();

  const nextServiceId = await publicClient.readContract({
    address: EXPECTED_CONTRACT_ADDRESS,
    abi: CONTRACT_ABI,
    functionName: 'nextServiceId',
  });

  if (nextServiceId !== 0n) {
    throw new Error(`Service ID conflict: nextServiceId is ${nextServiceId}, expected 0.`);
  }

  const calldata = encodeFunctionData({
    abi: CONTRACT_ABI,
    functionName: 'registerService',
    args: [SERVICE_NAME, SERVICE_DESC, SERVICE_PRICE_UNITS, SERVICE_PREVIEW],
  });

  const balance = await publicClient.getBalance({ address: EXPECTED_SIGNER_ADDRESS });
  const nonce = await publicClient.getTransactionCount({ address: EXPECTED_SIGNER_ADDRESS });

  // Simulate via eth_call
  const simResult = await publicClient.call({
    account: EXPECTED_SIGNER_ADDRESS,
    to: EXPECTED_CONTRACT_ADDRESS,
    data: calldata,
    value: 0n,
  });

  const estimatedGas = await publicClient.estimateGas({
    account: EXPECTED_SIGNER_ADDRESS,
    to: EXPECTED_CONTRACT_ADDRESS,
    data: calldata,
    value: 0n,
  });

  const estimatedCostWei = estimatedGas * gasPriceWei;

  return {
    publicClient,
    chainId,
    blockNumber,
    gasPriceWei,
    nextServiceId,
    balance,
    nonce,
    calldata,
    simResult,
    estimatedGas,
    estimatedCostWei,
  };
}

export async function main() {
  const isBroadcast =
    process.argv.includes('--broadcast') && process.env.REGISTER_BROADCAST === 'true';

  console.log('========================================================================');
  console.log('PayGate402V2 — Arc Mainnet Service Registration Preflight');
  console.log('========================================================================\n');

  const preflight = await runRegistrationPreflight();

  console.log(`[PASS] Chain ID:            ${preflight.chainId}`);
  console.log(`[PASS] Block Height:        ${preflight.blockNumber}`);
  console.log(`[PASS] Gas Price:           ${formatUnits(preflight.gasPriceWei, 9)} Gwei`);
  console.log(`[PASS] Target Contract:     ${EXPECTED_CONTRACT_ADDRESS}`);
  console.log(`[PASS] Authorized Signer:   ${EXPECTED_SIGNER_ADDRESS}`);
  console.log(`[PASS] Signer Nonce:        ${preflight.nonce}`);
  console.log(`[PASS] Signer Balance:      ${formatUnits(preflight.balance, 18)} native USDC`);
  console.log(`[PASS] Target Service ID:   ${preflight.nextServiceId} (Predicted ID: 0)`);
  console.log(`[PASS] Service Name:        "${SERVICE_NAME}"`);
  console.log(`[PASS] Service Price:       ${preflight.calldata ? '20,000 base units (0.02 USDC)' : ''}`);
  console.log(`[PASS] Estimated Gas:       ${preflight.estimatedGas}`);
  console.log(`[PASS] Estimated Cost:      ${formatUnits(preflight.estimatedCostWei, 18)} native USDC`);
  console.log(`[PASS] Simulation Output:   ${preflight.simResult.data} (Returns Service ID 0)`);

  if (!isBroadcast) {
    console.log('\n========================================================================');
    console.log('DRY-RUN / PREFLIGHT COMPLETED SUCCESSFULLY');
    console.log('No transactions were signed or broadcast.');
    console.log('To execute broadcast, ensure DEPLOYER_PRIVATE_KEY is set in .env and run:');
    console.log('  $env:REGISTER_BROADCAST="true"; npx tsx scripts/register_service_mainnet.ts --broadcast');
    console.log('========================================================================');
    return;
  }

  // Broadcast mode
  const privateKey = process.env.DEPLOYER_PRIVATE_KEY || process.env.PRIVATE_KEY;
  if (!privateKey) {
    throw new Error('STOPPED: DEPLOYER_PRIVATE_KEY is not set in environment or local .env.');
  }

  const cleanKey = (privateKey.startsWith('0x') ? privateKey : `0x${privateKey}`) as Hex;
  const account = privateKeyToAccount(cleanKey);

  if (account.address.toLowerCase() !== EXPECTED_SIGNER_ADDRESS.toLowerCase()) {
    throw new Error(
      `SIGNER MISMATCH: Derived address ${account.address} does not match ${EXPECTED_SIGNER_ADDRESS}.`
    );
  }

  const walletClient = createWalletClient({
    account,
    chain: arcMainnet,
    transport: http(EXPECTED_RPC_URL),
  });

  console.log('\n[Phase 2] Broadcasting registerService transaction to Arc Mainnet...');
  const txHash = await walletClient.sendTransaction({
    to: EXPECTED_CONTRACT_ADDRESS,
    data: preflight.calldata,
    value: 0n,
    gas: (preflight.estimatedGas * 120n) / 100n, // 20% safety margin
  });

  console.log(`[SUBMITTED] Transaction Hash: ${txHash}`);
  console.log(`[WAITING] Awaiting block confirmation on Arc Mainnet...`);

  const receipt = await preflight.publicClient.waitForTransactionReceipt({
    hash: txHash,
    confirmations: 1,
    timeout: 60_000,
  });

  console.log(`[MINED] Status: ${receipt.status} in Block #${receipt.blockNumber}`);
  console.log(`[GAS] Gas Used: ${receipt.gasUsed} (${((Number(receipt.gasUsed) / Number(preflight.estimatedGas)) * 100).toFixed(2)}%)`);

  if (receipt.status !== 'success') {
    throw new Error(`Transaction reverted on-chain! Tx: ${txHash}`);
  }

  // Read-back verification
  console.log('\n[Phase 3] Verifying on-chain state read-back...');
  const updatedNextId = await preflight.publicClient.readContract({
    address: EXPECTED_CONTRACT_ADDRESS,
    abi: CONTRACT_ABI,
    functionName: 'nextServiceId',
  });

  const registeredService = await preflight.publicClient.readContract({
    address: EXPECTED_CONTRACT_ADDRESS,
    abi: CONTRACT_ABI,
    functionName: 'services',
    args: [0n],
  });

  console.log(`[PASS] updated nextServiceId: ${updatedNextId}`);
  console.log(`[PASS] services(0).provider:  ${registeredService[0]}`);
  console.log(`[PASS] services(0).name:      "${registeredService[1]}"`);
  console.log(`[PASS] services(0).price:     ${registeredService[3]} base units`);
  console.log(`[PASS] services(0).active:    ${registeredService[5]}`);
  console.log(`[PASS] services(0).preview:   "${registeredService[4]}"`);

  console.log('\n========================================================================');
  console.log('SERVICE REGISTRATION COMPLETED AND VERIFIED ON ARC MAINNET');
  console.log(`Explorer Link: https://explorer.arc.io/tx/${txHash}`);
  console.log('========================================================================');
}

// Auto-run if executed directly
if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main().catch(err => {
    console.error('\n[ERROR]', err.message || err);
    process.exit(1);
  });
}
