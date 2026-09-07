// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {Vm} from "forge-std/Vm.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

import {Base} from "./Base.t.sol";
import {AgenticCommerceHooked} from "../src/AgenticCommerceHooked.sol";
import {HallmarkHook} from "../src/HallmarkHook.sol";
import {IAgenticCommerce} from "../src/interfaces/IAgenticCommerce.sol";
import {IValidationRegistry} from "../src/interfaces/IValidationRegistry.sol";
import {MockReputationRegistry} from "./mocks/MockReputationRegistry.sol";
import {MockValidationRegistry} from "./mocks/MockValidationRegistry.sol";
import {GasBurningReputationRegistry} from "./mocks/GasBurningReputationRegistry.sol";

// ---------------------------------------------------------------------------
// Adversarial mocks used only by this file.
// ---------------------------------------------------------------------------

/// @notice A Validation Registry whose per-agent request list can be grown to any length, with a
///         genuine, fresh, passing attestor record sitting at the end of the list.
contract BloatedValidationRegistry is IValidationRegistry {
    mapping(uint256 => bytes32[]) private _requests;
    bytes32 public goodHash;
    address public validator;
    uint256 public goodAgent;

    function spam(uint256 agentId, uint256 count) external {
        for (uint256 i = 0; i < count; ++i) {
            _requests[agentId].push(keccak256(abi.encode(agentId, i, block.number)));
        }
    }

    function seedGoodRecord(address validator_, uint256 agentId) external {
        validator = validator_;
        goodAgent = agentId;
        goodHash = keccak256(abi.encode("good", agentId));
        _requests[agentId].push(goodHash);
    }

    function getAgentValidations(uint256 agentId) external view returns (bytes32[] memory) {
        return _requests[agentId];
    }

    function getValidationStatus(bytes32 requestHash)
        external
        view
        returns (address, uint256, uint8, bytes32, string memory, uint256)
    {
        if (requestHash == goodHash && goodHash != bytes32(0)) {
            return (validator, goodAgent, 90, bytes32(uint256(1)), "liveness", block.timestamp);
        }
        return (address(0), 0, 0, bytes32(0), "", 0);
    }

    function getSummary(uint256, address[] calldata, string calldata) external pure returns (uint64, uint8) {
        return (0, 0);
    }

    function validationRequest(address, uint256, string calldata, bytes32) external {}
    function validationResponse(bytes32, uint8, string calldata, bytes32, string calldata) external {}
}

/// @notice An ERC-20 with a USDC/USDT-style transfer blacklist.
contract BlacklistERC20 is ERC20 {
    mapping(address => bool) public blocked;

    constructor() ERC20("Blacklistable", "BL") {}

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }

    function setBlocked(address account, bool value) external {
        blocked[account] = value;
    }

    function _update(address from, address to, uint256 value) internal override {
        require(!blocked[from] && !blocked[to], "blacklisted");
        super._update(from, to, value);
    }
}

// ---------------------------------------------------------------------------

/// @notice Adversarial proofs-of-concept written during the pre-mainnet self-audit.
contract AuditPoCTest is Base {
    address internal attacker = makeAddr("attacker");
    address internal victimAgentOwner = makeAddr("victimAgentOwner");

    uint256 internal constant VICTIM_AGENT = 4242;

    bytes32 internal constant _FAILED_TOPIC = keccak256("FeedbackWriteFailed(uint256,uint256,bytes)");

    function setUp() public override {
        super.setUp();
        identity.register(VICTIM_AGENT, victimAgentOwner);
        token.mint(attacker, 1_000e18);
        vm.prank(attacker);
        token.approve(address(commerce), type(uint256).max);
    }

    // =====================================================================
    // F-01  Anyone can write arbitrary ERC-8004 reputation for any hireable
    //       agent, because nothing binds the declared agent id to the paid
    //       provider and nothing stops one address holding all three roles.
    // =====================================================================

    /// @dev One EOA is client, provider and evaluator. The agent id it declares belongs to a third
    ///      party it has never interacted with. Net token cost: zero.
    function test_PoC_F01_NegativeFeedbackForgedAgainstAThirdPartyAgent() public {
        // The victim is a live, well-behaved agent that Hallmark actively probes.
        _probe(VICTIM_AGENT, 99);

        uint256 balanceBefore = token.balanceOf(attacker);
        assertEq(reputation.entryCount(VICTIM_AGENT), 1, "only the attestor's reachable entry so far");

        vm.startPrank(attacker);
        uint256 jobId = commerce.createJob(attacker, attacker, block.timestamp + 1 hours, "nothing", address(hook));
        commerce.setBudget(jobId, 1, "");

        // FIXED. The gate now requires the declared agent to be the party this job pays. The
        // attacker pays himself, so the only agents he can declare are ones whose on-chain payee he
        // controls -- never the victim's.
        vm.expectRevert(
            abi.encodeWithSelector(
                HallmarkHook.AgentProviderMismatch.selector,
                VICTIM_AGENT,
                identity.getAgentWallet(VICTIM_AGENT),
                attacker
            )
        );
        commerce.fund(jobId, 1, abi.encode(VICTIM_AGENT));
        vm.stopPrank();

        assertEq(reputation.entryCount(VICTIM_AGENT), 1, "no entry was forged against the victim");
        assertEq(hook.agentRecord(VICTIM_AGENT).jobsRejected, 0, "and Hallmark's own record is clean");
        assertEq(hook.agentRecord(VICTIM_AGENT).jobsFunded, 0);
        assertEq(token.balanceOf(attacker), balanceBefore);
    }

    /// @dev The mirror image: mint a flawless record for an agent you control. Blocked twice over
    ///      now -- by the payee binding for anyone else's agent, and by the self-dealing check for
    ///      your own.
    function test_PoC_F01_PositiveRecordForgedForYourOwnAgent() public {
        // The attacker owns an agent outright: he is its owner, its wallet, and the job's provider.
        uint256 ownAgent = 5150;
        identity.register(ownAgent, attacker);
        identity.setAgentWallet(ownAgent, attacker);
        _probe(ownAgent, 99);

        vm.startPrank(attacker);
        for (uint256 i = 0; i < 5; ++i) {
            uint256 jobId = commerce.createJob(attacker, attacker, block.timestamp + 1 hours, "self", address(hook));
            commerce.setBudget(jobId, 1e18, "");
            commerce.fund(jobId, 1e18, abi.encode(ownAgent));
            commerce.submit(jobId, keccak256("deliverable"), "");
            commerce.complete(jobId, keccak256("great work"), "");
        }
        vm.stopPrank();

        // The escrow still works. Self-dealing is not forbidden; it simply earns nothing.
        HallmarkHook.Record memory record = hook.agentRecord(ownAgent);
        assertEq(record.jobsFunded, 5, "escrow events are still recorded, because they are facts");
        assertEq(record.jobsCompleted, 0, "but no completion is credited");
        assertEq(record.jobsRejected, 0);

        address[] memory clients = new address[](1);
        clients[0] = address(hook);
        (uint64 count,,) = reputation.getSummary(ownAgent, clients, "jobcompleted", "");
        assertEq(count, 0, "and not one receipt reached the public registry");
    }

    /// @dev Self-dealing is reported, not silently dropped, and the money path is untouched.
    function test_Fixed_F01_SelfDealtJobSettlesButEarnsNoAttestation() public {
        uint256 ownAgent = 5151;
        identity.register(ownAgent, attacker);
        identity.setAgentWallet(ownAgent, attacker);
        _probe(ownAgent, 99);

        vm.startPrank(attacker);
        uint256 jobId = commerce.createJob(attacker, attacker, block.timestamp + 1 hours, "self", address(hook));
        commerce.setBudget(jobId, 1e18, "");
        commerce.fund(jobId, 1e18, abi.encode(ownAgent));
        commerce.submit(jobId, keccak256("d"), "");

        vm.expectEmit(true, true, false, true, address(hook));
        emit HallmarkHook.FeedbackSkippedSelfDealt(jobId, ownAgent, attacker);
        commerce.complete(jobId, keccak256("great work"), "");
        vm.stopPrank();

        assertEq(uint8(_status(jobId)), uint8(IAgenticCommerce.JobStatus.Completed), "settlement is unaffected");
        assertEq(reputation.entryCount(ownAgent), 1, "only the attestor's own reachable mirror");
    }

    /// @dev A dust job earns nothing either, however arm's length it is.
    function test_Fixed_F01_DustJobEarnsNoAttestation() public {
        _probe(AGENT_ID, 99);

        uint256 jobId = _createAndBudget(address(hook), 1);
        vm.prank(client);
        commerce.fund(jobId, 1, abi.encode(AGENT_ID));
        vm.prank(provider);
        commerce.submit(jobId, bytes32(0), "");

        vm.expectEmit(true, true, false, true, address(hook));
        emit HallmarkHook.FeedbackSkippedBudgetTooSmall(jobId, AGENT_ID, hook.minAttestableBudget());
        vm.prank(evaluator);
        commerce.complete(jobId, bytes32(0), "");

        assertEq(hook.agentRecord(AGENT_ID).jobsCompleted, 0);
        assertEq(reputation.entryCount(AGENT_ID), 1, "nothing written for a one-wei job");
    }

    /// @dev FIXED. Credit and payment must now point at the same party. Declaring an agent whose
    ///      on-chain payee is not the job's provider is refused before any money moves.
    function test_PoC_F01_PaymentAndReputationCanPointAtDifferentParties() public {
        _probe(VICTIM_AGENT, 99);

        // An ordinary, honest client hires `provider` but declares somebody else's agent.
        uint256 jobId = _createAndBudget(address(hook), BUDGET);
        // Resolved before the prank: an external call in the argument list would consume it.
        address victimPayee = identity.getAgentWallet(VICTIM_AGENT);

        vm.prank(client);
        vm.expectRevert(
            abi.encodeWithSelector(HallmarkHook.AgentProviderMismatch.selector, VICTIM_AGENT, victimPayee, provider)
        );
        commerce.fund(jobId, BUDGET, abi.encode(VICTIM_AGENT));

        assertEq(hook.jobAgent(jobId), 0, "no binding was recorded");
        assertEq(token.balanceOf(address(commerce)), 0, "and no escrow was taken");
    }

    /// @dev The binding accepts an agent that has never declared a wallet, falling back to its owner.
    function test_Fixed_F01_BindingFallsBackToTheAgentOwner() public {
        uint256 walletlessAgent = 6060;
        identity.register(walletlessAgent, provider);
        identity.setAgentWallet(walletlessAgent, address(0));
        _probe(walletlessAgent, 99);

        uint256 jobId = _createAndBudget(address(hook), BUDGET);
        vm.prank(client);
        commerce.fund(jobId, BUDGET, abi.encode(walletlessAgent));

        assertEq(hook.jobAgent(jobId), walletlessAgent, "ownerOf carries the binding when no wallet is set");
    }

    // =====================================================================
    // F-02  Confirmed, and FIXED during this audit. A Reputation Registry that
    //       burns its stipend and then reverts with a large return-data blob
    //       used to run the hook out of gas inside its own catch handler and
    //       revert a settlement it is forbidden from blocking.
    //
    //       The proof now lives in the shipped suite as a regression test, so
    //       it runs on every build:
    //         HallmarkHookTest.test_Complete_SurvivesARegistryThatRevertsWithAReturnDataBomb
    //         HallmarkHookTest.test_Complete_SurvivesAReturnDataBombOfAnySize
    //         HallmarkHookTest.test_Reject_SurvivesARegistryThatRevertsWithAReturnDataBomb
    //         HallmarkHookTest.test_FeedbackWriteFailed_ErrorDataIsBounded
    //       All four fail against the pre-fix `_writeFeedback`.
    // =====================================================================

    // =====================================================================
    // F-03  `FEEDBACK_EPILOGUE_RESERVE` is measured before an unbounded amount
    //       of work (the owner-set evidence base URI), so the reserve the
    //       contract believes it holds back is not the reserve it gets.
    // =====================================================================

    /// @dev Binary-search the minimum gas limit at which `complete` survives a gas-burning registry,
    ///      as a function of the owner-set base URI length. The reserve is a constant; the work it
    ///      is measured across is not.
    function test_PoC_F03_MinimumSafeGasDependsOnAnOwnerSetString() public {
        uint256[3] memory lengths = [uint256(0), 256, 2048];
        for (uint256 i = 0; i < lengths.length; ++i) {
            uint256 firstBad = 0;
            uint256 lastBad = 0;
            // Sweep the whole band in which the write is attempted rather than skipped.
            for (uint256 g = 260_000; g <= 900_000; g += 20_000) {
                if (!_completeSucceedsAt(lengths[i], g)) {
                    if (firstBad == 0) firstBad = g;
                    lastBad = g;
                }
            }
            emit log_named_string(
                string.concat("baseURI length ", vm.toString(lengths[i])),
                firstBad == 0
                    ? "no reverting gas limit found in 260k-900k"
                    : string.concat("complete REVERTS from ", vm.toString(firstBad), " to ", vm.toString(lastBad))
            );
        }
    }

    function _completeSucceedsAt(uint256 uriLength, uint256 gasLimit) private returns (bool) {
        uint256 snap = vm.snapshotState();
        GasBurningReputationRegistry burner = new GasBurningReputationRegistry();
        HallmarkHook gasHook =
            new HallmarkHook(address(commerce), address(identity), address(burner), address(validation), attestor);
        commerce.setHookWhitelisted(address(gasHook), true);
        if (uriLength != 0) gasHook.setEvidenceBaseURI(_repeat("a", uriLength));

        _validate(attestor, AGENT_ID, 90);

        vm.startPrank(client);
        uint256 jobId = commerce.createJob(provider, evaluator, block.timestamp + JOB_DURATION, "j", address(gasHook));
        commerce.setBudget(jobId, 1e18, "");
        commerce.fund(jobId, 1e18, abi.encode(AGENT_ID));
        vm.stopPrank();
        vm.prank(provider);
        commerce.submit(jobId, bytes32(0), "");

        vm.prank(evaluator);
        (bool ok,) =
            address(commerce).call{gas: gasLimit}(abi.encodeCall(IAgenticCommerce.complete, (jobId, bytes32(0), "")));
        vm.revertToState(snap);
        return ok;
    }

    // =====================================================================
    // F-04  Both evidence reads are O(history), not O(1) or O(8). The gate's
    //       gas floor is calibrated against a history size nothing enforces,
    //       so a read that runs out of gas is swallowed by its own try/catch
    //       and a live agent is declared dead.
    // =====================================================================

    /// @dev `VALIDATION_SCAN_LIMIT` bounds the number of `getValidationStatus` calls, not the cost of
    ///      returning and decoding the array it scans.
    function test_PoC_F04a_ScanLimitDoesNotBoundTheArrayCost() public {
        BloatedValidationRegistry bloat = new BloatedValidationRegistry();
        HallmarkHook bloatHook =
            new HallmarkHook(address(commerce), address(identity), address(reputation), address(bloat), attestor);

        uint256[4] memory counts = [uint256(8), 250, 1_000, 5_000];
        for (uint256 i = 0; i < counts.length; ++i) {
            uint256 agentId = 900_000 + i;
            identity.register(agentId, agentOwner);
            bloat.spam(agentId, counts[i]);

            uint256 before = gasleft();
            bloatHook.isHireable(agentId);
            uint256 used = before - gasleft();
            emit log_named_uint(string.concat("isHireable gas @ ", vm.toString(counts[i]), " records"), used);
        }
    }

    /// @dev The gate answers "no fresh evidence" for an agent that provably has fresh evidence, purely
    ///      because the read was starved. `MIN_EVIDENCE_GAS` passed, so the loud refusal never fired.
    function test_PoC_F04b_StarvedValidationReadSilentlyDeclaresALiveAgentDead() public {
        BloatedValidationRegistry bloat = new BloatedValidationRegistry();
        HallmarkHook bloatHook =
            new HallmarkHook(address(commerce), address(identity), address(reputation), address(bloat), attestor);
        commerce.setHookWhitelisted(address(bloatHook), true);

        bloat.spam(AGENT_ID, 2_000);
        bloat.seedGoodRecord(attestor, AGENT_ID);

        // Read with effectively unlimited gas: the agent is hireable, on fresh attestor evidence.
        (bool okView,, uint8 score) = bloatHook.isHireable(AGENT_ID);
        assertTrue(okView, "the agent genuinely has fresh, passing attestor evidence");
        assertEq(score, 90);

        vm.startPrank(client);
        uint256 jobId = commerce.createJob(provider, evaluator, block.timestamp + JOB_DURATION, "j", address(bloatHook));
        commerce.setBudget(jobId, BUDGET, "");
        vm.stopPrank();

        // Sweep the gas limits a wallet would plausibly send and classify each failure.
        uint256 loud;
        uint256 silent;
        uint256 opaque;
        for (uint256 g = 300_000; g <= 3_000_000; g += 100_000) {
            uint256 snap = vm.snapshotState();
            vm.prank(client);
            (bool ok, bytes memory err) = address(commerce).call{gas: g}(
                abi.encodeCall(IAgenticCommerce.fund, (jobId, BUDGET, abi.encode(AGENT_ID)))
            );
            if (ok) {
                vm.revertToState(snap);
                continue;
            }
            // Taking the leading selector off revert data is the point of the cast.
            // forge-lint: disable-next-line(unsafe-typecast)
            bytes4 sel = err.length >= 4 ? bytes4(err) : bytes4(0);
            if (sel == HallmarkHook.InsufficientGasForEvidenceCheck.selector) loud++;
            else if (sel == HallmarkHook.NoFreshEvidence.selector) silent++;
            else opaque++;
            vm.revertToState(snap);
        }
        emit log_named_uint("limits refused loudly (InsufficientGasForEvidenceCheck)", loud);
        emit log_named_uint("limits that LIED (NoFreshEvidence on a live agent)", silent);
        emit log_named_uint("limits that failed opaquely (out of gas)", opaque);
        assertGt(silent + opaque, 0, "a live agent could not be funded");
    }

    /// @dev The same shape on the probe path, which is the one Hallmark actually uses. The prober
    ///      mirrors every probe as a `"reachable"` feedback entry, and `getSummary` walks all of that
    ///      client's entries on every read, so Hallmark's own prober grows the cost of its own gate.
    function test_PoC_F04c_ProbeMirrorHistoryGrowsTheGateUnbounded() public {
        uint256[4] memory counts = [uint256(1), 25, 100, 400];
        for (uint256 i = 0; i < counts.length; ++i) {
            uint256 agentId = 800_000 + i;
            identity.register(agentId, agentOwner);
            vm.startPrank(attestor);
            hook.recordProbe(agentId, 99);
            for (uint256 j = 0; j < counts[i]; ++j) {
                reputation.giveFeedback(agentId, 1, 0, "reachable", "hallmark", "", "", bytes32(0));
            }
            vm.stopPrank();

            uint256 before = gasleft();
            (bool ok,,) = hook.isHireable(agentId);
            uint256 used = before - gasleft();
            assertTrue(ok);
            emit log_named_uint(string.concat("isHireable gas @ ", vm.toString(counts[i]), " probe mirrors"), used);
        }
    }

    /// @dev FIXED. The gate's primary evidence is now the hook's own `lastProbeAt` slot, which is
    ///      one storage read. Our prober's mirror history is no longer on the funding path at all,
    ///      so it cannot grow the gate out of gas however long it gets.
    function test_PoC_F04c_FundFailsOnceTheProbeHistoryIsLongEnough() public {
        vm.startPrank(attestor);
        hook.recordProbe(AGENT_ID, 99);
        for (uint256 j = 0; j < 3_000; ++j) {
            reputation.giveFeedback(AGENT_ID, 1, 0, "reachable", "hallmark", "", "", bytes32(0));
        }
        vm.stopPrank();

        (bool okView,,) = hook.isHireable(AGENT_ID);
        assertTrue(okView, "the agent is hireable");

        uint256 jobId = _createAndBudget(address(hook), BUDGET);
        vm.prank(client);
        commerce.fund{gas: 900_000}(jobId, BUDGET, abi.encode(AGENT_ID));

        assertEq(uint8(_status(jobId)), uint8(IAgenticCommerce.JobStatus.Funded), "3,000 mirrors, still funded");
    }

    // =====================================================================
    // F-05  A provider who delivered has no protection: at `expiredAt` anyone
    //       can refund the client, and the agent is then marked as having
    //       expired the job.
    // =====================================================================

    function test_PoC_F05_DeliveredWorkIsRefundedAwayAndTheAgentIsBlamed() public {
        _probe(AGENT_ID, 99);
        uint256 clientBefore = token.balanceOf(client);
        uint256 jobId = _createFundedJob();

        vm.warp(block.timestamp + JOB_DURATION - 1 hours);
        vm.prank(provider);
        commerce.submit(jobId, keccak256("the finished work"), "");

        // The evaluator does nothing and the client reaches for the escrow at expiry.
        vm.warp(block.timestamp + 1 hours);

        // FIXED. Delivery bought the evaluator a guaranteed window, so the refund is refused.
        uint256 deadline = commerce.evaluationDeadline(jobId);
        assertGt(deadline, commerce.getJob(jobId).expiredAt, "submitting pushed the refund out");

        vm.prank(client);
        vm.expectRevert(abi.encodeWithSelector(AgenticCommerceHooked.EvaluationWindowOpen.selector, jobId, deadline));
        commerce.claimRefund(jobId);

        // The evaluator can still settle, and the provider is paid for work it delivered.
        vm.prank(evaluator);
        commerce.complete(jobId, keccak256("delivered"), "");

        uint256 fee = (BUDGET * FEE_BPS) / commerce.BPS_DENOMINATOR();
        assertEq(token.balanceOf(provider), BUDGET - fee, "delivered and paid");
        assertEq(token.balanceOf(client), clientBefore - BUDGET);
        assertEq(hook.agentRecord(AGENT_ID).jobsExpired, 0, "no blame on the agent");
        assertEq(hook.agentRecord(AGENT_ID).jobsCompleted, 1);
    }

    /// @dev And when the evaluator really never acts, the eventual expiry is booked against the
    ///      evaluator, not the agent that delivered.
    function test_Fixed_F05_ExpiryAfterDeliveryIsNotTheAgentsFault() public {
        _probe(AGENT_ID, 99);
        uint256 jobId = _createFundedJob();

        vm.prank(provider);
        commerce.submit(jobId, keccak256("the finished work"), "");

        vm.warp(commerce.evaluationDeadline(jobId));
        commerce.claimRefund(jobId);

        vm.expectEmit(true, true, false, true, address(hook));
        emit HallmarkHook.ExpiryRecorded(jobId, AGENT_ID, true);
        hook.recordExpiry(jobId);

        HallmarkHook.Record memory record = hook.agentRecord(AGENT_ID);
        assertEq(record.jobsExpired, 0, "the agent did not let this lapse");
        assertEq(record.jobsStalled, 1, "the evaluator did");
    }

    /// @dev `complete` has no expiry check, so settlement of a delivered job is a race the client
    ///      can always win by front-running the evaluator at `expiredAt`.
    function test_PoC_F05_ClaimRefundFrontRunsCompleteAtExpiry() public {
        _probe(AGENT_ID, 99);
        uint256 jobId = _createFundedJob();
        vm.prank(provider);
        commerce.submit(jobId, bytes32(0), "");

        vm.warp(commerce.getJob(jobId).expiredAt);

        // FIXED. At `expiredAt` the delivered job is still inside the evaluator's window, so the
        // race the client used to win no longer exists.
        vm.prank(client);
        vm.expectPartialRevert(AgenticCommerceHooked.EvaluationWindowOpen.selector);
        commerce.claimRefund(jobId);

        vm.prank(evaluator);
        commerce.complete(jobId, bytes32(0), "");
        assertEq(uint8(_status(jobId)), uint8(IAgenticCommerce.JobStatus.Completed));
    }

    // =====================================================================
    // F-06  The platform fee is read at settlement, not snapshotted at funding.
    // =====================================================================

    function test_PoC_F06_OwnerCanRaiseTheFeeOnAlreadyEscrowedJobs() public {
        _probe(AGENT_ID, 99);
        uint256 jobId = _createFundedJob();
        vm.prank(provider);
        commerce.submit(jobId, bytes32(0), "");

        // The provider accepted work priced at a 2.5% fee.
        assertEq(commerce.feeBps(), 250);
        assertEq(commerce.jobFeeBps(jobId), 250, "the rate was fixed when the escrow was funded");

        commerce.setPlatformFee(1000); // owner raises the fee mid-flight

        vm.prank(evaluator);
        commerce.complete(jobId, bytes32(0), "");

        // FIXED. Settlement uses the snapshot, so the deal the provider accepted is the deal it gets.
        assertEq(token.balanceOf(provider), BUDGET * 9750 / 10_000, "paid at the agreed 2.5%");
        assertEq(token.balanceOf(treasury), BUDGET * 250 / 10_000);
        assertEq(commerce.feeBps(), 1000, "the new rate applies to jobs funded from now on");
    }

    // =====================================================================
    // F-07  A payment token with a transfer blacklist locks escrow permanently
    //       (no rescue path) and one blocked treasury bricks every completion.
    // =====================================================================

    function test_PoC_F07_BlockedClientLocksTheEscrowForever() public {
        (AgenticCommerceHooked esc, BlacklistERC20 bt) = _blacklistFixture();

        vm.startPrank(client);
        uint256 jobId = esc.createJob(provider, evaluator, block.timestamp + JOB_DURATION, "j", address(0));
        esc.setBudget(jobId, BUDGET, "");
        esc.fund(jobId, BUDGET, "");
        vm.stopPrank();

        bt.setBlocked(client, true);

        vm.warp(block.timestamp + JOB_DURATION);
        vm.expectRevert(bytes("blacklisted"));
        esc.claimRefund(jobId);

        vm.prank(evaluator);
        vm.expectRevert(bytes("blacklisted"));
        esc.reject(jobId, bytes32(0), "");

        assertEq(bt.balanceOf(address(esc)), BUDGET, "escrow is stuck with no sweep and no pull path");
    }

    function test_PoC_F07_BlockedTreasuryBricksEveryCompletion() public {
        (AgenticCommerceHooked esc, BlacklistERC20 bt) = _blacklistFixture();

        vm.startPrank(client);
        uint256 jobId = esc.createJob(provider, evaluator, block.timestamp + JOB_DURATION, "j", address(0));
        esc.setBudget(jobId, BUDGET, "");
        esc.fund(jobId, BUDGET, "");
        vm.stopPrank();
        vm.prank(provider);
        esc.submit(jobId, bytes32(0), "");

        bt.setBlocked(treasury, true);

        vm.prank(evaluator);
        vm.expectRevert(bytes("blacklisted"));
        esc.complete(jobId, bytes32(0), "");
    }

    function _blacklistFixture() private returns (AgenticCommerceHooked esc, BlacklistERC20 bt) {
        bt = new BlacklistERC20();
        esc = new AgenticCommerceHooked(address(bt), treasury, 250);
        bt.mint(client, 1_000_000e18);
        vm.prank(client);
        bt.approve(address(esc), type(uint256).max);
    }

    // =====================================================================
    // F-08  Accounting edges.
    // =====================================================================

    /// @dev The fee floors, so any budget below `BPS_DENOMINATOR / feeBps` pays no fee at all.
    function test_PoC_F08_FeeRoundsToZeroOnSmallBudgets() public {
        uint256 jobId = _createAndBudget(address(0), 39); // 39 * 250 / 10000 == 0
        vm.prank(client);
        commerce.fund(jobId, 39, "");
        vm.prank(provider);
        commerce.submit(jobId, bytes32(0), "");
        vm.prank(evaluator);
        commerce.complete(jobId, bytes32(0), "");

        assertEq(token.balanceOf(treasury), 0, "no fee at all");
        assertEq(token.balanceOf(provider), 39);
    }

    /// @dev The shipped invariant asserts equality; a bare transfer breaks it and the surplus can
    ///      never be recovered.
    function test_PoC_F08_DonatedTokensAreStrandedForever() public {
        vm.prank(client);
        // forge-lint: disable-next-line(erc20-unchecked-transfer)
        token.transfer(address(commerce), 5e18);

        assertEq(commerce.escrowedTotal(), 0);
        assertEq(token.balanceOf(address(commerce)), 5e18, "balance != escrowedTotal, with no sweep");
    }

    /// @dev The provider can veto funding indefinitely by moving the budget under the client.
    function test_PoC_F08_ProviderCanVetoFunding() public {
        uint256 jobId = _createAndBudget(address(0), BUDGET);
        vm.prank(provider);
        commerce.setBudget(jobId, BUDGET + 1, "");

        vm.prank(client);
        vm.expectRevert(abi.encodeWithSelector(AgenticCommerceHooked.BudgetMismatch.selector, BUDGET, BUDGET + 1));
        commerce.fund(jobId, BUDGET, "");
    }

    /// @dev `escrowedTotal` is linear in `jobCount` and has no upper bound.
    function test_PoC_F08_EscrowedTotalIsUnbounded() public {
        for (uint256 i = 0; i < 400; ++i) {
            vm.prank(client);
            commerce.createJob(provider, evaluator, block.timestamp + JOB_DURATION, "", address(0));
        }
        uint256 before = gasleft();
        commerce.escrowedTotal();
        emit log_named_uint("escrowedTotal gas at 400 jobs", before - gasleft());
    }

    // =====================================================================
    // F-09  The view surface the indexer reads can describe evidence that did
    //       not produce the answer it reports.
    // =====================================================================

    /// @dev `ok` comes from whichever path passed; `lastEvidenceAt` and `score` come from whichever
    ///      evidence is newer. When those differ the view reports a score that failed the gate next
    ///      to an `ok` that a different, older piece of evidence earned.
    /// @dev FIXED. The view now returns the evidence that actually satisfied the gate, not whichever
    ///      record happened to be newest.
    function test_PoC_F09_IsHireableReportsEvidenceThatDidNotEarnTheAnswer() public {
        uint64 probedAt = uint64(block.timestamp);
        _probe(AGENT_ID, 99); // passing probe, now
        vm.warp(block.timestamp + 1 hours);
        _validate(attestor, AGENT_ID, 30); // fresher validation, below minValidationScore

        (bool ok, uint64 lastEvidenceAt, uint8 score) = hook.isHireable(AGENT_ID);
        assertTrue(ok, "hireable, on the strength of the probe");
        assertEq(score, 99, "and the score reported is the one that earned it");
        assertGe(score, hook.minValidationScore());
        assertEq(lastEvidenceAt, probedAt, "pointing at the record that passed");
    }

    /// @dev The two evidence paths disagree about whether the tag matters. The reputation path
    ///      filters on `"reachable"`; the validation path accepts any attestor record whatever its
    ///      tag, so an attestation about something other than liveness counts as proof of life.
    function test_PoC_F09_ValidationPathIgnoresTheTag() public {
        bytes32 requestHash = keccak256("code-quality-review");
        vm.startPrank(attestor);
        validation.validationRequest(attestor, AGENT_ID, "ipfs://x", requestHash);
        validation.validationResponse(requestHash, 80, "ipfs://y", bytes32(uint256(1)), "code-quality");
        vm.stopPrank();

        // FIXED. The validation path filters on a liveness tag, the way the reputation path always
        // did, so an attestation about something else is not proof of life.
        (bool ok,,) = hook.isHireable(AGENT_ID);
        assertFalse(ok, "a code-quality attestation is not a liveness attestation");

        // The same record, tagged as liveness, does open the gate.
        bytes32 liveHash = keccak256("liveness-probe");
        vm.startPrank(attestor);
        validation.validationRequest(attestor, AGENT_ID, "ipfs://x", liveHash);
        validation.validationResponse(liveHash, 80, "ipfs://y", bytes32(uint256(1)), "liveness");
        vm.stopPrank();

        (bool okNow,, uint8 score) = hook.isHireable(AGENT_ID);
        assertTrue(okNow);
        assertEq(score, 80);
    }

    // =====================================================================
    // F-04  FIXED. The gate can no longer answer "no evidence" because it ran
    //       out of gas. Primary evidence is an O(1) storage read; the O(history)
    //       validation branch is floored, stipended, and reverts loudly rather
    //       than degrading into a false negative.
    // =====================================================================

    /// @dev The regression the auditor asked for. A demonstrably live agent is put behind a large
    ///      validation history and a large probe-mirror history, and every gas limit across a wide
    ///      sweep is checked. `fund` may succeed, and it may refuse loudly because it could not
    ///      afford to read. It must never claim the agent has no evidence.
    function test_Fixed_F04_GateNeverLiesUnderAnyGasLimit() public {
        BloatedValidationRegistry bloat = new BloatedValidationRegistry();
        HallmarkHook gateHook =
            new HallmarkHook(address(commerce), address(identity), address(reputation), address(bloat), attestor);
        commerce.setHookWhitelisted(address(gateHook), true);

        uint256 agentId = 777_001;
        _registerAgent(agentId, provider);
        bloat.spam(agentId, 1_200);
        bloat.seedGoodRecord(attestor, agentId);

        // Self-inflicted history too: our own prober mirrors every probe into the registry.
        vm.startPrank(attestor);
        for (uint256 i = 0; i < 400; ++i) {
            reputation.giveFeedback(agentId, 1, 0, "reachable", "hallmark", "", "", bytes32(0));
        }
        vm.stopPrank();

        uint256 funded;
        uint256 refusedLoudly;

        for (uint256 g = 300_000; g <= 3_000_000; g += 100_000) {
            uint256 snap = vm.snapshotState();

            vm.startPrank(client);
            uint256 jobId =
                commerce.createJob(provider, evaluator, block.timestamp + JOB_DURATION, "j", address(gateHook));
            commerce.setBudget(jobId, BUDGET, "");
            (bool ok, bytes memory err) = address(commerce).call{gas: g}(
                abi.encodeCall(IAgenticCommerce.fund, (jobId, BUDGET, abi.encode(agentId)))
            );
            vm.stopPrank();

            if (ok) {
                funded++;
            } else if (err.length >= 4) {
                // Taking the leading selector off revert data is the point of the cast.
                // forge-lint: disable-next-line(unsafe-typecast)
                bytes4 sel = bytes4(err);
                assertTrue(
                    sel != HallmarkHook.NoFreshEvidence.selector,
                    string.concat("gate lied about a live agent at gas limit ", vm.toString(g))
                );
                if (
                    sel == HallmarkHook.InsufficientGasForEvidenceCheck.selector
                        || sel == HallmarkHook.EvidenceReadFailed.selector
                ) {
                    refusedLoudly++;
                }
            }

            vm.revertToState(snap);
        }

        assertGt(funded, 0, "a live agent is fundable when the caller supplies real gas");
        assertGt(refusedLoudly, 0, "and starved calls refuse with a named error, not a false negative");
    }

    /// @dev The same agent, now with a probe on the Hallmark clock. The O(1) path carries it, so the
    ///      histories stop mattering entirely.
    function test_Fixed_F04_ProbedAgentIsFundableRegardlessOfHistory() public {
        BloatedValidationRegistry bloat = new BloatedValidationRegistry();
        HallmarkHook gateHook =
            new HallmarkHook(address(commerce), address(identity), address(reputation), address(bloat), attestor);
        commerce.setHookWhitelisted(address(gateHook), true);

        uint256 agentId = 777_002;
        _registerAgent(agentId, provider);
        bloat.spam(agentId, 5_000);

        vm.prank(attestor);
        gateHook.recordProbe(agentId, 95);

        vm.startPrank(client);
        uint256 jobId = commerce.createJob(provider, evaluator, block.timestamp + JOB_DURATION, "j", address(gateHook));
        commerce.setBudget(jobId, BUDGET, "");
        commerce.fund{gas: 500_000}(jobId, BUDGET, abi.encode(agentId));
        vm.stopPrank();

        assertEq(uint8(_status(jobId)), uint8(IAgenticCommerce.JobStatus.Funded), "5,000 records, still funded");
    }

    /// @dev A starved validation read is indeterminate, and the gate says exactly that.
    function test_Fixed_F04_StarvedValidationReadRefusesLoudly() public {
        BloatedValidationRegistry bloat = new BloatedValidationRegistry();
        HallmarkHook gateHook =
            new HallmarkHook(address(commerce), address(identity), address(reputation), address(bloat), attestor);
        commerce.setHookWhitelisted(address(gateHook), true);

        uint256 agentId = 777_003;
        _registerAgent(agentId, provider);
        bloat.spam(agentId, 20_000);
        bloat.seedGoodRecord(attestor, agentId);

        vm.startPrank(client);
        uint256 jobId = commerce.createJob(provider, evaluator, block.timestamp + JOB_DURATION, "j", address(gateHook));
        commerce.setBudget(jobId, BUDGET, "");
        vm.expectRevert(abi.encodeWithSelector(HallmarkHook.EvidenceReadFailed.selector, agentId));
        commerce.fund{gas: 2_000_000}(jobId, BUDGET, abi.encode(agentId));
        vm.stopPrank();
    }

    // =====================================================================
    // Helpers
    // =====================================================================

    function _repeat(string memory ch, uint256 n) private pure returns (string memory out) {
        bytes memory b = new bytes(n);
        bytes1 c = bytes(ch)[0];
        for (uint256 i = 0; i < n; ++i) {
            b[i] = c;
        }
        return string(b);
    }
}
