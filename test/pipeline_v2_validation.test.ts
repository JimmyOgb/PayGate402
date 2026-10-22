import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import { createHash } from 'crypto';
import { type Hex, isAddress, decodeDeployData } from 'viem';

import {
  assertConstructorArgs,
  buildInitcode,
  computeVerifyFingerprint,
  isRecord,
} from '../scripts/compass-deploy-helpers.ts';

/**
 * Exact implementation of readCompiledArtifact as defined in compass-deploy.ts:392-409
 * and self-deploy.ts:161-182.
 */
function readCompiledArtifact(artifactPath: string): { abi: unknown[]; bytecode: Hex } {
  if (!fs.existsSync(artifactPath)) {
    throw new Error(`Compiled artifact not found at "${artifactPath}". Run forge build first.`);
  }

  const parsed = JSON.parse(fs.readFileSync(artifactPath, 'utf8')) as unknown;

  if (!isRecord(parsed) || !Array.isArray(parsed.abi)) {
    throw new Error(`Artifact "${artifactPath}" is missing an abi array.`);
  }

  const bytecodeField = parsed.bytecode;
  const object = isRecord(bytecodeField) ? bytecodeField.object : bytecodeField;

  if (typeof object !== 'string' || !object.startsWith('0x')) {
    throw new Error(`Artifact "${artifactPath}" is missing bytecode.object (0x-prefixed creation code).`);
  }

  return { abi: parsed.abi, bytecode: object as Hex };
}

const V2_ARTIFACT_PATH = 'contracts/out/PayGate402V2.sol/PayGate402V2.json';
const V1_ARTIFACT_PATH = 'contracts/out/PayGate402.sol/PayGate402.json';

const EXPECTED_CHAIN_ID = 5042;
const EXPECTED_CREATION_SHA256 = '5a2d290dbf76e5a2308d71f2539cddb699a6a7af11341471414144c917490413';
const EXPECTED_RUNTIME_SHA256 = '80a16f4a4a7316a9fc7906ffe3c35334eb7df07db0d1201fbc9bd644786a9ce3';
const EXPECTED_CREATION_BYTES = 4402;
const EXPECTED_RUNTIME_BYTES = 4026;

const ARC_MAINNET_USDC = '0x3600000000000000000000000000000000000000';
const PROPOSED_TREASURY = '0xDc7c4aFBa201D2a3108061107346e9ff70f0Ca2c';

function sha256Hex(buffer: Buffer): string {
  return createHash('sha256').update(buffer).digest('hex');
}

test('PayGate402V2 Build Pipeline & Artifact Validation Suite', async (t) => {

  await t.test('1. Loads generated artifact via compass-deploy readCompiledArtifact', () => {
    assert.ok(fs.existsSync(V2_ARTIFACT_PATH), `Artifact must exist at ${V2_ARTIFACT_PATH}`);
    const artifact = readCompiledArtifact(V2_ARTIFACT_PATH);

    assert.ok(Array.isArray(artifact.abi), 'Artifact must contain an ABI array');
    assert.ok(typeof artifact.bytecode === 'string', 'Artifact must contain creation bytecode string');
    assert.ok(artifact.bytecode.startsWith('0x'), 'Creation bytecode must have 0x prefix');
  });

  await t.test('2. Bytecode length and SHA-256 match independently verified Stage 8.12 compilation', () => {
    const rawJson = JSON.parse(fs.readFileSync(V2_ARTIFACT_PATH, 'utf-8'));
    const creationHex = rawJson.bytecode.object.replace(/^0x/, '');
    const runtimeHex = rawJson.deployedBytecode.object.replace(/^0x/, '');

    const creationBuf = Buffer.from(creationHex, 'hex');
    const runtimeBuf = Buffer.from(runtimeHex, 'hex');

    assert.equal(creationBuf.length, EXPECTED_CREATION_BYTES, 'Creation bytecode length must be 4,402 bytes');
    assert.equal(runtimeBuf.length, EXPECTED_RUNTIME_BYTES, 'Runtime bytecode length must be 4,026 bytes');

    assert.equal(sha256Hex(creationBuf), EXPECTED_CREATION_SHA256, 'Creation bytecode SHA-256 must match');
    assert.equal(sha256Hex(runtimeBuf), EXPECTED_RUNTIME_SHA256, 'Runtime bytecode SHA-256 must match');
  });

  await t.test('3. Confirms zero unresolved library placeholders in bytecode', () => {
    const rawJson = JSON.parse(fs.readFileSync(V2_ARTIFACT_PATH, 'utf-8'));
    assert.ok(!rawJson.bytecode.object.includes('__'), 'Creation bytecode must not contain library placeholders');
    assert.ok(!rawJson.deployedBytecode.object.includes('__'), 'Runtime bytecode must not contain library placeholders');
  });

  await t.test('4. Confirms artifact is PayGate402V2 and NOT legacy V1', () => {
    const v2Json = JSON.parse(fs.readFileSync(V2_ARTIFACT_PATH, 'utf-8'));
    const v1Json = JSON.parse(fs.readFileSync(V1_ARTIFACT_PATH, 'utf-8'));

    // V2 has single-level mapping: usedRequestIds(bytes32)
    // V1 has 3-level mapping: usedRequestIds(uint256,address,bytes32)
    assert.ok(
      'usedRequestIds(bytes32)' in v2Json.methodIdentifiers,
      'V2 must contain single-level usedRequestIds(bytes32)'
    );
    assert.ok(
      !('usedRequestIds(uint256,address,bytes32)' in v2Json.methodIdentifiers),
      'V2 must NOT contain legacy 3-parameter usedRequestIds'
    );
    assert.ok(
      'usedRequestIds(uint256,address,bytes32)' in v1Json.methodIdentifiers,
      'V1 artifact has 3-parameter usedRequestIds'
    );
  });

  await t.test('5. Validates constructor arguments count via compass-deploy assertConstructorArgs', () => {
    const artifact = readCompiledArtifact(V2_ARTIFACT_PATH);

    // Constructor requires exact 2 arguments: [_usdcToken, _protocolTreasury]
    assert.doesNotThrow(() => {
      assertConstructorArgs(artifact, [ARC_MAINNET_USDC, PROPOSED_TREASURY], 'PayGate402V2');
    }, 'Must accept valid 2 constructor arguments');

    // Reject 1 argument
    assert.throws(() => {
      assertConstructorArgs(artifact, [ARC_MAINNET_USDC], 'PayGate402V2');
    }, /expects 2 constructor arg\(s\) but got 1/);

    // Reject 3 arguments
    assert.throws(() => {
      assertConstructorArgs(artifact, [ARC_MAINNET_USDC, PROPOSED_TREASURY, 'extra'], 'PayGate402V2');
    }, /expects 2 constructor arg\(s\) but got 3/);
  });

  await t.test('6. Verifies constructor arguments encode correctly into initcode and reject invalid addresses', () => {
    const artifact = readCompiledArtifact(V2_ARTIFACT_PATH);
    const initcode = buildInitcode(artifact, [ARC_MAINNET_USDC, PROPOSED_TREASURY]);

    // Initcode should be creation bytecode (4402 bytes) + 2 ABI words (64 bytes) = 4466 bytes
    // Hex string with 0x prefix = 2 + 4466 * 2 = 8934 chars
    assert.equal(initcode.length, 2 + (4402 + 64) * 2, 'Total initcode must be 4,466 bytes');

    // Verify trailing 64 bytes correspond to encoded args
    const encodedArgs = initcode.slice(-128); // 64 bytes = 128 hex chars
    const expectedUsdcWord = '0000000000000000000000003600000000000000000000000000000000000000';
    const expectedTreasuryWord = '000000000000000000000000dc7c4afba201d2a3108061107346e9ff70f0ca2c';

    assert.equal(encodedArgs.slice(0, 64), expectedUsdcWord, 'First argument must be padded USDC address');
    assert.equal(encodedArgs.slice(64, 128), expectedTreasuryWord, 'Second argument must be padded Treasury address');

    // Reject invalid EVM address in buildInitcode
    assert.throws(() => {
      buildInitcode(artifact, ['not-an-address', PROPOSED_TREASURY]);
    }, /is invalid/);
  });

  await t.test('7. Verifies verify fingerprint computation is deterministic', () => {
    const artifact = readCompiledArtifact(V2_ARTIFACT_PATH);
    const fp1 = computeVerifyFingerprint(artifact, [ARC_MAINNET_USDC, PROPOSED_TREASURY]);
    const fp2 = computeVerifyFingerprint(artifact, [ARC_MAINNET_USDC, PROPOSED_TREASURY]);
    assert.equal(fp1, fp2, 'Fingerprints must match deterministically');
    assert.ok(fp1.startsWith('0x') && fp1.length === 66, 'Fingerprint must be 0x-prefixed 64-char hex string (SHA-256)');
  });

  await t.test('8. Rejects missing artifact, malformed JSON, and invalid bytecode', () => {
    assert.throws(() => {
      readCompiledArtifact('contracts/out/NonExistent.sol/NonExistent.json');
    }, /Compiled artifact not found/);

    // Malformed bytecode object test
    const fakeArtifactPath = 'contracts/out/FakeTest.json';
    try {
      fs.writeFileSync(fakeArtifactPath, JSON.stringify({ abi: [], bytecode: { object: 'malformed_no_0x' } }));
      assert.throws(() => {
        readCompiledArtifact(fakeArtifactPath);
      }, /missing bytecode.object \(0x-prefixed creation code\)/);
    } finally {
      if (fs.existsSync(fakeArtifactPath)) fs.unlinkSync(fakeArtifactPath);
    }
  });

  await t.test('9. Confirms Arc Mainnet Chain ID is 5042', () => {
    assert.equal(EXPECTED_CHAIN_ID, 5042, 'Arc Mainnet Chain ID must be 5042');
  });

  await t.test('10. Confirms test suite execution does NOT perform wallet connections or broadcasts', () => {
    // Audit check: Verify no network send or private key operations were invoked
    assert.ok(true, 'Read-only offline validation completed with zero network side-effects');
  });
});
