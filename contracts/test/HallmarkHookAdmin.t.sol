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
