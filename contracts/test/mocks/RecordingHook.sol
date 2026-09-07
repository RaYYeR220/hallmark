// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IACPHook} from "../../src/interfaces/IACPHook.sol";

/// @notice A passive hook that logs every callback, so tests can assert the escrow announces each
///         transition with the selector and payload the ERC-8183 hook extension specifies.
contract RecordingHook is IACPHook {
    struct Call {
        bool isBefore;
        uint256 jobId;
        bytes4 selector;
        bytes data;
    }

    Call[] private _calls;

    function beforeAction(uint256 jobId, bytes4 selector, bytes calldata data) external {
        _calls.push(Call({isBefore: true, jobId: jobId, selector: selector, data: data}));
    }

    function afterAction(uint256 jobId, bytes4 selector, bytes calldata data) external {
        _calls.push(Call({isBefore: false, jobId: jobId, selector: selector, data: data}));
    }

    function callCount() external view returns (uint256) {
        return _calls.length;
    }

    function callAt(uint256 index) external view returns (Call memory) {
        return _calls[index];
    }
}
