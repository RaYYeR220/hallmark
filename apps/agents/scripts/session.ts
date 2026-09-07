/**
 * The session-key lifecycle, end to end, on BNB Chain testnet.
 *
 * This script exists to turn Hallmark's central claim from a design into an
 * artifact. The claim is: *the agent proposes, the session key constrains, the
 * chain enforces.* Everything else in this app demonstrates the first half in
 * software. This demonstrates the second half on chain:
 *
 *   1. `grant`   a real Altana session, scoped by `venusHealthFactorPolicy`
 *   2. `act`     one real transaction through it, with a hash
 *   3. `refuse`  an over-cap spend and an off-allowlist call, both refused
 *   4. `revoke`  the key, in one transaction
 *   5. `verify`  the Keystore flipping to false, read with plain viem
 *
 * `venusHealthFactorPolicy` is the right policy to demonstrate with because it
 * is the only selector-scoped one, and `borrow` is absent from it. So the
 * refusal in step 3 is not a contrived example: it is the agent being told it
 * may not lever a position up, by the account contract, on chain.
 *
 * Nothing here touches mainnet. The chain id is fixed at 97 and the script
 * refuses to run against 56.
 *
 *   pnpm session address     # generate/report the wallet to fund
 *   pnpm session status      # balances, live Keystore fee, current key state
 *   pnpm session grant
 *   pnpm session act
 *   pnpm session refuse
 *   pnpm session revoke
 *   pnpm session verify
 *   pnpm session all         # 2-7 in order, pausing for nothing
 *
 * Keys come from `.env.session` (gitignored) and are generated on first run.
 * `HALLMARK_ADMIN_KEY` may instead be set in the environment to use an
 * existing funded wallet.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import {
  createPublicClient,
  encodeFunctionData,
  formatEther,
  http,
  keccak256,
  parseEther,
  type Address,
  type Hex,
} from 'viem'
import { bscTestnet } from 'viem/chains'
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts'
import { getChain } from '@hallmark/core'
import {
  createAgentWallet,
  describePolicy,
  estimateGrantCostWei,
  executeWithSession,
  grantAgentSession,
  restoreSessionFromKey,
  revokeAgentSession,
  signerFromPrivateKey,
  venusHealthFactorPolicy,
  type AgentPolicy,
  type ExecuteOutcome,
  type SerializedSession,
  type Session,
} from '@hallmark/altana'

import { vBnbAbi, vTokenErc20Abi } from '../src/chain/abis.js'

/** Testnet only. A typo that reached mainnet would spend a committed budget. */
const CHAIN_ID = 97 as const
const chain = getChain(CHAIN_ID)

const ENV_PATH = new URL('../.env.session', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')
const STATE_PATH = new URL('../.session/testnet-97.json', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')

const KEYSTORE_ABI = [
  {
    name: 'isValidKey',
    type: 'function',
    stateMutability: 'view',
    inputs: [
      { name: 'user', type: 'address' },
      { name: 'keyId', type: 'bytes32' },
    ],
    outputs: [{ type: 'bool' }],
  },
] as const

// ---------------------------------------------------------------------------
// Key and state storage
// ---------------------------------------------------------------------------

type Keys = { adminKey: Hex; sessionKey: Hex }

type State = {
  chainId: number
  walletAddress: Address
  sessionPublicKey: Hex
  keyId: Hex
  expiresAt: number
  serialized: SerializedSession
  grantTxHash?: string
  actTxHash?: string
  revokeTxHash?: string
  refusals?: unknown[]
  /** Native spend this script has watched confirm, for the headroom figure. */
  observedNativeSpendWei?: string
  keystoreBefore?: boolean
  keystoreAfterGrant?: boolean
  keystoreAfterRevoke?: boolean
}

function readEnvFile(): Record<string, string> {
  try {
    const out: Record<string, string> = {}
    for (const line of readFileSync(ENV_PATH, 'utf8').split('\n')) {
      const match = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim())
      if (match) out[match[1]!] = match[2]!
    }
    return out
  } catch {
    return {}
  }
}

/**
 * Load the two keys, generating whatever is missing.
 *
 * They are split for the same reason the runtime splits them: the admin key is
 * the user's, the session key is the agent's, and conflating them is exactly
 * the custody model this project exists to avoid. `HALLMARK_ADMIN_KEY` in the
 * environment wins, so an already-funded wallet can be used without copying
 * its key into a file.
 */
function loadKeys(): { keys: Keys; generated: string[] } {
  const file = readEnvFile()
  const generated: string[] = []

  let adminKey = (process.env['HALLMARK_ADMIN_KEY'] ?? file['HALLMARK_ADMIN_KEY']) as Hex | undefined
  if (!adminKey) {
    adminKey = generatePrivateKey()
    generated.push('HALLMARK_ADMIN_KEY')
  }

  let sessionKey = (process.env['HALLMARK_DEMO_SESSION_KEY'] ?? file['HALLMARK_DEMO_SESSION_KEY']) as Hex | undefined
  if (!sessionKey) {
    sessionKey = generatePrivateKey()
    generated.push('HALLMARK_DEMO_SESSION_KEY')
  }

  if (generated.length > 0) {
    mkdirSync(dirname(ENV_PATH), { recursive: true })
    writeFileSync(
      ENV_PATH,
      [
        '# Generated by `pnpm session`. Gitignored. Testnet only.',
        '# The admin key is the user\'s wallet; the session key is the agent\'s.',
        '# They are separate because that separation is the product.',
        `HALLMARK_ADMIN_KEY=${adminKey}`,
        `HALLMARK_DEMO_SESSION_KEY=${sessionKey}`,
        '',
      ].join('\n'),
      { encoding: 'utf8', mode: 0o600 },
    )
  }

  return { keys: { adminKey, sessionKey }, generated }
}

function loadState(): State | null {
  try {
    return JSON.parse(readFileSync(STATE_PATH, 'utf8')) as State
  } catch {
    return null
  }
}

function saveState(state: State): void {
  mkdirSync(dirname(STATE_PATH), { recursive: true })
  // Outcomes carry bigints; JSON.stringify throws on them rather than losing
  // precision, which is the right default and needs handling here.
  writeFileSync(
    STATE_PATH,
    JSON.stringify(state, (_k, v) => (typeof v === 'bigint' ? v.toString() : v), 2),
    'utf8',
  )
}

// ---------------------------------------------------------------------------
// Shared pieces
// ---------------------------------------------------------------------------

const client = createPublicClient({ chain: bscTestnet, transport: http(chain.rpcUrl) })

function rule(title: string): void {
  console.log(`\n${'='.repeat(78)}\n${title}\n${'='.repeat(78)}`)
}

function policyFor(now: number): AgentPolicy {
  // A tight, explicit policy: a small native cap so an over-cap refusal is
  // unambiguous, and a short expiry because a demo key should not outlive the
  // demo.
  return venusHealthFactorPolicy(CHAIN_ID, {
    now,
    ttlSeconds: 24 * 60 * 60,
    nativeCapWei: parseEther('0.02'),
    stableCapAtomic: 5n * 10n ** 18n,
    label: 'Hallmark demo — Venus health-factor defence (testnet)',
  })
}

/** The Keystore read, with plain viem and a public node. Reproducible by anyone. */
async function keystoreSays(wallet: Address, keyId: Hex): Promise<boolean> {
  return (await client.readContract({
    address: chain.contracts.altanaKeyStore,
    abi: KEYSTORE_ABI,
    functionName: 'isValidKey',
    args: [wallet, keyId],
  })) as boolean
}

function printOutcome(label: string, outcome: ExecuteOutcome): void {
  console.log(`\n--- ${label} ---`)
  console.log(JSON.stringify(outcome, (_k, v) => (typeof v === 'bigint' ? v.toString() : v), 2))
}

function restore(state: State, keys: Keys): Session {
  return restoreSessionFromKey(state.serialized, keys.sessionKey)
}

// ---------------------------------------------------------------------------
// Phases
// ---------------------------------------------------------------------------

async function address(): Promise<void> {
  const { keys, generated } = loadKeys()
  const admin = privateKeyToAccount(keys.adminKey)
  const session = privateKeyToAccount(keys.sessionKey)

  rule('The two keys')
  console.log(`admin wallet (the user's)   ${admin.address}`)
  console.log(`session key  (the agent's)  ${session.address}`)
  console.log(`session key id              ${keccak256(session.publicKey)}`)
  if (generated.length > 0) {
    console.log(`\nGenerated ${generated.join(' and ')} into ${ENV_PATH} (gitignored, mode 600).`)
  } else {
    console.log('\nBoth keys loaded from the environment or .env.session.')
  }

  const [balance, fee] = await Promise.all([
    client.getBalance({ address: admin.address }),
    estimateGrantCostWei(CHAIN_ID).catch(() => null),
  ])
  console.log(`\nadmin balance               ${formatEther(balance)} tBNB`)
  console.log(
    `grant cost (live quote)     ${fee === null ? 'unavailable' : `${formatEther(fee)} tBNB`}` +
      ' — two Keystore calls on a first grant',
  )
  if (balance === 0n) {
    console.log(
      `\nFUND THIS ADDRESS on BNB Chain testnet (97) and re-run:\n  ${admin.address}\n` +
        '  0.05 tBNB is ample for the grant, one action, two refusals and the revoke.',
    )
  }
}

async function status(): Promise<void> {
  const { keys } = loadKeys()
  const admin = privateKeyToAccount(keys.adminKey)
  const state = loadState()

  rule('Status')
  console.log(`chain                       ${chain.name} (${CHAIN_ID})`)
  console.log(`keystore                    ${chain.contracts.altanaKeyStore}`)
  console.log(`admin wallet                ${admin.address}`)
  console.log(`admin balance               ${formatEther(await client.getBalance({ address: admin.address }))} tBNB`)
  console.log(`grant cost (live)           ${formatEther(await estimateGrantCostWei(CHAIN_ID))} tBNB`)

  if (state === null) {
    console.log('\nNo session granted yet. Run `pnpm session grant`.')
    return
  }
  const valid = await keystoreSays(state.walletAddress, state.keyId)
  console.log(`\nsession key id              ${state.keyId}`)
  console.log(`keystore isValidKey         ${valid}`)
  console.log(`expires                     ${new Date(state.expiresAt * 1000).toISOString()}`)
  if (state.grantTxHash) console.log(`grant tx                    ${chain.explorer}/tx/${state.grantTxHash}`)
  if (state.actTxHash) console.log(`act tx                      ${chain.explorer}/tx/${state.actTxHash}`)
  if (state.revokeTxHash) console.log(`revoke tx                   ${chain.explorer}/tx/${state.revokeTxHash}`)
}

async function grant(): Promise<void> {
  const { keys } = loadKeys()
  const now = Math.floor(Date.now() / 1000)
  const policy = policyFor(now)
  const adminSigner = signerFromPrivateKey(keys.adminKey)
  const admin = privateKeyToAccount(keys.adminKey)
  const sessionAccount = privateKeyToAccount(keys.sessionKey)

  rule('1. Grant — the scope the user is agreeing to')
  for (const line of describePolicy(policy, { now })) console.log(`  ${line}`)

  const keyId = keccak256(sessionAccount.publicKey)
  const before = await keystoreSays(admin.address, keyId)
  console.log(`\nKeystore before the grant: isValidKey(${admin.address}, ${keyId}) = ${before}`)

  const balance = await client.getBalance({ address: admin.address })
  const needed = await estimateGrantCostWei(CHAIN_ID)
  console.log(`Balance ${formatEther(balance)} tBNB against a live quote of ${formatEther(needed)} tBNB.`)
  if (balance < needed) {
    console.log(`\nNot enough tBNB. Fund ${admin.address} and re-run.`)
    process.exitCode = 1
    return
  }

  const wallet = await createAgentWallet(CHAIN_ID, keys.adminKey)
  const result = await grantAgentSession({
    chainId: CHAIN_ID,
    wallet: wallet.wallet,
    adminSigner,
    policy,
    sessionPrivateKey: keys.sessionKey,
  })

  if (result.kind !== 'granted') {
    console.log('\nThe grant did not confirm. This is an outcome, not an exception:')
    printOutcome('grant', result)
    process.exitCode = 1
    return
  }

  console.log(`\nGranted.`)
  console.log(`  wallet        ${result.walletAddress}`)
  console.log(`  key id        ${result.keyId}`)
  console.log(`  expires       ${new Date(result.expiresAt * 1000).toISOString()}`)
  if (result.txHash) console.log(`  tx            ${chain.explorer}/tx/${result.txHash}`)
  console.log(`  keystore key  ${result.keystoreKeyUrl}`)

  const after = await keystoreSays(result.walletAddress, result.keyId)
  console.log(`\nKeystore after the grant:  isValidKey(...) = ${after}`)

  saveState({
    chainId: CHAIN_ID,
    walletAddress: result.walletAddress,
    sessionPublicKey: result.publicKey,
    keyId: result.keyId,
    expiresAt: result.expiresAt,
    serialized: result.serialized,
    ...(result.txHash ? { grantTxHash: result.txHash } : {}),
    keystoreBefore: before,
    keystoreAfterGrant: after,
  })

  console.log(`\nState written to ${STATE_PATH}.`)
  console.log('Put these in the service environment to make `act` live:')
  console.log(`  HALLMARK_SESSION_HEALTH='${JSON.stringify(result.serialized)}'`)
  console.log('  HALLMARK_SESSION_KEY_HEALTH=<the session key from .env.session>')
}

async function act(): Promise<void> {
  const { keys } = loadKeys()
  const state = loadState()
  if (state === null) {
    console.log('No session. Run `pnpm session grant` first.')
    process.exitCode = 1
    return
  }

  rule('2. Act — one real transaction, inside the scope')

  // `mint()` on vBNB: supply a trivial amount of tBNB as Venus collateral.
  // Payable, no arguments — the vBNB signature, not the ERC-20 one — and on
  // the policy allowlist for exactly this market.
  const amount = parseEther('0.001')
  const call = {
    to: chain.defi.venusVBnb,
    data: encodeFunctionData({ abi: vBnbAbi, functionName: 'mint', args: [] }),
    value: amount,
  }
  console.log(`  to        ${call.to}  (vBNB)`)
  console.log(`  signature mint()  →  ${call.data}`)
  console.log(`  value     ${formatEther(amount)} tBNB`)
  console.log('  policy    "Supply BNB collateral" — allowlisted for this market, this selector')

  const outcome = await executeWithSession({
    chainId: CHAIN_ID,
    session: restore(state, keys),
    calls: [call],
  })
  printOutcome('outcome', outcome)

  if (outcome.kind === 'confirmed') {
    const observed = BigInt(state.observedNativeSpendWei ?? '0') + amount
    saveState({ ...state, actTxHash: outcome.txHash, observedNativeSpendWei: observed.toString() })
    console.log(`\nConfirmed: ${outcome.explorerUrl}`)
  } else {
    process.exitCode = 1
  }
}

async function refuse(): Promise<void> {
  const { keys } = loadKeys()
  const state = loadState()
  if (state === null) {
    console.log('No session. Run `pnpm session grant` first.')
    process.exitCode = 1
    return
  }
  const session = restore(state, keys)

  rule('3. Refuse — the same key, told no, twice')
  console.log(
    'Both go out with `preflight: false`, so the *relay* decides rather than our\n' +
      'own scope check. That is the point: the refusal has to come from the\n' +
      'authorization layer, not from us being polite.',
  )

  // The headroom, stated as a number. "Denied because it would have exceeded
  // 0.02 tBNB a day with 0.019 left" is a far better sentence than "denied",
  // and it is the sentence a user actually needs.
  const policy = policyFor(Math.floor(Date.now() / 1000))
  const nativeCap = policy.spend.find((cap) => cap.token.toLowerCase().startsWith('0xeeee'))!
  const observedSpend = BigInt(state.observedNativeSpendWei ?? '0')
  const remaining =
    nativeCap.limitAtomic > observedSpend ? nativeCap.limitAtomic - observedSpend : 0n
  console.log(
    `
Native cap right now: ${formatEther(nativeCap.limitAtomic)} tBNB per ${nativeCap.period}; ` +
      `${formatEther(observedSpend)} tBNB spent by phase 2; ` +
      `${formatEther(remaining)} tBNB of headroom left.`,
  )

  const attempts: Array<{ label: string; note: string; call: { to: Address; data: Hex; value: bigint } }> = [
    {
      label: 'over-cap spend',
      note:
        '0.03 tBNB through a key capped at 0.02 tBNB a day. The call itself is allowlisted, ' +
        'and — this is the part that has to be right for the test to mean anything — the ' +
        'wallet holds more than 0.03 tBNB. An amount larger than the balance would be refused ' +
        'for want of funds and prove nothing about the cap.',
      call: {
        to: chain.defi.venusVBnb,
        data: encodeFunctionData({ abi: vBnbAbi, functionName: 'mint', args: [] }),
        value: parseEther('0.03'),
      },
    },
    {
      label: 'off-allowlist call — borrow',
      note:
        'vUSDT is on the allowlist; `borrow(uint256)` is not on it for any market. ' +
        'This is the property that makes the health agent unable to lever a position up.',
      call: {
        to: chain.defi.venusVUsdt,
        data: encodeFunctionData({
          abi: vTokenErc20Abi,
          functionName: 'borrow',
          args: [10n ** 18n],
        }),
        value: 0n,
      },
    },
  ]

  const captured: unknown[] = []
  for (const attempt of attempts) {
    console.log(`\n### ${attempt.label}`)
    console.log(attempt.note)
    console.log(`  to ${attempt.call.to}`)
    console.log(`  data ${attempt.call.data.slice(0, 10)}…  value ${formatEther(attempt.call.value)} tBNB`)

    const outcome = await executeWithSession({
      chainId: CHAIN_ID,
      session,
      calls: [attempt.call],
      // Do not "optimise" this to the default. With preflight on, our own
      // scope check answers first and the relay never gets to speak, so the
      // 300-499 status band never appears and the artifact evaporates. The
      // claim being demonstrated is that the *authorization layer* refuses —
      // not that we politely declined to ask it.
      preflight: false,
    })
    printOutcome(attempt.label, outcome)
    captured.push({ attempt: attempt.label, outcome })

    // The relay's own words, independent of how the SDK bucketed them. An
    // `UnauthorizedCall` naming the key hash, the target and the calldata is
    // the authorization layer refusing, whatever `kind` it arrives under.
    // The Altana relay signals a policy refusal as a *typed error* at
    // `wallet_prepareCalls` — `UnauthorizedCall` for a call outside the
    // allowlist, `ExceededSpendLimit` for a cap breach — with no numbered
    // status, because it never gets as far as building a bundle. That is a
    // refusal on any reading, and stronger evidence than a status code: it
    // names the key hash, the target and the calldata.
    const raw = JSON.stringify(outcome)
    const relayError = /Reason: (\w+)/.exec(raw)?.[1]
    const isRelayRefusal = relayError === 'UnauthorizedCall' || relayError === 'ExceededSpendLimit'

    if (isRelayRefusal && attempt.label === 'over-cap spend') {
      const balance = await client.getBalance({ address: state.walletAddress })
      console.log(
        `
  → Denied because it would have exceeded ${formatEther(nativeCap.limitAtomic)} tBNB ` +
          `per ${nativeCap.period} with ${formatEther(remaining)} tBNB left: it asked for ` +
          `${formatEther(attempt.call.value)} tBNB, which is ` +
          `${formatEther(attempt.call.value - remaining)} tBNB beyond the headroom.` +
          `
     The wallet held ${formatEther(balance)} tBNB at the time, so funds were not ` +
          'the reason — the cap was.',
      )
    }

    if (isRelayRefusal) {
      const keyHash = /keyHash: (0x[0-9a-f]{64})/.exec(raw)?.[1]
      const target = /target: (0x[0-9a-fA-F]{40})/.exec(raw)?.[1]
      const token = /token: (0x[0-9a-fA-F]{40})/.exec(raw)?.[1]
      console.log(
        [
          '',
          `  → the relay refused at prepare time: ${relayError}`,
          ...(keyHash ? [`     keyHash ${keyHash}`] : []),
          ...(target ? [`     target  ${target}`] : []),
          ...(token ? [`     token   ${token}   (0x0 = the native spend cap)`] : []),
          '     Nothing reached the chain, so there is no numbered status band here: the',
          '     relay rejects an out-of-scope call before it builds a bundle at all. The',
          '     300-499 band belongs to the execute path, not to prepare-time rejection.',
        ].join('\n'),
      )
    }

    if (outcome.kind === 'refused') {
      console.log(
        `\n  → refused, status ${outcome.statusCode} (${outcome.source})` +
          `${outcome.statusCode >= 300 && outcome.statusCode <= 499 ? ', in the 300-499 band' : ''}.`,
      )
    } else if (isRelayRefusal) {
      console.log(
        `\n  → NOTE: @hallmark/altana bucketed this as \`${outcome.kind}\`, which is wrong.` +
          '\n     Nothing reverted and nothing reached the chain. `outcomeFromThrow` only maps' +
          '\n     to `refused` when the message carries "relay code NNN", and a prepare-time' +
          '\n     typed error carries none. Read from the relay error itself, above.',
      )
    } else {
      console.log(`\n  → NOT refused: ${outcome.kind}. That is a finding, not a pass.`)
      process.exitCode = 1
    }
  }

  saveState({ ...state, refusals: captured })
}

async function revoke(): Promise<void> {
  const { keys } = loadKeys()
  const state = loadState()
  if (state === null) {
    console.log('No session. Run `pnpm session grant` first.')
    process.exitCode = 1
    return
  }

  rule('4. Revoke — one transaction, effective immediately')
  const before = await keystoreSays(state.walletAddress, state.keyId)
  console.log(`Keystore before: isValidKey(${state.walletAddress}, ${state.keyId}) = ${before}`)

  const wallet = await createAgentWallet(CHAIN_ID, keys.adminKey)
  const outcome = await revokeAgentSession({
    chainId: CHAIN_ID,
    wallet: wallet.wallet,
    adminSigner: signerFromPrivateKey(keys.adminKey),
    session: state.sessionPublicKey,
  })
  printOutcome('revoke', outcome)

  const after = await keystoreSays(state.walletAddress, state.keyId)
  console.log(`\nKeystore after:  isValidKey(...) = ${after}`)

  saveState({
    ...state,
    ...(outcome.kind === 'confirmed' ? { revokeTxHash: outcome.txHash } : {}),
    keystoreAfterRevoke: after,
  })

  if (after !== false) {
    console.log('\nThe key is still valid. That is a failure of the central claim, not a warning.')
    process.exitCode = 1
  }
}

/**
 * The verification a reviewer repeats without any of our code.
 *
 * Deliberately printed as a `cast` command as well: the whole point of the
 * Keystore is that the claim is checkable by a stranger with a public node.
 */
async function verify(): Promise<void> {
  const state = loadState()
  if (state === null) {
    console.log('No session recorded.')
    process.exitCode = 1
    return
  }

  rule('5. Verify — one eth_call, no credentials')
  const valid = await keystoreSays(state.walletAddress, state.keyId)
  console.log(`keystore     ${chain.contracts.altanaKeyStore}`)
  console.log(`wallet       ${state.walletAddress}`)
  console.log(`key id       ${state.keyId}   (keccak256 of the session public key)`)
  console.log(`isValidKey   ${valid}`)
  console.log(`\nRepeat it yourself:`)
  console.log(
    `  cast call ${chain.contracts.altanaKeyStore} \\\n` +
      `    "isValidKey(address,bytes32)(bool)" \\\n` +
      `    ${state.walletAddress} ${state.keyId} \\\n` +
      `    --rpc-url ${chain.rpcUrl}`,
  )
  console.log(`\nOr in the Keystore explorer: ${chain.altanaExplorer}/key/${state.keyId}`)
}

// ---------------------------------------------------------------------------

const phases: Record<string, () => Promise<void>> = {
  address,
  status,
  grant,
  act,
  refuse,
  revoke,
  verify,
}

const requested = process.argv[2] ?? 'status'

if (requested === 'all') {
  for (const name of ['grant', 'act', 'refuse', 'revoke', 'verify'] as const) {
    await phases[name]!()
    if (process.exitCode === 1) {
      console.log(`\nStopped at "${name}".`)
      break
    }
  }
} else if (phases[requested]) {
  await phases[requested]!()
} else {
  console.log(`Unknown phase "${requested}". One of: ${Object.keys(phases).join(', ')}, all.`)
  process.exitCode = 1
}
