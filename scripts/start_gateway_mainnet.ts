import { startGateway } from '../src/gateway/index.ts'
import {
  ARC_MAINNET_CHAIN_ID,
  ARC_MAINNET_PAYGATE_CONTRACT,
  ARC_MAINNET_RPC,
  USDC_TOKEN_ADDRESS,
} from '../src/gateway/types.ts'

console.log('[PayGate402] Launching Arc Mainnet Gateway on port 4020...')

const gateway = startGateway({
  chainId: ARC_MAINNET_CHAIN_ID,
  contractAddress: ARC_MAINNET_PAYGATE_CONTRACT,
  rpcUrl: ARC_MAINNET_RPC,
  usdcAddress: USDC_TOKEN_ADDRESS,
  port: 4020,
  mockRpc: false,
  upstreamMode: 'real_metrics',
})

// Maintain process lifecycle and graceful teardown
process.on('SIGINT', async () => {
  console.log('[PayGate402] Gateway stopping on SIGINT...')
  await gateway.close()
  process.exit(0)
})

process.on('SIGTERM', async () => {
  console.log('[PayGate402] Gateway stopping on SIGTERM...')
  await gateway.close()
  process.exit(0)
})
