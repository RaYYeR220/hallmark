import type { Chain } from 'viem'
import { bsc, bscTestnet } from 'viem/chains'

export type Address = `0x${string}`

export const SUPPORTED_CHAIN_IDS = [56, 97] as const

export type SupportedChainId = (typeof SUPPORTED_CHAIN_IDS)[number]

/** ERC-8004 registries plus the Altana commerce/session-key stack. */
export type ProtocolContracts = {
  identityRegistry: Address
  reputationRegistry: Address
  validationRegistry: Address
  altanaCommerce: Address
  altanaEvaluatorRouter: Address
  altanaOptimisticPolicy: Address
  altanaKeyStore: Address
  altanaKeyStoreController: Address
  /** $U — United Stables, 18 decimals. Settlement asset for escrow jobs. */
  uToken: Address
  /** Testnet only: `requestTokens()` hands out 10 $U per call. */
  uTokenFaucet: Address | null
}

/** Protocols the marketplace agents actually transact against. */
export type DefiContracts = {
  pancakeV3PositionManager: Address
  pancakeV3Factory: Address
  pancakeV3SwapRouter: Address
  pancakeQuoterV2: Address
  venusComptroller: Address
  venusVBnb: Address
  venusVUsdt: Address
  /** Aave V3 is mainnet only on BNB Chain. */
  aavePool: Address | null
  aaveDataProvider: Address | null
  multicall3: Address
}

export type ChainlinkFeeds = {
  bnbUsd: Address
  btcUsd: Address
  ethUsd: Address
  cakeUsd: Address
}

export type HallmarkChain = {
  id: SupportedChainId
  chain: Chain
  name: string
  testnet: boolean
  rpcUrl: string
  explorer: string
  altanaRelay: string
  altanaExplorer: string
  contracts: ProtocolContracts
  defi: DefiContracts
  chainlink: ChainlinkFeeds
}

export const U_TOKEN = {
  symbol: '$U',
  name: 'United Stables',
  decimals: 18,
} as const

const MULTICALL3: Address = '0xca11bde05977b3631167028862be2a173976ca11'
const PANCAKE_V3_FACTORY: Address = '0x0BFbCF9fa4f9C56B0F40a671Ad40E0805A091865'
const PANCAKE_V3_SWAP_ROUTER: Address = '0x1b81D678ffb9C0263b24A97847620C99d213eB14'

const bscMainnet: HallmarkChain = {
  id: 56,
  chain: bsc,
  name: 'BNB Smart Chain',
  testnet: false,
  rpcUrl: 'https://bsc-rpc.publicnode.com',
  explorer: 'https://bscscan.com',
  altanaRelay: 'https://relay.altana.network',
  altanaExplorer: 'https://explorer.altana.network',
  contracts: {
    identityRegistry: '0x8004A169FB4a3325136EB29fA0ceB6D2e539a432',
    reputationRegistry: '0x8004BAa17C55a88189AE136b182e5fdA19dE9b63',
    validationRegistry: '0x8004Cc8439f36fd5F9F049D9fF86523Df6dAAB58',
    altanaCommerce: '0xEa4DAa3100A767e86FDed867729ae7446476EBA6',
    altanaEvaluatorRouter: '0x51895229E12F9876011789B04f8698af06cCD6DA',
    altanaOptimisticPolicy: '0x9C01845705b3078Aa2e8cfF7520a6376FD766dE5',
    altanaKeyStore: '0x6572427ED530BadcF7375Cf9A4709D8d2b0E7E0a',
    altanaKeyStoreController: '0x0834Ee2C9BdC3E3efF0a2dC34393D4B0e546A555',
    uToken: '0xcE24439F2D9C6a2289F741120FE202248B666666',
    uTokenFaucet: null,
  },
  defi: {
    pancakeV3PositionManager: '0x46A15B0b27311cedF172AB29E4f4766fbE7F4364',
    pancakeV3Factory: PANCAKE_V3_FACTORY,
    pancakeV3SwapRouter: PANCAKE_V3_SWAP_ROUTER,
    pancakeQuoterV2: '0xB048Bbc1Ee6b733FFfCFb9e9CeF7375518e25997',
    venusComptroller: '0xfD36E2c2a6789Db23113685031d7F16329158384',
    venusVBnb: '0xA07c5b74C9B40447a954e1466938b865b6BBea36',
    venusVUsdt: '0xfD5840Cd36d94D7229439859C0112a4185BC0255',
    aavePool: '0x6807dc923806fE8Fd134338EABCA509979a7e0cB',
    aaveDataProvider: '0xc90Df74A7c16245c5F5C5870327Ceb38Fe5d5328',
    multicall3: MULTICALL3,
  },
  chainlink: {
    bnbUsd: '0x0567F2323251f0Aab15c8dFb1967E4e8A7D42aeE',
    btcUsd: '0x264990fbd0A4796A3E3d8E37C4d5F87a3aCa5Ebf',
    ethUsd: '0x9ef1B8c0E4F7dc8bF5719Ea496883DC6401d5b2e',
    cakeUsd: '0xB6064eD41d4f67e353768aA239cA86f4F73665a1',
  },
}

const bscTest: HallmarkChain = {
  id: 97,
  chain: bscTestnet,
  name: 'BNB Smart Chain Testnet',
  testnet: true,
  rpcUrl: 'https://bsc-testnet-rpc.publicnode.com',
  explorer: 'https://testnet.bscscan.com',
  altanaRelay: 'https://testnet-relay.altana.network',
  altanaExplorer: 'https://testnet.altana.network',
  contracts: {
    identityRegistry: '0x8004A818BFB912233c491871b3d84c89A494BD9e',
    reputationRegistry: '0x8004B663056A597Dffe9eCcC1965A193B7388713',
    validationRegistry: '0x8004Cb1BF31DAf7788923b405b754f57acEB4272',
    altanaCommerce: '0xa206c0517B6371C6638CD9e4a42Cc9f02A33B0DE',
    altanaEvaluatorRouter: '0xD7d36D66d2F1B608A0F943f722D27e3744f66F25',
    altanaOptimisticPolicy: '0xd6a4217588F6B1F5657a92A3e94E6422aD771cEA',
    altanaKeyStore: '0x6b8361C29d05D498b1a12B54A37310f94171E94A',
    altanaKeyStoreController: '0xb530D1971f5453F3359518343F05D0AedFfF7e12',
    uToken: '0xc70B8741B8B07A6d61E54fd4B20f22Fa648E5565',
    uTokenFaucet: '0x86e9197CC0F76E4e4aaa7082180945196bBAb5D3',
  },
  defi: {
    pancakeV3PositionManager: '0x427bF5b37357632377eCbEC9de3626C71A5396c1',
    pancakeV3Factory: PANCAKE_V3_FACTORY,
    pancakeV3SwapRouter: PANCAKE_V3_SWAP_ROUTER,
    pancakeQuoterV2: '0xbC203d7f83677c7ed3F7acEc959963E7F4ECC5C2',
    venusComptroller: '0x94d1820b2D1c7c7452A163983Dc888CEC546b77D',
    venusVBnb: '0x2E7222e51c0f6e98610A1543Aa3836E092CDe62c',
    venusVUsdt: '0xb7526572FFE56AB9D7489838Bf2E18e3323b441A',
    aavePool: null,
    aaveDataProvider: null,
    multicall3: MULTICALL3,
  },
  chainlink: {
    bnbUsd: '0x2514895c72f50D8bd4B4F9b1110F0D6bD2c97526',
    btcUsd: '0x5741306c21795FdCBb9b265Ea0255F499DFe515C',
    ethUsd: '0x143db3CEEfbdfe5631aDD3E50f7614B6ba708BA7',
    cakeUsd: '0x81faeDDfeBc2F8Ac524327d70Cf913001732224C',
  },
}

export const CHAINS: Record<SupportedChainId, HallmarkChain> = {
  56: bscMainnet,
  97: bscTest,
}

export function isSupportedChainId(chainId: number): chainId is SupportedChainId {
  return chainId === 56 || chainId === 97
}

export function getChain(chainId: number): HallmarkChain {
  if (!isSupportedChainId(chainId)) {
    throw new Error(`Unsupported chain id ${chainId}; expected one of ${SUPPORTED_CHAIN_IDS.join(', ')}`)
  }
  return CHAINS[chainId]
}

export function txUrl(chainId: number, hash: string): string {
  return `${getChain(chainId).explorer}/tx/${hash}`
}

export function addressUrl(chainId: number, address: string): string {
  return `${getChain(chainId).explorer}/address/${address}`
}

/** CAIP-10 account id, the form ERC-8004 registration files use for wallets and registries. */
export function caip10(chainId: number, address: string): string {
  return `eip155:${chainId}:${address}`
}
