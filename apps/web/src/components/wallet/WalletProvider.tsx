'use client'

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react'
import {
  createWalletClient,
  custom,
  type Address,
  type EIP1193Provider,
  type Hex,
  type WalletClient,
} from 'viem'
import { bsc, bscTestnet } from 'viem/chains'

/**
 * Wallet connection, hand-rolled on EIP-1193 and EIP-6963.
 *
 * Deliberately not a connector kit. Everything the app needs is three RPC
 * methods and one event, and a kit would bring its own modal, its own theme
 * and its own opinions about layout — all of which would have to be fought
 * during the visual pass. This is about two hundred lines and owns nothing
 * visual.
 *
 * EIP-6963 is the discovery mechanism: wallets announce themselves and we
 * collect them, which is what makes a browser with three extensions installed
 * work at all. `window.ethereum` remains as a fallback for wallets that have
 * not shipped 6963 yet.
 *
 * What this deliberately does NOT do: hold a key, sign anything on its own, or
 * remember a connection across reloads without the wallet's consent. Every
 * transaction is initiated by an explicit user action in the page.
 */

type Eip6963ProviderInfo = {
  uuid: string
  name: string
  icon: string
  rdns: string
}

type Eip6963ProviderDetail = {
  info: Eip6963ProviderInfo
  provider: EIP1193Provider
}

export type WalletStatus = 'unavailable' | 'disconnected' | 'connecting' | 'connected'

export type WalletState = {
  status: WalletStatus
  address: Address | null
  chainId: number | null
  /** Every wallet that announced itself, for the picker. */
  available: Eip6963ProviderInfo[]
  /** Which one is connected. */
  activeRdns: string | null
  error: string | null
}

export type WalletActions = {
  connect(rdns?: string): Promise<void>
  disconnect(): void
  switchChain(chainId: number): Promise<boolean>
  /** A viem wallet client for the connected account, or null. */
  getWalletClient(chainId: number): WalletClient | null
  clearError(): void
}

const WalletContext = createContext<(WalletState & WalletActions) | null>(null)

const CHAINS = { 56: bsc, 97: bscTestnet } as const

export function WalletProvider({ children }: { children: ReactNode }) {
  const [details, setDetails] = useState<Eip6963ProviderDetail[]>([])
  const [active, setActive] = useState<Eip6963ProviderDetail | null>(null)
  const [address, setAddress] = useState<Address | null>(null)
  const [chainId, setChainId] = useState<number | null>(null)
  const [connecting, setConnecting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // --- discovery ----------------------------------------------------------
  useEffect(() => {
    const seen = new Map<string, Eip6963ProviderDetail>()

    const onAnnounce = (event: Event) => {
      const detail = (event as CustomEvent<Eip6963ProviderDetail>).detail
      if (detail?.info?.rdns === undefined) return
      if (seen.has(detail.info.rdns)) return
      seen.set(detail.info.rdns, detail)
      setDetails([...seen.values()])
    }

    window.addEventListener('eip6963:announceProvider', onAnnounce)
    window.dispatchEvent(new Event('eip6963:requestProvider'))

    // Wallets that predate 6963 only ever appear on window.ethereum.
    const legacy = (window as { ethereum?: EIP1193Provider }).ethereum
    if (legacy !== undefined && seen.size === 0) {
      const detail: Eip6963ProviderDetail = {
        info: {
          uuid: 'legacy',
          name: 'Browser wallet',
          icon: '',
          rdns: 'legacy.injected',
        },
        provider: legacy,
      }
      seen.set(detail.info.rdns, detail)
      setDetails([...seen.values()])
    }

    return () => window.removeEventListener('eip6963:announceProvider', onAnnounce)
  }, [])

  // --- account and chain tracking ------------------------------------------
  useEffect(() => {
    const provider = active?.provider
    if (provider === undefined) return

    const onAccounts = (accounts: unknown) => {
      const list = Array.isArray(accounts) ? (accounts as Address[]) : []
      const first = list[0]
      if (first === undefined) {
        setAddress(null)
        setActive(null)
      } else {
        setAddress(first)
      }
    }

    const onChain = (value: unknown) => {
      const parsed = typeof value === 'string' ? Number.parseInt(value, 16) : Number(value)
      setChainId(Number.isFinite(parsed) ? parsed : null)
    }

    provider.on('accountsChanged', onAccounts)
    provider.on('chainChanged', onChain)

    return () => {
      provider.removeListener('accountsChanged', onAccounts)
      provider.removeListener('chainChanged', onChain)
    }
  }, [active])

  const connect = useCallback(
    async (rdns?: string) => {
      setError(null)
      const detail =
        (rdns === undefined ? details[0] : details.find((item) => item.info.rdns === rdns)) ?? null

      if (detail === null) {
        setError(
          'No browser wallet announced itself. Install one, or use the sponsored demo hire — it needs no wallet at all.',
        )
        return
      }

      setConnecting(true)
      try {
        const accounts = (await detail.provider.request({
          method: 'eth_requestAccounts',
        })) as Address[]
        const first = accounts[0]
        if (first === undefined) {
          setError('The wallet returned no accounts.')
          return
        }
        const rawChain = (await detail.provider.request({ method: 'eth_chainId' })) as string
        setActive(detail)
        setAddress(first)
        setChainId(Number.parseInt(rawChain, 16))
      } catch (cause) {
        setError(describeWalletError(cause))
      } finally {
        setConnecting(false)
      }
    },
    [details],
  )

  const disconnect = useCallback(() => {
    // EIP-1193 has no disconnect. Dropping our reference is the honest thing:
    // the wallet still knows about the site, and pretending otherwise would be
    // a lie about a permission the user has actually granted.
    setActive(null)
    setAddress(null)
    setChainId(null)
    setError(null)
  }, [])

  const switchChain = useCallback(
    async (target: number): Promise<boolean> => {
      const provider = active?.provider
      if (provider === undefined) return false
      const chain = CHAINS[target as 56 | 97]
      if (chain === undefined) return false

      const hexId = `0x${target.toString(16)}` as Hex
      try {
        await provider.request({
          method: 'wallet_switchEthereumChain',
          params: [{ chainId: hexId }],
        })
        setChainId(target)
        return true
      } catch (cause) {
        // 4902: the wallet does not know this chain yet. Offer to add it.
        const code = (cause as { code?: number })?.code
        if (code === 4902) {
          try {
            await provider.request({
              method: 'wallet_addEthereumChain',
              params: [
                {
                  chainId: hexId,
                  chainName: chain.name,
                  nativeCurrency: chain.nativeCurrency,
                  rpcUrls: [...chain.rpcUrls.default.http],
                  blockExplorerUrls: [chain.blockExplorers?.default.url ?? ''],
                },
              ],
            })
            setChainId(target)
            return true
          } catch (addCause) {
            setError(describeWalletError(addCause))
            return false
          }
        }
        setError(describeWalletError(cause))
        return false
      }
    },
    [active],
  )

  const getWalletClient = useCallback(
    (target: number): WalletClient | null => {
      const provider = active?.provider
      if (provider === undefined || address === null) return null
      const chain = CHAINS[target as 56 | 97]
      if (chain === undefined) return null
      return createWalletClient({ account: address, chain, transport: custom(provider) })
    },
    [active, address],
  )

  const status: WalletStatus = useMemo(() => {
    if (details.length === 0) return 'unavailable'
    if (connecting) return 'connecting'
    if (address !== null) return 'connected'
    return 'disconnected'
  }, [details.length, connecting, address])

  const value = useMemo(
    () => ({
      status,
      address,
      chainId,
      available: details.map((detail) => detail.info),
      activeRdns: active?.info.rdns ?? null,
      error,
      connect,
      disconnect,
      switchChain,
      getWalletClient,
      clearError: () => setError(null),
    }),
    [status, address, chainId, details, active, error, connect, disconnect, switchChain, getWalletClient],
  )

  return <WalletContext.Provider value={value}>{children}</WalletContext.Provider>
}

export function useWallet(): WalletState & WalletActions {
  const context = useContext(WalletContext)
  if (context === null) {
    throw new Error('useWallet must be used inside <WalletProvider>')
  }
  return context
}

/**
 * Turn a provider rejection into something a person can act on.
 *
 * Wallets report user cancellation as an error, which it is not — it is a
 * decision. Saying "you cancelled" beats "Error: user rejected the request".
 */
export function describeWalletError(cause: unknown): string {
  const code = (cause as { code?: number })?.code
  if (code === 4001) return 'You cancelled the request in your wallet. Nothing was sent.'
  if (code === 4100) return 'Your wallet has not authorised this account for this site.'
  if (code === -32002) {
    return 'Your wallet already has a pending request. Open it and finish that one first.'
  }
  const message =
    (cause as { shortMessage?: string })?.shortMessage ??
    (cause instanceof Error ? cause.message : String(cause))
  return message.split('\n')[0] ?? 'The wallet request failed.'
}
