// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IReputationRegistry} from "../../src/interfaces/IReputationRegistry.sol";

/// @notice A Reputation Registry that consumes every unit of gas it is handed and reverts with empty
///         data — the exact signature of the failure observed on BSC testnet.
/// @dev Without an explicit stipend, EIP-150 would hand this contract 63/64 of everything and leave
///      the hook 1/64 to finish `_afterSettlement`. That is enough gas to be dangerous and not always
///      enough to emit two logs, so a registry like this one could run the hook out of gas *after*
///      the escrow had already paid out, reverting a settlement it is explicitly forbidden from
///      blocking. `FEEDBACK_EPILOGUE_RESERVE` is what makes that impossible.
contract GasBurningReputationRegistry is IReputationRegistry {
    function giveFeedback(
        uint256,
        int128,
        uint8,
        string calldata,
        string calldata,
        string calldata,
        string calldata,
        bytes32
    ) external pure {
        // INVALID: burns the entire call frame's gas and returns no revert data.
        assembly {
            invalid()
        }
    }

    function getSummary(uint256, address[] calldata, string calldata, string calldata)
        external
        pure
        returns (uint64, int128, uint8)
    {
        return (0, 0, 0);
    }

    function getLastIndex(uint256, address) external pure returns (uint64) {
        return 0;
    }
}
