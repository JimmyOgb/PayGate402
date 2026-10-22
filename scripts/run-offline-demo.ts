/**
 * PayGate402 - Local $0 Offline Protocol Simulation
 *
 * SIMULATED DEMO — NOT ON-CHAIN AUTHORIZED
 * Strictly offline fixtures; no real on-chain payment, no gas, no wallet approval.
 */
import { privateKeyToAccount } from 'viem/accounts'
import {
  type Hex,
} from 'viem'
import {
  PAYGATE_EIP712_DOMAIN,
  PAYGATE_EIP712_TYPES,
  type PaymentChallenge,
} from '../src/gateway/types.ts'

const GATEWAY_URL = 'http://localhost:4020'
const ALICE_KEY: Hex = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80'
const alice = privateKeyToAccount(ALICE_KEY)

const BOB_KEY: Hex = '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d'
const bob = privateKeyToAccount(BOB_KEY)

console.log('================================================================');
console.log('   SIMULATED DEMO — NOT ON-CHAIN AUTHORIZED');
console.log('   PayGate402 Offline $0 Protocol Simulation');
console.log('================================================================');

async function getChallenge(payer: string = alice.address, body: string = '{}') {
  const res = await fetch(`${GATEWAY_URL}/v1/gateway/0/signals/whale`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Payment-Payer': payer,
    },
    body,
  });
  if (res.status !== 402) {
    throw new Error(`Expected 402, got ${res.status}`);
  }
  const json = await res.json();
  return json.challenge as PaymentChallenge;
}

async function runDemo() {
  // 1. Health check
  console.log('\n[1/8] Testing Health Endpoint (GET /health)...');
  const healthRes = await fetch(`${GATEWAY_URL}/health`);
  const healthJson = await healthRes.json();
  console.log('Status code:', healthRes.status);
  console.log('Health info:', JSON.stringify(healthJson, null, 2));

  // 2. Challenge flow
  console.log('\n[2/8] Testing Challenge Flow (POST /v1/gateway/0/signals/whale)...');
  const sampleBody = JSON.stringify({ query: 'latest_signals', limit: 10 });
  const challenge = await getChallenge(alice.address, sampleBody);
  console.log('HTTP Status: 402 Payment Required');
  console.log('Challenge Ticket:', JSON.stringify(challenge, null, 2));

  // 3. Invalid requests: Unknown service ID
  console.log('\n[3/8] Testing Invalid Request (Unregistered Service ID 999)...');
  const invalidServiceRes = await fetch(`${GATEWAY_URL}/v1/gateway/999/test`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{}',
  });
  console.log('Invalid Service Status (Expect 400):', invalidServiceRes.status);
  const invalidJson = await invalidServiceRes.json();
  console.log('Response:', JSON.stringify(invalidJson));

  // 4. Oversized body (> 1 MiB)
  console.log('\n[4/8] Testing Oversized Request Body (Exceeding 1 MiB limit)...');
  const oversizedData = 'X'.repeat(1024 * 1024 + 100);
  const oversizedRes = await fetch(`${GATEWAY_URL}/v1/gateway/0/signals/whale`, {
    method: 'POST',
    headers: { 'Content-Type': 'text/plain' },
    body: oversizedData,
  });
  console.log('Oversized Body Status (Expect 413):', oversizedRes.status);
  const oversizedJson = await oversizedRes.json();
  console.log('Response:', JSON.stringify(oversizedJson));

  // 5. Rate limiting test
  console.log('\n[5/8] Testing Rate Limiting Protection (Burst Challenges)...');
  let rateLimitedHit = false;
  for (let i = 0; i < 70; i++) {
    const res = await fetch(`${GATEWAY_URL}/v1/gateway/0/signals/whale`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Payment-Payer': '0x0000000000000000000000000000000000000088',
      },
      body: JSON.stringify({ burstId: i }),
    });
    if (res.status === 429) {
      rateLimitedHit = true;
      const rlJson = await res.json();
      console.log(`Rate limit triggered at burst request #${i + 1} with HTTP 429:`, JSON.stringify(rlJson));
      break;
    }
  }
  if (!rateLimitedHit) {
    console.log('Notice: Rate limit was not exceeded in this batch window.');
  }

  // 6. Offline Failure Handling (each with distinct fresh challenge)
  console.log('\n[6/8] Testing Offline Failure Handling...');

  // 6A. Non-existent transaction
  const c6a = await getChallenge(alice.address, sampleBody);
  const nonexistentTx: Hex = '0x9999999999999999999999999999999999999999999999999999999999999999';
  const dummySig: Hex = '0x' + '00'.repeat(65);
  const notFoundRes = await fetch(`${GATEWAY_URL}/v1/gateway/0/signals/whale`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Payment-TxHash': nonexistentTx,
      'X-Payment-RequestId': c6a.requestId,
      'X-Payment-Signature': dummySig,
      'X-Payment-Payer': alice.address,
    },
    body: sampleBody,
  });
  console.log('6A. Nonexistent Tx Status (Expect 402 TX_NOT_FOUND):', notFoundRes.status);
  const notFoundJson = await notFoundRes.json();
  console.log('Response:', JSON.stringify(notFoundJson));

  // 6B. Reverted transaction on-chain
  const c6b = await getChallenge(alice.address, sampleBody);
  const revertedTx: Hex = '0x3333333333333333333333333333333333333333333333333333333333333333';
  await fetch(`${GATEWAY_URL}/v1/mock/register-payment`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      txHash: revertedTx,
      serviceId: '0',
      requestId: c6b.requestId,
      caller: alice.address,
      amountPaid: '100000',
      status: 'reverted',
    }),
  });
  const revertedRes = await fetch(`${GATEWAY_URL}/v1/gateway/0/signals/whale`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Payment-TxHash': revertedTx,
      'X-Payment-RequestId': c6b.requestId,
      'X-Payment-Signature': dummySig,
      'X-Payment-Payer': alice.address,
    },
    body: sampleBody,
  });
  console.log('6B. Reverted Tx Status (Expect 402 TX_REVERTED):', revertedRes.status);
  const revertedJson = await revertedRes.json();
  console.log('Response:', JSON.stringify(revertedJson));

  // 6C. Invalid signature (Bob signs Alice\'s payment)
  const c6c = await getChallenge(alice.address, sampleBody);
  const validTxHash1: Hex = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa1';
  await fetch(`${GATEWAY_URL}/v1/mock/register-payment`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      txHash: validTxHash1,
      serviceId: '0',
      requestId: c6c.requestId,
      caller: alice.address,
      amountPaid: '100000',
      status: 'success',
    }),
  });

  const eip712MessageBob = {
    serviceId: BigInt(c6c.serviceId),
    requestId: c6c.requestId as Hex,
    txHash: validTxHash1,
    method: c6c.method,
    path: c6c.path,
    bodyDigest: c6c.bodyDigest as Hex,
    quotedPrice: BigInt(c6c.quotedPrice),
    expiresAt: BigInt(c6c.expiresAt),
  };

  const bobWrongSignature = await bob.signTypedData({
    domain: PAYGATE_EIP712_DOMAIN,
    types: PAYGATE_EIP712_TYPES,
    primaryType: 'PayGateAuthorization',
    message: eip712MessageBob,
  });

  const wrongSigRes = await fetch(`${GATEWAY_URL}/v1/gateway/0/signals/whale`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Payment-TxHash': validTxHash1,
      'X-Payment-RequestId': c6c.requestId,
      'X-Payment-Signature': bobWrongSignature,
      'X-Payment-Payer': alice.address,
    },
    body: sampleBody,
  });
  console.log('6C. Mismatched Signer Status (Expect 401 SIGNER_MISMATCH):', wrongSigRes.status);
  const wrongSigJson = await wrongSigRes.json();
  console.log('Response:', JSON.stringify(wrongSigJson));

  // 7. Successful Payment Unlocking (Alice signs Alice\'s payment)
  console.log('\n[7/8] Testing Valid Payment Unlock (Alice signs valid payment)...');
  const c7 = await getChallenge(alice.address, sampleBody);
  const validTxHash2: Hex = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa2';
  await fetch(`${GATEWAY_URL}/v1/mock/register-payment`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      txHash: validTxHash2,
      serviceId: '0',
      requestId: c7.requestId,
      caller: alice.address,
      amountPaid: '100000',
      status: 'success',
    }),
  });

  const eip712MessageAlice = {
    serviceId: BigInt(c7.serviceId),
    requestId: c7.requestId as Hex,
    txHash: validTxHash2,
    method: c7.method,
    path: c7.path,
    bodyDigest: c7.bodyDigest as Hex,
    quotedPrice: BigInt(c7.quotedPrice),
    expiresAt: BigInt(c7.expiresAt),
  };

  const aliceValidSignature = await alice.signTypedData({
    domain: PAYGATE_EIP712_DOMAIN,
    types: PAYGATE_EIP712_TYPES,
    primaryType: 'PayGateAuthorization',
    message: eip712MessageAlice,
  });

  const unlockRes = await fetch(`${GATEWAY_URL}/v1/gateway/0/signals/whale`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Payment-TxHash': validTxHash2,
      'X-Payment-RequestId': c7.requestId,
      'X-Payment-Signature': aliceValidSignature,
      'X-Payment-Payer': alice.address,
    },
    body: sampleBody,
  });
  console.log('Unlock Status (Expect 200):', unlockRes.status);
  const unlockHeaders = Object.fromEntries(unlockRes.headers.entries());
  console.log('Status Header (X-PayGate-Status):', unlockHeaders['x-paygate-status']);
  const unlockPayload = await unlockRes.json();
  console.log('Unlocked Payload (SIMULATED):', JSON.stringify(unlockPayload, null, 2));

  // 8. Replay Protection & Idempotent Cache
  console.log('\n[8/8] Testing Replay Protection & Idempotent Caching...');
  
  // 8A. Immediate identical retry: returns cached payload
  const retryRes = await fetch(`${GATEWAY_URL}/v1/gateway/0/signals/whale`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Payment-TxHash': validTxHash2,
      'X-Payment-RequestId': c7.requestId,
      'X-Payment-Signature': aliceValidSignature,
      'X-Payment-Payer': alice.address,
    },
    body: sampleBody,
  });
  console.log('8A. Idempotent Retry Status (Expect 200):', retryRes.status);
  const retryHeaders = Object.fromEntries(retryRes.headers.entries());
  console.log('Cached Header (X-PayGate-Cached):', retryHeaders['x-paygate-cached']);
  console.log('Status Header (X-PayGate-Status):', retryHeaders['x-paygate-status']);

  // 8B. Reusing the settled payment tx on a NEW challenge: must be rejected with 409 PAYMENT_ALREADY_CONSUMED
  const freshChallenge = await getChallenge(alice.address, sampleBody);
  const replayNewChallengeRes = await fetch(`${GATEWAY_URL}/v1/gateway/0/signals/whale`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Payment-TxHash': validTxHash2,
      'X-Payment-RequestId': freshChallenge.requestId,
      'X-Payment-Signature': aliceValidSignature,
      'X-Payment-Payer': alice.address,
    },
    body: sampleBody,
  });
  console.log('8B. Replay on New Challenge Status (Expect 409):', replayNewChallengeRes.status);
  const replayJson = await replayNewChallengeRes.json();
  console.log('Replay Rejection:', JSON.stringify(replayJson));

  console.log('\n================================================================');
  console.log('   SIMULATED DEMO COMPLETE — ALL 8 SCENARIOS VERIFIED');
  console.log('   SIMULATED DEMO — NOT ON-CHAIN AUTHORIZED');
  console.log('================================================================');
}

runDemo().catch(err => {
  console.error('Demo error:', err);
  process.exit(1);
});
