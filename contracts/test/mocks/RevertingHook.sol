// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IACPHook} from "../../src/interfaces/IACPHook.sol";

/// @notice A hook that can be armed to refuse every callback, used to prove that a broken or hostile
///         policy contract can stop new business but can never trap an expired job's escrow.
contract RevertingHook is IACPHook {
    error AlwaysReverts();

    bool public armed;

    constructor(bool armed_) {
        armed = armed_;
    }

    function arm() external {
        armed = true;
    }

    function disarm() external {
        armed = false;
    }

    function beforeAction(uint256, bytes4, bytes calldata) external view {
        if (armed) revert AlwaysReverts();
    }

    function afterAction(uint256, bytes4, bytes calldata) external view {
        if (armed) revert AlwaysReverts();
    }
}
