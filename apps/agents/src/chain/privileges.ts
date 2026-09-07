import { toFunctionSelector, type Hex } from 'viem'

/**
 * What the code can be made to do to a holder.
 *
 * The check is a selector scan of the runtime bytecode. A contract's dispatch
 * table contains the four-byte selector of every external function it exposes,
 * so finding one is strong evidence the function exists — far stronger than
 * asking the contract, which only answers about functions you already guessed,
 * and available with no API key and no verified source.
 *
 * It is evidence, not proof, in both directions, and the report says so: a
 * selector can appear inside an unrelated constant, and a contract can hide
 * privilege behind a fallback that no selector names. What it does do reliably
 * is separate a plain ERC-20 from one with a mint function, which is most of
 * the question.
 *
 * Run against the *implementation* when the address is a proxy. A stub has no
 * dispatch table, so scanning it finds nothing and proves nothing.
 */

export type PrivilegeSeverity = 'critical' | 'high' | 'medium' | 'low'

export type PrivilegeDefinition = {
  signature: string
  label: string
  severity: PrivilegeSeverity
  why: string
}

export const PRIVILEGE_SIGNATURES: readonly PrivilegeDefinition[] = [
  {
    signature: 'mint(address,uint256)',
    label: 'Mint to an arbitrary address',
    severity: 'critical',
    why: 'Whoever holds the right can print supply and sell it into the pool. Every holder is diluted at will.',
  },
  {
    signature: 'mint(uint256)',
    label: 'Mint',
    severity: 'critical',
    why: 'The supply is not fixed. Whatever the token says about scarcity, someone can add to it.',
  },
  {
    signature: 'blacklist(address)',
    label: 'Blacklist an address',
    severity: 'critical',
    why: 'A blacklisted holder cannot sell. This is a honeypot with a switch.',
  },
  {
    signature: 'setBlacklist(address,bool)',
    label: 'Set blacklist status',
    severity: 'critical',
    why: 'A blacklisted holder cannot sell.',
  },
  {
    signature: 'addBlackList(address)',
    label: 'Add to blacklist (Tether-style)',
    severity: 'critical',
    why: 'A blacklisted holder cannot sell.',
  },
  {
    signature: 'setBots(address[],bool)',
    label: 'Flag addresses as bots',
    severity: 'critical',
    why: 'The usual euphemism for a blacklist. Flagged addresses cannot sell.',
  },
  {
    signature: 'pause()',
    label: 'Pause all transfers',
    severity: 'high',
    why: 'Trading can be stopped by the owner at any moment, including while you hold.',
  },
  {
    signature: 'setTradingEnabled(bool)',
    label: 'Toggle trading',
    severity: 'high',
    why: 'Trading is a switch the owner controls.',
  },
  {
    signature: 'enableTrading()',
    label: 'Enable trading',
    severity: 'medium',
    why: 'Trading starts on the owner’s command; before that only they can move tokens.',
  },
  {
    signature: 'setFees(uint256,uint256)',
    label: 'Change fees',
    severity: 'high',
    why: 'The tax you pay to sell can be changed after you buy.',
  },
  {
    signature: 'setTaxes(uint256,uint256,uint256)',
    label: 'Change taxes',
    severity: 'high',
    why: 'The tax you pay to sell can be changed after you buy.',
  },
  {
    signature: 'setFee(uint256)',
    label: 'Change fee',
    severity: 'high',
    why: 'The tax you pay to sell can be changed after you buy.',
  },
  {
    signature: 'setSellTax(uint256)',
    label: 'Change sell tax',
    severity: 'high',
    why: 'The sell tax can be raised to 100% after you buy, which is a honeypot in slow motion.',
  },
  {
    signature: 'setMaxTxAmount(uint256)',
    label: 'Change max transaction size',
    severity: 'medium',
    why: 'A max-transaction limit set to dust stops holders exiting without technically blocking them.',
  },
  {
    signature: 'setMaxWalletAmount(uint256)',
    label: 'Change max wallet size',
    severity: 'medium',
    why: 'Caps how much a holder may keep; can be tightened after the fact.',
  },
  {
    signature: 'excludeFromFee(address)',
    label: 'Exempt an address from fees',
    severity: 'low',
    why: 'Ordinary in fee tokens, but it means insiders can trade on terms holders do not get.',
  },
  {
    signature: 'setExcludedFromFees(address,bool)',
    label: 'Exempt an address from fees',
    severity: 'low',
    why: 'Insiders can trade on terms holders do not get.',
  },
  {
    signature: 'transferOwnership(address)',
    label: 'Transfer ownership',
    severity: 'low',
    why: 'Standard Ownable. Only meaningful alongside the privileges above.',
  },
  {
    signature: 'renounceOwnership()',
    label: 'Renounce ownership',
    severity: 'low',
    why: 'Standard Ownable. Its presence says nothing about whether it was called.',
  },
  {
    signature: 'upgradeTo(address)',
    label: 'Upgrade the implementation',
    severity: 'critical',
    why: 'The code you audited can be replaced with different code, retroactively, at any time.',
  },
  {
    signature: 'upgradeToAndCall(address,bytes)',
    label: 'Upgrade and call',
    severity: 'critical',
    why: 'The code you audited can be replaced with different code at any time.',
  },
  {
    signature: 'burnFrom(address,uint256)',
    label: 'Burn from an arbitrary address',
    severity: 'high',
    why: 'Depending on the access control, a privileged account may be able to destroy your balance.',
  },
  {
    signature: 'setRouter(address)',
    label: 'Change the router',
    severity: 'medium',
    why: 'Redirects where the contract sends its own liquidity and tax proceeds.',
  },
  {
    signature: 'withdrawStuckTokens(address,uint256)',
    label: 'Sweep tokens out of the contract',
    severity: 'medium',
    why: 'Whatever the contract holds — including collected tax — can be taken.',
  },
]

export type PrivilegeFinding = PrivilegeDefinition & {
  selector: Hex
  present: boolean
}

/** Precomputed once: 24 keccaks per analysis is silly. */
const SELECTORS: ReadonlyArray<PrivilegeFinding> = PRIVILEGE_SIGNATURES.map((definition) => ({
  ...definition,
  selector: toFunctionSelector(definition.signature),
  present: false,
}))

export function privilegeSelectors(): ReadonlyArray<Omit<PrivilegeFinding, 'present'>> {
  return SELECTORS.map(({ present: _present, ...rest }) => rest)
}

export type PrivilegeScan = {
  /** The address whose bytecode was scanned. */
  scanned: string
  codeSize: number
  found: PrivilegeFinding[]
  absent: PrivilegeFinding[]
  counts: Record<PrivilegeSeverity, number>
  detail: string
}

export function scanPrivileges(args: { address: string; bytecode: Hex }): PrivilegeScan {
  const hex = args.bytecode.toLowerCase()
  const codeSize = Math.max(0, (hex.length - 2) / 2)

  const found: PrivilegeFinding[] = []
  const absent: PrivilegeFinding[] = []
  for (const entry of SELECTORS) {
    const present = hex.includes(entry.selector.slice(2).toLowerCase())
    ;(present ? found : absent).push({ ...entry, present })
  }

  const counts: Record<PrivilegeSeverity, number> = { critical: 0, high: 0, medium: 0, low: 0 }
  for (const finding of found) counts[finding.severity] += 1

  return {
    scanned: args.address,
    codeSize,
    found,
    absent,
    counts,
    detail:
      codeSize === 0
        ? `${args.address} has no bytecode to scan.`
        : `Scanned ${codeSize} bytes at ${args.address} for ${SELECTORS.length} privileged ` +
          `selectors: ${found.length} present (${counts.critical} critical, ${counts.high} high, ` +
          `${counts.medium} medium, ${counts.low} low).`,
  }
}

/**
 * Contracts the token itself names, and who owns them.
 *
 * A token can be renounced and still be controlled, because the privilege
 * lives one hop away: a `taxProcessor` or a `dividendContract` with its own
 * non-renounced owner is a real privilege surface, and a scan that stops at
 * the token address cannot see it. An independent review found exactly that on
 * a token this agent had already called clean at the token level.
 *
 * The getters below are the ones that appear in the wild. Each is tried, and
 * anything that answers with a contract address is followed and its ownership
 * read.
 */
export const AUXILIARY_GETTERS = [
  'taxProcessor',
  'dividendContract',
  'dividendTracker',
  'treasury',
  'marketingWallet',
  'feeReceiver',
  'rewardToken',
  'swapRouter',
  'router',
  'pair',
] as const

export const auxiliaryGetterAbi = AUXILIARY_GETTERS.map((name) => ({
  type: 'function' as const,
  name,
  stateMutability: 'view' as const,
  inputs: [],
  outputs: [{ name: '', type: 'address' as const }],
}))
