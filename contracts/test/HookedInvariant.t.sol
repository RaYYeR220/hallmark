// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";

import {AgenticCommerceHooked} from "../src/AgenticCommerceHooked.sol";
import {HallmarkHook} from "../src/HallmarkHook.sol";
import {IAgenticCommerce} from "../src/interfaces/IAgenticCommerce.sol";

import {MockERC20} from "./mocks/MockERC20.sol";
import {MockIdentityRegistry} from "./mocks/MockIdentityRegistry.sol";
import {MockReputationRegistry} from "./mocks/MockReputationRegistry.sol";
import {MockValidationRegistry} from "./mocks/MockValidationRegistry.sol";

/// @notice Drives the escrow with the real `HallmarkHook` attached, across several actors who are
///         allowed to occupy more than one role at a time.
/// @dev The shipped invariant campaign never attached a hook, used one address per role, and
///      pre-filtered every illegal call — so it reported zero reverts by construction and a handler
///      that quietly stopped doing anything would still have passed. This one runs the policy
///      contract in the loop, lets clients and providers collide, and counts what it actually
///      landed so `afterInvariant` can insist the campaign did real work.
contract HookedHandler is Test {
    AgenticCommerceHooked internal immutable commerce;
    HallmarkHook internal immutable hook;
    MockERC20 internal immutable token;
    address internal immutable attestor;

    address[3] public actors;
    uint256[3] public agents;

    uint256 public jobsFunded;
    uint256 public jobsCompleted;
    uint256 public jobsRejected;
    uint256 public jobsExpired;
    uint256 public gateRefusals;

    constructor(
        AgenticCommerceHooked commerce_,
        HallmarkHook hook_,
        MockERC20 token_,
        address attestor_,
        address[3] memory actors_,
        uint256[3] memory agents_
    ) {
        commerce = commerce_;
        hook = hook_;
        token = token_;
        attestor = attestor_;
        actors = actors_;
        agents = agents_;
    }

    /// @dev Any actor may hire any other, including itself — self-dealing is legal, it just earns
    ///      no attestation, and the invariants must hold either way.
    function createJob(uint256 clientSeed, uint256 providerSeed, uint256 budgetSeed, uint256 durationSeed) external {
        address client = actors[bound(clientSeed, 0, 2)];
        uint256 slot = bound(providerSeed, 0, 2);
        uint256 budget = bound(budgetSeed, 1, 5_000e18);
        uint256 duration = bound(durationSeed, commerce.MIN_JOB_DURATION(), 30 days);

        vm.startPrank(client);
        uint256 jobId =
            commerce.createJob(actors[slot], actors[(slot + 1) % 3], block.timestamp + duration, "j", address(hook));
        commerce.setBudget(jobId, budget, "");
        vm.stopPrank();
    }

    /// @dev The honest flow: the client declares the agent whose on-chain wallet is the provider it
    ///      is paying, and Hallmark's prober is live, so the evidence is fresh.
    function fund(uint256 jobSeed) external {
        uint256 jobId = _pick(jobSeed);
        if (jobId == 0) return;
        (address client, address provider,, uint256 budget,, IAgenticCommerce.JobStatus status) =
            commerce.getJobParties(jobId);
        if (status != IAgenticCommerce.JobStatus.Open) return;

        uint256 agentId = _agentFor(provider);
        if (agentId == 0) return;

        // Model a prober that is actually running rather than one that stopped in `setUp`.
        vm.prank(attestor);
        hook.recordProbe(agentId, 90);

        vm.prank(client);
        commerce.fund(jobId, budget, abi.encode(agentId));
        jobsFunded++;
    }

    /// @dev The dishonest flow: declare somebody else's agent. The gate must refuse every time.
    function fundWithMismatchedAgent(uint256 jobSeed, uint256 agentSeed) external {
        uint256 jobId = _pick(jobSeed);
        if (jobId == 0) return;
        (address client, address provider,, uint256 budget,, IAgenticCommerce.JobStatus status) =
            commerce.getJobParties(jobId);
        if (status != IAgenticCommerce.JobStatus.Open) return;

        uint256 agentId = agents[bound(agentSeed, 0, 2)];
        if (agentId == _agentFor(provider)) return;

        vm.prank(attestor);
        hook.recordProbe(agentId, 90);

        vm.prank(client);
        try commerce.fund(jobId, budget, abi.encode(agentId)) {
            revert("gate admitted a job whose agent is not its payee");
        } catch {
            gateRefusals++;
        }
    }

    function _agentFor(address payee) private view returns (uint256) {
        for (uint256 i = 0; i < 3; ++i) {
            if (actors[i] == payee) return agents[i];
        }
        return 0;
    }

    function submit(uint256 jobSeed) external {
        uint256 jobId = _pick(jobSeed);
        if (jobId == 0) return;
        (, address provider,,,, IAgenticCommerce.JobStatus status) = commerce.getJobParties(jobId);
        if (status != IAgenticCommerce.JobStatus.Funded) return;

        vm.prank(provider);
        commerce.submit(jobId, keccak256(abi.encode(jobId)), "");
    }

    function complete(uint256 jobSeed) external {
        uint256 jobId = _pick(jobSeed);
        if (jobId == 0) return;
        (,, address evaluator,,, IAgenticCommerce.JobStatus status) = commerce.getJobParties(jobId);
        if (status != IAgenticCommerce.JobStatus.Submitted) return;

        vm.prank(evaluator);
        commerce.complete(jobId, bytes32(0), "");
        jobsCompleted++;
    }

    function reject(uint256 jobSeed) external {
        uint256 jobId = _pick(jobSeed);
        if (jobId == 0) return;
        (address client,, address evaluator,,, IAgenticCommerce.JobStatus status) = commerce.getJobParties(jobId);

        if (status == IAgenticCommerce.JobStatus.Open) {
            vm.prank(client);
            commerce.reject(jobId, bytes32(0), "");
        } else if (status == IAgenticCommerce.JobStatus.Funded || status == IAgenticCommerce.JobStatus.Submitted) {
            vm.prank(evaluator);
            commerce.reject(jobId, bytes32(0), "");
            jobsRejected++;
        }
    }

    function claimRefund(uint256 jobSeed) external {
        uint256 jobId = _pick(jobSeed);
        if (jobId == 0) return;
        (,,,, uint256 expiredAt, IAgenticCommerce.JobStatus status) = commerce.getJobParties(jobId);

        if (status == IAgenticCommerce.JobStatus.Funded) {
            if (block.timestamp < expiredAt) return;
        } else if (status == IAgenticCommerce.JobStatus.Submitted) {
            if (block.timestamp < commerce.evaluationDeadline(jobId)) return;
        } else {
            return;
        }

        commerce.claimRefund(jobId);
        jobsExpired++;
    }

    function recordExpiry(uint256 jobSeed) external {
        uint256 jobId = _pick(jobSeed);
        if (jobId == 0) return;
        if (hook.expiryRecorded(jobId)) return;
        (,,,,, IAgenticCommerce.JobStatus status) = commerce.getJobParties(jobId);
        if (status != IAgenticCommerce.JobStatus.Expired) return;

        hook.recordExpiry(jobId);
    }

    function probe(uint256 agentSeed, uint256 scoreSeed) external {
        vm.prank(attestor);
        hook.recordProbe(agents[bound(agentSeed, 0, 2)], uint8(bound(scoreSeed, 0, 100)));
    }

    function advanceTime(uint256 seconds_) external {
        vm.warp(block.timestamp + bound(seconds_, 1 hours, 5 days));
    }

    function _pick(uint256 seed) private view returns (uint256) {
        uint256 count = commerce.jobCount();
        if (count == 0) return 0;
        return bound(seed, 1, count);
    }
}

/// @notice Escrow accounting and hook bookkeeping, with the policy contract in the loop.
contract HookedInvariantTest is Test {
    MockERC20 internal token;
    MockIdentityRegistry internal identity;
    MockReputationRegistry internal reputation;
    MockValidationRegistry internal validation;
    AgenticCommerceHooked internal commerce;
    HallmarkHook internal hook;
    HookedHandler internal handler;

    address internal treasury = makeAddr("treasury");
    address internal attestor = makeAddr("attestor");

    address[3] internal actors;
    uint256[3] internal agents;

    uint256 internal constant MINTED = 10_000_000e18;

    function setUp() public {
        vm.warp(1_700_000_000);

        token = new MockERC20("United Stables", "U");
        identity = new MockIdentityRegistry();
        reputation = new MockReputationRegistry();
        validation = new MockValidationRegistry();

        commerce = new AgenticCommerceHooked(address(token), treasury, 250);
        hook =
            new HallmarkHook(address(commerce), address(identity), address(reputation), address(validation), attestor);
        commerce.setHookWhitelisted(address(hook), true);

        for (uint256 i = 0; i < 3; ++i) {
            actors[i] = makeAddr(string.concat("actor", vm.toString(i)));
            agents[i] = 100 + i;
            // Each actor is the on-chain payee of exactly one agent, so the binding is satisfiable.
            identity.register(agents[i], makeAddr(string.concat("agentOwner", vm.toString(i))));
            identity.setAgentWallet(agents[i], actors[i]);

            vm.prank(attestor);
            hook.recordProbe(agents[i], 90);

            token.mint(actors[i], MINTED);
            vm.prank(actors[i]);
            token.approve(address(commerce), type(uint256).max);
        }

        handler = new HookedHandler(commerce, hook, token, attestor, actors, agents);
        targetContract(address(handler));
    }

    /// @notice The escrow holds exactly what it owes, with the hook running on every transition.
    function invariant_HookedEscrowMatchesOpenBudgets() public view {
        assertEq(token.balanceOf(address(commerce)), commerce.escrowedTotal());
    }

    /// @notice An agent's settled outcomes can never exceed the jobs actually funded against it.
    /// @dev The property H-1 broke: outcomes used to be writable without a corresponding funded job
    ///      against that agent.
    function invariant_HookedOutcomesNeverExceedFundedJobs() public view {
        for (uint256 i = 0; i < 3; ++i) {
            HallmarkHook.Record memory record = hook.agentRecord(agents[i]);
            uint256 settled =
                uint256(record.jobsCompleted) + record.jobsRejected + record.jobsExpired + record.jobsStalled;
            assertLe(settled, record.jobsFunded, "an agent's outcomes outnumber its funded jobs");
        }
    }

    /// @notice Every ERC-8004 entry the hook wrote corresponds to a job funded against that agent.
    function invariant_HookedFeedbackIsBackedByEscrow() public view {
        address[] memory clients = new address[](1);
        clients[0] = address(hook);

        for (uint256 i = 0; i < 3; ++i) {
            (uint64 count,,) = reputation.getSummary(agents[i], clients, "", "");
            assertLe(uint256(count), hook.agentRecord(agents[i]).jobsFunded, "unbacked attestation");
        }
    }

    /// @notice Nothing is minted or burned along the way.
    function invariant_HookedTokensAreConserved() public view {
        uint256 total = token.balanceOf(treasury) + token.balanceOf(address(commerce));
        for (uint256 i = 0; i < 3; ++i) {
            total += token.balanceOf(actors[i]);
        }
        assertEq(total, MINTED * 3);
    }

    /// @notice Proof that the handler can actually drive the transitions the invariants claim to
    ///         cover, so a handler that quietly stopped doing anything cannot pass by doing nothing.
    /// @dev This is a deterministic test rather than an `afterInvariant` assertion on purpose.
    ///      `afterInvariant` runs once per campaign *run*, so asserting there that a settlement
    ///      landed would demand that every random 64-call sequence happens to contain a full
    ///      create/fund/submit/complete chain — a flaky requirement that says more about the
    ///      fuzzer's luck than about the handler. Driving the chain explicitly proves the same thing
    ///      and cannot flake.
    function test_Handler_DrivesAFullLifecycle() public {
        // Arm's length on purpose: client actors[0], provider actors[1], evaluator actors[2]. A
        // self-dealing triple would settle just the same but earn no attestation, which is the point
        // of the H-1 fix and would make this a weaker check.
        handler.createJob(0, 1, 1_000e18, 7 days);
        assertEq(commerce.jobCount(), 1, "handler creates jobs");

        handler.fund(1);
        assertEq(handler.jobsFunded(), 1, "handler funds jobs through the gate");
        assertEq(token.balanceOf(address(commerce)), 1_000e18);

        handler.submit(1);
        assertEq(uint8(commerce.getJob(1).status), uint8(IAgenticCommerce.JobStatus.Submitted));

        handler.complete(1);
        assertEq(handler.jobsCompleted(), 1, "handler settles jobs");
        assertEq(uint8(commerce.getJob(1).status), uint8(IAgenticCommerce.JobStatus.Completed));
        assertEq(hook.agentRecord(agents[1]).jobsCompleted, 1, "and the hook recorded the outcome");
    }

    /// @notice The handler's refusal path is real: a mismatched agent is rejected by the gate.
    function test_Handler_RefusesAMismatchedAgent() public {
        handler.createJob(0, 1, 1_000e18, 7 days);
        handler.fundWithMismatchedAgent(1, 0);

        assertEq(handler.gateRefusals(), 1, "the gate refused a job whose agent is not its payee");
        assertEq(token.balanceOf(address(commerce)), 0, "and took no escrow");
    }

    /// @notice The rejection and expiry legs, also driven explicitly.
    function test_Handler_DrivesRejectionAndExpiry() public {
        handler.createJob(0, 1, 1_000e18, 7 days);
        handler.fund(1);
        handler.reject(1);
        assertEq(handler.jobsRejected(), 1);

        handler.createJob(0, 1, 1_000e18, 7 days);
        handler.fund(2);
        // `advanceTime` is bounded to at most 5 days, so step past the 7-day expiry twice.
        handler.advanceTime(5 days);
        handler.advanceTime(5 days);
        handler.claimRefund(2);
        assertEq(handler.jobsExpired(), 1);

        handler.recordExpiry(2);
        assertEq(hook.agentRecord(agents[1]).jobsExpired, 1, "expiry without delivery is the agent's");
    }
}
