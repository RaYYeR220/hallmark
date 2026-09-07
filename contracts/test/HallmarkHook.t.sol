// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Vm} from "forge-std/Vm.sol";

import {Base} from "./Base.t.sol";
import {HallmarkHook} from "../src/HallmarkHook.sol";
import {IAgenticCommerce} from "../src/interfaces/IAgenticCommerce.sol";
import {GasBurningReputationRegistry} from "./mocks/GasBurningReputationRegistry.sol";
import {MockReputationRegistry} from "./mocks/MockReputationRegistry.sol";

/// @notice The product test: money cannot move toward an agent without fresh liveness evidence, and
///         every settled job leaves an on-chain receipt in the ERC-8004 Reputation Registry.
contract HallmarkHookTest is Base {
    bytes32 private constant _FAILED_TOPIC = keccak256("FeedbackWriteFailed(uint256,uint256,bytes)");
    bytes32 private constant _SKIPPED_TOPIC =
        keccak256("FeedbackSkippedInsufficientGas(uint256,uint256,uint256,uint256)");

    // ---------------------------------------------------------------------
    // The refusal
    // ---------------------------------------------------------------------

    function test_Fund_RevertsWhenAgentHasNoEvidence() public {
        uint256 jobId = _createAndBudget(address(hook), BUDGET);

        vm.prank(client);
        vm.expectRevert(abi.encodeWithSelector(HallmarkHook.NoFreshEvidence.selector, AGENT_ID, 0));
        commerce.fund(jobId, BUDGET, abi.encode(AGENT_ID));

        assertEq(token.balanceOf(address(commerce)), 0, "no escrow was taken");
        assertEq(uint8(_status(jobId)), uint8(IAgenticCommerce.JobStatus.Open));
        assertEq(hook.jobAgent(jobId), 0);
    }

    function test_Fund_RevertsWhenEvidenceIsStale() public {
        _probe(AGENT_ID, 95);
        uint64 probedAt = uint64(block.timestamp);

        uint256 jobId = _createAndBudget(address(hook), BUDGET);
        vm.warp(block.timestamp + hook.maxEvidenceAge() + 1);

        vm.prank(client);
        vm.expectRevert(abi.encodeWithSelector(HallmarkHook.NoFreshEvidence.selector, AGENT_ID, probedAt));
        commerce.fund(jobId, BUDGET, abi.encode(AGENT_ID));

        assertEq(token.balanceOf(address(commerce)), 0);
    }

    function test_Fund_SucceedsAtTheExactEdgeOfTheEvidenceWindow() public {
        _probe(AGENT_ID, 95);
        uint256 jobId = _createAndBudget(address(hook), BUDGET);

        vm.warp(block.timestamp + hook.maxEvidenceAge());
        vm.prank(client);
        commerce.fund(jobId, BUDGET, abi.encode(AGENT_ID));

        assertEq(uint8(_status(jobId)), uint8(IAgenticCommerce.JobStatus.Funded));
    }

    function test_Fund_RevertsWhenAgentIsUnknownToIdentityRegistry() public {
        // The identity check runs first, so a bogus agent id is rejected as unknown rather than as
        // merely unproven.
        uint256 unknownAgent = 999_999;

        uint256 jobId = _createAndBudget(address(hook), BUDGET);
        vm.prank(client);
        vm.expectRevert(abi.encodeWithSelector(HallmarkHook.UnknownAgent.selector, unknownAgent));
        commerce.fund(jobId, BUDGET, abi.encode(unknownAgent));
    }

    function test_Fund_RevertsWhenAgentNotDeclared() public {
        _probe(AGENT_ID, 95);
        uint256 jobId = _createAndBudget(address(hook), BUDGET);

        vm.prank(client);
        vm.expectRevert(HallmarkHook.AgentNotDeclared.selector);
        commerce.fund(jobId, BUDGET, "");
    }

    function test_Fund_RevertsWhenValidationScoreBelowMinimum() public {
        _validate(attestor, AGENT_ID, 10);
        uint64 validatedAt = uint64(block.timestamp);

        uint256 jobId = _createAndBudget(address(hook), BUDGET);
        vm.prank(client);
        vm.expectRevert(abi.encodeWithSelector(HallmarkHook.NoFreshEvidence.selector, AGENT_ID, validatedAt));
        commerce.fund(jobId, BUDGET, abi.encode(AGENT_ID));
    }

    function test_Fund_RevertsWhenProbeScoreBelowMinimum() public {
        _probe(AGENT_ID, 49);
        uint64 probedAt = uint64(block.timestamp);

        uint256 jobId = _createAndBudget(address(hook), BUDGET);
        vm.prank(client);
        vm.expectRevert(abi.encodeWithSelector(HallmarkHook.NoFreshEvidence.selector, AGENT_ID, probedAt));
        commerce.fund(jobId, BUDGET, abi.encode(AGENT_ID));
    }

    function test_Fund_RevertsWhenValidationCameFromSomeoneElse() public {
        _validate(stranger, AGENT_ID, 100);

        uint256 jobId = _createAndBudget(address(hook), BUDGET);
        vm.prank(client);
        vm.expectRevert(abi.encodeWithSelector(HallmarkHook.NoFreshEvidence.selector, AGENT_ID, 0));
        commerce.fund(jobId, BUDGET, abi.encode(AGENT_ID));
    }

    function test_Fund_RevertsWhenProbeHasNoRegistryMirror() public {
        // The Hallmark clock is set but the public "reachable" feedback was never written, so the
        // evidence is not verifiable through the standard registry.
        _probeWithoutMirror(AGENT_ID, 95);
        uint64 probedAt = uint64(block.timestamp);

        uint256 jobId = _createAndBudget(address(hook), BUDGET);
        vm.prank(client);
        vm.expectRevert(abi.encodeWithSelector(HallmarkHook.NoFreshEvidence.selector, AGENT_ID, probedAt));
        commerce.fund(jobId, BUDGET, abi.encode(AGENT_ID));
    }

    function test_Fund_SucceedsOnValidationRegistryEvidenceAlone() public {
        _validate(attestor, AGENT_ID, 88);

        uint256 jobId = _createAndBudget(address(hook), BUDGET);
        vm.prank(client);
        commerce.fund(jobId, BUDGET, abi.encode(AGENT_ID));

        assertEq(uint8(_status(jobId)), uint8(IAgenticCommerce.JobStatus.Funded));
        assertEq(hook.jobAgent(jobId), AGENT_ID);
    }

    function test_Fund_SucceedsOnProbeAndReputationEvidence() public {
        _probe(AGENT_ID, 70);

        uint256 jobId = _createAndBudget(address(hook), BUDGET);
        vm.prank(client);
        commerce.fund(jobId, BUDGET, abi.encode(AGENT_ID));

        assertEq(token.balanceOf(address(commerce)), BUDGET);
    }

    function test_Fund_TolerantOfAValidationRegistryThatReverts() public {
        _probe(AGENT_ID, 70);
        validation.setRevertOnRead(true);

        uint256 jobId = _createAndBudget(address(hook), BUDGET);
        vm.prank(client);
        commerce.fund(jobId, BUDGET, abi.encode(AGENT_ID));

        assertEq(uint8(_status(jobId)), uint8(IAgenticCommerce.JobStatus.Funded));
    }

    function test_Fund_RefusesWhenBothRegistriesRevert() public {
        _probe(AGENT_ID, 70);
        validation.setRevertOnRead(true);
        reputation.setRevertOnSummary(true);

        uint256 jobId = _createAndBudget(address(hook), BUDGET);
        vm.prank(client);
        vm.expectRevert(
            abi.encodeWithSelector(HallmarkHook.NoFreshEvidence.selector, AGENT_ID, uint64(block.timestamp))
        );
        commerce.fund(jobId, BUDGET, abi.encode(AGENT_ID));
    }

    function test_Fund_RevertsAfterAttestorRotation() public {
        _probe(AGENT_ID, 95);
        // Rotating the attestor invalidates evidence gathered under the old key.
        hook.setAttestor(stranger);

        uint256 jobId = _createAndBudget(address(hook), BUDGET);
        vm.prank(client);
        vm.expectRevert(
            abi.encodeWithSelector(HallmarkHook.NoFreshEvidence.selector, AGENT_ID, uint64(block.timestamp))
        );
        commerce.fund(jobId, BUDGET, abi.encode(AGENT_ID));
    }

    function testFuzz_Fund_RefusesEveryUnprobedAgent(uint256 agentId) public {
        agentId = bound(agentId, 1, type(uint128).max);
        vm.assume(agentId != AGENT_ID);
        identity.register(agentId, agentOwner);

        uint256 jobId = _createAndBudget(address(hook), BUDGET);
        vm.prank(client);
        vm.expectRevert(abi.encodeWithSelector(HallmarkHook.NoFreshEvidence.selector, agentId, 0));
        commerce.fund(jobId, BUDGET, abi.encode(agentId));
    }

    function testFuzz_Fund_RefusesEveryStaleProbe(uint256 elapsed) public {
        elapsed = bound(elapsed, hook.maxEvidenceAge() + 1, 3_650 days);
        _probe(AGENT_ID, 100);
        uint64 probedAt = uint64(block.timestamp);

        uint256 jobId = _createAndBudget(address(hook), BUDGET);
        vm.warp(block.timestamp + elapsed);

        vm.prank(client);
        vm.expectRevert(abi.encodeWithSelector(HallmarkHook.NoFreshEvidence.selector, AGENT_ID, probedAt));
        commerce.fund(jobId, BUDGET, abi.encode(AGENT_ID));
    }

    // ---------------------------------------------------------------------
    // Binding and measurement
    // ---------------------------------------------------------------------

    function test_AfterFund_BindsAgentAndCountsIt() public {
        _probe(AGENT_ID, 95);
        uint256 jobId = _createAndBudget(address(hook), BUDGET);

        vm.expectEmit(true, true, false, false, address(hook));
        emit HallmarkHook.JobBound(jobId, AGENT_ID);
        vm.prank(client);
        commerce.fund(jobId, BUDGET, abi.encode(AGENT_ID));

        assertEq(hook.jobAgent(jobId), AGENT_ID);
        assertEq(hook.fundedAt(jobId), uint64(block.timestamp));
        assertEq(hook.agentRecord(AGENT_ID).jobsFunded, 1);
    }

    function test_AfterSubmit_MeasuresTimeToDeliver() public {
        _probe(AGENT_ID, 95);
        uint256 jobId = _createFundedJob();

        vm.warp(block.timestamp + 3 hours);
        vm.expectEmit(true, true, false, true, address(hook));
        emit HallmarkHook.DeliverySubmitted(jobId, AGENT_ID, 3 hours);
        vm.prank(provider);
        commerce.submit(jobId, keccak256("deliverable"), "");

        assertEq(hook.submittedAt(jobId), uint64(block.timestamp));
    }

    function test_AverageDeliverySeconds_AveragesCompletedJobs() public {
        _probe(AGENT_ID, 95);

        _runJob(2 hours);
        _probe(AGENT_ID, 95);
        _runJob(4 hours);

        assertEq(hook.agentRecord(AGENT_ID).jobsCompleted, 2);
        assertEq(hook.averageDeliverySeconds(AGENT_ID), 3 hours);
    }

    function test_AverageDeliverySeconds_IsZeroWithoutCompletions() public view {
        assertEq(hook.averageDeliverySeconds(AGENT_ID), 0);
    }

    // ---------------------------------------------------------------------
    // The receipt
    // ---------------------------------------------------------------------

    function test_HappyPath_SettlesAndWritesReputation() public {
        _probe(AGENT_ID, 95);
        uint256 clientBefore = token.balanceOf(client);
        uint256 jobId = _createFundedJob();

        vm.warp(block.timestamp + 1 hours);
        vm.prank(provider);
        commerce.submit(jobId, keccak256("deliverable"), "");

        bytes32 reason = keccak256("accepted by evaluator");
        vm.prank(evaluator);
        commerce.complete(jobId, reason, "");

        uint256 fee = (BUDGET * FEE_BPS) / commerce.BPS_DENOMINATOR();
        assertEq(token.balanceOf(provider), BUDGET - fee, "provider paid net of fee");
        assertEq(token.balanceOf(treasury), fee, "treasury took the fee");
        assertEq(token.balanceOf(client), clientBefore - BUDGET);
        assertEq(uint8(_status(jobId)), uint8(IAgenticCommerce.JobStatus.Completed));

        // Entry 0 is the attestor's "reachable" probe mirror; entry 1 is the settlement receipt.
        assertEq(reputation.entryCount(AGENT_ID), 2);
        MockReputationRegistry.Entry memory entry = reputation.lastEntry(AGENT_ID);
        assertEq(entry.client, address(hook), "the hook, never the agent, is the submitter");
        assertEq(entry.value, int128(100));
        assertEq(entry.valueDecimals, 0);
        assertEq(entry.tag1, "jobcompleted");
        assertEq(entry.tag2, "hallmark");
        assertEq(entry.endpoint, "");
        assertEq(entry.feedbackURI, "https://hallmark.xyz/evidence/1");
        assertEq(entry.feedbackHash, reason);

        HallmarkHook.Record memory record = hook.agentRecord(AGENT_ID);
        assertEq(record.jobsFunded, 1);
        assertEq(record.jobsCompleted, 1);
        assertEq(record.jobsRejected, 0);
        assertEq(record.totalDeliverySeconds, 1 hours);
    }

    function test_Complete_EmitsOutcomeRecorded() public {
        _probe(AGENT_ID, 95);
        uint256 jobId = _createFundedJob();
        vm.prank(provider);
        commerce.submit(jobId, bytes32(0), "");

        bytes32 reason = keccak256("ok");
        vm.expectEmit(true, true, false, true, address(hook));
        emit HallmarkHook.OutcomeRecorded(jobId, AGENT_ID, true, reason);
        vm.prank(evaluator);
        commerce.complete(jobId, reason, "");
    }

    function test_Reject_RefundsClientAndRecordsNegativeOutcome() public {
        _probe(AGENT_ID, 95);
        uint256 clientBefore = token.balanceOf(client);
        uint256 jobId = _createFundedJob();

        bytes32 reason = keccak256("agent stopped responding");
        vm.expectEmit(true, true, false, true, address(hook));
        emit HallmarkHook.OutcomeRecorded(jobId, AGENT_ID, false, reason);
        vm.prank(evaluator);
        commerce.reject(jobId, reason, "");

        assertEq(token.balanceOf(client), clientBefore, "client made whole");
        assertEq(token.balanceOf(treasury), 0, "no fee on a rejection");

        MockReputationRegistry.Entry memory entry = reputation.lastEntry(AGENT_ID);
        assertEq(entry.value, int128(0));
        assertEq(entry.tag1, "jobrejected");
        assertEq(entry.feedbackHash, reason);

        HallmarkHook.Record memory record = hook.agentRecord(AGENT_ID);
        assertEq(record.jobsRejected, 1);
        assertEq(record.jobsCompleted, 0);
    }

    function test_Reject_WhileOpenRecordsNothing() public {
        uint256 jobId = _createAndBudget(address(hook), BUDGET);
        vm.prank(client);
        commerce.reject(jobId, keccak256("never mind"), "");

        assertEq(reputation.entryCount(AGENT_ID), 0);
        assertEq(hook.agentRecord(AGENT_ID).jobsRejected, 0);
    }

    function test_Complete_SurvivesAReputationRegistryFailure() public {
        _probe(AGENT_ID, 95);
        uint256 jobId = _createFundedJob();
        vm.prank(provider);
        commerce.submit(jobId, bytes32(0), "");

        reputation.setRevertOnFeedback(true);

        vm.recordLogs();
        vm.prank(evaluator);
        commerce.complete(jobId, keccak256("ok"), "");

        uint256 fee = (BUDGET * FEE_BPS) / commerce.BPS_DENOMINATOR();
        assertEq(token.balanceOf(provider), BUDGET - fee, "settlement is never blocked by the registry");
        assertEq(uint8(_status(jobId)), uint8(IAgenticCommerce.JobStatus.Completed));
        assertEq(hook.agentRecord(AGENT_ID).jobsCompleted, 1, "the local record still updates");
        assertTrue(_sawEvent(vm.getRecordedLogs(), _FAILED_TOPIC, jobId), "FeedbackWriteFailed was emitted");
    }

    function test_Reject_SurvivesAReputationRegistryFailure() public {
        _probe(AGENT_ID, 95);
        uint256 clientBefore = token.balanceOf(client);
        uint256 jobId = _createFundedJob();

        reputation.setRevertOnFeedback(true);

        vm.recordLogs();
        vm.prank(evaluator);
        commerce.reject(jobId, keccak256("nope"), "");

        assertEq(token.balanceOf(client), clientBefore, "the refund still happens");
        assertTrue(_sawEvent(vm.getRecordedLogs(), _FAILED_TOPIC, jobId));
    }

    function test_FeedbackURI_IsEmptyWhenNoBaseIsConfigured() public {
        hook.setEvidenceBaseURI("");
        _probe(AGENT_ID, 95);
        uint256 jobId = _createFundedJob();
        vm.prank(provider);
        commerce.submit(jobId, bytes32(0), "");
        vm.prank(evaluator);
        commerce.complete(jobId, bytes32(0), "");

        assertEq(reputation.lastEntry(AGENT_ID).feedbackURI, "");
    }

    // ---------------------------------------------------------------------
    // Gas budgeting
    //
    // Regression cover for a bug found on BSC testnet. `_writeFeedback` wraps the registry call in
    // try/catch, so an out-of-gas INNER call still leaves the OUTER call successful. `eth_estimateGas`
    // binary-searches for the smallest limit under which the outer call succeeds, so it converged on
    // a limit that starved the write: `complete` mined fine, the job reached Completed, and the
    // ERC-8004 receipt silently never landed (empty-revert-data `FeedbackWriteFailed`). The hook now
    // refuses to attempt a write it cannot pay for, and says so with its own event.
    // ---------------------------------------------------------------------

    function test_Complete_EmitsFeedbackSkippedWhenGasIsInsufficient() public {
        _probe(AGENT_ID, 95);
        uint256 jobId = _createFundedJob();
        vm.prank(provider);
        commerce.submit(jobId, bytes32(0), "");

        uint256 entriesBefore = reputation.entryCount(AGENT_ID);

        vm.recordLogs();
        vm.prank(evaluator);
        // Enough to settle, deliberately not enough to also pay for the registry write.
        commerce.complete{gas: 300_000}(jobId, keccak256("ok"), "");

        Vm.Log[] memory logs = vm.getRecordedLogs();
        assertTrue(_sawEvent(logs, _SKIPPED_TOPIC, jobId), "FeedbackSkippedInsufficientGas was emitted");
        assertFalse(_sawEvent(logs, _FAILED_TOPIC, jobId), "a skipped write is never reported as a failed one");
        assertEq(reputation.entryCount(AGENT_ID), entriesBefore, "no feedback was written");
    }

    function test_Complete_WritesFeedbackWhenGasIsSufficient() public {
        _probe(AGENT_ID, 95);
        uint256 jobId = _createFundedJob();
        vm.prank(provider);
        commerce.submit(jobId, bytes32(0), "");

        uint256 entriesBefore = reputation.entryCount(AGENT_ID);

        vm.recordLogs();
        vm.prank(evaluator);
        commerce.complete{gas: 600_000}(jobId, keccak256("ok"), "");

        Vm.Log[] memory logs = vm.getRecordedLogs();
        assertFalse(_sawEvent(logs, _SKIPPED_TOPIC, jobId), "the write was attempted");
        assertFalse(_sawEvent(logs, _FAILED_TOPIC, jobId), "and it succeeded");
        assertEq(reputation.entryCount(AGENT_ID), entriesBefore + 1, "the registry received the receipt");

        MockReputationRegistry.Entry memory entry = reputation.lastEntry(AGENT_ID);
        assertEq(entry.client, address(hook));
        assertEq(entry.tag1, "jobcompleted");

        address[] memory clients = new address[](1);
        clients[0] = address(hook);
        (uint64 count, int128 value,) = reputation.getSummary(AGENT_ID, clients, "jobcompleted", "");
        assertEq(count, 1);
        assertEq(value, int128(100));
    }

    /// @dev The floor and the stipend both have to clear the cost measured against the live
    ///      ERC-8004 Reputation Registry, or the guard is decorative.
    function test_FeedbackGasBudget_ClearsTheMeasuredWriteCost() public view {
        uint256 measuredFirstWrite = 214_000;
        uint256 measuredSubsequentWrite = 132_000;

        assertGt(hook.MIN_FEEDBACK_STIPEND(), measuredFirstWrite, "stipend covers a first write");
        assertGt(hook.MIN_FEEDBACK_STIPEND(), measuredSubsequentWrite, "stipend covers a repeat write");
        assertGt(hook.MIN_FEEDBACK_GAS(), hook.MIN_FEEDBACK_STIPEND(), "the floor sits above the stipend");
        assertEq(
            hook.MIN_FEEDBACK_GAS() - hook.FEEDBACK_EPILOGUE_RESERVE(),
            hook.MIN_FEEDBACK_STIPEND(),
            "stipend is the floor minus the epilogue reserve"
        );

        // EIP-150 hands a call at most 63/64 of gas remaining, so the floor has to exceed the
        // stipend by more than that shortfall or the stipend could never actually be delivered.
        assertGe(hook.MIN_FEEDBACK_GAS() * 63 / 64, hook.MIN_FEEDBACK_STIPEND(), "stipend is deliverable at the floor");
    }

    /// @dev The mock is cheaper than the real registry, but a write that costs more than the guard
    ///      admits would still mean the guard is set too low relative to reality.
    function test_FeedbackGasBudget_ExceedsAnObservedWriteCost() public {
        vm.startPrank(attestor);
        uint256 before = gasleft();
        reputation.giveFeedback(AGENT_ID, 100, 0, "jobcompleted", "hallmark", "", "https://x/1", bytes32(uint256(7)));
        uint256 used = before - gasleft();
        vm.stopPrank();

        assertLt(used, hook.MIN_FEEDBACK_STIPEND(), "an observed first write fits inside the stipend");
    }

    /// @dev The whole point of the try/catch is that settlement is final. A skipped receipt must not
    ///      leave the escrow, the payout or the local record half-applied.
    function test_Complete_SkippedFeedbackLeavesTheJobConsistent() public {
        _probe(AGENT_ID, 95);
        uint256 clientBefore = token.balanceOf(client);
        uint256 jobId = _createFundedJob();

        vm.warp(block.timestamp + 90 minutes);
        vm.prank(provider);
        commerce.submit(jobId, bytes32(0), "");

        vm.prank(evaluator);
        commerce.complete{gas: 300_000}(jobId, keccak256("ok"), "");

        uint256 fee = (BUDGET * FEE_BPS) / commerce.BPS_DENOMINATOR();
        assertEq(uint8(_status(jobId)), uint8(IAgenticCommerce.JobStatus.Completed), "job settled");
        assertEq(token.balanceOf(provider), BUDGET - fee, "provider paid in full");
        assertEq(token.balanceOf(treasury), fee, "treasury paid in full");
        assertEq(token.balanceOf(client), clientBefore - BUDGET);
        assertEq(token.balanceOf(address(commerce)), 0, "escrow drained");
        assertEq(commerce.escrowedTotal(), 0);

        // The hook's own accounting is unaffected by the registry write being skipped.
        HallmarkHook.Record memory record = hook.agentRecord(AGENT_ID);
        assertEq(record.jobsCompleted, 1);
        assertEq(record.totalDeliverySeconds, 90 minutes);

        // And the job is genuinely terminal, not retryable into a double payout.
        vm.prank(evaluator);
        vm.expectRevert(IAgenticCommerce.WrongStatus.selector);
        commerce.complete(jobId, keccak256("ok"), "");
    }

    function test_Reject_EmitsFeedbackSkippedWhenGasIsInsufficient() public {
        _probe(AGENT_ID, 95);
        uint256 clientBefore = token.balanceOf(client);
        uint256 jobId = _createFundedJob();

        vm.recordLogs();
        vm.prank(evaluator);
        // `reject` moves one transfer rather than two, so it needs a tighter limit than `complete`
        // to land under the floor.
        commerce.reject{gas: 250_000}(jobId, keccak256("nope"), "");

        assertTrue(_sawEvent(vm.getRecordedLogs(), _SKIPPED_TOPIC, jobId));
        assertEq(token.balanceOf(client), clientBefore, "the refund still happens");
        assertEq(hook.agentRecord(AGENT_ID).jobsRejected, 1);
    }

    function test_Fund_RevertsWhenGasIsInsufficientForEvidenceCheck() public {
        _probe(AGENT_ID, 95);
        uint256 jobId = _createAndBudget(address(hook), BUDGET);

        vm.prank(client);
        vm.expectPartialRevert(HallmarkHook.InsufficientGasForEvidenceCheck.selector);
        commerce.fund{gas: 120_000}(jobId, BUDGET, abi.encode(AGENT_ID));

        assertEq(token.balanceOf(address(commerce)), 0, "a gate that cannot read refuses to open");
        assertEq(uint8(_status(jobId)), uint8(IAgenticCommerce.JobStatus.Open));
    }

    /// @dev A starved gate must never silently answer "unhireable" — it must refuse instead, so the
    ///      caller retries with a real limit rather than believing a live agent is dead.
    function test_Fund_SucceedsOnceEnoughGasIsSuppliedForTheGate() public {
        _probe(AGENT_ID, 95);
        uint256 jobId = _createAndBudget(address(hook), BUDGET);

        vm.prank(client);
        commerce.fund{gas: 600_000}(jobId, BUDGET, abi.encode(AGENT_ID));

        assertEq(uint8(_status(jobId)), uint8(IAgenticCommerce.JobStatus.Funded));
    }

    /// @dev The reserve half of the fix. A registry handed a stipend it burns entirely must still
    ///      leave the hook enough gas to finish, or settlement unwinds after the money moved.
    function test_Complete_SurvivesARegistryThatBurnsAllForwardedGas() public {
        GasBurningReputationRegistry burner = new GasBurningReputationRegistry();
        HallmarkHook gasHook =
            new HallmarkHook(address(commerce), address(identity), address(burner), address(validation), attestor);
        commerce.setHookWhitelisted(address(gasHook), true);
        gasHook.setEvidenceBaseURI("https://hallmark.xyz/evidence/");

        // The burner serves no reputation summaries, so the gate runs on validation evidence.
        _validate(attestor, AGENT_ID, 90);

        vm.startPrank(client);
        uint256 jobId =
            commerce.createJob(provider, evaluator, block.timestamp + JOB_DURATION, "burn", address(gasHook));
        commerce.setBudget(jobId, BUDGET, "");
        commerce.fund(jobId, BUDGET, abi.encode(AGENT_ID));
        vm.stopPrank();

        vm.prank(provider);
        commerce.submit(jobId, bytes32(0), "");

        vm.recordLogs();
        vm.prank(evaluator);
        // This limit is chosen, not arbitrary. It leaves the write just above MIN_FEEDBACK_GAS, which
        // is where the reserve actually bites: 1/64 of what remains is not enough to emit the two
        // closing logs. Set FEEDBACK_EPILOGUE_RESERVE to 0 and this test fails; raise the limit much
        // above this and 1/64 becomes sufficient on its own and the test stops proving anything.
        commerce.complete{gas: 360_000}(jobId, keccak256("ok"), "");

        uint256 fee = (BUDGET * FEE_BPS) / commerce.BPS_DENOMINATOR();
        assertEq(uint8(_status(jobId)), uint8(IAgenticCommerce.JobStatus.Completed), "settlement is final");
        assertEq(token.balanceOf(provider), BUDGET - fee, "provider still paid");
        assertEq(token.balanceOf(treasury), fee);
        assertEq(token.balanceOf(address(commerce)), 0);
        assertEq(gasHook.agentRecord(AGENT_ID).jobsCompleted, 1, "the local record still updates");
        assertTrue(_sawEvent(vm.getRecordedLogs(), _FAILED_TOPIC, jobId), "the failure is reported, not swallowed");
    }

    function test_EvidenceGasFloor_CoversAFullyLoadedGateRead() public {
        // Worst case the gate can reach: a full scan window of validation records plus the
        // reputation summary.
        for (uint256 i = 0; i < hook.VALIDATION_SCAN_LIMIT(); ++i) {
            _validate(attestor, AGENT_ID, 90);
        }
        _probe(AGENT_ID, 95);

        uint256 before = gasleft();
        hook.isHireable(AGENT_ID);
        uint256 used = before - gasleft();

        assertLt(used, hook.MIN_EVIDENCE_GAS(), "the floor covers a fully loaded evidence read");
    }

    // ---------------------------------------------------------------------
    // Expiry catch-up
    // ---------------------------------------------------------------------

    function test_RecordExpiry_CountsAnExpiredJob() public {
        _probe(AGENT_ID, 95);
        uint256 jobId = _createFundedJob();

        vm.warp(block.timestamp + JOB_DURATION + 1);
        commerce.claimRefund(jobId);

        vm.expectEmit(true, true, false, false, address(hook));
        emit HallmarkHook.ExpiryRecorded(jobId, AGENT_ID);
        vm.prank(stranger);
        hook.recordExpiry(jobId);

        assertEq(hook.agentRecord(AGENT_ID).jobsExpired, 1);
        assertTrue(hook.expiryRecorded(jobId));
    }

    function test_RecordExpiry_RevertsWhenJobIsNotExpired() public {
        _probe(AGENT_ID, 95);
        uint256 jobId = _createFundedJob();

        vm.expectRevert(abi.encodeWithSelector(HallmarkHook.JobNotExpired.selector, jobId));
        hook.recordExpiry(jobId);
    }

    function test_RecordExpiry_RevertsOnSecondCall() public {
        _probe(AGENT_ID, 95);
        uint256 jobId = _createFundedJob();
        vm.warp(block.timestamp + JOB_DURATION + 1);
        commerce.claimRefund(jobId);
        hook.recordExpiry(jobId);

        vm.expectRevert(abi.encodeWithSelector(HallmarkHook.ExpiryAlreadyRecorded.selector, jobId));
        hook.recordExpiry(jobId);
    }

    // ---------------------------------------------------------------------
    // Internals
    // ---------------------------------------------------------------------

    function _runJob(uint256 deliveryTime) private {
        uint256 jobId = _createFundedJob();
        vm.warp(block.timestamp + deliveryTime);
        vm.prank(provider);
        commerce.submit(jobId, bytes32(0), "");
        vm.prank(evaluator);
        commerce.complete(jobId, bytes32(0), "");
    }

    /// @dev Takes the log array explicitly rather than reading the cheatcode, so a single test can
    ///      ask several questions of one capture.
    function _sawEvent(Vm.Log[] memory logs, bytes32 topic0, uint256 jobId) private pure returns (bool) {
        for (uint256 i = 0; i < logs.length; ++i) {
            if (logs[i].topics.length >= 2 && logs[i].topics[0] == topic0 && uint256(logs[i].topics[1]) == jobId) {
                return true;
            }
        }
        return false;
    }
}
