/*
 * Onchain facts for this app. GENERATED — do not edit.
 *
 * Arc Studio writes this file from its onchain facts registry, so the values here are
 * the ones Arc Studio itself deploys and links against. Edits are overwritten.
 *
 * Import a fact instead of typing one:
 *
 *   import { getUsdc, requireChain, buildTxExplorerUrl } from '@/onchain-facts';
 *
 * A chain's gas token and its ERC-20 USDC are separate facts. On Arc both are
 * USDC, at different decimal counts: 'nativeCurrency' for the gas token,
 * 'usdc' for the ERC-20. Mixing the two is a 10^12 error on a money path.
 */

export const USDC_DECIMALS = 6;

export interface TokenFact {
  symbol: string;
  address: string;
  decimals: number;
}

export interface NativeCurrencyFact {
  symbol: string;
  decimals: number;
  /** True when the gas token IS USDC, which makes 'decimals' above the gas decimals. */
  isUsdc: boolean;
}

export interface OnchainChain {
  chainId: number;
  name: string;
  isTestnet: boolean;
  /** Rollup / alt-EVM family. Absent for an L1 and for a chain in no shared-stack family. */
  family?: string;
  explorerBase: string;
  rpcUrls: string[];
  nativeCurrency: NativeCurrencyFact;
  /** Absent when no USDC contract is deployed on the chain. */
  usdc?: TokenFact;
  cctpDomain?: number;
  /** Circle SCP blockchain enum. Absent unless the deploy tool supports the chain. */
  scpBlockchain?: string;
}

export interface ProtocolContractFact {
  name: string;
  address: string;
  protocol: 'CCTP' | 'Gateway';
  networkKind?: 'testnet' | 'mainnet';
}

interface OnchainFacts {
  chains: OnchainChain[];
  protocolContracts: ProtocolContractFact[];
}

const FACTS: OnchainFacts = {
  "chains": [
    {
      "chainId": 5042,
      "name": "Arc",
      "isTestnet": false,
      "family": "arc",
      "explorerBase": "https://explorer.arc.io",
      "rpcUrls": [
        "https://rpc.mainnet.arc.io"
      ],
      "nativeCurrency": {
        "symbol": "USDC",
        "decimals": 18,
        "isUsdc": true
      },
      "usdc": {
        "symbol": "USDC",
        "address": "0x3600000000000000000000000000000000000000",
        "decimals": 6
      },
      "cctpDomain": 26
    },
    {
      "chainId": 1,
      "name": "Ethereum",
      "isTestnet": false,
      "explorerBase": "https://etherscan.io",
      "rpcUrls": [
        "https://ethereum.reth.rs/rpc"
      ],
      "nativeCurrency": {
        "symbol": "ETH",
        "decimals": 18,
        "isUsdc": false
      },
      "usdc": {
        "symbol": "USDC",
        "address": "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
        "decimals": 6
      }
    },
    {
      "chainId": 8453,
      "name": "Base",
      "isTestnet": false,
      "family": "op-stack",
      "explorerBase": "https://basescan.org",
      "rpcUrls": [
        "https://mainnet.base.org"
      ],
      "nativeCurrency": {
        "symbol": "ETH",
        "decimals": 18,
        "isUsdc": false
      },
      "usdc": {
        "symbol": "USDC",
        "address": "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
        "decimals": 6
      }
    },
    {
      "chainId": 42161,
      "name": "Arbitrum One",
      "isTestnet": false,
      "family": "arbitrum",
      "explorerBase": "https://arbiscan.io",
      "rpcUrls": [
        "https://arb1.arbitrum.io/rpc"
      ],
      "nativeCurrency": {
        "symbol": "ETH",
        "decimals": 18,
        "isUsdc": false
      },
      "usdc": {
        "symbol": "USDC",
        "address": "0xaf88d065e77c8cC2239327C5EDb3A432268e5831",
        "decimals": 6
      }
    },
    {
      "chainId": 137,
      "name": "Polygon PoS",
      "isTestnet": false,
      "family": "polygon",
      "explorerBase": "https://polygonscan.com",
      "rpcUrls": [
        "https://polygon.drpc.org"
      ],
      "nativeCurrency": {
        "symbol": "POL",
        "decimals": 18,
        "isUsdc": false
      },
      "usdc": {
        "symbol": "USDC",
        "address": "0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359",
        "decimals": 6
      }
    },
    {
      "chainId": 43114,
      "name": "Avalanche",
      "isTestnet": false,
      "explorerBase": "https://snowtrace.io",
      "rpcUrls": [
        "https://api.avax.network/ext/bc/C/rpc"
      ],
      "nativeCurrency": {
        "symbol": "AVAX",
        "decimals": 18,
        "isUsdc": false
      },
      "usdc": {
        "symbol": "USDC",
        "address": "0xB97EF9Ef8734C71904D8002F8b6Bc66Dd9c48a6E",
        "decimals": 6
      }
    },
    {
      "chainId": 10,
      "name": "OP Mainnet",
      "isTestnet": false,
      "family": "op-stack",
      "explorerBase": "https://optimistic.etherscan.io",
      "rpcUrls": [
        "https://mainnet.optimism.io"
      ],
      "nativeCurrency": {
        "symbol": "ETH",
        "decimals": 18,
        "isUsdc": false
      },
      "usdc": {
        "symbol": "USDC",
        "address": "0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85",
        "decimals": 6
      }
    },
    {
      "chainId": 56,
      "name": "BSC",
      "isTestnet": false,
      "family": "bsc",
      "explorerBase": "https://bscscan.com",
      "rpcUrls": [
        "https://56.rpc.thirdweb.com"
      ],
      "nativeCurrency": {
        "symbol": "BNB",
        "decimals": 18,
        "isUsdc": false
      }
    },
    {
      "chainId": 81457,
      "name": "Blast",
      "isTestnet": false,
      "family": "blast",
      "explorerBase": "https://blastscan.io",
      "rpcUrls": [
        "https://rpc.blast.io"
      ],
      "nativeCurrency": {
        "symbol": "ETH",
        "decimals": 18,
        "isUsdc": false
      }
    },
    {
      "chainId": 100,
      "name": "Gnosis",
      "isTestnet": false,
      "family": "gnosis",
      "explorerBase": "https://gnosisscan.io",
      "rpcUrls": [
        "https://rpc.gnosischain.com"
      ],
      "nativeCurrency": {
        "symbol": "XDAI",
        "decimals": 18,
        "isUsdc": false
      }
    },
    {
      "chainId": 324,
      "name": "zkSync",
      "isTestnet": false,
      "family": "zksync",
      "explorerBase": "https://explorer.zksync.io",
      "rpcUrls": [
        "https://mainnet.era.zksync.io"
      ],
      "nativeCurrency": {
        "symbol": "ETH",
        "decimals": 18,
        "isUsdc": false
      },
      "usdc": {
        "symbol": "USDC",
        "address": "0x1d17CBcF0D6D143135aE902365D2E5e2A16538D4",
        "decimals": 6
      }
    }
  ],
  "protocolContracts": [
                        {
      "name": "TokenMessengerV2",
      "address": "0x28b5a0e9C621a5BadaA536219b3a228C8168cf5d",
      "protocol": "CCTP",
      "networkKind": "mainnet"
    },
    {
      "name": "MessageTransmitterV2",
      "address": "0x81D40F21F12A8F0E3252Bccb954D722d4c464B64",
      "protocol": "CCTP",
      "networkKind": "mainnet"
    },
    {
      "name": "TokenMinterV2",
      "address": "0xfd78EE919681417d192449715b2594ab58f5D002",
      "protocol": "CCTP",
      "networkKind": "mainnet"
    },
    {
      "name": "MessageV2",
      "address": "0xec546b6B005471ECf012e5aF77FBeC07e0FD8f78",
      "protocol": "CCTP",
      "networkKind": "mainnet"
    },
            {
      "name": "GatewayWallet",
      "address": "0x77777777Dcc4d5A8B6E418Fd04D8997ef11000eE",
      "protocol": "Gateway",
      "networkKind": "mainnet"
    },
    {
      "name": "GatewayMinter",
      "address": "0x2222222d7164433c4C09B0b0D809a9b52C04C205",
      "protocol": "Gateway",
      "networkKind": "mainnet"
    }
  ]
};

export const ONCHAIN_CHAINS: readonly OnchainChain[] = FACTS.chains;

export const TESTNET_ONCHAIN_CHAINS: readonly OnchainChain[] = FACTS.chains.filter((chain) => chain.isTestnet);

/** CCTP and Gateway addresses differ by network kind (see networkKind) — mainnet differs from testnet. */
export const EVM_PROTOCOL_CONTRACTS: readonly ProtocolContractFact[] = FACTS.protocolContracts;

const BY_CHAIN_ID = new Map(ONCHAIN_CHAINS.map((chain) => [chain.chainId, chain]));

const BY_SCP_BLOCKCHAIN = new Map(
  ONCHAIN_CHAINS.flatMap((chain) => (chain.scpBlockchain ? [[chain.scpBlockchain, chain] as const] : [])),
);

export function getChain(chainId: number): OnchainChain | undefined {
  return BY_CHAIN_ID.get(chainId);
}

export function requireChain(chainId: number): OnchainChain {
  const chain = getChain(chainId);

  if (!chain) {
    throw new Error('Unknown chain ID ' + chainId + ' — ask Arc Studio to add it to its onchain facts registry');
  }

  return chain;
}

export function getChainByScpBlockchain(blockchain: string): OnchainChain | undefined {
  return BY_SCP_BLOCKCHAIN.get(blockchain);
}

export function requireChainByScpBlockchain(blockchain: string): OnchainChain {
  const chain = getChainByScpBlockchain(blockchain);

  if (!chain) {
    throw new Error(
      "No chain for SCP blockchain '" + blockchain + "' — ask Arc Studio to add it to its onchain facts registry",
    );
  }

  return chain;
}

export function getUsdc(chainId: number): TokenFact | undefined {
  return getChain(chainId)?.usdc;
}

export function getProtocolContractByName(
  name: string,
  networkKind?: 'testnet' | 'mainnet',
): ProtocolContractFact | undefined {
  const matches = EVM_PROTOCOL_CONTRACTS.filter((contract) => contract.name === name);
  if (matches.length > 1 && networkKind === undefined) {
    throw new Error('"' + name + '" has both a testnet and a mainnet address — pass networkKind to disambiguate');
  }
  return matches.find((contract) => contract.networkKind === undefined || contract.networkKind === networkKind);
}

export function buildAddressExplorerUrl(chainId: number, address: string): string {
  return requireChain(chainId).explorerBase + '/address/' + address;
}

export function buildTxExplorerUrl(chainId: number, txHash: string): string {
  return requireChain(chainId).explorerBase + '/tx/' + txHash;
}
