/**
 * Live checks that need no funds.
 *
 *   pnpm build && node scripts/live-check.mjs
 *
 * Everything here runs against the real Altana relay and real public RPCs with
 * a throwaway key that has never held anything. Nothing is spent; the grant in
 * check 4 is *expected* to fail, and the point is that our code classifies the
 * failure instead of crashing on it.
 */
import { ERC8183_ADDRESSES, JOB_STATUS, PERMIT2_ADDRESS } from '@altananetwork/sdk'
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts'

import {
  ALTANA_NETWORKS,
  createAgentWallet,
  createAltanaClient,
  describeOutcome,
  grantAgentSession,
  isSessionValid,
  keystoreExplorerUrl,
  listRegisteredKeys,
  pancakeGridPolicy,
  readRegistrationFeeWei,
  sessionKeyId,
  toAltanaPermissions,
  validatePolicy,
} from '../dist/index.js'

const line = (title) => console.log(`\n${'='.repeat(72)}\n${title}\n${'='.repeat(72)}`)

// ---------------------------------------------------------------------------
line('1. Wallet address is the signer EOA (no new counterfactual account)')
// ---------------------------------------------------------------------------
const adminKey = generatePrivateKey()
const eoa = privateKeyToAccount(adminKey).address
console.log('throwaway key      :', `${adminKey.slice(0, 10)}… (never funded, never reused)`)
console.log('EOA from viem      :', eoa)

for (const chainId of [97, 56]) {
  const { address } = await createAgentWallet(chainId, adminKey)
  console.log(`Altana wallet (${chainId}) :`, address, address === eoa ? '— identical' : '— DIFFERENT')
}

// ---------------------------------------------------------------------------
line('2. Real client method surface and ERC-8183 addresses')
// ---------------------------------------------------------------------------
const client97 = createAltanaClient(97)
console.log('client keys:')
console.log(
  Object.keys(client97)
    .map((key) => `  ${key}: ${typeof client97[key]}`)
    .join('\n'),
)
console.log('\ndefaultChainId:', client97.defaultChainId)
console.log('chains        :', client97.chains.map((chain) => chain.chainId).join(', '))
console.log('\nPERMIT2_ADDRESS      :', PERMIT2_ADDRESS)
console.log('JOB_STATUS           :', JOB_STATUS.join(' '))
console.log('ERC8183_ADDRESSES[56]:', ERC8183_ADDRESSES[56])
console.log('ERC8183_ADDRESSES[97]:', ERC8183_ADDRESSES[97])
console.log('\nKeystore deployments:')
for (const network of Object.values(ALTANA_NETWORKS)) {
  console.log(
    `  ${network.chainId}: keyStore=${network.keyStore} controller=${network.keyStoreController}`,
  )
}

// ---------------------------------------------------------------------------
line('3. Permissionless Keystore verification (no key, no funds, one eth_call)')
// ---------------------------------------------------------------------------
const arbitrary = '0x000000000000000000000000000000000000dEaD'
const madeUpPublicKey = `0x04${'11'.repeat(64)}`
console.log('mainnet Keystore   :', ALTANA_NETWORKS[56].keyStore)
console.log('account            :', arbitrary)
console.log('keyId              :', sessionKeyId(madeUpPublicKey))
console.log('isValidKey         :', await isSessionValid(56, arbitrary, madeUpPublicKey))
console.log('getKeys            :', await listRegisteredKeys(56, arbitrary))
console.log('explorer           :', keystoreExplorerUrl(56, arbitrary))
for (const chainId of [56, 97]) {
  console.log(`registration fee (${chainId}):`, await readRegistrationFeeWei(chainId), 'wei')
}

// ---------------------------------------------------------------------------
line('4. grantSession from an unfunded wallet is classified, not crashed')
// ---------------------------------------------------------------------------
const wallet = await createAgentWallet(97, adminKey)
const policy = pancakeGridPolicy(97, { ttlSeconds: 3600 })
console.log('policy valid       :', JSON.stringify(validatePolicy(policy)))
console.log('permissions        :', JSON.stringify(toAltanaPermissions(policy), (_k, v) =>
  typeof v === 'bigint' ? `${v}n` : v,
))
console.log('wallet             :', wallet.address, '(balance: 0)')

const sessionKey = generatePrivateKey()
const started = Date.now()
const result = await grantAgentSession({
  chainId: 97,
  wallet: wallet.wallet,
  adminSigner: wallet.signer,
  sessionPrivateKey: sessionKey,
  policy,
})
console.log(`\nreturned after ${Math.round((Date.now() - started) / 1000)}s — no exception thrown`)
console.log('kind               :', result.kind)
if (result.kind !== 'granted') {
  const copy = describeOutcome(result)
  console.log('headline           :', copy.headline)
  console.log('tone               :', copy.tone)
  console.log('detail             :', copy.detail)
  if (result.kind === 'unfunded') console.log('requiredWei        :', result.requiredWei)
}
