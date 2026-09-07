// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {IERC20Errors} from "@openzeppelin/contracts/interfaces/draft-IERC6093.sol";

import {Base} from "./Base.t.sol";
import {AgenticCommerceHooked} from "../src/AgenticCommerceHooked.sol";
import {IAgenticCommerce} from "../src/interfaces/IAgenticCommerce.sol";

import {MockERC20} from "./mocks/MockERC20.sol";
import {RecordingHook} from "./mocks/RecordingHook.sol";
import {ReentrantHook} from "./mocks/ReentrantHook.sol";
import {RevertingHook} from "./mocks/RevertingHook.sol";

/// @notice Exercises the ERC-8183 escrow on its own: state machine, authorisation, fee maths and
///         the hook call contract.
contract AgenticCommerceHookedTest is Base {
    // ---------------------------------------------------------------------
    // Construction and administration
    // ---------------------------------------------------------------------

    function test_Constructor_SetsImmutablesAndConfig() public view {
        assertEq(address(commerce.paymentToken()), address(token));
        assertEq(commerce.treasury(), treasury);
        assertEq(commerce.feeBps(), FEE_BPS);
        assertEq(commerce.owner(), owner);
        assertEq(commerce.jobCount(), 0);
    }

    function test_Constructor_RevertsOnZeroToken() public {
        vm.expectRevert(IAgenticCommerce.ZeroAddress.selector);
        new AgenticCommerceHooked(address(0), treasury, FEE_BPS);
    }

    function test_Constructor_RevertsOnZeroTreasury() public {
        vm.expectRevert(IAgenticCommerce.ZeroAddress.selector);
        new AgenticCommerceHooked(address(token), address(0), FEE_BPS);
    }

    function test_Constructor_RevertsWhenFeeAboveCap() public {
        vm.expectRevert(IAgenticCommerce.FeesTooHigh.selector);
        new AgenticCommerceHooked(address(token), treasury, 1_001);
    }

    function test_SetPlatformFee_UpdatesFee() public {
        commerce.setPlatformFee(500);
        assertEq(commerce.feeBps(), 500);
    }

    function test_SetPlatformFee_RevertsAboveCap() public {
        vm.expectRevert(IAgenticCommerce.FeesTooHigh.selector);
        commerce.setPlatformFee(1_001);
    }

    function test_SetPlatformFee_AcceptsExactlyTheCap() public {
        commerce.setPlatformFee(uint16(commerce.MAX_FEE_BPS()));
        assertEq(commerce.feeBps(), 1_000);
    }

    function test_SetPlatformFee_OnlyOwner() public {
        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, stranger));
        commerce.setPlatformFee(100);
    }

    function test_SetTreasury_UpdatesTreasury() public {
        commerce.setTreasury(stranger);
        assertEq(commerce.treasury(), stranger);
    }

    function test_SetTreasury_RevertsOnZeroAddress() public {
        vm.expectRevert(IAgenticCommerce.ZeroAddress.selector);
        commerce.setTreasury(address(0));
    }

    function test_SetTreasury_OnlyOwner() public {
        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, stranger));
        commerce.setTreasury(stranger);
    }

    function test_SetHookWhitelisted_OnlyOwner() public {
        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, stranger));
        commerce.setHookWhitelisted(address(hook), false);
    }

    function test_SetHookWhitelisted_RevertsOnZeroAddress() public {
        vm.expectRevert(IAgenticCommerce.ZeroAddress.selector);
        commerce.setHookWhitelisted(address(0), true);
    }

    function test_SetHookWhitelisted_CanRevoke() public {
        commerce.setHookWhitelisted(address(hook), false);
        assertFalse(commerce.isHookWhitelisted(address(hook)));
    }

    // ---------------------------------------------------------------------
    // createJob
    // ---------------------------------------------------------------------

    function test_CreateJob_StoresEveryField() public {
        uint256 expiry = block.timestamp + JOB_DURATION;
        vm.prank(client);
        uint256 jobId = commerce.createJob(provider, evaluator, expiry, "index a wallet", address(0));

        IAgenticCommerce.Job memory job = commerce.getJob(jobId);
        assertEq(job.id, 1);
        assertEq(job.client, client);
        assertEq(job.provider, provider);
        assertEq(job.evaluator, evaluator);
        assertEq(job.description, "index a wallet");
        assertEq(job.budget, 0);
        assertEq(job.expiredAt, expiry);
        assertEq(uint8(job.status), uint8(IAgenticCommerce.JobStatus.Open));
        assertEq(job.hook, address(0));
    }

    function test_CreateJob_AssignsSequentialIds() public {
        assertEq(_createJob(address(0)), 1);
        assertEq(_createJob(address(0)), 2);
        assertEq(_createJob(address(0)), 3);
        assertEq(commerce.jobCount(), 3);
    }

    function test_CreateJob_AllowsUnsetProvider() public {
        vm.prank(client);
        uint256 jobId = commerce.createJob(address(0), evaluator, block.timestamp + JOB_DURATION, "tbd", address(0));
        assertEq(commerce.getJob(jobId).provider, address(0));
    }

    function test_CreateJob_RevertsOnZeroEvaluator() public {
        vm.prank(client);
        vm.expectRevert(IAgenticCommerce.ZeroAddress.selector);
        commerce.createJob(provider, address(0), block.timestamp + JOB_DURATION, "x", address(0));
    }

    function test_CreateJob_RevertsWhenExpiryTooShort() public {
        vm.prank(client);
        vm.expectRevert(IAgenticCommerce.ExpiryTooShort.selector);
        commerce.createJob(provider, evaluator, block.timestamp + 59 minutes, "x", address(0));
    }

    function test_CreateJob_RevertsWhenExpiryInThePast() public {
        vm.prank(client);
        vm.expectRevert(IAgenticCommerce.ExpiryTooShort.selector);
        commerce.createJob(provider, evaluator, block.timestamp - 1, "x", address(0));
    }

    function test_CreateJob_AcceptsExactlyTheMinimumDuration() public {
        vm.prank(client);
        uint256 jobId =
            commerce.createJob(provider, evaluator, block.timestamp + commerce.MIN_JOB_DURATION(), "x", address(0));
        assertEq(jobId, 1);
    }

    function test_CreateJob_RevertsOnNonWhitelistedHook() public {
        RecordingHook rogue = new RecordingHook();
        vm.prank(client);
        vm.expectRevert(IAgenticCommerce.HookNotWhitelisted.selector);
        commerce.createJob(provider, evaluator, block.timestamp + JOB_DURATION, "x", address(rogue));
    }

    function test_CreateJob_AcceptsWhitelistedHook() public {
        RecordingHook allowed = new RecordingHook();
        commerce.setHookWhitelisted(address(allowed), true);
        uint256 jobId = _createJob(address(allowed));
        assertEq(commerce.getJob(jobId).hook, address(allowed));
    }

    // ---------------------------------------------------------------------
    // setProvider / setBudget
    // ---------------------------------------------------------------------

    function test_SetProvider_ByClient() public {
        uint256 jobId = _createJob(address(0));
        vm.prank(client);
        commerce.setProvider(jobId, stranger);
        assertEq(commerce.getJob(jobId).provider, stranger);
    }

    function test_SetProvider_RevertsForNonClient() public {
        uint256 jobId = _createJob(address(0));
        vm.prank(provider);
        vm.expectRevert(IAgenticCommerce.Unauthorized.selector);
        commerce.setProvider(jobId, stranger);
    }

    function test_SetProvider_RevertsOnZeroAddress() public {
        uint256 jobId = _createJob(address(0));
        vm.prank(client);
        vm.expectRevert(IAgenticCommerce.ZeroAddress.selector);
        commerce.setProvider(jobId, address(0));
    }

    function test_SetProvider_RevertsOnceFunded() public {
        _probe(AGENT_ID, 90);
        uint256 jobId = _createFundedJob();
        vm.prank(client);
        vm.expectRevert(IAgenticCommerce.WrongStatus.selector);
        commerce.setProvider(jobId, stranger);
    }

    function test_SetBudget_ByClient() public {
        uint256 jobId = _createJob(address(0));
        vm.prank(client);
        commerce.setBudget(jobId, BUDGET, "");
        assertEq(commerce.getJob(jobId).budget, BUDGET);
    }

    function test_SetBudget_ByProvider() public {
        uint256 jobId = _createJob(address(0));
        vm.prank(provider);
        commerce.setBudget(jobId, BUDGET, "");
        assertEq(commerce.getJob(jobId).budget, BUDGET);
    }

    function test_SetBudget_CanBeRenegotiatedWhileOpen() public {
        uint256 jobId = _createJob(address(0));
        vm.prank(client);
        commerce.setBudget(jobId, BUDGET, "");
        vm.prank(provider);
        commerce.setBudget(jobId, BUDGET * 2, "");
        assertEq(commerce.getJob(jobId).budget, BUDGET * 2);
    }

    function test_SetBudget_RevertsForStranger() public {
        uint256 jobId = _createJob(address(0));
        vm.prank(stranger);
        vm.expectRevert(IAgenticCommerce.Unauthorized.selector);
        commerce.setBudget(jobId, BUDGET, "");
    }

    function test_SetBudget_RevertsOnZero() public {
        uint256 jobId = _createJob(address(0));
        vm.prank(client);
        vm.expectRevert(IAgenticCommerce.ZeroBudget.selector);
        commerce.setBudget(jobId, 0, "");
    }

    function test_SetBudget_RevertsOnceFunded() public {
        _probe(AGENT_ID, 90);
        uint256 jobId = _createFundedJob();
        vm.prank(client);
        vm.expectRevert(IAgenticCommerce.WrongStatus.selector);
        commerce.setBudget(jobId, BUDGET, "");
    }

    // ---------------------------------------------------------------------
    // fund
    // ---------------------------------------------------------------------

    function test_Fund_MovesEscrowAndSetsStatus() public {
        uint256 jobId = _createAndBudget(address(0), BUDGET);
        uint256 before = token.balanceOf(client);

        vm.prank(client);
        commerce.fund(jobId, BUDGET, "");

        assertEq(uint8(_status(jobId)), uint8(IAgenticCommerce.JobStatus.Funded));
        assertEq(token.balanceOf(address(commerce)), BUDGET);
        assertEq(token.balanceOf(client), before - BUDGET);
        assertEq(commerce.escrowedTotal(), BUDGET);
    }

    function test_Fund_RevertsForNonClient() public {
        uint256 jobId = _createAndBudget(address(0), BUDGET);
        vm.prank(provider);
        vm.expectRevert(IAgenticCommerce.Unauthorized.selector);
        commerce.fund(jobId, BUDGET, "");
    }

    function test_Fund_RevertsWhenProviderNotSet() public {
        vm.prank(client);
        uint256 jobId = commerce.createJob(address(0), evaluator, block.timestamp + JOB_DURATION, "x", address(0));
        vm.prank(client);
        commerce.setBudget(jobId, BUDGET, "");

        vm.prank(client);
        vm.expectRevert(IAgenticCommerce.ProviderNotSet.selector);
        commerce.fund(jobId, BUDGET, "");
    }

    function test_Fund_RevertsWhenBudgetNeverSet() public {
        uint256 jobId = _createJob(address(0));
        vm.prank(client);
        vm.expectRevert(IAgenticCommerce.ZeroBudget.selector);
        commerce.fund(jobId, 0, "");
    }

    function test_Fund_RevertsOnBudgetMismatch() public {
        uint256 jobId = _createAndBudget(address(0), BUDGET);
        // The provider raises the budget between the client's read and its transaction.
        vm.prank(provider);
        commerce.setBudget(jobId, BUDGET * 3, "");

        vm.prank(client);
        vm.expectRevert(abi.encodeWithSelector(AgenticCommerceHooked.BudgetMismatch.selector, BUDGET, BUDGET * 3));
        commerce.fund(jobId, BUDGET, "");
    }

    function test_Fund_RevertsWhenAlreadyFunded() public {
        uint256 jobId = _createAndBudget(address(0), BUDGET);
        vm.prank(client);
        commerce.fund(jobId, BUDGET, "");
        vm.prank(client);
        vm.expectRevert(IAgenticCommerce.WrongStatus.selector);
        commerce.fund(jobId, BUDGET, "");
    }

    function test_Fund_RevertsWithoutAllowance() public {
        uint256 jobId = _createAndBudget(address(0), BUDGET);
        vm.prank(client);
        token.approve(address(commerce), 0);

        vm.prank(client);
        vm.expectRevert(
            abi.encodeWithSelector(IERC20Errors.ERC20InsufficientAllowance.selector, address(commerce), 0, BUDGET)
        );
        commerce.fund(jobId, BUDGET, "");
    }

    // ---------------------------------------------------------------------
    // submit / complete
    // ---------------------------------------------------------------------

    function test_Submit_MovesToSubmitted() public {
        uint256 jobId = _createAndBudget(address(0), BUDGET);
        vm.prank(client);
        commerce.fund(jobId, BUDGET, "");

        vm.prank(provider);
        commerce.submit(jobId, keccak256("deliverable"), "");
        assertEq(uint8(_status(jobId)), uint8(IAgenticCommerce.JobStatus.Submitted));
    }

    function test_Submit_RevertsForNonProvider() public {
        uint256 jobId = _createAndBudget(address(0), BUDGET);
        vm.prank(client);
        commerce.fund(jobId, BUDGET, "");

        vm.prank(client);
        vm.expectRevert(IAgenticCommerce.Unauthorized.selector);
        commerce.submit(jobId, bytes32(0), "");
    }

    function test_Submit_RevertsWhenNotFunded() public {
        uint256 jobId = _createAndBudget(address(0), BUDGET);
        vm.prank(provider);
        vm.expectRevert(IAgenticCommerce.WrongStatus.selector);
        commerce.submit(jobId, bytes32(0), "");
    }

    function test_Complete_PaysProviderAndTreasury() public {
        uint256 jobId = _fundAndSubmit(BUDGET);

        vm.prank(evaluator);
        commerce.complete(jobId, keccak256("good work"), "");

        uint256 fee = (BUDGET * FEE_BPS) / commerce.BPS_DENOMINATOR();
        assertEq(token.balanceOf(provider), BUDGET - fee);
        assertEq(token.balanceOf(treasury), fee);
        assertEq(token.balanceOf(address(commerce)), 0);
        assertEq(uint8(_status(jobId)), uint8(IAgenticCommerce.JobStatus.Completed));
        assertEq(commerce.escrowedTotal(), 0);
    }

    function test_Complete_EmitsPaymentReleased() public {
        uint256 jobId = _fundAndSubmit(BUDGET);
        uint256 fee = (BUDGET * FEE_BPS) / commerce.BPS_DENOMINATOR();

        vm.expectEmit(true, true, false, true, address(commerce));
        emit IAgenticCommerce.PaymentReleased(jobId, provider, BUDGET - fee, fee);
        vm.prank(evaluator);
        commerce.complete(jobId, bytes32(0), "");
    }

    function test_Complete_WithZeroFeePaysFullBudget() public {
        commerce.setPlatformFee(0);
        uint256 jobId = _fundAndSubmit(BUDGET);

        vm.prank(evaluator);
        commerce.complete(jobId, bytes32(0), "");

        assertEq(token.balanceOf(provider), BUDGET);
        assertEq(token.balanceOf(treasury), 0);
    }

    function test_Complete_RevertsForNonEvaluator() public {
        uint256 jobId = _fundAndSubmit(BUDGET);
        vm.prank(client);
        vm.expectRevert(IAgenticCommerce.Unauthorized.selector);
        commerce.complete(jobId, bytes32(0), "");
    }

    function test_Complete_RevertsWhenNotSubmitted() public {
        uint256 jobId = _createAndBudget(address(0), BUDGET);
        vm.prank(client);
        commerce.fund(jobId, BUDGET, "");

        vm.prank(evaluator);
        vm.expectRevert(IAgenticCommerce.WrongStatus.selector);
        commerce.complete(jobId, bytes32(0), "");
    }

    function test_Complete_RevertsTwice() public {
        uint256 jobId = _fundAndSubmit(BUDGET);
        vm.prank(evaluator);
        commerce.complete(jobId, bytes32(0), "");

        vm.prank(evaluator);
        vm.expectRevert(IAgenticCommerce.WrongStatus.selector);
        commerce.complete(jobId, bytes32(0), "");
    }

    // ---------------------------------------------------------------------
    // reject
    // ---------------------------------------------------------------------

    function test_Reject_ByClientWhileOpen() public {
        uint256 jobId = _createAndBudget(address(0), BUDGET);
        vm.prank(client);
        commerce.reject(jobId, keccak256("changed my mind"), "");
        assertEq(uint8(_status(jobId)), uint8(IAgenticCommerce.JobStatus.Rejected));
        assertEq(token.balanceOf(address(commerce)), 0);
    }

    function test_Reject_ByEvaluatorWhenFunded_RefundsClient() public {
        uint256 jobId = _createAndBudget(address(0), BUDGET);
        uint256 before = token.balanceOf(client);
        vm.prank(client);
        commerce.fund(jobId, BUDGET, "");

        vm.prank(evaluator);
        commerce.reject(jobId, keccak256("agent went dark"), "");

        assertEq(token.balanceOf(client), before);
        assertEq(token.balanceOf(address(commerce)), 0);
        assertEq(uint8(_status(jobId)), uint8(IAgenticCommerce.JobStatus.Rejected));
    }

    function test_Reject_ByEvaluatorWhenSubmitted_RefundsClient() public {
        uint256 before = token.balanceOf(client);
        uint256 jobId = _fundAndSubmit(BUDGET);

        vm.prank(evaluator);
        commerce.reject(jobId, keccak256("bad deliverable"), "");

        assertEq(token.balanceOf(client), before);
        assertEq(token.balanceOf(treasury), 0);
    }

    function test_Reject_RevertsForClientOnceFunded() public {
        uint256 jobId = _createAndBudget(address(0), BUDGET);
        vm.prank(client);
        commerce.fund(jobId, BUDGET, "");

        vm.prank(client);
        vm.expectRevert(IAgenticCommerce.Unauthorized.selector);
        commerce.reject(jobId, bytes32(0), "");
    }

    function test_Reject_RevertsForEvaluatorWhileOpen() public {
        uint256 jobId = _createAndBudget(address(0), BUDGET);
        vm.prank(evaluator);
        vm.expectRevert(IAgenticCommerce.Unauthorized.selector);
        commerce.reject(jobId, bytes32(0), "");
    }

    function test_Reject_RevertsOnCompletedJob() public {
        uint256 jobId = _fundAndSubmit(BUDGET);
        vm.prank(evaluator);
        commerce.complete(jobId, bytes32(0), "");

        vm.prank(evaluator);
        vm.expectRevert(IAgenticCommerce.WrongStatus.selector);
        commerce.reject(jobId, bytes32(0), "");
    }

    // ---------------------------------------------------------------------
    // claimRefund
    // ---------------------------------------------------------------------

    function test_ClaimRefund_ReturnsEscrowAfterExpiry() public {
        uint256 before = token.balanceOf(client);
        uint256 jobId = _createAndBudget(address(0), BUDGET);
        vm.prank(client);
        commerce.fund(jobId, BUDGET, "");

        vm.warp(block.timestamp + JOB_DURATION + 1);
        commerce.claimRefund(jobId);

        assertEq(token.balanceOf(client), before);
        assertEq(uint8(_status(jobId)), uint8(IAgenticCommerce.JobStatus.Expired));
    }

    function test_ClaimRefund_IsPermissionless() public {
        uint256 jobId = _createAndBudget(address(0), BUDGET);
        vm.prank(client);
        commerce.fund(jobId, BUDGET, "");

        vm.warp(block.timestamp + JOB_DURATION);
        vm.prank(stranger);
        commerce.claimRefund(jobId);

        assertEq(uint8(_status(jobId)), uint8(IAgenticCommerce.JobStatus.Expired));
    }

    function test_ClaimRefund_WorksFromSubmittedStateOnceTheEvaluationWindowCloses() public {
        uint256 before = token.balanceOf(client);
        uint256 jobId = _fundAndSubmit(BUDGET);

        vm.warp(commerce.evaluationDeadline(jobId));
        commerce.claimRefund(jobId);

        assertEq(token.balanceOf(client), before);
    }

    function test_ClaimRefund_RefusedWhileTheEvaluationWindowIsOpen() public {
        uint256 jobId = _fundAndSubmit(BUDGET);
        uint256 deadline = commerce.evaluationDeadline(jobId);
        assertEq(deadline, commerce.getJob(jobId).expiredAt + commerce.EVALUATION_WINDOW());

        vm.warp(deadline - 1);
        vm.expectRevert(abi.encodeWithSelector(AgenticCommerceHooked.EvaluationWindowOpen.selector, jobId, deadline));
        commerce.claimRefund(jobId);
    }

    function test_Submit_SetsTheEvaluationDeadline() public {
        uint256 jobId = _createAndBudget(address(0), BUDGET);
        vm.prank(client);
        commerce.fund(jobId, BUDGET, "");

        uint256 expiredAt = commerce.getJob(jobId).expiredAt;
        vm.expectEmit(true, false, false, true, address(commerce));
        emit AgenticCommerceHooked.EvaluationDeadlineSet(jobId, expiredAt + commerce.EVALUATION_WINDOW());
        vm.prank(provider);
        commerce.submit(jobId, bytes32(0), "");
    }

    function test_ClaimRefund_RevertsBeforeExpiry() public {
        uint256 jobId = _createAndBudget(address(0), BUDGET);
        vm.prank(client);
        commerce.fund(jobId, BUDGET, "");

        vm.expectRevert(AgenticCommerceHooked.NotYetExpired.selector);
        commerce.claimRefund(jobId);
    }

    function test_ClaimRefund_RevertsWhileOpen() public {
        uint256 jobId = _createAndBudget(address(0), BUDGET);
        vm.warp(block.timestamp + JOB_DURATION + 1);
        vm.expectRevert(IAgenticCommerce.WrongStatus.selector);
        commerce.claimRefund(jobId);
    }

    function test_ClaimRefund_RevertsTwice() public {
        uint256 jobId = _createAndBudget(address(0), BUDGET);
        vm.prank(client);
        commerce.fund(jobId, BUDGET, "");
        vm.warp(block.timestamp + JOB_DURATION + 1);
        commerce.claimRefund(jobId);

        vm.expectRevert(IAgenticCommerce.WrongStatus.selector);
        commerce.claimRefund(jobId);
    }

    // ---------------------------------------------------------------------
    // getJob
    // ---------------------------------------------------------------------

    function test_GetJob_RevertsOnZeroId() public {
        vm.expectRevert(IAgenticCommerce.InvalidJob.selector);
        commerce.getJob(0);
    }

    function test_GetJob_RevertsOnUnknownId() public {
        _createJob(address(0));
        vm.expectRevert(IAgenticCommerce.InvalidJob.selector);
        commerce.getJob(2);
    }

    function test_Actions_RevertOnUnknownJob() public {
        vm.prank(client);
        vm.expectRevert(IAgenticCommerce.InvalidJob.selector);
        commerce.setBudget(99, BUDGET, "");
    }

    // ---------------------------------------------------------------------
    // Hook call contract
    // ---------------------------------------------------------------------

    function test_Hooks_AreAnnouncedAroundEveryTransition() public {
        RecordingHook recorder = new RecordingHook();
        commerce.setHookWhitelisted(address(recorder), true);

        uint256 jobId = _createJob(address(recorder));
        vm.prank(client);
        commerce.setBudget(jobId, BUDGET, "");
        vm.prank(client);
        commerce.fund(jobId, BUDGET, "");
        vm.prank(provider);
        commerce.submit(jobId, keccak256("d"), "");
        vm.prank(evaluator);
        commerce.complete(jobId, keccak256("r"), "");

        // setBudget, fund, submit, complete -> 4 transitions, before and after each.
        assertEq(recorder.callCount(), 8);
        assertTrue(recorder.callAt(0).isBefore);
        assertEq(recorder.callAt(0).selector, IAgenticCommerce.setBudget.selector);
        assertFalse(recorder.callAt(1).isBefore);
        assertEq(recorder.callAt(2).selector, IAgenticCommerce.fund.selector);
        assertEq(recorder.callAt(4).selector, IAgenticCommerce.submit.selector);
        assertEq(recorder.callAt(6).selector, IAgenticCommerce.complete.selector);
    }

    function test_Hooks_FundPayloadIsRawOptParams() public {
        RecordingHook recorder = new RecordingHook();
        commerce.setHookWhitelisted(address(recorder), true);

        uint256 jobId = _createAndBudget(address(recorder), BUDGET);
        vm.prank(client);
        commerce.fund(jobId, BUDGET, abi.encode(uint256(42)));

        // Index 2 is beforeAction(fund): setBudget consumed indices 0 and 1.
        assertEq(recorder.callAt(2).data, abi.encode(uint256(42)));
    }

    function test_Hooks_SetProviderPayloadIsEncoded() public {
        RecordingHook recorder = new RecordingHook();
        commerce.setHookWhitelisted(address(recorder), true);

        uint256 jobId = _createJob(address(recorder));
        vm.prank(client);
        commerce.setProvider(jobId, stranger);

        assertEq(recorder.callAt(0).data, abi.encode(stranger, bytes("")));
    }

    function test_Hooks_AreNotCalledOnClaimRefund() public {
        RecordingHook recorder = new RecordingHook();
        commerce.setHookWhitelisted(address(recorder), true);

        uint256 jobId = _createAndBudget(address(recorder), BUDGET);
        vm.prank(client);
        commerce.fund(jobId, BUDGET, "");
        uint256 callsAfterFund = recorder.callCount();

        vm.warp(block.timestamp + JOB_DURATION + 1);
        commerce.claimRefund(jobId);

        assertEq(recorder.callCount(), callsAfterFund);
    }

    function test_Fund_RevertsWhenHookRefuses() public {
        RevertingHook blocker = new RevertingHook(false);
        commerce.setHookWhitelisted(address(blocker), true);

        uint256 jobId = _createAndBudget(address(blocker), BUDGET);
        blocker.arm();

        vm.prank(client);
        vm.expectRevert(RevertingHook.AlwaysReverts.selector);
        commerce.fund(jobId, BUDGET, "");

        assertEq(token.balanceOf(address(commerce)), 0);
    }

    function test_ClaimRefund_WorksEvenWhenHookReverts() public {
        RevertingHook blocker = new RevertingHook(false);
        commerce.setHookWhitelisted(address(blocker), true);

        uint256 before = token.balanceOf(client);
        uint256 jobId = _createAndBudget(address(blocker), BUDGET);
        vm.prank(client);
        commerce.fund(jobId, BUDGET, "");

        // The policy contract turns hostile after the escrow is already funded.
        blocker.arm();

        vm.prank(provider);
        vm.expectRevert(RevertingHook.AlwaysReverts.selector);
        commerce.submit(jobId, bytes32(0), "");

        vm.prank(evaluator);
        vm.expectRevert(RevertingHook.AlwaysReverts.selector);
        commerce.reject(jobId, bytes32(0), "");

        // The escrow is still recoverable by anyone once the job expires.
        vm.warp(block.timestamp + JOB_DURATION + 1);
        vm.prank(stranger);
        commerce.claimRefund(jobId);

        assertEq(token.balanceOf(client), before);
        assertEq(token.balanceOf(address(commerce)), 0);
        assertEq(uint8(_status(jobId)), uint8(IAgenticCommerce.JobStatus.Expired));
    }

    // ---------------------------------------------------------------------
    // Reentrancy
    // ---------------------------------------------------------------------

    function test_Reentrancy_FundIsBlocked() public {
        ReentrantHook attacker = new ReentrantHook(address(commerce));
        commerce.setHookWhitelisted(address(attacker), true);

        uint256 jobId = _createAndBudget(address(attacker), BUDGET);
        attacker.arm(ReentrantHook.Mode.ReenterFund, jobId, BUDGET);

        vm.prank(client);
        vm.expectRevert(ReentrancyGuard.ReentrancyGuardReentrantCall.selector);
        commerce.fund(jobId, BUDGET, "");

        assertEq(token.balanceOf(address(commerce)), 0);
    }

    function test_Reentrancy_CompleteIsBlocked() public {
        ReentrantHook attacker = new ReentrantHook(address(commerce));
        commerce.setHookWhitelisted(address(attacker), true);

        uint256 jobId = _createAndBudget(address(attacker), BUDGET);
        vm.prank(client);
        commerce.fund(jobId, BUDGET, "");
        vm.prank(provider);
        commerce.submit(jobId, bytes32(0), "");

        attacker.arm(ReentrantHook.Mode.ReenterComplete, jobId, BUDGET);

        vm.prank(evaluator);
        vm.expectRevert(ReentrancyGuard.ReentrancyGuardReentrantCall.selector);
        commerce.complete(jobId, bytes32(0), "");

        assertEq(token.balanceOf(provider), 0);
    }

    function test_Reentrancy_ClaimRefundFromHookIsBlocked() public {
        ReentrantHook attacker = new ReentrantHook(address(commerce));
        commerce.setHookWhitelisted(address(attacker), true);

        uint256 jobId = _createAndBudget(address(attacker), BUDGET);
        vm.prank(client);
        commerce.fund(jobId, BUDGET, "");

        vm.warp(block.timestamp + JOB_DURATION + 1);
        attacker.arm(ReentrantHook.Mode.ReenterClaimRefund, jobId, BUDGET);

        vm.prank(provider);
        vm.expectRevert(ReentrancyGuard.ReentrancyGuardReentrantCall.selector);
        commerce.submit(jobId, bytes32(0), "");
    }

    // ---------------------------------------------------------------------
    // Fuzz
    // ---------------------------------------------------------------------

    function testFuzz_Complete_SplitsBudgetExactly(uint256 budget, uint16 feeBps) public {
        budget = bound(budget, 1, 1e30);
        feeBps = uint16(bound(feeBps, 0, commerce.MAX_FEE_BPS()));

        commerce.setPlatformFee(feeBps);
        token.mint(client, budget);

        uint256 jobId = _createAndBudget(address(0), budget);
        vm.prank(client);
        commerce.fund(jobId, budget, "");
        vm.prank(provider);
        commerce.submit(jobId, bytes32(0), "");
        vm.prank(evaluator);
        commerce.complete(jobId, bytes32(0), "");

        uint256 fee = (budget * feeBps) / 10_000;
        assertEq(token.balanceOf(provider), budget - fee);
        assertEq(token.balanceOf(treasury), fee);
        assertEq(token.balanceOf(address(commerce)), 0, "escrow fully drained");
        assertLe(fee, budget / 10, "fee never exceeds the 10% cap");
    }

    function testFuzz_Refund_ReturnsTheExactBudget(uint256 budget) public {
        budget = bound(budget, 1, 1e30);
        token.mint(client, budget);
        uint256 before = token.balanceOf(client);

        uint256 jobId = _createAndBudget(address(0), budget);
        vm.prank(client);
        commerce.fund(jobId, budget, "");
        vm.warp(block.timestamp + JOB_DURATION + 1);
        commerce.claimRefund(jobId);

        assertEq(token.balanceOf(client), before);
        assertEq(token.balanceOf(treasury), 0, "a refund never pays a fee");
    }

    function testFuzz_SetPlatformFee_RevertsAboveCap(uint16 feeBps) public {
        feeBps = uint16(bound(feeBps, commerce.MAX_FEE_BPS() + 1, type(uint16).max));
        vm.expectRevert(IAgenticCommerce.FeesTooHigh.selector);
        commerce.setPlatformFee(feeBps);
    }

    function testFuzz_CreateJob_RevertsBelowMinimumDuration(uint256 offset) public {
        offset = bound(offset, 0, commerce.MIN_JOB_DURATION() - 1);
        vm.prank(client);
        vm.expectRevert(IAgenticCommerce.ExpiryTooShort.selector);
        commerce.createJob(provider, evaluator, block.timestamp + offset, "x", address(0));
    }

    function testFuzz_Fund_RevertsOnAnyWrongExpectedBudget(uint256 expected) public {
        vm.assume(expected != BUDGET);
        uint256 jobId = _createAndBudget(address(0), BUDGET);
        vm.prank(client);
        vm.expectRevert(abi.encodeWithSelector(AgenticCommerceHooked.BudgetMismatch.selector, expected, BUDGET));
        commerce.fund(jobId, expected, "");
    }

    // ---------------------------------------------------------------------
    // Internals
    // ---------------------------------------------------------------------

    function _fundAndSubmit(uint256 budget) private returns (uint256 jobId) {
        jobId = _createAndBudget(address(0), budget);
        vm.prank(client);
        commerce.fund(jobId, budget, "");
        vm.prank(provider);
        commerce.submit(jobId, keccak256("deliverable"), "");
    }
}
