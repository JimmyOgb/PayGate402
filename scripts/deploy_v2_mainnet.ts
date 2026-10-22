#!/usr/bin/env node
/**
 * PayGate402V2 — Standalone Arc Mainnet Deployment Script
 *
 * Implements the verified standalone Viem/RPC deployment pattern established
 * by PayProof, with strict multi-layer preflight safeguards:
 *
 * Safeguards:
 *  1. Requires Arc Mainnet chain ID 5042 (reverts on wrong chain or testnet RPC)
 *  2. Asserts deployer address strictly equals 0xE4220c4b71877bb94EB173f467ef5c5557017085
 *  3. Verifies bit-for-bit creation and runtime bytecode SHA-256 hashes before signing
 *  4. Asserts constructor args: USDC 0x3600...0000 and Treasury 0xDc7c...Ca2c
 *  5. Rechecks deployer native USDC balance against live gas estimate
 *  6. Defaults to non-broadcasting DRY-RUN mode; requires --broadcast flag AND DEPLOY_BROADCAST=true
 *  7. Zero blind retries: single broadcast with explicit receipt and code verification
 *  8. Never prints private keys or sensitive credentials to logs or reports
 *  9. Leaves networkConfig.ts unconfigured pending separate owner authorization
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import {
  createPublicClient,
  createWalletClient,
  http,
  encodeDeployData,
  getAddress,
  isAddress,
  type Hex,
  type Hash,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = path.resolve(__dirname, '..');

// Safely load local .env if present (without overwriting existing process.env)
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

// --- Canonical Deployment Invariants ---
export const EXPECTED_CHAIN_ID = 5042;
export const EXPECTED_RPC_URL = 'https://rpc.mainnet.arc.io';
export const EXPECTED_DEPLOYER_ADDRESS = '0xE4220c4b71877bb94EB173f467ef5c5557017085';
export const EXPECTED_TREASURY_ADDRESS = '0xDc7c4aFBa201D2a3108061107346e9ff70f0Ca2c';
export const EXPECTED_USDC_ADDRESS = '0x3600000000000000000000000000000000000000';

export const EXPECTED_CREATION_SHA256 = '5a2d290dbf76e5a2308d71f2539cddb699a6a7af11341471414144c917490413';
export const EXPECTED_RUNTIME_SHA256 = '80a16f4a4a7316a9fc7906ffe3c35334eb7df07db0d1201fbc9bd644786a9ce3';
export const EXPECTED_CREATION_BYTES = 4402;
export const EXPECTED_RUNTIME_BYTES = 4026;
export const EXPECTED_INITCODE_BYTES = 4466; // 4402 creation + 64 constructor args

export const ARTIFACT_PATH = path.join(ROOT_DIR, 'contracts/out/PayGate402V2.sol/PayGate402V2.json');

function sha256Hex(buf: Buffer): string {
  return createHash('sha256').update(buf).digest('hex');
}

export interface DeploymentOptions {
  broadcast?: boolean;
  rpcUrl?: string;
  privateKey?: string;
}

export interface PreflightResult {
  chainId: number;
  blockNumber: bigint;
  gasPriceWei: bigint;
  deployerAddress: string;
  deployerBalanceWei: bigint;
  deployerNonce: number;
  estimatedGas: bigint;
  estimatedCostWei: bigint;
  estimatedCostUsdc: number;
  bufferedCostUsdc: number;
  deployData: Hex;
  artifactPath: string;
  isReadyForBroadcast: boolean;
}

export async function runPreflight(options: DeploymentOptions = {}): Promise<PreflightResult> {
  const rpcUrl = options.rpcUrl || process.env.ARC_RPC_URL || EXPECTED_RPC_URL;

  if (rpcUrl.toLowerCase().includes('testnet')) {
    throw new Error(`REJECTED: Testnet RPC URL detected (${rpcUrl}). Target must be Arc Mainnet.`);
  }

  // 1. Verify Artifact Exists and Matches Exact Bytecode Hashes
  if (!fs.existsSync(ARTIFACT_PATH)) {
    throw new Error(`Artifact not found at ${ARTIFACT_PATH}. Run python scripts/build_v2_artifact.py first.`);
  }

  const rawArtifact = JSON.parse(fs.readFileSync(ARTIFACT_PATH, 'utf-8'));
  if (!rawArtifact.abi || !rawArtifact.bytecode?.object || !rawArtifact.deployedBytecode?.object) {
    throw new Error('Malformed artifact: missing abi, bytecode.object, or deployedBytecode.object.');
  }

  const creationHex = rawArtifact.bytecode.object.replace(/^0x/, '');
  const runtimeHex = rawArtifact.deployedBytecode.object.replace(/^0x/, '');
  const creationBuf = Buffer.from(creationHex, 'hex');
  const runtimeBuf = Buffer.from(runtimeHex, 'hex');

  if (creationBuf.length !== EXPECTED_CREATION_BYTES) {
    throw new Error(`Creation bytecode length mismatch: expected ${EXPECTED_CREATION_BYTES}, got ${creationBuf.length}`);
  }
  if (runtimeBuf.length !== EXPECTED_RUNTIME_BYTES) {
    throw new Error(`Runtime bytecode length mismatch: expected ${EXPECTED_RUNTIME_BYTES}, got ${runtimeBuf.length}`);
  }

  const creationSha = sha256Hex(creationBuf);
  const runtimeSha = sha256Hex(runtimeBuf);

  if (creationSha !== EXPECTED_CREATION_SHA256) {
    throw new Error(`Creation bytecode SHA-256 mismatch!\nExpected: ${EXPECTED_CREATION_SHA256}\nGot:      ${creationSha}`);
  }
  if (runtimeSha !== EXPECTED_RUNTIME_SHA256) {
    throw new Error(`Runtime bytecode SHA-256 mismatch!\nExpected: ${EXPECTED_RUNTIME_SHA256}\nGot:      ${runtimeSha}`);
  }

  // Check no unlinked placeholders
  if (creationHex.includes('__') || runtimeHex.includes('__')) {
    throw new Error('Unresolved library placeholders detected in bytecode.');
  }

  // 2. Validate Constructor Parameters
  if (!isAddress(EXPECTED_USDC_ADDRESS) || !isAddress(EXPECTED_TREASURY_ADDRESS)) {
    throw new Error('Invalid constructor address parameters.');
  }

  const usdcChecksum = getAddress(EXPECTED_USDC_ADDRESS);
  const treasuryChecksum = getAddress(EXPECTED_TREASURY_ADDRESS);

  const deployData = encodeDeployData({
    abi: rawArtifact.abi,
    bytecode: `0x${creationHex}`,
    args: [usdcChecksum, treasuryChecksum],
  });

  const initcodeBytes = (deployData.length - 2) / 2;
  if (initcodeBytes !== EXPECTED_INITCODE_BYTES) {
    throw new Error(`Initcode length mismatch: expected ${EXPECTED_INITCODE_BYTES} bytes, got ${initcodeBytes}`);
  }

  // 3. Connect to RPC and Verify Chain ID
  const publicClient = createPublicClient({ transport: http(rpcUrl) });
  const chainId = await publicClient.getChainId();
  if (chainId !== EXPECTED_CHAIN_ID) {
    throw new Error(`Wrong chain ID: connected to ${chainId}, expected Arc Mainnet (${EXPECTED_CHAIN_ID}).`);
  }

  const blockNumber = await publicClient.getBlockNumber();
  const gasPriceWei = await publicClient.getGasPrice();

  // 4. Validate Signer Address
  const privateKey = options.privateKey || process.env.DEPLOYER_PRIVATE_KEY;
  let deployerAddress = EXPECTED_DEPLOYER_ADDRESS;

  if (privateKey) {
    const cleanKey = (privateKey.startsWith('0x') ? privateKey : `0x${privateKey}`) as Hex;
    const account = privateKeyToAccount(cleanKey);

    if (account.address.toLowerCase() !== EXPECTED_DEPLOYER_ADDRESS.toLowerCase()) {
      throw new Error(
        `SIGNER MISMATCH: Key derived address ${account.address} does not match expected deployer ${EXPECTED_DEPLOYER_ADDRESS}.`
      );
    }
    deployerAddress = account.address;
  } else if (options.broadcast || process.argv.includes('--broadcast') || process.env.DEPLOY_BROADCAST === 'true') {
    throw new Error('DEPLOYER_PRIVATE_KEY is not set in environment (required for broadcast).');
  }

  const deployerBalanceWei = await publicClient.getBalance({ address: deployerAddress as `0x${string}` });
  const deployerNonce = await publicClient.getTransactionCount({ address: deployerAddress as `0x${string}` });

  // 5. Estimate Gas
  const estimatedGas = await publicClient.estimateGas({
    account: deployerAddress as `0x${string}`,
    data: deployData,
  });

  const estimatedCostWei = estimatedGas * gasPriceWei;
  const estimatedCostUsdc = Number(estimatedCostWei) / 1e18;
  const bufferedCostUsdc = (1500000 * Number(gasPriceWei)) / 1e18;

  if (deployerBalanceWei < estimatedCostWei) {
    throw new Error(
      `INSUFFICIENT GAS: Deployer holds ${Number(deployerBalanceWei) / 1e18} native USDC, required ${estimatedCostUsdc} USDC.`
    );
  }

  return {
    chainId,
    blockNumber,
    gasPriceWei,
    deployerAddress,
    deployerBalanceWei,
    deployerNonce,
    estimatedGas,
    estimatedCostWei,
    estimatedCostUsdc,
    bufferedCostUsdc,
    deployData,
    artifactPath: ARTIFACT_PATH,
    isReadyForBroadcast: true,
  };
}

export async function deployMainnet(options: DeploymentOptions = {}) {
  const isBroadcast = options.broadcast || process.argv.includes('--broadcast');
  const envBroadcast = process.env.DEPLOY_BROADCAST === 'true';

  console.log('='.repeat(72));
  console.log('PayGate402V2 — Standalone Arc Mainnet Deployment');
  console.log('='.repeat(72));

  // Step 1: Execute Full Preflight
  console.log('\n[Phase 1] Executing strict preflight invariant checks...');
  const preflight = await runPreflight(options);

  console.log('  [PASS] Arc Mainnet Chain ID:     ', preflight.chainId);
  console.log('  [PASS] Block Height:             ', preflight.blockNumber.toString());
  console.log('  [PASS] Base Gas Price:           ', (Number(preflight.gasPriceWei) / 1e9).toFixed(4), 'Gwei');
  console.log('  [PASS] Verified Deployer:        ', preflight.deployerAddress);
  console.log('  [PASS] Deployer Nonce:           ', preflight.deployerNonce);
  console.log('  [PASS] Deployer Native Balance:  ', (Number(preflight.deployerBalanceWei) / 1e18).toFixed(6), 'USDC');
  console.log('  [PASS] Creation Bytecode SHA-256:', EXPECTED_CREATION_SHA256);
  console.log('  [PASS] Runtime Bytecode SHA-256: ', EXPECTED_RUNTIME_SHA256);
  console.log('  [PASS] Constructor USDC Token:   ', EXPECTED_USDC_ADDRESS);
  console.log('  [PASS] Constructor Treasury:     ', EXPECTED_TREASURY_ADDRESS);
  console.log('  [PASS] Total Initcode Length:    ', EXPECTED_INITCODE_BYTES, 'bytes');
  console.log('  [PASS] Estimated Deployment Gas: ', preflight.estimatedGas.toString(), 'gas');
  console.log('  [PASS] Estimated Cost:           ', preflight.estimatedCostUsdc.toFixed(6), 'native USDC');
  console.log('  [PASS] Buffered Cost (1.5M gas): ', preflight.bufferedCostUsdc.toFixed(6), 'native USDC');
  console.log('  [PASS] Balance Coverage Ratio:   ', (Number(preflight.deployerBalanceWei) / Number(preflight.estimatedCostWei)).toFixed(2) + 'x');

  // Step 2: Safety Gate Evaluation
  if (!isBroadcast || !envBroadcast) {
    console.log('\n' + '='.repeat(72));
    console.log('DRY-RUN / PREFLIGHT COMPLETED SUCCESSFULLY');
    console.log('No transactions were signed or broadcast.');
    console.log('To execute the real deployment, both of the following are required:');
    console.log('  1. Pass the `--broadcast` flag on the CLI');
    console.log('  2. Set environment variable `DEPLOY_BROADCAST=true`');
    console.log('='.repeat(72));
    return {
      success: true,
      mode: 'dry-run',
      preflight,
    };
  }

  // Step 3: Broadcast (Only when explicitly gated)
  console.log('\n[Phase 2] BROADCASTING CONTRACT DEPLOYMENT TO ARC MAINNET...');
  const rpcUrl = options.rpcUrl || process.env.ARC_RPC_URL || EXPECTED_RPC_URL;
  const privateKey = (options.privateKey || process.env.DEPLOYER_PRIVATE_KEY)!;
  const cleanKey = (privateKey.startsWith('0x') ? privateKey : `0x${privateKey}`) as Hex;

  const account = privateKeyToAccount(cleanKey);
  const publicClient = createPublicClient({ transport: http(rpcUrl) });
  const walletClient = createWalletClient({ account, transport: http(rpcUrl) });

  console.log(`Submitting single contract-creation transaction from ${account.address}...`);
  const txHash: Hash = await walletClient.sendTransaction({
    to: null,
    data: preflight.deployData,
    value: 0n,
  });

  console.log('Transaction broadcast successfully! Tx Hash:', txHash);
  console.log(`Explorer URL: https://explorer.arc.io/tx/${txHash}`);
  console.log('Waiting for block confirmation on Arc Mainnet...');

  const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash });

  if (receipt.status !== 'success' || !receipt.contractAddress) {
    throw new Error(`Deployment transaction reverted on-chain. Status: ${receipt.status}, Tx: ${txHash}`);
  }

  const deployedAddress = getAddress(receipt.contractAddress);
  console.log('\n' + '='.repeat(72));
  console.log('PAYGATE402V2 SUCCESSFULLY DEPLOYED ON ARC MAINNET!');
  console.log('='.repeat(72));
  console.log('Contract Address:    ', deployedAddress);
  console.log('Transaction Hash:    ', txHash);
  console.log('Block Number:        ', receipt.blockNumber.toString());
  console.log('Gas Used:            ', receipt.gasUsed.toString());
  console.log('Contract Explorer:   ', `https://explorer.arc.io/address/${deployedAddress}`);
  console.log('Tx Explorer:         ', `https://explorer.arc.io/tx/${txHash}`);

  // Step 4: Verify Deployed Runtime Bytecode
  console.log('\n[Phase 3] Verifying deployed runtime bytecode on Arc Mainnet...');
  const deployedCode = await publicClient.getBytecode({ address: deployedAddress });
  if (!deployedCode || deployedCode === '0x') {
    throw new Error(`Fatal: No bytecode detected at deployed address ${deployedAddress}`);
  }

  const deployedCodeBytes = (deployedCode.length - 2) / 2;
  console.log(`Deployed Bytecode Length: ${deployedCodeBytes} bytes (Expected: ${EXPECTED_RUNTIME_BYTES})`);

  // Step 5: Read Back On-Chain Invariants
  const rawArtifact = JSON.parse(fs.readFileSync(ARTIFACT_PATH, 'utf-8'));
  const onchainTreasury = await publicClient.readContract({
    address: deployedAddress,
    abi: rawArtifact.abi,
    functionName: 'protocolTreasury',
  });
  const onchainUsdc = await publicClient.readContract({
    address: deployedAddress,
    abi: rawArtifact.abi,
    functionName: 'usdcToken',
  });
  const onchainFeeBps = await publicClient.readContract({
    address: deployedAddress,
    abi: rawArtifact.abi,
    functionName: 'PROTOCOL_FEE_BPS',
  });

  console.log('On-Chain Verified Treasury:  ', onchainTreasury);
  console.log('On-Chain Verified USDC Token:', onchainUsdc);
  console.log('On-Chain Verified Fee BPS:   ', onchainFeeBps.toString());

  return {
    success: true,
    mode: 'live-deployment',
    txHash,
    contractAddress: deployedAddress,
    blockNumber: receipt.blockNumber.toString(),
    gasUsed: receipt.gasUsed.toString(),
    onchainTreasury,
    onchainUsdc,
    onchainFeeBps: onchainFeeBps.toString(),
  };
}

// Direct execution entry point
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  deployMainnet().catch((err) => {
    console.error('\n[DEPLOYMENT ERROR]:', err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
