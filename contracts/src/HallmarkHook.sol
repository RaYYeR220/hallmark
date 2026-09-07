// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {IERC165} from "@openzeppelin/contracts/utils/introspection/IERC165.sol";
import {Strings} from "@openzeppelin/contracts/utils/Strings.sol";

import {IACPHook} from "./interfaces/IACPHook.sol";
import {IAgenticCommerce} from "./interfaces/IAgenticCommerce.sol";
import {IJobParties} from "./interfaces/IJobParties.sol";
import {IIdentityRegistry} from "./interfaces/IIdentityRegistry.sol";
import {IReputationRegistry} from "./interfaces/IReputationRegistry.sol";
import {IValidationRegistry} from "./interfaces/IValidationRegistry.sol";

/// @title HallmarkHook
/// @notice The policy Hallmark attaches to every ERC-8183 job: money only moves toward an agent that
///         has fresh, on-chain liveness evidence, and every settled job writes its outcome back into
///         the ERC-8004 Reputation Registry.
///
/// @dev Two halves, both mandatory to the product:
///
///      1. **The refusal.** `beforeAction(fund)` decodes the ERC-8004 agent id the client declared,
///         checks the agent actually exists in the Identity Registry, and then demands recent proof
///         of life. Without it the call reverts with `NoFreshEvidence` and no token ever leaves the
///         client's wallet. Listings can lie; an escrow that refuses to fund cannot.
///
///      2. **The receipt.** `afterAction(complete)` and `afterAction(reject)` write the outcome into
///         the Reputation Registry, so an on-chain rating always corresponds to a job that really
///         settled. Those writes are wrapped in `try/catch`: a registry that reverts, runs out of
///         room, or changes behaviour must never be able to brick settlement of a funded job.
///
///      **Freshness clock.** Evidence is accepted from two sources. The Validation Registry exposes
///      `lastUpdate` per record, so an attestor validation is self-timestamping and used directly.
///      The Reputation Registry, by contrast, exposes no timestamp at all — `getSummary` returns a
///      count and an aggregate and nothing about when the entries were written. A ten-month-old
///      "reachable" feedback and a ten-minute-old one are indistinguishable through the standard
///      interface. Hallmark therefore keeps its own `lastProbeAt` clock, written by `recordProbe`
///      and callable only by the attestor, and treats the registry entry as the public, standard-
///      visible mirror of that probe. The registry says *what* was observed; this contract says
///      *when*.
///
///      **Why a separate contract.** The Reputation Registry rejects feedback whose submitter is the
///      agent's own owner or operator. This hook is a standalone contract owned by the marketplace
///      and is never an agent controller, so its writes are always accepted.
///
/// @custom:eip https://eips.ethereum.org/EIPS/eip-8183
contract HallmarkHook is IACPHook, IERC165, Ownable {
    /// @notice Aggregate, per-agent performance record maintained from real settled escrow.
    /// @param jobsFunded Jobs that passed the evidence gate and were funded against this agent.
    /// @param jobsCompleted Jobs the evaluator settled in the agent's favour.
    /// @param jobsRejected Jobs the evaluator or client cancelled.
    /// @param jobsExpired Jobs that expired with nothing delivered. This one is the agent's.
    /// @param jobsStalled Jobs the agent delivered that expired anyway, because the evaluator never
    ///        acted. Counted separately because blaming the agent for someone else's inaction is
    ///        exactly the griefing lever a hostile client would reach for.
    /// @param totalDeliverySeconds Sum of funding-to-submission times across completed jobs.
    struct Record {
        uint32 jobsFunded;
        uint32 jobsCompleted;
        uint32 jobsRejected;
        uint32 jobsExpired;
        uint32 jobsStalled;
        uint64 totalDeliverySeconds;
    }

    /// @notice Why a settled job did or did not earn an ERC-8004 attestation.
    enum Attestability {
        Attestable,
        SelfDealt,
        BudgetTooSmall
    }

    /// @notice Tag the attestor's liveness feedback carries in the Reputation Registry.
    string public constant REACHABLE_TAG = "reachable";

    /// @notice Secondary tag stamped on every feedback entry this hook writes.
    string public constant HALLMARK_TAG = "hallmark";

    /// @notice Tag written on completion.
    string public constant COMPLETED_TAG = "jobcompleted";

    /// @notice Tag written on rejection.
    string public constant REJECTED_TAG = "jobrejected";

    /// @notice Validation Registry tag the gate accepts as a liveness attestation.
    string public constant LIVENESS_TAG = "liveness";

    /// @notice Upper bound on how far back a validation record scan walks, to keep `fund` gas bounded.
    uint256 public constant VALIDATION_SCAN_LIMIT = 8;

    /// @notice Upper bound accepted by `setMaxEvidenceAge`.
    uint256 public constant MAX_EVIDENCE_AGE_LIMIT = 30 days;

    /// @notice Gas that must remain before the hook will even attempt a Reputation Registry write.
    /// @dev Measured against the live ERC-8004 Reputation Registry on BSC testnet: the FIRST
    ///      `giveFeedback` a given client writes for a given agent costs ~214,000 gas, because it
    ///      allocates the client record and several fresh storage slots; every subsequent write for
    ///      the same pair costs ~132,000. This floor is sized from the 214,000 first-write case,
    ///      since by construction Hallmark's first receipt for any agent is a first write.
    ///
    ///      The floor exists because of EIP-150. `_writeFeedback` wraps the registry call in
    ///      `try/catch` so a hostile registry cannot unwind a paid job — but that also means the
    ///      OUTER call succeeds when the INNER one runs out of gas. `eth_estimateGas` binary-searches
    ///      for the smallest limit under which the outer call succeeds, so it happily converges on a
    ///      limit that starves the write, and the receipt silently never lands. Checking `gasleft()`
    ///      up front turns that from a silent no-op into a distinct, indexed
    ///      `FeedbackSkippedInsufficientGas` event. It cannot, however, make an under-gassed call
    ///      write the receipt: integrators must send a real gas limit rather than an estimate. See
    ///      the gas note in the README.
    uint256 public constant MIN_FEEDBACK_GAS = 250_000;

    /// @notice Gas held back from the registry call for this contract's own epilogue.
    /// @dev Without an explicit stipend the registry would receive 63/64 of everything, leaving the
    ///      hook barely 1/64 to finish `_afterSettlement` — so a registry that burns whatever it is
    ///      given could run this contract out of gas after the money has already moved and revert the
    ///      settlement it was forbidden from blocking. Reserving a fixed slice makes that impossible.
    ///
    ///      For the reserve to mean anything the epilogue it pays for has to be bounded, which is why
    ///      `MAX_FEEDBACK_ERROR_BYTES` exists and why the reserve is taken from `gasleft()` measured
    ///      immediately before the call rather than at the top of `_writeFeedback`.
    uint256 public constant FEEDBACK_EPILOGUE_RESERVE = 20_000;

    /// @notice Hard cap on how much of the registry's revert data this contract will copy and log.
    /// @dev A `try/catch (bytes memory err)` copies the whole of `returndatasize()` and then pays 8 gas
    ///      per byte to log it, both out of the epilogue reserve. A registry that burns its stipend and
    ///      then reverts with a few hundred kilobytes therefore runs the hook out of gas inside its own
    ///      catch handler and reverts a settlement that has already paid out — the exact outcome the
    ///      try/catch exists to prevent. Copying a bounded prefix keeps the diagnostic (an empty
    ///      prefix still reads as "out of gas", a populated one as "the registry rejected us") while
    ///      making the epilogue's cost a constant the reserve can actually cover.
    uint256 public constant MAX_FEEDBACK_ERROR_BYTES = 256;

    /// @notice Smallest stipend the registry call can receive once `MIN_FEEDBACK_GAS` is satisfied.
    /// @dev 230,000, comfortably above the measured 214,000 first-write cost. When the caller supplies
    ///      more gas the stipend scales up with it; this is the floor, not the cap.
    uint256 public constant MIN_FEEDBACK_STIPEND = MIN_FEEDBACK_GAS - FEEDBACK_EPILOGUE_RESERVE;

    /// @notice Gas that must remain before the funding gate will evaluate an agent's evidence.
    /// @dev The mirror image of `MIN_FEEDBACK_GAS`, and note the deliberately opposite failure
    ///      direction. The evidence reads are also wrapped in `try/catch`, so a starved read would
    ///      degrade to "no evidence found" and make a perfectly live agent look unhireable. Before
    ///      money moves, the safe answer to "I could not evaluate this" is to refuse loudly, so this
    ///      reverts with `InsufficientGasForEvidenceCheck` instead of guessing. Reverting is also what
    ///      keeps `eth_estimateGas` honest here: the estimator raises the limit until the gate has
    ///      enough room to actually run.
    uint256 public constant MIN_EVIDENCE_GAS = 150_000;

    /// @notice Gas that must remain before the gate will enter the O(history) validation branch.
    /// @dev `VALIDATION_SCAN_LIMIT` bounds how many records are inspected. It does not bound
    ///      `getAgentValidations`, which returns the agent's entire request array and has to be
    ///      returned and ABI-decoded before the scan window is even chosen. Measured against an agent
    ///      with 1,000 records that read alone is ~361,000 gas, so a single 150,000 floor checked once
    ///      at entry never covered it. This is a second floor, checked immediately before the read it
    ///      pays for, and the read is given an explicit stipend so EIP-150 cannot starve it below what
    ///      was checked.
    uint256 public constant MIN_VALIDATION_READ_GAS = 400_000;

    /// @notice Stipend handed to each Identity Registry call.
    uint256 public constant IDENTITY_READ_GAS = 60_000;

    /// @notice Stipend handed to each `getValidationStatus` read inside the bounded scan.
    uint256 public constant VALIDATION_STATUS_READ_GAS = 40_000;

    /// @notice Stipend handed to the escrow's bounded job read.
    uint256 public constant JOB_READ_GAS = 60_000;

    /// @notice Default floor on a job's budget for its outcome to be written to ERC-8004.
    uint256 public constant DEFAULT_MIN_ATTESTABLE_BUDGET = 1e17;

    /// @notice The ERC-8183 escrow allowed to invoke the hook callbacks.
    address public immutable commerce;

    /// @notice ERC-8004 Reputation Registry outcomes are written to.
    IReputationRegistry public immutable reputation;

    /// @notice ERC-8004 Validation Registry liveness attestations are read from.
    IValidationRegistry public immutable validation;

    /// @notice ERC-8004 Identity Registry agent existence is checked against.
    IIdentityRegistry public immutable identity;

    /// @notice Hallmark's prober. Only its validations and probes count as evidence.
    address public attestor;

    /// @notice How old evidence may be and still gate a funding open. Defaults to 24 hours.
    uint256 public maxEvidenceAge;

    /// @notice Minimum validation score, on the ERC-8004 [0, 100] scale, that counts as alive.
    uint8 public minValidationScore;

    /// @notice Prefix for the evidence document referenced by each feedback entry; the job id is
    ///         appended to it.
    string public evidenceBaseURI;

    /// @notice ERC-8004 agent a job was funded against.
    mapping(uint256 jobId => uint256 agentId) public jobAgent;

    /// @notice Timestamp a job's escrow was funded.
    mapping(uint256 jobId => uint64 timestamp) public fundedAt;

    /// @notice Timestamp a job's deliverable was submitted.
    mapping(uint256 jobId => uint64 timestamp) public submittedAt;

    /// @notice The attestor's last observation of an agent: the authoritative freshness clock.
    /// @param at When the probe was taken.
    /// @param score What the prober saw, on the ERC-8004 [0, 100] scale.
    /// @param by Which attestor key took it. Recorded so that rotating `attestor` invalidates
    ///        evidence gathered under the old key — the probe is only as trustworthy as the key that
    ///        signed it, and a rotation exists precisely because that trust ended.
    struct Probe {
        uint64 at;
        uint8 score;
        address by;
    }

    mapping(uint256 agentId => Probe probe) private _probes;

    /// @notice Guards `recordExpiry` against double counting.
    mapping(uint256 jobId => bool recorded) public expiryRecorded;

    /// @notice Smallest budget whose outcome is worth writing to the public registry.
    /// @dev A one-wei job is not evidence of anything. Without a floor, an attestation costs an
    ///      attacker nothing but gas, because the platform fee on a tiny budget rounds to zero.
    ///      Owner-settable; zero disables the check.
    uint256 public minAttestableBudget;

    /// @notice Everything the settlement path needs to know about a job, decided when it was funded.
    /// @dev Deliberately resolved at `fund` and cached, not recomputed at settlement. Two reasons.
    ///      The settlement path runs inside a gas budget and must not take on unbounded registry
    ///      reads — that is the failure class this contract has already been bitten by twice. And
    ///      funding is the honest moment to judge the relationship: it is when the client chose the
    ///      counterparty and the money moved. Later changes to who owns the agent, or to
    ///      `minAttestableBudget`, do not retroactively rewrite whether a completed job was arm's
    ///      length.
    struct Binding {
        address client;
        Attestability attestability;
    }

    mapping(uint256 jobId => Binding binding) public jobBinding;

    mapping(uint256 agentId => Record record) private _records;

    /// @notice Caller is not the escrow this hook was deployed for.
    error NotCommerce();
    /// @notice Caller is not the configured attestor.
    error NotAttestor();
    /// @notice `fund` carried no agent id in `optParams`.
    error AgentNotDeclared();
    /// @notice The declared agent id is not registered in the Identity Registry.
    error UnknownAgent(uint256 agentId);
    /// @notice The agent has no liveness evidence inside `maxEvidenceAge`.
    /// @param agentId Agent the client tried to hire.
    /// @param lastEvidenceAt Timestamp of the newest evidence found, or zero if there is none.
    error NoFreshEvidence(uint256 agentId, uint256 lastEvidenceAt);
    /// @notice A required address argument was the zero address.
    error ZeroAddress();
    /// @notice `maxEvidenceAge` was set to zero or beyond `MAX_EVIDENCE_AGE_LIMIT`.
    error InvalidEvidenceAge();
    /// @notice `recordExpiry` was called for a job the escrow does not report as expired.
    error JobNotExpired(uint256 jobId);
    /// @notice `recordExpiry` was called twice for the same job.
    error ExpiryAlreadyRecorded(uint256 jobId);
    /// @notice `fund` was called with too little gas left to evaluate the agent's evidence honestly.
    error InsufficientGasForEvidenceCheck(uint256 gasLeft, uint256 required);
    /// @notice A registry read failed or ran out of gas, so the answer is unknown rather than "no".
    /// @dev Distinct from `NoFreshEvidence` on purpose. "I could not read the evidence" and "there is
    ///      no evidence" are different claims, and conflating them is what let a starved gate declare
    ///      a live agent dead.
    error EvidenceReadFailed(uint256 agentId);
    /// @notice The declared agent is not the party this job pays.
    /// @param agentId Agent the client declared in `optParams`.
    /// @param expected The agent's on-chain payee: its declared wallet, or its owner if it has none.
    /// @param provider The address the job actually pays.
    error AgentProviderMismatch(uint256 agentId, address expected, address provider);

    event JobBound(uint256 indexed jobId, uint256 indexed agentId);
    event DeliverySubmitted(uint256 indexed jobId, uint256 indexed agentId, uint64 secondsToDeliver);
    event OutcomeRecorded(uint256 indexed jobId, uint256 indexed agentId, bool completed, bytes32 reason);
    /// @param delivered True when the agent had already submitted and the evaluator let it lapse.
    event ExpiryRecorded(uint256 indexed jobId, uint256 indexed agentId, bool delivered);
    /// @notice The outcome was not written to ERC-8004 because the job was not arm's length.
    event FeedbackSkippedSelfDealt(uint256 indexed jobId, uint256 indexed agentId, address client);
    /// @notice The outcome was not written to ERC-8004 because the budget was below the floor.
    event FeedbackSkippedBudgetTooSmall(uint256 indexed jobId, uint256 indexed agentId, uint256 required);
    event MinAttestableBudgetUpdated(uint256 minAttestableBudget);
    event FeedbackWriteFailed(uint256 indexed jobId, uint256 indexed agentId, bytes reason);
    /// @notice The registry write was never attempted because the caller left too little gas.
    /// @dev Deliberately distinct from `FeedbackWriteFailed`: a skipped write must never be mistaken
    ///      for an attempted one. This one means "send more gas", not "the registry rejected us".
    event FeedbackSkippedInsufficientGas(
        uint256 indexed jobId, uint256 indexed agentId, uint256 gasLeft, uint256 required
    );
    event ProbeRecorded(uint256 indexed agentId, uint8 score, uint64 timestamp);
    event AttestorUpdated(address indexed attestor);
    event MaxEvidenceAgeUpdated(uint256 maxEvidenceAge);
    event MinValidationScoreUpdated(uint8 minValidationScore);
    event EvidenceBaseURIUpdated(string evidenceBaseURI);

    modifier onlyCommerce() {
        if (msg.sender != commerce) revert NotCommerce();
        _;
    }

    modifier onlyAttestor() {
        if (msg.sender != attestor) revert NotAttestor();
        _;
    }

    /// @param commerce_ ERC-8183 escrow this hook serves; the only permitted callback caller.
    /// @param identity_ ERC-8004 Identity Registry.
    /// @param reputation_ ERC-8004 Reputation Registry.
    /// @param validation_ ERC-8004 Validation Registry.
    /// @param attestor_ Address whose probes and validations count as evidence.
    constructor(address commerce_, address identity_, address reputation_, address validation_, address attestor_)
        Ownable(msg.sender)
    {
        if (
            commerce_ == address(0) || identity_ == address(0) || reputation_ == address(0) || validation_ == address(0)
                || attestor_ == address(0)
        ) revert ZeroAddress();

        commerce = commerce_;
        identity = IIdentityRegistry(identity_);
        reputation = IReputationRegistry(reputation_);
        validation = IValidationRegistry(validation_);
        attestor = attestor_;
        maxEvidenceAge = 24 hours;
        minValidationScore = 50;
        minAttestableBudget = DEFAULT_MIN_ATTESTABLE_BUDGET;

        emit AttestorUpdated(attestor_);
        emit MaxEvidenceAgeUpdated(24 hours);
        emit MinValidationScoreUpdated(50);
        emit MinAttestableBudgetUpdated(DEFAULT_MIN_ATTESTABLE_BUDGET);
    }

    // ---------------------------------------------------------------------
    // Hook callbacks
    // ---------------------------------------------------------------------

    /// @inheritdoc IACPHook
    /// @dev Only `fund` carries policy. Every other selector, known or unknown, is a clean no-op so
    ///      that adding functions to the escrow can never brick jobs already bound to this hook.
    function beforeAction(uint256 jobId, bytes4 selector, bytes calldata data) external onlyCommerce {
        if (selector == IAgenticCommerce.fund.selector) _beforeFund(jobId, data);
    }

    /// @inheritdoc IACPHook
    function afterAction(uint256 jobId, bytes4 selector, bytes calldata data) external onlyCommerce {
        if (selector == IAgenticCommerce.fund.selector) {
            _afterFund(jobId);
        } else if (selector == IAgenticCommerce.submit.selector) {
            _afterSubmit(jobId);
        } else if (selector == IAgenticCommerce.complete.selector) {
            _afterSettlement(jobId, data, true);
        } else if (selector == IAgenticCommerce.reject.selector) {
            _afterSettlement(jobId, data, false);
        }
    }

    // ---------------------------------------------------------------------
    // Attestor surface
    // ---------------------------------------------------------------------

    /// @notice Records that the attestor observed the agent alive, with a score on the ERC-8004
    ///         [0, 100] scale.
    /// @dev This is the freshness clock the Reputation Registry cannot provide. Pairing it with a
    ///      `"reachable"` feedback entry keeps the evidence publicly readable through the standard
    ///      registry while keeping the timestamp trustworthy.
    function recordProbe(uint256 agentId, uint8 score) external onlyAttestor {
        _agentOwner(agentId);
        _probes[agentId] = Probe({at: uint64(block.timestamp), score: score, by: msg.sender});
        emit ProbeRecorded(agentId, score, uint64(block.timestamp));
    }

    /// @notice Counts a job that expired unclaimed against its agent's record.
    /// @dev `claimRefund` is not hookable, so expiry cannot be observed from a callback. This is the
    ///      permissionless catch-up: anyone may call it, and it only writes if the escrow itself
    ///      reports the job as `Expired`.
    function recordExpiry(uint256 jobId) external {
        if (expiryRecorded[jobId]) revert ExpiryAlreadyRecorded(jobId);

        IAgenticCommerce.Job memory job = IAgenticCommerce(commerce).getJob(jobId);
        if (job.status != IAgenticCommerce.JobStatus.Expired) revert JobNotExpired(jobId);

        uint256 agentId = jobAgent[jobId];
        expiryRecorded[jobId] = true;

        // An expiry after delivery is the evaluator's failure, not the agent's. Counting the two the
        // same way is what let a client hire, take the work, sit on it, refund at expiry and mark the
        // agent down on the way out.
        bool delivered = submittedAt[jobId] != 0;
        if (agentId != 0) {
            if (delivered) _records[agentId].jobsStalled += 1;
            else _records[agentId].jobsExpired += 1;
        }
        emit ExpiryRecorded(jobId, agentId, delivered);
    }

    // ---------------------------------------------------------------------
    // Views
    // ---------------------------------------------------------------------

    /// @notice Aggregate record an agent has earned through settled escrow.
    function agentRecord(uint256 agentId) external view returns (Record memory) {
        return _records[agentId];
    }

    /// @notice The attestor's last recorded observation of an agent.
    function agentProbe(uint256 agentId) external view returns (Probe memory) {
        return _probes[agentId];
    }

    /// @notice When the current attestor last probed this agent. Zero if never, or if the probe was
    ///         taken by a key that has since been rotated out.
    function lastProbeAt(uint256 agentId) public view returns (uint64) {
        Probe storage probe = _probes[agentId];
        return probe.by == attestor ? probe.at : 0;
    }

    /// @notice Score from the current attestor's last probe. Zero once the key has been rotated.
    function lastProbeScore(uint256 agentId) public view returns (uint8) {
        Probe storage probe = _probes[agentId];
        return probe.by == attestor ? probe.score : 0;
    }

    /// @notice Whether an agent could be funded right now, and the evidence behind that answer.
    /// @return ok True if `fund` would pass the evidence gate.
    /// @return lastEvidenceAt Timestamp of the freshest evidence found, zero if none.
    /// @return score Score attached to that freshest evidence.
    function isHireable(uint256 agentId) public view returns (bool ok, uint64 lastEvidenceAt, uint8 score) {
        return _evaluateEvidence(agentId);
    }

    /// @notice Whether the attestor's probe of this agent is also visible in the public Reputation
    ///         Registry, as a `"reachable"` entry.
    /// @dev **Off-chain read only. Never call this from a transaction.** `getSummary` walks every
    ///      entry the attestor has ever written for the agent, so its cost grows without bound with
    ///      our own prober's history — measured at 21k gas with one mirror and 1.31M with four
    ///      hundred. It used to sit on the `fund` path, where that growth was a scheduled outage of
    ///      the gate rather than a possibility.
    ///
    ///      It was removed from the gate rather than merely floored, because it was never a security
    ///      control. The mirror is written by the same attestor key that writes `recordProbe`, so
    ///      requiring both proves nothing the probe alone does not; what the mirror buys is public
    ///      visibility for anyone reading ERC-8004 directly. Visibility belongs in an `eth_call`,
    ///      where an unbounded read is free. Trust belongs in the O(1) storage slot.
    function hasRegistryMirror(uint256 agentId) external view returns (bool) {
        address att = attestor;
        if (att == address(0)) return false;

        address[] memory clients = new address[](1);
        clients[0] = att;

        try reputation.getSummary(agentId, clients, REACHABLE_TAG, "") returns (uint64 count, int128 value, uint8) {
            return count > 0 && value > 0;
        } catch {
            return false;
        }
    }

    /// @notice Mean funding-to-submission time across an agent's completed jobs, in seconds.
    function averageDeliverySeconds(uint256 agentId) external view returns (uint256) {
        Record memory record = _records[agentId];
        if (record.jobsCompleted == 0) return 0;
        return uint256(record.totalDeliverySeconds) / record.jobsCompleted;
    }

    /// @notice Evidence document this hook would reference for a given job.
    function feedbackURI(uint256 jobId) public view returns (string memory) {
        if (bytes(evidenceBaseURI).length == 0) return "";
        return string.concat(evidenceBaseURI, Strings.toString(jobId));
    }

    /// @inheritdoc IERC165
    function supportsInterface(bytes4 interfaceId) external pure returns (bool) {
        return interfaceId == type(IACPHook).interfaceId || interfaceId == type(IERC165).interfaceId;
    }

    // ---------------------------------------------------------------------
    // Administration
    // ---------------------------------------------------------------------

    /// @notice Replaces the attestor whose evidence the gate trusts.
    function setAttestor(address attestor_) external onlyOwner {
        if (attestor_ == address(0)) revert ZeroAddress();
        attestor = attestor_;
        emit AttestorUpdated(attestor_);
    }

    /// @notice Sets how old evidence may be and still open funding.
    function setMaxEvidenceAge(uint256 maxEvidenceAge_) external onlyOwner {
        if (maxEvidenceAge_ == 0 || maxEvidenceAge_ > MAX_EVIDENCE_AGE_LIMIT) revert InvalidEvidenceAge();
        maxEvidenceAge = maxEvidenceAge_;
        emit MaxEvidenceAgeUpdated(maxEvidenceAge_);
    }

    /// @notice Sets the minimum score that counts as alive.
    function setMinValidationScore(uint8 minValidationScore_) external onlyOwner {
        minValidationScore = minValidationScore_;
        emit MinValidationScoreUpdated(minValidationScore_);
    }

    /// @notice Sets the smallest budget whose outcome earns an ERC-8004 attestation.
    /// @dev Zero disables the floor. Applies to jobs funded after the change; jobs already in flight
    ///      keep the verdict they were funded under, for the same reason the platform fee is
    ///      snapshotted at funding.
    function setMinAttestableBudget(uint256 minAttestableBudget_) external onlyOwner {
        minAttestableBudget = minAttestableBudget_;
        emit MinAttestableBudgetUpdated(minAttestableBudget_);
    }

    /// @notice Sets the prefix of the evidence document referenced by written feedback.
    function setEvidenceBaseURI(string calldata evidenceBaseURI_) external onlyOwner {
        evidenceBaseURI = evidenceBaseURI_;
        emit EvidenceBaseURIUpdated(evidenceBaseURI_);
    }

    // ---------------------------------------------------------------------
    // Internals: the gate
    // ---------------------------------------------------------------------

    function _beforeFund(uint256 jobId, bytes calldata optParams) private {
        if (optParams.length == 0) revert AgentNotDeclared();
        uint256 agentId = abi.decode(optParams, (uint256));

        // Everything below reads another contract. A starved read that is swallowed becomes a wrong
        // answer, and before money moves the only safe wrong answer is none: refuse loudly so the
        // caller retries with a real limit. Each floor is checked immediately before the read it
        // pays for, because one global check at entry cannot size a cost that varies per call.
        _requireGas(MIN_EVIDENCE_GAS);

        // 1. The agent must exist, and must be the party this job pays.
        address owner = _agentOwner(agentId);
        address payee = _agentPayee(agentId, owner);

        (address client, address provider,,,,) = _jobParties(jobId);
        if (payee != provider) revert AgentProviderMismatch(agentId, payee, provider);

        // 2. The agent must have fresh liveness evidence.
        (bool ok, uint64 lastEvidenceAt,) = _evaluateEvidence(agentId);
        if (!ok) revert NoFreshEvidence(agentId, lastEvidenceAt);

        jobAgent[jobId] = agentId;
        jobBinding[jobId] = Binding({client: client, attestability: _classify(jobId, client, owner, payee)});
    }

    /// @dev Decides at funding time whether this job's outcome will be worth an ERC-8004 attestation.
    ///
    ///      Binding the agent to the payee (step 1 above) stops you from writing reputation for an
    ///      agent you never paid. It does not stop you from paying yourself. This closes the cheap
    ///      version of that: a job whose client is the agent's own payee or owner, or whose evaluator
    ///      is the party being paid, is not an arm's-length transaction and earns no attestation.
    ///
    ///      Be honest about the limit. An attacker holding three unrelated keys — client, agent owner,
    ///      agent wallet — still passes every relationship test on-chain, because nothing here can
    ///      tell two strangers apart from one person with two wallets. That case is priced, not
    ///      detected: `minAttestableBudget` plus the platform fee is what a forged attestation costs.
    ///      The relationship checks remove the free path; the budget floor removes the cheap one.
    function _classify(uint256 jobId, address client, address owner, address payee)
        private
        view
        returns (Attestability)
    {
        (,, address evaluator, uint256 budget,,) = _jobParties(jobId);

        if (client == payee || client == owner || evaluator == payee) return Attestability.SelfDealt;
        if (budget < minAttestableBudget) return Attestability.BudgetTooSmall;
        return Attestability.Attestable;
    }

    function _afterFund(uint256 jobId) private {
        uint256 agentId = jobAgent[jobId];
        if (agentId == 0) return;
        fundedAt[jobId] = uint64(block.timestamp);
        _records[agentId].jobsFunded += 1;
        emit JobBound(jobId, agentId);
    }

    function _afterSubmit(uint256 jobId) private {
        uint256 agentId = jobAgent[jobId];
        if (agentId == 0) return;

        uint64 nowTs = uint64(block.timestamp);
        submittedAt[jobId] = nowTs;

        uint64 fundedTs = fundedAt[jobId];
        uint64 elapsed = nowTs > fundedTs ? nowTs - fundedTs : 0;
        emit DeliverySubmitted(jobId, agentId, elapsed);
    }

    /// @param completed True on `complete`, false on `reject`.
    function _afterSettlement(uint256 jobId, bytes calldata data, bool completed) private {
        uint256 agentId = jobAgent[jobId];
        // A job rejected while still Open was never bound to an agent; nothing to record.
        if (agentId == 0) return;

        (bytes32 reason,) = abi.decode(data, (bytes32, bytes));

        Binding memory binding = jobBinding[jobId];

        // A job that cannot earn an attestation does not touch the outcome counters either.
        //
        // The call: `agentRecord` is the surface our own marketplace ranks on, and the UI shows it
        // beside the registry data. If it counted jobs that earned no attestation it would simply be
        // a second reputation channel with the forgery property we just removed from the first one,
        // and the cheaper one to attack. So the counters and the registry agree by construction.
        //
        // `jobsFunded` still increments, because it is a fact about escrow rather than a claim about
        // quality — and the gap between `jobsFunded` and `jobsCompleted + jobsRejected` is then a
        // visible, on-chain signal that somebody is running jobs that do not qualify.
        if (binding.attestability != Attestability.Attestable) {
            if (binding.attestability == Attestability.SelfDealt) {
                emit FeedbackSkippedSelfDealt(jobId, agentId, binding.client);
            } else {
                emit FeedbackSkippedBudgetTooSmall(jobId, agentId, minAttestableBudget);
            }
            emit OutcomeRecorded(jobId, agentId, completed, reason);
            return;
        }

        Record storage record = _records[agentId];

        if (completed) {
            record.jobsCompleted += 1;
            uint64 fundedTs = fundedAt[jobId];
            uint64 submittedTs = submittedAt[jobId];
            if (submittedTs > fundedTs) record.totalDeliverySeconds += submittedTs - fundedTs;
            _writeFeedback(jobId, agentId, 100, COMPLETED_TAG, reason);
        } else {
            record.jobsRejected += 1;
            _writeFeedback(jobId, agentId, 0, REJECTED_TAG, reason);
        }

        emit OutcomeRecorded(jobId, agentId, completed, reason);
    }

    /// @dev Settlement has already moved the money by the time this runs. A Reputation Registry
    ///      failure is surfaced as an event and swallowed; it must never unwind a paid job.
    ///
    ///      Two gas defences, both load-bearing. The `gasleft()` floor stops an under-gassed caller
    ///      from turning the receipt into a silent no-op that is indistinguishable from a registry
    ///      rejection. The explicit stipend stops the reverse: without it EIP-150 hands the registry
    ///      63/64 of everything and leaves this function 1/64 to finish, so a registry that consumes
    ///      its whole allowance could run us out of gas after the money moved.
    function _writeFeedback(uint256 jobId, uint256 agentId, int128 value, string memory tag1, bytes32 reason) private {
        uint256 available = gasleft();
        if (available < MIN_FEEDBACK_GAS) {
            emit FeedbackSkippedInsufficientGas(jobId, agentId, available, MIN_FEEDBACK_GAS);
            return;
        }

        address target = address(reputation);
        bytes memory payload = abi.encodeCall(
            IReputationRegistry.giveFeedback,
            (agentId, value, uint8(0), tag1, HALLMARK_TAG, "", feedbackURI(jobId), reason)
        );

        // Read the meter again rather than reusing `available`. Encoding the payload loads
        // `evidenceBaseURI`, whose length nothing bounds, so a reserve subtracted from the earlier
        // reading would be a reserve this function has already spent.
        uint256 remaining = gasleft();
        if (remaining <= FEEDBACK_EPILOGUE_RESERVE) {
            emit FeedbackSkippedInsufficientGas(jobId, agentId, remaining, MIN_FEEDBACK_GAS);
            return;
        }

        // At least MIN_FEEDBACK_STIPEND in practice, and more whenever the caller was generous. The
        // EVM clamps this to 63/64 of gas at the call site if it ever exceeds it, so requesting more
        // than is available is safe rather than fatal.
        uint256 stipend = remaining - FEEDBACK_EPILOGUE_RESERVE;

        bool ok;
        bytes memory err = new bytes(MAX_FEEDBACK_ERROR_BYTES);
        uint256 cap = MAX_FEEDBACK_ERROR_BYTES;
        assembly ("memory-safe") {
            ok := call(stipend, target, 0, add(payload, 0x20), mload(payload), 0, 0)
            // A bare CALL to an address with no code succeeds; a high-level call would not. Keep the
            // stricter behaviour so a mis-wired or self-destructed registry is reported, not ignored.
            if iszero(extcodesize(target)) { ok := 0 }
            let size := returndatasize()
            if gt(size, cap) { size := cap }
            returndatacopy(add(err, 0x20), 0, size)
            mstore(err, size)
        }

        if (!ok) emit FeedbackWriteFailed(jobId, agentId, err);
    }

    // ---------------------------------------------------------------------
    // Internals: bounded, floored registry reads
    //
    // Every read here obeys the same two rules.
    //
    //   1. Check `gasleft()` against a floor sized for *this* call, immediately before making it.
    //      One global floor checked once at entry cannot size costs that differ per call, and cannot
    //      see the gas the earlier calls have already spent.
    //   2. Hand the call an explicit stipend, so EIP-150's 63/64 rule cannot deliver it less than the
    //      floor just promised.
    //
    // A read that still fails is *indeterminate*, never negative. It reverts. Silently converting
    // "I could not read this" into "there is nothing here" is the bug that made the gate lie.
    // ---------------------------------------------------------------------

    function _requireGas(uint256 required) private view {
        uint256 available = gasleft();
        if (available < required) revert InsufficientGasForEvidenceCheck(available, required);
    }

    /// @dev Reverts `UnknownAgent` only when the registry answers and the answer is "no such agent".
    ///      A read that could not be made reverts `InsufficientGasForEvidenceCheck` instead.
    function _agentOwner(uint256 agentId) private view returns (address) {
        _requireGas(IDENTITY_READ_GAS * 2);
        try identity.ownerOf{gas: IDENTITY_READ_GAS}(agentId) returns (address owner) {
            if (owner == address(0)) revert UnknownAgent(agentId);
            return owner;
        } catch {
            revert UnknownAgent(agentId);
        }
    }

    /// @dev The address a job must pay for its outcome to count as this agent's work: the agent's
    ///      declared wallet, or its owner when it has not declared one. Registration auto-sets the
    ///      wallet to the registrant, so both branches are live against the deployed registry, and an
    ///      agent that has never touched `setAgentWallet` still resolves.
    function _agentPayee(uint256 agentId, address owner) private view returns (address) {
        _requireGas(IDENTITY_READ_GAS * 2);
        try identity.getAgentWallet{gas: IDENTITY_READ_GAS}(agentId) returns (address wallet) {
            if (wallet != address(0)) return wallet;
        } catch {
            // A registry without the accessor is not an error; fall back to the owner.
        }
        return owner;
    }

    function _jobParties(uint256 jobId)
        private
        view
        returns (
            address client,
            address provider,
            address evaluator,
            uint256 budget,
            uint256 expiredAt,
            IAgenticCommerce.JobStatus status
        )
    {
        _requireGas(JOB_READ_GAS * 2);
        try IJobParties(commerce).getJobParties{gas: JOB_READ_GAS}(jobId) returns (
            address c, address p, address e, uint256 b, uint256 x, IAgenticCommerce.JobStatus st
        ) {
            return (c, p, e, b, x, st);
        } catch {
            revert InsufficientGasForEvidenceCheck(gasleft(), JOB_READ_GAS * 2);
        }
    }

    /// @dev The gate's answer. Primary evidence is this contract's own `lastProbeAt`, which is a
    ///      single storage read: O(1), attestor-written, and impossible to starve. Only when the
    ///      probe does not carry the decision does the gate reach for the O(history) Validation
    ///      Registry, and that branch is floored, stipended, and allowed to revert rather than lie.
    function _evaluateEvidence(uint256 agentId) private view returns (bool ok, uint64 lastEvidenceAt, uint8 score) {
        uint256 age = maxEvidenceAge;
        uint8 minScore = minValidationScore;

        Probe storage probe = _probes[agentId];
        // A probe signed by a rotated-out key is not evidence.
        uint64 probedAt = probe.by == attestor ? probe.at : 0;
        uint8 probeScore = probe.by == attestor ? probe.score : 0;
        if (probedAt != 0 && probeScore >= minScore && uint256(probedAt) + age >= block.timestamp) {
            return (true, probedAt, probeScore);
        }

        (bool readOk, bool found, uint64 validatedAt, uint8 validationScore) = _validationEvidence(agentId);
        if (!readOk) revert EvidenceReadFailed(agentId);

        if (found && validationScore >= minScore && uint256(validatedAt) + age >= block.timestamp) {
            return (true, validatedAt, validationScore);
        }

        // Nothing passed. Report the freshest thing actually seen, so the error says something true.
        if (validatedAt > probedAt) return (false, validatedAt, validationScore);
        return (false, probedAt, probeScore);
    }

    /// @dev Bounded scan of the attestor's most recent liveness validations.
    /// @return readOk False when the registry could not be read at all — the caller must treat this
    ///         as unknown, not as absence.
    function _validationEvidence(uint256 agentId)
        private
        view
        returns (bool readOk, bool found, uint64 lastUpdate, uint8 response)
    {
        address att = attestor;
        if (att == address(0)) return (true, false, 0, 0);

        _requireGas(MIN_VALIDATION_READ_GAS);

        bytes32[] memory hashes;
        {
            // Hold back enough for the whole scan window, then give the list read everything else.
            // The reservation is deliberately generous: erring high costs a loud refusal, erring low
            // costs a starved read, and only one of those two is safe.
            uint256 available = gasleft();
            uint256 reserved = VALIDATION_SCAN_LIMIT * VALIDATION_STATUS_READ_GAS;
            uint256 listGas = available > reserved ? available - reserved - (available / 64) : available / 2;

            try validation.getAgentValidations{gas: listGas}(agentId) returns (bytes32[] memory result) {
                hashes = result;
            } catch {
                return (false, false, 0, 0);
            }
        }

        uint256 n = hashes.length;
        uint256 scan = n > VALIDATION_SCAN_LIMIT ? VALIDATION_SCAN_LIMIT : n;

        for (uint256 i = 0; i < scan; ++i) {
            _requireGas(VALIDATION_STATUS_READ_GAS * 2);
            (bool ok, bool matched, uint64 updatedAt, uint8 score) = _readValidation(hashes[n - 1 - i], agentId, att);
            // One unreadable record out of a bounded scan is not grounds to refuse the gate, but it
            // is grounds not to claim the scan was complete.
            if (!ok) return (false, false, 0, 0);
            if (matched && updatedAt > lastUpdate) {
                found = true;
                lastUpdate = updatedAt;
                response = score;
            }
        }

        readOk = true;
    }

    /// @dev Split out of the scan loop purely to keep the six-value registry response off a stack
    ///      that already carries the accumulator.
    function _readValidation(bytes32 requestHash, uint256 agentId, address att)
        private
        view
        returns (bool readOk, bool matched, uint64 lastUpdate, uint8 response)
    {
        try validation.getValidationStatus{gas: VALIDATION_STATUS_READ_GAS}(requestHash) returns (
            address validatorAddress,
            uint256 recordAgentId,
            uint8 recordResponse,
            bytes32,
            string memory tag,
            uint256 recordLastUpdate
        ) {
            readOk = true;
            if (validatorAddress == att && recordAgentId == agentId && recordLastUpdate != 0 && _isLivenessTag(tag)) {
                matched = true;
                // A unix timestamp cannot exceed uint64 within the lifetime of this chain.
                // forge-lint: disable-next-line(unsafe-typecast)
                lastUpdate = uint64(recordLastUpdate);
                response = recordResponse;
            }
        } catch {}
    }

    /// @dev The reputation path filtered on `"reachable"` while the validation path accepted any tag,
    ///      so a code-quality score of 80 opened the liveness gate. Both filter now.
    function _isLivenessTag(string memory tag) private pure returns (bool) {
        bytes32 h = keccak256(bytes(tag));
        return h == keccak256(bytes(LIVENESS_TAG)) || h == keccak256(bytes(REACHABLE_TAG));
    }
}
