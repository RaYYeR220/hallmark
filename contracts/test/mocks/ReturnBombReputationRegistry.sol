// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IReputationRegistry} from "../../src/interfaces/IReputationRegistry.sol";

/// @notice A Reputation Registry that burns almost all the gas it is handed and then reverts with a
///         very large blob of return data.
/// @dev Both halves are load-bearing, which is why a naive version of this mock proves nothing. A
///      plain revert hands the unused gas back to the caller, so the hook still has plenty left to
///      absorb the blob. Burning first leaves the hook with only the reserve, at which point copying
///      `returndatasize()` bytes and paying 8 gas per byte to log them is unaffordable — and an
///      out-of-gas frame inside the `catch` reverts the whole settlement, after the money has moved.
///
///      This is the third instance of the same failure family as the two found on BSC testnet: an
///      external call whose *failure mode*, not its success, changes the escrow's outcome.
contract ReturnBombReputationRegistry is IReputationRegistry {
    uint256 public immutable bombBytes;

    constructor(uint256 bombBytes_) {
        bombBytes = bombBytes_;
    }

    function giveFeedback(
        uint256,
        int128,
        uint8,
        string calldata,
        string calldata,
        string calldata,
        string calldata,
        bytes32
    ) external view {
        uint256 size = bombBytes;
        assembly {
            // Pay for the blob's memory expansion first, then burn the rest of the stipend, then
            // return the blob as revert data.
            mstore(size, 0)
            for {} gt(gas(), 3000) {} {}
            revert(0, size)
        }
    }

    function getSummary(uint256, address[] calldata, string calldata, string calldata)
        external
        pure
        returns (uint64, int128, uint8)
    {
        return (1, 1, 0);
    }

    function getLastIndex(uint256, address) external pure returns (uint64) {
        return 0;
    }
}
