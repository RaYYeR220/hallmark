// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {IERC165} from "@openzeppelin/contracts/utils/introspection/IERC165.sol";
import {Strings} from "@openzeppelin/contracts/utils/Strings.sol";

import {IACPHook} from "./interfaces/IACPHook.sol";
import {IAgenticCommerce} from "./interfaces/IAgenticCommerce.sol";
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
    /// @param jobsExpired Funded jobs that ran past their expiry and were refunded.
    /// @param totalDeliverySeconds Sum of funding-to-submission times across completed jobs.
    struct Record {
        uint32 jobsFunded;
        uint32 jobsCompleted;
        uint32 jobsRejected;
        uint32 jobsExpired;
        uint64 totalDeliverySeconds;
    }

    /// @notice Tag the attestor's liveness feedback carries in the Reputation Registry.
    string public constant REACHABLE_TAG = "reachable";

    /// @notice Secondary tag stamped on every feedback entry this hook writes.
    string public constant HALLMARK_TAG = "hallmark";

    /// @notice Tag written on completion.
    string public constant COMPLETED_TAG = "jobcompleted";

    /// @notice Tag written on rejection.
    string public constant REJECTED_TAG = "jobrejected";

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
    uint256 public constant FEEDBACK_EPILOGUE_RESERVE = 20_000;

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

    /// @notice Authoritative freshness clock: when the attestor last probed an agent.
    mapping(uint256 agentId => uint64 timestamp) public lastProbeAt;

    /// @notice Score the attestor reported on its last probe of an agent.
    mapping(uint256 agentId => uint8 score) public lastProbeScore;

    /// @notice Guards `recordExpiry` against double counting.
    mapping(uint256 jobId => bool recorded) public expiryRecorded;

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

    event JobBound(uint256 indexed jobId, uint256 indexed agentId);
    event DeliverySubmitted(uint256 indexed jobId, uint256 indexed agentId, uint64 secondsToDeliver);
    event OutcomeRecorded(uint256 indexed jobId, uint256 indexed agentId, bool completed, bytes32 reason);
    event ExpiryRecorded(uint256 indexed jobId, uint256 indexed agentId);
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

        emit AttestorUpdated(attestor_);
        emit MaxEvidenceAgeUpdated(24 hours);
        emit MinValidationScoreUpdated(50);
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
        _requireAgentExists(agentId);
        lastProbeAt[agentId] = uint64(block.timestamp);
        lastProbeScore[agentId] = score;
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
        if (agentId != 0) {
            _records[agentId].jobsExpired += 1;
            emit ExpiryRecorded(jobId, agentId);
        }
    }

    // ---------------------------------------------------------------------
    // Views
    // ---------------------------------------------------------------------

    /// @notice Aggregate record an agent has earned through settled escrow.
    function agentRecord(uint256 agentId) external view returns (Record memory) {
        return _records[agentId];
    }

    /// @notice Whether an agent could be funded right now, and the evidence behind that answer.
    /// @return ok True if `fund` would pass the evidence gate.
    /// @return lastEvidenceAt Timestamp of the freshest evidence found, zero if none.
    /// @return score Score attached to that freshest evidence.
    function isHireable(uint256 agentId) public view returns (bool ok, uint64 lastEvidenceAt, uint8 score) {
        (bool found, uint64 validatedAt, uint8 validationScore) = _validationEvidence(agentId);
        uint64 probedAt = lastProbeAt[agentId];
        uint8 probeScore = lastProbeScore[agentId];

        uint256 age = maxEvidenceAge;
        uint8 minScore = minValidationScore;

        bool viaValidation = found && validationScore >= minScore && uint256(validatedAt) + age >= block.timestamp;

        bool viaProbe = probedAt != 0 && probeScore >= minScore && uint256(probedAt) + age >= block.timestamp
            && _reputationEvidence(agentId);

        lastEvidenceAt = validatedAt > probedAt ? validatedAt : probedAt;
        score = validatedAt > probedAt ? validationScore : probeScore;
        ok = viaValidation || viaProbe;
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

        // Every read below is wrapped in try/catch, so a starved call would quietly degrade to
        // "no evidence" and refuse a live agent for a reason that has nothing to do with the agent.
        // Refuse loudly instead: an evidence gate that cannot read its evidence must say so.
        uint256 available = gasleft();
        if (available < MIN_EVIDENCE_GAS) revert InsufficientGasForEvidenceCheck(available, MIN_EVIDENCE_GAS);

        _requireAgentExists(agentId);

        (bool ok, uint64 lastEvidenceAt,) = isHireable(agentId);
        if (!ok) revert NoFreshEvidence(agentId, lastEvidenceAt);

        jobAgent[jobId] = agentId;
    }

    function _afterFund(uint256 jobId) private {
        uint256 agentId = jobAgent[jobId];
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

        // At least MIN_FEEDBACK_STIPEND by construction, and more whenever the caller was generous.
        // The EVM clamps this to 63/64 of gas at the call site if it ever exceeds it, so requesting
        // more than is available is safe rather than fatal.
        uint256 stipend = available - FEEDBACK_EPILOGUE_RESERVE;

        try reputation.giveFeedback{gas: stipend}(
            agentId, value, 0, tag1, HALLMARK_TAG, "", feedbackURI(jobId), reason
        ) {}
        catch (bytes memory err) {
            emit FeedbackWriteFailed(jobId, agentId, err);
        }
    }

    function _requireAgentExists(uint256 agentId) private view {
        try identity.ownerOf(agentId) returns (address owner) {
            if (owner == address(0)) revert UnknownAgent(agentId);
        } catch {
            revert UnknownAgent(agentId);
        }
    }

    /// @dev Walks back over the agent's most recent validation records looking for the freshest one
    ///      written by the attestor. Bounded by `VALIDATION_SCAN_LIMIT`; wrapped in `try/catch` so a
    ///      registry that misbehaves degrades to "no validation evidence" rather than reverting the
    ///      gate for reasons unrelated to the agent.
    function _validationEvidence(uint256 agentId) private view returns (bool found, uint64 lastUpdate, uint8 response) {
        address att = attestor;
        if (att == address(0)) return (false, 0, 0);

        try validation.getAgentValidations(agentId) returns (bytes32[] memory hashes) {
            uint256 n = hashes.length;
            uint256 scan = n > VALIDATION_SCAN_LIMIT ? VALIDATION_SCAN_LIMIT : n;
            for (uint256 i = 0; i < scan; ++i) {
                bytes32 requestHash = hashes[n - 1 - i];
                try validation.getValidationStatus(requestHash) returns (
                    address validatorAddress,
                    uint256 recordAgentId,
                    uint8 recordResponse,
                    bytes32,
                    string memory,
                    uint256 recordLastUpdate
                ) {
                    if (
                        validatorAddress == att && recordAgentId == agentId && recordLastUpdate != 0
                            && recordLastUpdate > uint256(lastUpdate)
                    ) {
                        found = true;
                        // A unix timestamp cannot exceed uint64 within the lifetime of this chain.
                        // forge-lint: disable-next-line(unsafe-typecast)
                        lastUpdate = uint64(recordLastUpdate);
                        response = recordResponse;
                    }
                } catch {}
            }
        } catch {
            return (false, 0, 0);
        }
    }

    /// @dev Standard-visible half of the probe: the attestor's `"reachable"` feedback in the
    ///      Reputation Registry. Carries no timestamp, so it is only ever used together with
    ///      `lastProbeAt`.
    function _reputationEvidence(uint256 agentId) private view returns (bool) {
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
}
