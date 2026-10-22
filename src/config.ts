/**
 * wagmi configuration — Arc Mainnet Authoritative Production
 * Built with Arc Studio — https://studio.arc.io
 * Configures strictly Arc Mainnet (Chain ID 5042).
 */

import { http, createConfig } from 'wagmi'
import { defineChain } from 'viem'
import { injected } from 'wagmi/connectors'

export const arcMainnet = defineChain({
  id: 5042,
  name: 'Arc',
  nativeCurrency: {
    name: 'USDC',
    symbol: 'USDC',
    decimals: 18,
  },
  rpcUrls: {
    default: {
      http: ['https://rpc.mainnet.arc.io'],
    },
  },
  blockExplorers: {
    default: {
      name: 'Arc Explorer',
      url: 'https://explorer.arc.io',
    },
  },
})

export const config = createConfig({
  chains: [arcMainnet],
  connectors: [injected()],
  transports: {
    [arcMainnet.id]: http('https://rpc.mainnet.arc.io'),
  },
})
