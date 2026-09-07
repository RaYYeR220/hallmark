// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IAgenticCommerce} from "./IAgenticCommerce.sol";

/// @title IJobParties
/// @notice A bounded read of a job's parties and money, for callers that run inside a gas budget.
/// @dev Not part of ERC-8183. It exists because `getJob` returns the whole `Job`, including the
///      client-supplied `description` string, whose length nothing bounds. A policy hook that reads
///      the job during `fund` would otherwise inherit an unbounded, client-controlled gas cost on a
///      money path — the same class of problem as the O(history) registry reads. Everything a hook
///      needs to make a decision is fixed-width, so it gets its own accessor.
interface IJobParties {
    /// @notice Fixed-width view of a job: no strings, no unbounded data, constant gas.
    function getJobParties(uint256 jobId)
        external
        view
        returns (
            address client,
            address provider,
            address evaluator,
            uint256 budget,
            uint256 expiredAt,
            IAgenticCommerce.JobStatus status
        );
}
