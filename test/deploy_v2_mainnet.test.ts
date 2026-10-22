import test from 'node:test';
import assert from 'node:assert/strict';
import {
  EXPECTED_CHAIN_ID,
  EXPECTED_RPC_URL,
  EXPECTED_DEPLOYER_ADDRESS,
  EXPECTED_TREASURY_ADDRESS,
  EXPECTED_USDC_ADDRESS,
  EXPECTED_CREATION_SHA256,
  EXPECTED_RUNTIME_SHA256,
  EXPECTED_CREATION_BYTES,
  EXPECTED_RUNTIME_BYTES,
  EXPECTED_INITCODE_BYTES,
  runPreflight,
  deployMainnet,
} from '../scripts/deploy_v2_mainnet.ts';

test('PayGate402V2 Mainnet Deployment Safety & Invariant Test Suite', async (t) => {

  await t.test('1. Validates canonical deployment constants and addresses', () => {
    assert.equal(EXPECTED_CHAIN_ID, 5042, 'Arc Mainnet Chain ID must be 5042');
    assert.equal(EXPECTED_RPC_URL, 'https://rpc.mainnet.arc.io');
    assert.equal(EXPECTED_DEPLOYER_ADDRESS, '0xE4220c4b71877bb94EB173f467ef5c5557017085');
    assert.equal(EXPECTED_TREASURY_ADDRESS, '0xDc7c4aFBa201D2a3108061107346e9ff70f0Ca2c');
    assert.equal(EXPECTED_USDC_ADDRESS, '0x3600000000000000000000000000000000000000');
    assert.equal(EXPECTED_CREATION_BYTES, 4402);
    assert.equal(EXPECTED_RUNTIME_BYTES, 4026);
    assert.equal(EXPECTED_INITCODE_BYTES, 4466);
    assert.equal(EXPECTED_CREATION_SHA256, '5a2d290dbf76e5a2308d71f2539cddb699a6a7af11341471414144c917490413');
    assert.equal(EXPECTED_RUNTIME_SHA256, '80a16f4a4a7316a9fc7906ffe3c35334eb7df07db0d1201fbc9bd644786a9ce3');
  });

  await t.test('2. Rejects testnet RPC URLs to prevent accidental network cross-contamination', async () => {
    await assert.rejects(
      async () => {
        await runPreflight({ rpcUrl: 'https://rpc.testnet.arc.io' });
      },
      /REJECTED: Testnet RPC URL detected/
    );
  });

  await t.test('3. Rejects mismatched signer private keys with explicit address assertion', async () => {
    // Generate a dummy key (private key 0x1111... derives to 0x19E7E376E7C213B6174ABC64487CED14DD01070A)
    const dummyKey = '0x1111111111111111111111111111111111111111111111111111111111111111';
    await assert.rejects(
      async () => {
        await runPreflight({ privateKey: dummyKey });
      },
      /SIGNER MISMATCH/
    );
  });

  await t.test('4. Rejects broadcast attempt if private key is absent', async () => {
    const origEnvKey = process.env.DEPLOYER_PRIVATE_KEY;
    delete process.env.DEPLOYER_PRIVATE_KEY;
    try {
      await assert.rejects(
        async () => {
          await runPreflight({ broadcast: true });
        },
        /DEPLOYER_PRIVATE_KEY is not set in environment/
      );
    } finally {
      if (origEnvKey) process.env.DEPLOYER_PRIVATE_KEY = origEnvKey;
    }
  });

  await t.test('5. Read-only preflight passes and verifies live Arc Mainnet state', async () => {
    const preflight = await runPreflight({ broadcast: false });

    assert.equal(preflight.chainId, 5042);
    assert.ok(preflight.blockNumber > 27000000n, 'Block height must be above 27M');
    assert.equal(preflight.deployerAddress.toLowerCase(), EXPECTED_DEPLOYER_ADDRESS.toLowerCase());
    assert.ok(preflight.deployerBalanceWei > 0n, 'Deployer must hold native balance');
    assert.ok(preflight.estimatedGas > 800000n, 'Gas estimation must be realistic');
    assert.ok(preflight.deployerBalanceWei > preflight.estimatedCostWei, 'Balance must exceed cost');
    assert.equal(preflight.isReadyForBroadcast, true);
  });

  await t.test('6. deployMainnet defaults strictly to dry-run without broadcasting', async () => {
    const result = await deployMainnet({ broadcast: false });
    assert.equal(result.success, true);
    assert.equal(result.mode, 'dry-run');
    assert.ok(result.preflight);
  });
});
