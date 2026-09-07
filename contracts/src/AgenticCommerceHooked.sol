// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";

import {IAgenticCommerce} from "./interfaces/IAgenticCommerce.sol";
import {IACPHook} from "./interfaces/IACPHook.sol";

/// @title AgenticCommerceHooked
/// @notice An implementation of ERC-8183 (Agentic Commerce) with the optional hook extension.
///         A client escrows a single ERC-20 payment token against a job, a provider delivers, and a
///         named evaluator settles or cancels. Every hookable transition is announced to the job's
///         `IACPHook` before and after it is applied, which lets a marketplace attach policy — such
///         as Hallmark's liveness gate — without forking the escrow.
/// @dev Reference: https://eips.ethereum.org/EIPS/eip-8183
///
///      Design notes that matter for integrators:
///      - The payment token is fixed at construction. A rebasing or fee-on-transfer token would
///        break the escrow accounting invariant and must not be used.
///      - `claimRefund` never calls the hook. A hook that reverts can block new business, but it can
///        never hold an expired job's escrow hostage.
///      - The platform fee is charged only on `complete`, never on a refund, and is capped at
///        `MAX_FEE_BPS`.
///      - Hooks must be allow-listed by the owner before a job can reference them, because a hook is
///        an arbitrary callee invoked inside the escrow's own call frame.
contract AgenticCommerceHooked is IAgenticCommerce, Ownable, ReentrancyGuard {
    using SafeERC20 for IERC20;

    /// @notice Basis-point denominator.
    uint256 public constant BPS_DENOMINATOR = 10_000;

    /// @notice Hard cap on the platform fee: 10%.
    uint256 public constant MAX_FEE_BPS = 1_000;

    /// @notice Minimum lifetime of a job at creation time.
    uint256 public constant MIN_JOB_DURATION = 1 hours;

    /// @notice ERC-20 token every job is denominated and settled in.
    IERC20 public immutable paymentToken;

    /// @notice Recipient of the platform fee.
    address public treasury;

    /// @notice Platform fee in basis points, charged on `complete` only.
    uint16 public feeBps;

    /// @notice Number of jobs created so far; job ids run from 1 to `jobCount`.
    uint256 public jobCount;

    mapping(uint256 jobId => Job job) private _jobs;

    /// @notice Hooks the owner has approved for use by new jobs.
    mapping(address hook => bool allowed) public isHookWhitelisted;

    /// @notice The budget observed on-chain differs from the one the funder expected.
    error BudgetMismatch(uint256 expected, uint256 actual);

    /// @notice The job's `expiredAt` has not been reached yet.
    error NotYetExpired();

    event TreasuryUpdated(address indexed treasury);
    event PlatformFeeUpdated(uint16 feeBps);
    event HookWhitelisted(address indexed hook, bool allowed);

    /// @param paymentToken_ ERC-20 token used for every job.
    /// @param treasury_ Recipient of platform fees.
    /// @param feeBps_ Initial platform fee in basis points; must not exceed `MAX_FEE_BPS`.
    constructor(address paymentToken_, address treasury_, uint16 feeBps_) Ownable(msg.sender) {
        if (paymentToken_ == address(0) || treasury_ == address(0)) revert ZeroAddress();
        if (feeBps_ > MAX_FEE_BPS) revert FeesTooHigh();
        paymentToken = IERC20(paymentToken_);
        treasury = treasury_;
        feeBps = feeBps_;
        emit TreasuryUpdated(treasury_);
        emit PlatformFeeUpdated(feeBps_);
    }

    // ---------------------------------------------------------------------
    // Job lifecycle
    // ---------------------------------------------------------------------

    /// @inheritdoc IAgenticCommerce
    function createJob(
        address provider,
        address evaluator,
        uint256 expiredAt,
        string calldata description,
        address hook
    ) external returns (uint256 jobId) {
        if (evaluator == address(0)) revert ZeroAddress();
        if (expiredAt < block.timestamp + MIN_JOB_DURATION) revert ExpiryTooShort();
        if (hook != address(0) && !isHookWhitelisted[hook]) revert HookNotWhitelisted();

        jobId = ++jobCount;
        Job storage job = _jobs[jobId];
        job.id = jobId;
        job.client = msg.sender;
        job.provider = provider;
        job.evaluator = evaluator;
        job.description = description;
        job.expiredAt = expiredAt;
        job.status = JobStatus.Open;
        job.hook = hook;

        emit JobCreated(jobId, msg.sender, provider, evaluator, expiredAt, description, hook);
    }

    /// @inheritdoc IAgenticCommerce
    function setProvider(uint256 jobId, address provider_) external nonReentrant {
        Job storage job = _job(jobId);
        if (msg.sender != job.client) revert Unauthorized();
        if (job.status != JobStatus.Open) revert WrongStatus();
        if (provider_ == address(0)) revert ZeroAddress();

        bytes memory payload = abi.encode(provider_, bytes(""));
        _before(job.hook, jobId, IAgenticCommerce.setProvider.selector, payload);

        job.provider = provider_;
        emit ProviderSet(jobId, provider_);

        _after(job.hook, jobId, IAgenticCommerce.setProvider.selector, payload);
    }

    /// @inheritdoc IAgenticCommerce
    function setBudget(uint256 jobId, uint256 amount, bytes calldata optParams) external nonReentrant {
        Job storage job = _job(jobId);
        if (msg.sender != job.client && msg.sender != job.provider) revert Unauthorized();
        if (job.status != JobStatus.Open) revert WrongStatus();
        if (amount == 0) revert ZeroBudget();

        bytes memory payload = abi.encode(amount, optParams);
        _before(job.hook, jobId, IAgenticCommerce.setBudget.selector, payload);

        job.budget = amount;
        emit BudgetSet(jobId, amount);

        _after(job.hook, jobId, IAgenticCommerce.setBudget.selector, payload);
    }

    /// @inheritdoc IAgenticCommerce
    /// @dev `optParams` is forwarded to the hook verbatim. Hallmark uses it to carry the ERC-8004
    ///      agent id the client believes it is hiring, which the hook then gates on.
    function fund(uint256 jobId, uint256 expectedBudget, bytes calldata optParams) external nonReentrant {
        Job storage job = _job(jobId);
        if (msg.sender != job.client) revert Unauthorized();
        if (job.status != JobStatus.Open) revert WrongStatus();
        if (job.provider == address(0)) revert ProviderNotSet();

        uint256 amount = job.budget;
        if (amount == 0) revert ZeroBudget();
        if (amount != expectedBudget) revert BudgetMismatch(expectedBudget, amount);

        // The gate runs before any state change or token movement, so a refusal is total.
        _before(job.hook, jobId, IAgenticCommerce.fund.selector, optParams);

        job.status = JobStatus.Funded;
        paymentToken.safeTransferFrom(msg.sender, address(this), amount);
        emit JobFunded(jobId, msg.sender, amount);

        _after(job.hook, jobId, IAgenticCommerce.fund.selector, optParams);
    }

    /// @inheritdoc IAgenticCommerce
    function submit(uint256 jobId, bytes32 deliverable, bytes calldata optParams) external nonReentrant {
        Job storage job = _job(jobId);
        if (msg.sender != job.provider) revert Unauthorized();
        if (job.status != JobStatus.Funded) revert WrongStatus();

        bytes memory payload = abi.encode(deliverable, optParams);
        _before(job.hook, jobId, IAgenticCommerce.submit.selector, payload);

        job.status = JobStatus.Submitted;
        emit JobSubmitted(jobId, msg.sender, deliverable);

        _after(job.hook, jobId, IAgenticCommerce.submit.selector, payload);
    }

    /// @inheritdoc IAgenticCommerce
    function complete(uint256 jobId, bytes32 reason, bytes calldata optParams) external nonReentrant {
        Job storage job = _job(jobId);
        if (msg.sender != job.evaluator) revert Unauthorized();
        if (job.status != JobStatus.Submitted) revert WrongStatus();

        bytes memory payload = abi.encode(reason, optParams);
        _before(job.hook, jobId, IAgenticCommerce.complete.selector, payload);

        uint256 amount = job.budget;
        uint256 fee = (amount * feeBps) / BPS_DENOMINATOR;
        uint256 payout = amount - fee;

        job.status = JobStatus.Completed;

        address provider = job.provider;
        paymentToken.safeTransfer(provider, payout);
        if (fee != 0) paymentToken.safeTransfer(treasury, fee);

        emit PaymentReleased(jobId, provider, payout, fee);
        emit JobCompleted(jobId, msg.sender, reason);

        _after(job.hook, jobId, IAgenticCommerce.complete.selector, payload);
    }

    /// @inheritdoc IAgenticCommerce
    function reject(uint256 jobId, bytes32 reason, bytes calldata optParams) external nonReentrant {
        Job storage job = _job(jobId);
        JobStatus status = job.status;

        if (status == JobStatus.Open) {
            if (msg.sender != job.client) revert Unauthorized();
        } else if (status == JobStatus.Funded || status == JobStatus.Submitted) {
            if (msg.sender != job.evaluator) revert Unauthorized();
        } else {
            revert WrongStatus();
        }

        bytes memory payload = abi.encode(reason, optParams);
        _before(job.hook, jobId, IAgenticCommerce.reject.selector, payload);

        job.status = JobStatus.Rejected;

        if (status != JobStatus.Open) {
            address client = job.client;
            uint256 amount = job.budget;
            paymentToken.safeTransfer(client, amount);
            emit Refunded(jobId, client, amount);
        }

        emit JobRejected(jobId, msg.sender, reason);

        _after(job.hook, jobId, IAgenticCommerce.reject.selector, payload);
    }

    /// @inheritdoc IAgenticCommerce
    /// @dev Deliberately hook-free. Once a job is past `expiredAt` the client's escrow must be
    ///      recoverable by anyone, whatever policy the marketplace attached to the job.
    function claimRefund(uint256 jobId) external nonReentrant {
        Job storage job = _job(jobId);
        JobStatus status = job.status;
        if (status != JobStatus.Funded && status != JobStatus.Submitted) revert WrongStatus();
        if (block.timestamp < job.expiredAt) revert NotYetExpired();

        job.status = JobStatus.Expired;

        address client = job.client;
        uint256 amount = job.budget;
        paymentToken.safeTransfer(client, amount);

        emit Refunded(jobId, client, amount);
        emit JobExpired(jobId);
    }

    // ---------------------------------------------------------------------
    // Views
    // ---------------------------------------------------------------------

    /// @inheritdoc IAgenticCommerce
    function getJob(uint256 jobId) external view returns (Job memory) {
        if (jobId == 0 || jobId > jobCount) revert InvalidJob();
        return _jobs[jobId];
    }

    /// @notice Total escrow the contract is currently obliged to hold, i.e. the sum of the budgets
    ///         of every `Funded` or `Submitted` job.
    /// @dev Linear in `jobCount`; intended for off-chain reads and invariant testing.
    function escrowedTotal() external view returns (uint256 total) {
        uint256 n = jobCount;
        for (uint256 i = 1; i <= n; ++i) {
            JobStatus status = _jobs[i].status;
            if (status == JobStatus.Funded || status == JobStatus.Submitted) total += _jobs[i].budget;
        }
    }

    // ---------------------------------------------------------------------
    // Administration
    // ---------------------------------------------------------------------

    /// @notice Updates the platform fee charged on completion.
    function setPlatformFee(uint16 feeBps_) external onlyOwner {
        if (feeBps_ > MAX_FEE_BPS) revert FeesTooHigh();
        feeBps = feeBps_;
        emit PlatformFeeUpdated(feeBps_);
    }

    /// @notice Updates the fee recipient.
    function setTreasury(address treasury_) external onlyOwner {
        if (treasury_ == address(0)) revert ZeroAddress();
        treasury = treasury_;
        emit TreasuryUpdated(treasury_);
    }

    /// @notice Adds or removes a hook from the allow list consulted by `createJob`.
    /// @dev Existing jobs keep the hook they were created with; the list is a creation-time filter.
    function setHookWhitelisted(address hook, bool allowed) external onlyOwner {
        if (hook == address(0)) revert ZeroAddress();
        isHookWhitelisted[hook] = allowed;
        emit HookWhitelisted(hook, allowed);
    }

    // ---------------------------------------------------------------------
    // Internals
    // ---------------------------------------------------------------------

    function _job(uint256 jobId) private view returns (Job storage job) {
        if (jobId == 0 || jobId > jobCount) revert InvalidJob();
        job = _jobs[jobId];
    }

    function _before(address hook, uint256 jobId, bytes4 selector, bytes memory data) private {
        if (hook != address(0)) IACPHook(hook).beforeAction(jobId, selector, data);
    }

    function _after(address hook, uint256 jobId, bytes4 selector, bytes memory data) private {
        if (hook != address(0)) IACPHook(hook).afterAction(jobId, selector, data);
    }
}
