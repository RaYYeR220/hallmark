// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IACPHook} from "../../src/interfaces/IACPHook.sol";
import {IAgenticCommerce} from "../../src/interfaces/IAgenticCommerce.sol";

/// @notice A hostile hook that tries to re-enter the escrow from inside a callback.
/// @dev The escrow hands control to the hook while a job transition is in flight; without a
///      reentrancy guard that is a window to double-spend an escrow. This mock forces that window
///      open so the guard is proved, not assumed.
contract ReentrantHook is IACPHook {
    enum Mode {
        Off,
        ReenterFund,
        ReenterComplete,
        ReenterClaimRefund
    }

    IAgenticCommerce public immutable commerce;

    Mode public mode;
    uint256 public targetJobId;
    uint256 public expectedBudget;

    constructor(address commerce_) {
        commerce = IAgenticCommerce(commerce_);
    }

    function arm(Mode mode_, uint256 targetJobId_, uint256 expectedBudget_) external {
        mode = mode_;
        targetJobId = targetJobId_;
        expectedBudget = expectedBudget_;
    }

    function beforeAction(uint256, bytes4, bytes calldata) external {}

    function afterAction(uint256, bytes4, bytes calldata) external {
        Mode current = mode;
        if (current == Mode.Off) return;
        if (current == Mode.ReenterFund) {
            commerce.fund(targetJobId, expectedBudget, "");
        } else if (current == Mode.ReenterComplete) {
            commerce.complete(targetJobId, bytes32(0), "");
        } else if (current == Mode.ReenterClaimRefund) {
            commerce.claimRefund(targetJobId);
        }
    }
}
