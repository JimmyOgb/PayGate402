#!/usr/bin/env node
/**
 * Ensures required contract ABI artifacts exist in contracts/out/
 * for environments without a local Foundry/solc toolchain (e.g. Render).
 * Uses the tracked, authoritative contracts/contract-metadata/PayGate402.json.
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const rootDir = path.resolve(__dirname, '..')

const targetDir = path.join(rootDir, 'contracts', 'out', 'PayGate402.sol')
const targetFile = path.join(targetDir, 'PayGate402.json')
const sourceFile = path.join(rootDir, 'contracts', 'contract-metadata', 'PayGate402.json')

export function ensureArtifacts() {
  // Do not overwrite an existing valid artifact unnecessarily
  if (fs.existsSync(targetFile)) {
    try {
      const existing = JSON.parse(fs.readFileSync(targetFile, 'utf8'))
      if (Array.isArray(existing.abi) && existing.abi.length > 0) {
        return
      }
    } catch {
      // Re-generate if malformed
    }
  }

  if (!fs.existsSync(sourceFile)) {
    console.error(`[ensure-artifacts] Authoritative metadata not found at ${sourceFile}`)
    process.exit(1)
  }

  let meta
  try {
    meta = JSON.parse(fs.readFileSync(sourceFile, 'utf8'))
  } catch (err) {
    console.error(`[ensure-artifacts] Failed to parse ${sourceFile}:`, err)
    process.exit(1)
  }

  if (!Array.isArray(meta.abi) || meta.abi.length === 0) {
    console.error(`[ensure-artifacts] Metadata at ${sourceFile} contains an invalid or empty ABI array`)
    process.exit(1)
  }

  // Create the expected parent directory when missing
  fs.mkdirSync(targetDir, { recursive: true })

  // Write only the authoritative ABI without bytecode or fabricated data
  fs.writeFileSync(
    targetFile,
    JSON.stringify({ abi: meta.abi, contractName: 'PayGate402' }, null, 2),
    'utf8'
  )
  console.log(`[ensure-artifacts] Restored PayGate402 ABI artifact at ${targetFile}`)
}

ensureArtifacts()
