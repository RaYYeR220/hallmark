// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {IERC165} from "@openzeppelin/contracts/utils/introspection/IERC165.sol";

import {Base} from "./Base.t.sol";
import {HallmarkHook} from "../src/HallmarkHook.sol";
import {IACPHook} from "../src/interfaces/IACPHook.sol";
import {IAgenticCommerce} from "../src/interfaces/IAgenticCommerce.sol";

/// @notice Access control, configuration and the view surface a marketplace UI reads.
contract HallmarkHookAdminTest is Base {
    // ---------------------------------------------------------------------
    // Construction
    // ---------------------------------------------------------------------

    function test_Constructor_WiresEveryDependency() public view {
        assertEq(hook.commerce(), address(commerce));
        assertEq(address(hook.identity()), address(identity));
        assertEq(address(hook.reputation()), address(reputation));
        assertEq(address(hook.validation()), address(validation));
        assertEq(hook.attestor(), attestor);
        assertEq(hook.maxEvidenceAge(), 24 hours);
        assertEq(hook.minValidationScore(), 50);
        assertEq(hook.owner(), owner);
    }

    function test_Constructor_RevertsOnZeroCommerce() public {
        vm.expectRevert(HallmarkHook.ZeroAddress.selector);
        new HallmarkHook(address(0), address(identity), address(reputation), address(validation), attestor);
    }

    function test_Constructor_RevertsOnZeroIdentity() public {
        vm.expectRevert(HallmarkHook.ZeroAddress.selector);
        new HallmarkHook(address(commerce), address(0), address(reputation), address(validation), attestor);
    }

    function test_Constructor_RevertsOnZeroReputation() public {
        vm.expectRevert(HallmarkHook.ZeroAddress.selector);
        new HallmarkHook(address(commerce), address(identity), address(0), address(validation), attestor);
    }

    function test_Constructor_RevertsOnZeroValidation() public {
        vm.expectRevert(HallmarkHook.ZeroAddress.selector);
        new HallmarkHook(address(commerce), address(identity), address(reputation), address(0), attestor);
    }

    function test_Constructor_RevertsOnZeroAttestor() public {
        vm.expectRevert(HallmarkHook.ZeroAddress.selector);
        new HallmarkHook(address(commerce), address(identity), address(reputation), address(validation), address(0));
    }

    // ---------------------------------------------------------------------
    // Callback access control
    // ---------------------------------------------------------------------

    function test_BeforeAction_OnlyCommerce() public {
        vm.prank(stranger);
        vm.expectRevert(HallmarkHook.NotCommerce.selector);
        hook.beforeAction(1, IAgenticCommerce.fund.selector, abi.encode(AGENT_ID));
    }

    function test_AfterAction_OnlyCommerce() public {
        vm.prank(stranger);
        vm.expectRevert(HallmarkHook.NotCommerce.selector);
        hook.afterAction(1, IAgenticCommerce.fund.selector, abi.encode(AGENT_ID));
    }

    function test_BeforeAction_RejectsEvenTheOwner() public {
        vm.expectRevert(HallmarkHook.NotCommerce.selector);
        hook.beforeAction(1, IAgenticCommerce.fund.selector, abi.encode(AGENT_ID));
    }

    function test_BeforeAction_RejectsTheAttestor() public {
        vm.prank(attestor);
        vm.expectRevert(HallmarkHook.NotCommerce.selector);
        hook.beforeAction(1, IAgenticCommerce.fund.selector, abi.encode(AGENT_ID));
    }

    // ---------------------------------------------------------------------
    // Selector routing
    // ---------------------------------------------------------------------

    function test_BeforeAction_SetProviderIsNoOp() public {
        vm.prank(address(commerce));
        hook.beforeAction(1, IAgenticCommerce.setProvider.selector, abi.encode(provider, bytes("")));
        assertEq(hook.jobAgent(1), 0);
    }

    function test_BeforeAction_SetBudgetIsNoOp() public {
        vm.prank(address(commerce));
        hook.beforeAction(1, IAgenticCommerce.setBudget.selector, abi.encode(BUDGET, bytes("")));
        assertEq(hook.jobAgent(1), 0);
    }

    function test_AfterAction_SetProviderIsNoOp() public {
        vm.prank(address(commerce));
        hook.afterAction(1, IAgenticCommerce.setProvider.selector, abi.encode(provider, bytes("")));
        assertEq(hook.fundedAt(1), 0);
    }

    function test_AfterAction_SetBudgetIsNoOp() public {
        vm.prank(address(commerce));
        hook.afterAction(1, IAgenticCommerce.setBudget.selector, abi.encode(BUDGET, bytes("")));
        assertEq(hook.fundedAt(1), 0);
    }

    function test_BeforeAction_UnknownSelectorNeverReverts() public {
        vm.prank(address(commerce));
        hook.beforeAction(1, bytes4(0xdeadbeef), hex"c0ffee");
    }

    function test_AfterAction_UnknownSelectorNeverReverts() public {
        vm.prank(address(commerce));
        hook.afterAction(1, bytes4(0xdeadbeef), hex"c0ffee");
    }

    function test_AfterAction_SubmitOnAnUnboundJobIsNoOp() public {
        vm.prank(address(commerce));
        hook.afterAction(77, IAgenticCommerce.submit.selector, abi.encode(bytes32(0), bytes("")));
        assertEq(hook.submittedAt(77), 0);
    }

    function test_AfterAction_CompleteOnAnUnboundJobWritesNothing() public {
        vm.prank(address(commerce));
        hook.afterAction(77, IAgenticCommerce.complete.selector, abi.encode(bytes32(0), bytes("")));
        assertEq(reputation.entryCount(0), 0);
    }

    // ---------------------------------------------------------------------
    // recordProbe
    // ---------------------------------------------------------------------

    function test_RecordProbe_StoresTimestampAndScore() public {
        vm.expectEmit(true, false, false, true, address(hook));
        emit HallmarkHook.ProbeRecorded(AGENT_ID, 77, uint64(block.timestamp));
        vm.prank(attestor);
        hook.recordProbe(AGENT_ID, 77);

        assertEq(hook.lastProbeAt(AGENT_ID), uint64(block.timestamp));
        assertEq(hook.lastProbeScore(AGENT_ID), 77);
    }

    function test_RecordProbe_OnlyAttestor() public {
        vm.prank(stranger);
        vm.expectRevert(HallmarkHook.NotAttestor.selector);
        hook.recordProbe(AGENT_ID, 90);
    }

    function test_RecordProbe_RejectsEvenTheOwner() public {
        vm.expectRevert(HallmarkHook.NotAttestor.selector);
        hook.recordProbe(AGENT_ID, 90);
    }

    function test_RecordProbe_RevertsForUnknownAgent() public {
        vm.prank(attestor);
        vm.expectRevert(abi.encodeWithSelector(HallmarkHook.UnknownAgent.selector, 4_242));
        hook.recordProbe(4_242, 90);
    }

    function test_RecordProbe_OverwritesTheClock() public {
        _probe(AGENT_ID, 60);
        vm.warp(block.timestamp + 6 hours);
        vm.prank(attestor);
        hook.recordProbe(AGENT_ID, 91);

        assertEq(hook.lastProbeAt(AGENT_ID), uint64(block.timestamp));
        assertEq(hook.lastProbeScore(AGENT_ID), 91);
    }

    function test_RecordProbe_FollowsAttestorRotation() public {
        hook.setAttestor(stranger);

        vm.prank(attestor);
        vm.expectRevert(HallmarkHook.NotAttestor.selector);
        hook.recordProbe(AGENT_ID, 90);

        vm.prank(stranger);
        hook.recordProbe(AGENT_ID, 90);
        assertEq(hook.lastProbeScore(AGENT_ID), 90);
    }

    // ---------------------------------------------------------------------
    // Configuration
    // ---------------------------------------------------------------------

    function test_SetAttestor_UpdatesAndEmits() public {
        vm.expectEmit(true, false, false, false, address(hook));
        emit HallmarkHook.AttestorUpdated(stranger);
        hook.setAttestor(stranger);
        assertEq(hook.attestor(), stranger);
    }

    function test_SetAttestor_OnlyOwner() public {
        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, stranger));
        hook.setAttestor(stranger);
    }

    function test_SetAttestor_RevertsOnZeroAddress() public {
        vm.expectRevert(HallmarkHook.ZeroAddress.selector);
        hook.setAttestor(address(0));
    }

    function test_SetMaxEvidenceAge_Updates() public {
        hook.setMaxEvidenceAge(6 hours);
        assertEq(hook.maxEvidenceAge(), 6 hours);
    }

    function test_SetMaxEvidenceAge_OnlyOwner() public {
        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, stranger));
        hook.setMaxEvidenceAge(6 hours);
    }

    function test_SetMaxEvidenceAge_RevertsOnZero() public {
        vm.expectRevert(HallmarkHook.InvalidEvidenceAge.selector);
        hook.setMaxEvidenceAge(0);
    }

    function test_SetMaxEvidenceAge_RevertsAboveLimit() public {
        uint256 tooOld = hook.MAX_EVIDENCE_AGE_LIMIT() + 1;
        vm.expectRevert(HallmarkHook.InvalidEvidenceAge.selector);
        hook.setMaxEvidenceAge(tooOld);
    }

    function test_SetMaxEvidenceAge_AcceptsExactlyTheLimit() public {
        uint256 limit = hook.MAX_EVIDENCE_AGE_LIMIT();
        hook.setMaxEvidenceAge(limit);
        assertEq(hook.maxEvidenceAge(), limit);
    }

    function test_SetMinValidationScore_Updates() public {
        hook.setMinValidationScore(80);
        assertEq(hook.minValidationScore(), 80);
    }

    function test_SetMinValidationScore_OnlyOwner() public {
        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, stranger));
        hook.setMinValidationScore(80);
    }

    function test_SetEvidenceBaseURI_Updates() public {
        hook.setEvidenceBaseURI("ipfs://hallmark/");
        assertEq(hook.evidenceBaseURI(), "ipfs://hallmark/");
        assertEq(hook.feedbackURI(12), "ipfs://hallmark/12");
    }

    function test_SetEvidenceBaseURI_OnlyOwner() public {
        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, stranger));
        hook.setEvidenceBaseURI("ipfs://x/");
    }

    // ---------------------------------------------------------------------
    // Views
    // ---------------------------------------------------------------------

    function test_IsHireable_FalseWithoutEvidence() public view {
        (bool ok, uint64 lastEvidenceAt, uint8 score) = hook.isHireable(AGENT_ID);
        assertFalse(ok);
        assertEq(lastEvidenceAt, 0);
        assertEq(score, 0);
    }

    function test_IsHireable_TrueAfterAProbe() public {
        _probe(AGENT_ID, 88);
        (bool ok, uint64 lastEvidenceAt, uint8 score) = hook.isHireable(AGENT_ID);
        assertTrue(ok);
        assertEq(lastEvidenceAt, uint64(block.timestamp));
        assertEq(score, 88);
    }

    function test_IsHireable_TrueAfterAValidation() public {
        _validate(attestor, AGENT_ID, 64);
        (bool ok, uint64 lastEvidenceAt, uint8 score) = hook.isHireable(AGENT_ID);
        assertTrue(ok);
        assertEq(lastEvidenceAt, uint64(block.timestamp));
        assertEq(score, 64);
    }

    function test_IsHireable_FalseOnceEvidenceAges() public {
        _probe(AGENT_ID, 88);
        vm.warp(block.timestamp + 24 hours + 1);
        (bool ok,,) = hook.isHireable(AGENT_ID);
        assertFalse(ok);
    }

    function test_IsHireable_FollowsTheMinimumScore() public {
        _probe(AGENT_ID, 60);
        (bool okBefore,,) = hook.isHireable(AGENT_ID);
        assertTrue(okBefore);

        hook.setMinValidationScore(61);
        (bool okAfter,,) = hook.isHireable(AGENT_ID);
        assertFalse(okAfter);
    }

    function test_IsHireable_FollowsTheEvidenceWindow() public {
        _probe(AGENT_ID, 88);
        vm.warp(block.timestamp + 12 hours);
        (bool okBefore,,) = hook.isHireable(AGENT_ID);
        assertTrue(okBefore);

        hook.setMaxEvidenceAge(6 hours);
        (bool okAfter,,) = hook.isHireable(AGENT_ID);
        assertFalse(okAfter);
    }

    function test_IsHireable_ReportsTheFreshestEvidence() public {
        _validate(attestor, AGENT_ID, 51);
        vm.warp(block.timestamp + 1 hours);
        _probe(AGENT_ID, 99);

        (bool ok, uint64 lastEvidenceAt, uint8 score) = hook.isHireable(AGENT_ID);
        assertTrue(ok);
        assertEq(lastEvidenceAt, uint64(block.timestamp));
        assertEq(score, 99);
    }

    function test_IsHireable_ScansOnlyTheMostRecentValidations() public {
        // The oldest record is the only usable one, and it falls outside the bounded scan window.
        _validate(attestor, AGENT_ID, 90);
        for (uint256 i = 0; i < hook.VALIDATION_SCAN_LIMIT(); ++i) {
            _validate(stranger, AGENT_ID, 90);
        }

        (bool ok,,) = hook.isHireable(AGENT_ID);
        assertFalse(ok, "gas-bounded scan does not reach back forever");
    }

    function test_AgentRecord_StartsEmpty() public view {
        HallmarkHook.Record memory record = hook.agentRecord(AGENT_ID);
        assertEq(record.jobsFunded, 0);
        assertEq(record.jobsCompleted, 0);
        assertEq(record.jobsRejected, 0);
        assertEq(record.jobsExpired, 0);
        assertEq(record.totalDeliverySeconds, 0);
    }

    function test_SupportsInterface() public view {
        assertTrue(hook.supportsInterface(type(IACPHook).interfaceId));
        assertTrue(hook.supportsInterface(type(IERC165).interfaceId));
        assertFalse(hook.supportsInterface(bytes4(0xffffffff)));
        assertFalse(hook.supportsInterface(type(IAgenticCommerce).interfaceId));
    }

    function test_FeedbackURI_ConcatenatesTheJobId() public view {
        assertEq(hook.feedbackURI(1), "https://hallmark.xyz/evidence/1");
        assertEq(hook.feedbackURI(123_456), "https://hallmark.xyz/evidence/123456");
    }

    // ---------------------------------------------------------------------
    // Agent / payee binding
    // ---------------------------------------------------------------------

    function test_MinAttestableBudget_DefaultsToATenthOfAToken() public view {
        assertEq(hook.minAttestableBudget(), 1e17);
        assertEq(hook.minAttestableBudget(), hook.DEFAULT_MIN_ATTESTABLE_BUDGET());
    }

    function test_SetMinAttestableBudget_Updates() public {
        vm.expectEmit(false, false, false, true, address(hook));
        emit HallmarkHook.MinAttestableBudgetUpdated(5e18);
        hook.setMinAttestableBudget(5e18);
        assertEq(hook.minAttestableBudget(), 5e18);
    }

    function test_SetMinAttestableBudget_OnlyOwner() public {
        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, stranger));
        hook.setMinAttestableBudget(5e18);
    }

    function test_SetMinAttestableBudget_ZeroDisablesTheFloor() public {
        hook.setMinAttestableBudget(0);
        _probe(AGENT_ID, 95);

        uint256 jobId = _createAndBudget(address(hook), 1);
        vm.prank(client);
        commerce.fund(jobId, 1, abi.encode(AGENT_ID));
        vm.prank(provider);
        commerce.submit(jobId, bytes32(0), "");
        vm.prank(evaluator);
        commerce.complete(jobId, bytes32(0), "");

        assertEq(hook.agentRecord(AGENT_ID).jobsCompleted, 1, "a one-wei job counts once the floor is off");
    }

    /// @dev The threshold in force when the escrow was funded is the one that applies, matching how
    ///      the platform fee is snapshotted.
    function test_MinAttestableBudget_IsFixedAtFundingTime() public {
        _probe(AGENT_ID, 95);
        uint256 jobId = _createAndBudget(address(hook), 1e18);
        vm.prank(client);
        commerce.fund(jobId, 1e18, abi.encode(AGENT_ID));

        // Owner raises the bar above this job's budget after it was funded.
        hook.setMinAttestableBudget(100e18);

        vm.prank(provider);
        commerce.submit(jobId, bytes32(0), "");
        vm.prank(evaluator);
        commerce.complete(jobId, bytes32(0), "");

        assertEq(hook.agentRecord(AGENT_ID).jobsCompleted, 1, "judged under the rules it was funded under");
    }

    function test_Fund_RevertsWhenTheAgentIsNotTheJobsPayee() public {
        uint256 otherAgent = 31_337;
        _registerAgent(otherAgent, stranger);
        _probe(otherAgent, 95);

        uint256 jobId = _createAndBudget(address(hook), BUDGET);
        vm.prank(client);
        vm.expectRevert(
            abi.encodeWithSelector(HallmarkHook.AgentProviderMismatch.selector, otherAgent, stranger, provider)
        );
        commerce.fund(jobId, BUDGET, abi.encode(otherAgent));
    }

    function test_JobBinding_RecordsTheClientAndVerdict() public {
        _probe(AGENT_ID, 95);
        uint256 jobId = _createFundedJob();

        (address boundClient, HallmarkHook.Attestability verdict) = hook.jobBinding(jobId);
        assertEq(boundClient, client);
        assertEq(uint8(verdict), uint8(HallmarkHook.Attestability.Attestable));
    }

    function test_JobBinding_FlagsADustJob() public {
        _probe(AGENT_ID, 95);
        uint256 jobId = _createAndBudget(address(hook), 1);
        vm.prank(client);
        commerce.fund(jobId, 1, abi.encode(AGENT_ID));

        (, HallmarkHook.Attestability verdict) = hook.jobBinding(jobId);
        assertEq(uint8(verdict), uint8(HallmarkHook.Attestability.BudgetTooSmall));
    }

    // ---------------------------------------------------------------------
    // Probe provenance
    // ---------------------------------------------------------------------

    function test_AgentProbe_RecordsTheAuthoringKey() public {
        _probe(AGENT_ID, 77);
        HallmarkHook.Probe memory probe = hook.agentProbe(AGENT_ID);
        assertEq(probe.by, attestor);
        assertEq(probe.score, 77);
        assertEq(probe.at, uint64(block.timestamp));
    }

    function test_LastProbe_ReadsZeroAfterAttestorRotation() public {
        _probe(AGENT_ID, 77);
        assertEq(hook.lastProbeAt(AGENT_ID), uint64(block.timestamp));

        hook.setAttestor(stranger);
        assertEq(hook.lastProbeAt(AGENT_ID), 0, "a probe signed by a retired key is not evidence");
        assertEq(hook.lastProbeScore(AGENT_ID), 0);

        (bool ok,,) = hook.isHireable(AGENT_ID);
        assertFalse(ok);
    }

    // ---------------------------------------------------------------------
    // Bounded job read
    // ---------------------------------------------------------------------

    function test_GetJobParties_MatchesGetJob() public {
        uint256 jobId = _createAndBudget(address(hook), BUDGET);
        (address c, address p, address e, uint256 b, uint256 x, IAgenticCommerce.JobStatus st) =
            commerce.getJobParties(jobId);
        IAgenticCommerce.Job memory job = commerce.getJob(jobId);

        assertEq(c, job.client);
        assertEq(p, job.provider);
        assertEq(e, job.evaluator);
        assertEq(b, job.budget);
        assertEq(x, job.expiredAt);
        assertEq(uint8(st), uint8(job.status));
    }

    function test_GetJobParties_RevertsOnUnknownJob() public {
        vm.expectRevert(IAgenticCommerce.InvalidJob.selector);
        commerce.getJobParties(99);
    }

    /// @dev Constant gas regardless of the client-chosen description, which is why the hook reads
    ///      this rather than `getJob` on the funding path.
    function test_GetJobParties_CostDoesNotFollowTheDescription() public {
        vm.prank(client);
        uint256 shortJob = commerce.createJob(provider, evaluator, block.timestamp + JOB_DURATION, "x", address(0));

        string memory long = new string(4_000);
        vm.prank(client);
        uint256 longJob = commerce.createJob(provider, evaluator, block.timestamp + JOB_DURATION, long, address(0));

        uint256 before = gasleft();
        commerce.getJobParties(shortJob);
        uint256 shortCost = before - gasleft();

        before = gasleft();
        commerce.getJobParties(longJob);
        uint256 longCost = before - gasleft();

        assertApproxEqAbs(shortCost, longCost, 1_000, "the description does not enter the cost");
    }

    // ---------------------------------------------------------------------
    // Stalled versus expired
    // ---------------------------------------------------------------------

    function test_RecordExpiry_UndeliveredCountsAgainstTheAgent() public {
        _probe(AGENT_ID, 95);
        uint256 jobId = _createFundedJob();

        vm.warp(block.timestamp + JOB_DURATION + 1);
        commerce.claimRefund(jobId);
        hook.recordExpiry(jobId);

        HallmarkHook.Record memory record = hook.agentRecord(AGENT_ID);
        assertEq(record.jobsExpired, 1);
        assertEq(record.jobsStalled, 0);
    }

    function test_RecordExpiry_EmitsForAnUnboundJobToo() public {
        // A job that used a different hook still resolves, and still emits, rather than being
        // consumed silently.
        uint256 jobId = _createAndBudget(address(0), BUDGET);
        vm.prank(client);
        commerce.fund(jobId, BUDGET, "");
        vm.warp(block.timestamp + JOB_DURATION + 1);
        commerce.claimRefund(jobId);

        vm.expectEmit(true, true, false, true, address(hook));
        emit HallmarkHook.ExpiryRecorded(jobId, 0, false);
        hook.recordExpiry(jobId);
    }

    function testFuzz_RecordProbe_OnlyAttestor(address caller) public {
        vm.assume(caller != attestor && caller != address(vm));
        vm.prank(caller);
        vm.expectRevert(HallmarkHook.NotAttestor.selector);
        hook.recordProbe(AGENT_ID, 90);
    }

    function testFuzz_Callbacks_OnlyCommerce(address caller) public {
        vm.assume(caller != address(commerce) && caller != address(vm));
        vm.startPrank(caller);
        vm.expectRevert(HallmarkHook.NotCommerce.selector);
        hook.beforeAction(1, IAgenticCommerce.fund.selector, abi.encode(AGENT_ID));
        vm.expectRevert(HallmarkHook.NotCommerce.selector);
        hook.afterAction(1, IAgenticCommerce.fund.selector, abi.encode(AGENT_ID));
        vm.stopPrank();
    }

    function testFuzz_IsHireable_TracksTheWindow(uint256 elapsed) public {
        elapsed = bound(elapsed, 0, 72 hours);
        _probe(AGENT_ID, 90);
        uint256 window = hook.maxEvidenceAge();

        vm.warp(block.timestamp + elapsed);
        (bool ok,,) = hook.isHireable(AGENT_ID);
        assertEq(ok, elapsed <= window);
    }
}
