/**
 * `@hallmark/sdk` — publish an ERC-8004 agent to BNB Chain, and opt into
 * on-chain validation.
 *
 * Three ways in, all the same code underneath:
 *
 *   library     `import { publishAgent } from '@hallmark/sdk'`
 *   config      `export default defineAgent({ … })` in `hallmark.config.ts`
 *   CLI         `hallmark validate | doctor | estimate | publish | status`
 */

export { defineAgent, validateAgentConfig } from './config.js'
export {
  checkAgentConfig,
  CARD_MAX_BYTES,
  CARD_WARN_BYTES,
  type Issue,
  type Severity,
  type ValidationResult,
} from './schema.js'

export {
  A2A_VERSION,
  MCP_VERSION,
  SERVICE_NAMES,
  SERVICE_ORDER,
  X402_VERSION,
  agentUriBytes,
  buildRegistrationFile,
  canonicalJson,
  chainIdOf,
  decodeAgentUri,
  encodeAgentUri,
  withRegistration,
  type BuildOptions,
} from './registration.js'

export {
  COLD_GAS_PER_URI_BYTE,
  DEFAULT_GAS_PRICE_WEI,
  DEFAULT_NATIVE_USD,
  MEASURED_REGISTRATION,
  REGISTER_FIXED_GAS,
  SET_URI_FIXED_GAS,
  WARM_GAS_PER_URI_BYTE,
  estimateRegistrationCost,
  fetchGasParams,
  registerGas,
  setUriGas,
  type CostLine,
  type EstimateOptions,
  type GasParams,
  type RegistrationCostEstimate,
} from './cost.js'

export {
  agentOwner,
  identityWriteAbi,
  planPublish,
  publishAgent,
  resolveChainId,
  scanLookup,
  type ExistingAgentLookup,
  type ExistingAgentQuery,
  type PlannedCall,
  type PlannedValidation,
  type PublishAgentInput,
  type PublishAgentResult,
  type PublishPlan,
  type PublishPlanInput,
} from './publish.js'

export {
  HALLMARK_VALIDATOR,
  REQUEST_HASH_DOMAIN,
  computeValidationRequestHash,
  getValidationStatus,
  requestValidation,
  resolveValidator,
  validationRequestPreimage,
  type GetValidationStatusInput,
  type RequestHashInput,
  type RequestValidationInput,
  type RequestValidationResult,
  type ValidationRecord,
  type ValidationStatusReport,
  type ValidatorRef,
} from './validation.js'

export {
  verifyAgent,
  type EndpointCheck,
  type Finding,
  type VerifyAgentInput,
  type VerifyReport,
  type VerifyVerdict,
} from './verify.js'

export {
  MCP_PROTOCOL_VERSION,
  probeA2A,
  probeMCP,
  probeWeb,
  probeX402,
  type ProbeOptions,
  type ProbeOutcome,
  type ProbeStatus,
} from './probes.js'

export { getAgentStatus, type AgentStatusInput, type AgentStatusReport } from './status.js'

export {
  CONFIG_FILENAMES,
  findConfigFile,
  loadAgentConfig,
  type LoadedConfig,
} from './loadConfig.js'

export {
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_REDIRECTS,
  DEFAULT_TIMEOUT_MS,
  assertPublicUrl,
  classifyUrl,
  isBlockedHostname,
  isPrivateAddress,
  isPrivateIpv4,
  isPrivateIpv6,
  safeFetch,
  type HostLookup,
  type SafeFetchOptions,
  type SafeFetchResult,
  type UrlVerdict,
} from './net.js'

export {
  AgentConfigError,
  BlockedUrlError,
  ConfigFileError,
  HallmarkError,
  PublishError,
  UnsupportedChainError,
  formatIssues,
} from './errors.js'

export { accountAddress, type AgentWalletClient, type ReceiptWaiter, type WriteRequest } from './clients.js'

export {
  AGENT_CATEGORIES,
  CHAIN_IDS,
  CHAIN_NAMES,
  PRICING_MODELS,
  REGISTRATION_TYPE,
  TRUST_MODELS,
  type Address,
  type AgentCategory,
  type AgentConfig,
  type AgentSkill,
  type ChainName,
  type HallmarkExtension,
  type Hex,
  type JsonSchema,
  type Pricing,
  type PricingModel,
  type RegistrationEntry,
  type RegistrationFile,
  type RegistrationService,
  type ServiceEndpoints,
  type ServiceKind,
  type TrustModel,
  type ValidationConfig,
} from './types.js'
