// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title IACPHook
/// @notice Optional hook extension of ERC-8183 (Agentic Commerce).
///         An escrow implementation calls `beforeAction` immediately before, and `afterAction`
///         immediately after, each hookable state transition of a job it owns.
/// @dev Hookable core functions are `setProvider`, `setBudget`, `fund`, `submit`, `complete` and
///      `reject`. `claimRefund` is deliberately NOT hookable so that a faulty or malicious hook can
///      never trap escrowed funds after a job expires.
///
///      The `data` payload is ABI-encoded per selector:
///      - `setProvider` -> abi.encode(address provider, bytes optParams)
///      - `setBudget`   -> abi.encode(uint256 amount, bytes optParams)
///      - `fund`        -> optParams (raw bytes, forwarded verbatim)
///      - `submit`      -> abi.encode(bytes32 deliverable, bytes optParams)
///      - `complete`    -> abi.encode(bytes32 reason, bytes optParams)
///      - `reject`      -> abi.encode(bytes32 reason, bytes optParams)
///
/// @custom:eip https://eips.ethereum.org/EIPS/eip-8183
interface IACPHook {
    /// @notice Called before the escrow applies the state transition.
    /// @dev Reverting here cancels the action. This is the enforcement point.
    /// @param jobId Identifier of the job being acted on.
    /// @param selector Function selector of the core function being executed.
    /// @param data Selector-specific payload, encoded as documented above.
    function beforeAction(uint256 jobId, bytes4 selector, bytes calldata data) external;

    /// @notice Called after the escrow has applied the state transition and moved any funds.
    /// @dev Reverting here reverts the whole action, so implementations should stay non-critical.
    /// @param jobId Identifier of the job that was acted on.
    /// @param selector Function selector of the core function that was executed.
    /// @param data Selector-specific payload, encoded as documented above.
    function afterAction(uint256 jobId, bytes4 selector, bytes calldata data) external;
}
