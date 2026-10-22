#!/usr/bin/env python3
"""
Deterministic V2 Artifact Generator for PayGate402V2.
Compiles contracts/PayGate402V2.sol using the verified local solc 0.8.28 compiler
and emits a canonical Foundry-compatible artifact at:
contracts/out/PayGate402V2.sol/PayGate402V2.json
"""

import os
import sys
import json
import hashlib
import subprocess

SOLC_0828 = os.environ.get("SOLC_PATH") or os.path.expanduser(r"~/.solcx/solc-v0.8.28/solc.exe")
SOURCE_PATH = "contracts/PayGate402V2.sol"
OUTPUT_DIR = "contracts/out/PayGate402V2.sol"
OUTPUT_FILE = os.path.join(OUTPUT_DIR, "PayGate402V2.json")

EXPECTED_CREATION_SHA256 = "5a2d290dbf76e5a2308d71f2539cddb699a6a7af11341471414144c917490413"
EXPECTED_RUNTIME_SHA256 = "80a16f4a4a7316a9fc7906ffe3c35334eb7df07db0d1201fbc9bd644786a9ce3"
EXPECTED_CREATION_BYTES = 4402
EXPECTED_RUNTIME_BYTES = 4026

def compute_sha256(data_bytes):
    return hashlib.sha256(data_bytes).hexdigest()

def main():
    print("=" * 70)
    print("PayGate402V2 — Deterministic Artifact Generator")
    print("=" * 70)

    if not os.path.isfile(SOLC_0828):
        print(f"FATAL: solc 0.8.28 executable not found at: {SOLC_0828}")
        sys.exit(1)

    # Verify solc version
    ver_res = subprocess.run([SOLC_0828, "--version"], capture_output=True, text=True, check=True)
    ver_str = ver_res.stdout.strip()
    print(f"Compiler: {ver_str.splitlines()[-1] if ver_str else 'Unknown'}")
    print(f"Source:   {SOURCE_PATH}")

    with open(SOURCE_PATH, "r", encoding="utf-8") as f:
        source_code = f.read()

    source_hash = compute_sha256(source_code.encode("utf-8"))
    print(f"Source SHA-256: {source_hash}")

    standard_json_input = {
        "language": "Solidity",
        "sources": {
            SOURCE_PATH: {
                "content": source_code
            }
        },
        "settings": {
            "optimizer": {
                "enabled": True,
                "runs": 200
            },
            "evmVersion": "paris",
            "remappings": [
                "@openzeppelin/=node_modules/@openzeppelin/"
            ],
            "outputSelection": {
                "*": {
                    "*": [
                        "abi",
                        "evm.bytecode",
                        "evm.deployedBytecode",
                        "evm.methodIdentifiers",
                        "metadata"
                    ]
                }
            }
        }
    }

    print("\nCompiling via solc --standard-json (paris EVM, optimizer=200)...")
    proc = subprocess.Popen(
        [SOLC_0828, "--standard-json"],
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True
    )
    stdout, stderr = proc.communicate(input=json.dumps(standard_json_input))
    if proc.returncode != 0:
        print(f"FATAL: Compiler exited with code {proc.returncode}")
        print(stderr)
        sys.exit(proc.returncode)

    res = json.loads(stdout)
    errors = res.get("errors", [])
    has_fatal = False
    for err in errors:
        sev = err.get("severity", "error")
        msg = err.get("formattedMessage", "")
        print(f"[{sev.upper()}] {msg}")
        if sev == "error":
            has_fatal = True
    if has_fatal:
        sys.exit(1)

    contract_data = res.get("contracts", {}).get(SOURCE_PATH, {}).get("PayGate402V2")
    if not contract_data:
        print(f"FATAL: PayGate402V2 not found in compiler output.")
        sys.exit(1)

    abi = contract_data["abi"]
    creation_hex = contract_data["evm"]["bytecode"]["object"]
    runtime_hex = contract_data["evm"]["deployedBytecode"]["object"]
    method_ids = contract_data["evm"]["methodIdentifiers"]
    raw_metadata = contract_data.get("metadata", "")
    metadata = json.loads(raw_metadata) if isinstance(raw_metadata, str) and raw_metadata else raw_metadata

    creation_bytes = bytes.fromhex(creation_hex)
    runtime_bytes = bytes.fromhex(runtime_hex)

    creation_sha256 = compute_sha256(creation_bytes)
    runtime_sha256 = compute_sha256(runtime_bytes)

    print(f"\nArtifact Bytecode Verification:")
    print(f"  Creation Bytes: {len(creation_bytes)} (Expected: {EXPECTED_CREATION_BYTES})")
    print(f"  Creation SHA-256: {creation_sha256}")
    print(f"  Runtime Bytes:  {len(runtime_bytes)} (Expected: {EXPECTED_RUNTIME_BYTES})")
    print(f"  Runtime SHA-256:  {runtime_sha256}")

    if creation_sha256 != EXPECTED_CREATION_SHA256:
        print(f"FATAL: Creation bytecode SHA-256 mismatch!")
        sys.exit(1)
    if runtime_sha256 != EXPECTED_RUNTIME_SHA256:
        print(f"FATAL: Runtime bytecode SHA-256 mismatch!")
        sys.exit(1)

    # Check for unlinked library placeholders
    if "__" in creation_hex or "__" in runtime_hex:
        print("FATAL: Unresolved library placeholder detected in bytecode!")
        sys.exit(1)

    # Assemble Foundry-compatible artifact
    foundry_artifact = {
        "abi": abi,
        "bytecode": {
            "object": "0x" + creation_hex,
            "sourceMap": contract_data["evm"]["bytecode"].get("sourceMap", ""),
            "linkReferences": contract_data["evm"]["bytecode"].get("linkReferences", {})
        },
        "deployedBytecode": {
            "object": "0x" + runtime_hex,
            "sourceMap": contract_data["evm"]["deployedBytecode"].get("sourceMap", ""),
            "linkReferences": contract_data["evm"]["deployedBytecode"].get("linkReferences", {}),
            "immutableReferences": contract_data["evm"]["deployedBytecode"].get("immutableReferences", {})
        },
        "methodIdentifiers": method_ids,
        "rawMetadata": raw_metadata,
        "metadata": metadata
    }

    os.makedirs(OUTPUT_DIR, exist_ok=True)
    with open(OUTPUT_FILE, "w", encoding="utf-8") as f:
        json.dump(foundry_artifact, f, indent=2)

    artifact_file_bytes = os.path.getsize(OUTPUT_FILE)
    artifact_file_hash = compute_sha256(open(OUTPUT_FILE, "rb").read())

    print(f"\nArtifact successfully generated:")
    print(f"  Destination: {OUTPUT_FILE}")
    print(f"  File Size:   {artifact_file_bytes:,} bytes")
    print(f"  File SHA-256:{artifact_file_hash}")
    print("=" * 70)
    print("STATUS: V2 ARTIFACT GENERATED AND VERIFIED")
    print("=" * 70)

if __name__ == "__main__":
    main()
