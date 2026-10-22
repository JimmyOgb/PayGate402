/**
 * PayGate402 Authoritative Arc Mainnet Network Configuration
 * Production configuration strictly enforces Arc Mainnet (Chain ID 5042).
 */

export const ARC_MAINNET_CHAIN_ID = 5042 as const
export const ARC_TESTNET_CHAIN_ID = 5042002 as const

// Mainnet PayGate402 contract address — deployed & verified on Arc Mainnet in Stage 8.17
export const PAYGATE402_MAINNET_ADDRESS = '0xa27e390CC82793911D805D4cB3E0c50F2117C77A' as const
export const PROTOCOL_TREASURY_MAINNET_ADDRESS = '0xDc7c4aFBa201D2a3108061107346e9ff70f0Ca2c' as const
export const USDC_MAINNET_ADDRESS = '0x3600000000000000000000000000000000000000' as const

// Backward-compatibility references for test harness compatibility
export const PAYGATE402_TESTNET_ADDRESS = '0xcc69506b784dffda4ee4d221b122303304099971' as const
export const PROTOCOL_TREASURY_TESTNET_ADDRESS = '0x5B12Ce46C7194aD57d143bC22847224047b1Ef42' as const

export interface NetworkConfig {
  chainId: number
  chainName: string
  contractAddress: string
  treasuryAddress: string
  usdcAddress: string
  explorerBase: string
  isDeployed: boolean
  isMainnet: boolean
}

export function getNetworkConfig(chainId?: number): NetworkConfig {
  // If chainId is 5042002 explicitly requested in isolated test harnesses, handle gracefully
  if (chainId === ARC_TESTNET_CHAIN_ID) {
    return {
      chainId: ARC_TESTNET_CHAIN_ID,
      chainName: 'Arc Testnet',
      contractAddress: PAYGATE402_TESTNET_ADDRESS,
      treasuryAddress: PROTOCOL_TREASURY_TESTNET_ADDRESS,
      usdcAddress: USDC_MAINNET_ADDRESS,
      explorerBase: 'https://explorer.testnet.arc.io',
      isDeployed: true,
      isMainnet: false,
    }
  }

  // Authoritative default is strictly Arc Mainnet (5042)
  return {
    chainId: ARC_MAINNET_CHAIN_ID,
    chainName: 'Arc',
    contractAddress: PAYGATE402_MAINNET_ADDRESS,
    treasuryAddress: PROTOCOL_TREASURY_MAINNET_ADDRESS,
    usdcAddress: USDC_MAINNET_ADDRESS,
    explorerBase: 'https://explorer.arc.io',
    isDeployed: true,
    isMainnet: true,
  }
}
