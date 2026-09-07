// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title IAgenticCommerce
/// @notice Core surface of ERC-8183 (Agentic Commerce): a single-token escrow that carries a job
///         from creation through funding, delivery and evaluation.
/// @custom:eip https://eips.ethereum.org/EIPS/eip-8183
interface IAgenticCommerce {
    /// @notice Lifecycle state of a job.
    /// @dev Open -> Funded -> Submitted -> Completed is the settlement path. Rejected and Expired
    ///      are the two terminal refund paths.
    enum JobStatus {
        Open,
        Funded,
        Submitted,
        Completed,
        Rejected,
        Expired
    }

    /// @notice Full job record.
    /// @param id Monotonic job identifier, starting at 1.
    /// @param client Account that created the job and funds the escrow.
    /// @param provider Account that performs the work and receives payment on completion.
    /// @param evaluator Account entitled to complete or reject a funded job.
    /// @param description Human-readable statement of work.
    /// @param budget Amount of the payment token held in escrow once funded.
    /// @param expiredAt Unix timestamp after which the escrow can be refunded permissionlessly.
    /// @param status Current lifecycle state.
    /// @param hook Optional IACPHook contract notified around each hookable transition.
    struct Job {
        uint256 id;
        address client;
        address provider;
        address evaluator;
        string description;
        uint256 budget;
        uint256 expiredAt;
        JobStatus status;
        address hook;
    }

    event JobCreated(
        uint256 indexed jobId,
        address indexed client,
        address indexed provider,
        address evaluator,
        uint256 expiredAt,
        string description,
        address hook
    );
    event ProviderSet(uint256 indexed jobId, address indexed provider);
    event BudgetSet(uint256 indexed jobId, uint256 amount);
    event JobFunded(uint256 indexed jobId, address indexed client, uint256 amount);
    event JobSubmitted(uint256 indexed jobId, address indexed provider, bytes32 deliverable);
    event JobCompleted(uint256 indexed jobId, address indexed evaluator, bytes32 reason);
    event JobRejected(uint256 indexed jobId, address indexed caller, bytes32 reason);
    event JobExpired(uint256 indexed jobId);
    event PaymentReleased(uint256 indexed jobId, address indexed provider, uint256 amount, uint256 fee);
    event Refunded(uint256 indexed jobId, address indexed client, uint256 amount);

    /// @notice The job id does not exist.
    error InvalidJob();
    /// @notice The job is not in a state that allows the requested transition.
    error WrongStatus();
    /// @notice The caller does not hold the role required for this transition.
    error Unauthorized();
    /// @notice A required address argument was the zero address.
    error ZeroAddress();
    /// @notice The requested expiry is not far enough in the future.
    error ExpiryTooShort();
    /// @notice The budget is zero.
    error ZeroBudget();
    /// @notice The job has no provider assigned yet.
    error ProviderNotSet();
    /// @notice The platform fee exceeds the hard cap.
    error FeesTooHigh();
    /// @notice The supplied hook contract is not on the escrow's allow list.
    error HookNotWhitelisted();

    /// @notice Creates a new job in the `Open` state with no budget.
    /// @return jobId Identifier of the created job.
    function createJob(
        address provider,
        address evaluator,
        uint256 expiredAt,
        string calldata description,
        address hook
    ) external returns (uint256 jobId);

    /// @notice Assigns or replaces the provider while the job is `Open`. Client only.
    function setProvider(uint256 jobId, address provider_) external;

    /// @notice Sets the budget while the job is `Open`. Client or provider.
    function setBudget(uint256 jobId, uint256 amount, bytes calldata optParams) external;

    /// @notice Pulls `budget` payment tokens from the client into escrow. Client only.
    /// @param expectedBudget Budget the client believes is set; guards against a front-run raise.
    function fund(uint256 jobId, uint256 expectedBudget, bytes calldata optParams) external;

    /// @notice Records a deliverable and moves the job to `Submitted`. Provider only.
    function submit(uint256 jobId, bytes32 deliverable, bytes calldata optParams) external;

    /// @notice Settles the job, paying the provider minus the platform fee. Evaluator only.
    function complete(uint256 jobId, bytes32 reason, bytes calldata optParams) external;

    /// @notice Cancels the job. Client while `Open`; evaluator while `Funded` or `Submitted`.
    function reject(uint256 jobId, bytes32 reason, bytes calldata optParams) external;

    /// @notice Returns the escrow to the client once `expiredAt` has passed. Permissionless.
    function claimRefund(uint256 jobId) external;

    /// @notice Returns the full job record.
    function getJob(uint256 jobId) external view returns (Job memory);
}
