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

/// @notice Shared fixture: a live escrow, the Hallmark gate wired to three mock ERC-8004 registries,
///         and a cast of funded actors.
abstract contract Base is Test {
    uint256 internal constant AGENT_ID = 8004;
    uint256 internal constant BUDGET = 1_000e18;
    uint16 internal constant FEE_BPS = 250;
    uint256 internal constant JOB_DURATION = 7 days;
    uint256 internal constant START_TIME = 1_700_000_000;

    MockERC20 internal token;
    MockIdentityRegistry internal identity;
    MockReputationRegistry internal reputation;
    MockValidationRegistry internal validation;

    AgenticCommerceHooked internal commerce;
    HallmarkHook internal hook;

    address internal owner = address(this);
    address internal client = makeAddr("client");
    address internal provider = makeAddr("provider");
    address internal evaluator = makeAddr("evaluator");
    address internal treasury = makeAddr("treasury");
    address internal attestor = makeAddr("attestor");
    address internal stranger = makeAddr("stranger");
    address internal agentOwner = makeAddr("agentOwner");

    uint256 private _nonce;

    function setUp() public virtual {
        vm.warp(START_TIME);

        token = new MockERC20("United Stables", "U");
        identity = new MockIdentityRegistry();
        reputation = new MockReputationRegistry();
        validation = new MockValidationRegistry();

        commerce = new AgenticCommerceHooked(address(token), treasury, FEE_BPS);
        hook =
            new HallmarkHook(address(commerce), address(identity), address(reputation), address(validation), attestor);
        commerce.setHookWhitelisted(address(hook), true);
        hook.setEvidenceBaseURI("https://hallmark.xyz/evidence/");

        // The agent's on-chain payee is the address the job actually pays. The gate now requires
        // that relationship, so the fixture models a correctly onboarded agent: owned by one key,
        // paid at another.
        _registerAgent(AGENT_ID, provider);

        token.mint(client, 1_000_000e18);
        vm.prank(client);
        token.approve(address(commerce), type(uint256).max);
    }

    // ---------------------------------------------------------------------
    // Identity helpers
    // ---------------------------------------------------------------------

    /// @dev Registers an agent owned by `agentOwner` whose declared wallet — the address a job must
    ///      pay for the outcome to count as this agent's work — is `payee`.
    function _registerAgent(uint256 agentId, address payee) internal {
        identity.register(agentId, agentOwner);
        identity.setAgentWallet(agentId, payee);
    }

    // ---------------------------------------------------------------------
    // Evidence helpers
    // ---------------------------------------------------------------------

    /// @dev Records a probe on the Hallmark clock and mirrors it as a "reachable" feedback entry in
    ///      the Reputation Registry, which is what the attestor's prober does on-chain.
    function _probe(uint256 agentId, uint8 score) internal {
        vm.startPrank(attestor);
        hook.recordProbe(agentId, score);
        reputation.giveFeedback(agentId, 1, 0, "reachable", "hallmark", "", "", bytes32(0));
        vm.stopPrank();
    }

    /// @dev Records only the Hallmark-side probe, without the public registry mirror.
    function _probeWithoutMirror(uint256 agentId, uint8 score) internal {
        vm.prank(attestor);
        hook.recordProbe(agentId, score);
    }

    /// @dev Writes a completed validation record from `validator` into the Validation Registry.
    function _validate(address validator, uint256 agentId, uint8 response) internal returns (bytes32 requestHash) {
        requestHash = keccak256(abi.encode(agentId, block.timestamp, ++_nonce));
        vm.startPrank(validator);
        validation.validationRequest(validator, agentId, "ipfs://request", requestHash);
        validation.validationResponse(requestHash, response, "ipfs://response", bytes32(uint256(1)), "liveness");
        vm.stopPrank();
    }

    // ---------------------------------------------------------------------
    // Job helpers
    // ---------------------------------------------------------------------

    function _createJob(address hook_) internal returns (uint256 jobId) {
        vm.prank(client);
        jobId = commerce.createJob(provider, evaluator, block.timestamp + JOB_DURATION, "index a wallet", hook_);
    }

    function _createAndBudget(address hook_, uint256 budget) internal returns (uint256 jobId) {
        jobId = _createJob(hook_);
        vm.prank(client);
        commerce.setBudget(jobId, budget, "");
    }

    /// @dev Creates, budgets and funds a job against `AGENT_ID` through the Hallmark gate.
    function _createFundedJob() internal returns (uint256 jobId) {
        jobId = _createAndBudget(address(hook), BUDGET);
        vm.prank(client);
        commerce.fund(jobId, BUDGET, abi.encode(AGENT_ID));
    }

    function _status(uint256 jobId) internal view returns (IAgenticCommerce.JobStatus) {
        return commerce.getJob(jobId).status;
    }
}
