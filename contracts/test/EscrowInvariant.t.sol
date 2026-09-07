// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";

import {AgenticCommerceHooked} from "../src/AgenticCommerceHooked.sol";
import {IAgenticCommerce} from "../src/interfaces/IAgenticCommerce.sol";
import {MockERC20} from "./mocks/MockERC20.sol";

/// @notice Drives the escrow through random, legal-ish action sequences.
/// @dev Illegal calls are expected and simply revert; the invariants must hold across whatever
///      subset of them the fuzzer manages to land.
contract EscrowHandler is Test {
    AgenticCommerceHooked internal immutable commerce;
    MockERC20 internal immutable token;

    address internal immutable client;
    address internal immutable provider;
    address internal immutable evaluator;

    uint256 public jobsCreated;
    uint256 public feesPaid;

    constructor(
        AgenticCommerceHooked commerce_,
        MockERC20 token_,
        address client_,
        address provider_,
        address evaluator_
    ) {
        commerce = commerce_;
        token = token_;
        client = client_;
        provider = provider_;
        evaluator = evaluator_;
    }

    function createJob(uint256 budgetSeed, uint256 durationSeed) external {
        uint256 budget = bound(budgetSeed, 1, 10_000e18);
        uint256 duration = bound(durationSeed, commerce.MIN_JOB_DURATION(), 30 days);

        vm.startPrank(client);
        uint256 jobId = commerce.createJob(provider, evaluator, block.timestamp + duration, "job", address(0));
        commerce.setBudget(jobId, budget, "");
        vm.stopPrank();
        jobsCreated = jobId;
    }

    function fund(uint256 jobSeed) external {
        uint256 jobId = _pick(jobSeed);
        if (jobId == 0) return;
        IAgenticCommerce.Job memory job = commerce.getJob(jobId);
        if (job.status != IAgenticCommerce.JobStatus.Open) return;

        vm.prank(client);
        commerce.fund(jobId, job.budget, "");
    }

    function submit(uint256 jobSeed) external {
        uint256 jobId = _pick(jobSeed);
        if (jobId == 0) return;
        if (commerce.getJob(jobId).status != IAgenticCommerce.JobStatus.Funded) return;

        vm.prank(provider);
        commerce.submit(jobId, keccak256(abi.encode(jobId)), "");
    }

    function complete(uint256 jobSeed) external {
        uint256 jobId = _pick(jobSeed);
        if (jobId == 0) return;
        IAgenticCommerce.Job memory job = commerce.getJob(jobId);
        if (job.status != IAgenticCommerce.JobStatus.Submitted) return;

        feesPaid += (job.budget * commerce.feeBps()) / commerce.BPS_DENOMINATOR();
        vm.prank(evaluator);
        commerce.complete(jobId, bytes32(0), "");
    }

    function reject(uint256 jobSeed) external {
        uint256 jobId = _pick(jobSeed);
        if (jobId == 0) return;
        IAgenticCommerce.JobStatus status = commerce.getJob(jobId).status;

        if (status == IAgenticCommerce.JobStatus.Open) {
            vm.prank(client);
            commerce.reject(jobId, bytes32(0), "");
        } else if (status == IAgenticCommerce.JobStatus.Funded || status == IAgenticCommerce.JobStatus.Submitted) {
            vm.prank(evaluator);
            commerce.reject(jobId, bytes32(0), "");
        }
    }

    function claimRefund(uint256 jobSeed) external {
        uint256 jobId = _pick(jobSeed);
        if (jobId == 0) return;
        IAgenticCommerce.Job memory job = commerce.getJob(jobId);
        if (job.status != IAgenticCommerce.JobStatus.Funded && job.status != IAgenticCommerce.JobStatus.Submitted) {
            return;
        }
        if (block.timestamp < job.expiredAt) return;

        commerce.claimRefund(jobId);
    }

    function advanceTime(uint256 seconds_) external {
        vm.warp(block.timestamp + bound(seconds_, 1 hours, 40 days));
    }

    function _pick(uint256 seed) private view returns (uint256) {
        uint256 count = commerce.jobCount();
        if (count == 0) return 0;
        return bound(seed, 1, count);
    }
}

/// @notice The escrow's accounting invariant: what the contract holds is exactly what it owes.
contract EscrowInvariantTest is Test {
    MockERC20 internal token;
    AgenticCommerceHooked internal commerce;
    EscrowHandler internal handler;

    address internal client = makeAddr("client");
    address internal provider = makeAddr("provider");
    address internal evaluator = makeAddr("evaluator");
    address internal treasury = makeAddr("treasury");

    uint256 internal constant MINTED = 100_000_000e18;

    function setUp() public {
        vm.warp(1_700_000_000);

        token = new MockERC20("United Stables", "U");
        commerce = new AgenticCommerceHooked(address(token), treasury, 250);

        token.mint(client, MINTED);
        vm.prank(client);
        token.approve(address(commerce), type(uint256).max);

        handler = new EscrowHandler(commerce, token, client, provider, evaluator);
        targetContract(address(handler));
    }

    /// @notice Escrowed token balance always equals the sum of the budgets of every job that is
    ///         still Funded or Submitted. No dust, no shortfall, no stranded escrow.
    function invariant_EscrowMatchesOpenBudgets() public view {
        assertEq(token.balanceOf(address(commerce)), commerce.escrowedTotal());
    }

    /// @notice The treasury only ever receives fees from completed jobs.
    function invariant_TreasuryOnlyEarnsOnCompletion() public view {
        assertEq(token.balanceOf(treasury), handler.feesPaid());
    }

    /// @notice Nothing is minted or burned along the way.
    function invariant_TokensAreConserved() public view {
        uint256 total = token.balanceOf(client) + token.balanceOf(provider) + token.balanceOf(evaluator)
            + token.balanceOf(treasury) + token.balanceOf(address(commerce));
        assertEq(total, MINTED);
    }
}
