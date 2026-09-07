// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IReputationRegistry} from "../../src/interfaces/IReputationRegistry.sol";

/// @notice Minimal ERC-8004 Reputation Registry stand-in.
/// @dev Stores every feedback entry verbatim so tests can assert exactly what the hook wrote, and
///      can be told to revert on `giveFeedback` or `getSummary` to exercise the hook's failure paths.
contract MockReputationRegistry is IReputationRegistry {
    struct Entry {
        address client;
        int128 value;
        uint8 valueDecimals;
        string tag1;
        string tag2;
        string endpoint;
        string feedbackURI;
        bytes32 feedbackHash;
    }

    error FeedbackRejected();
    error SummaryUnavailable();

    bool public revertOnFeedback;
    bool public revertOnSummary;

    mapping(uint256 => Entry[]) private _entries;
    mapping(uint256 => mapping(address => uint64)) private _lastIndex;

    function setRevertOnFeedback(bool value) external {
        revertOnFeedback = value;
    }

    function setRevertOnSummary(bool value) external {
        revertOnSummary = value;
    }

    function giveFeedback(
        uint256 agentId,
        int128 value,
        uint8 valueDecimals,
        string calldata tag1,
        string calldata tag2,
        string calldata endpoint,
        string calldata feedbackURI,
        bytes32 feedbackHash
    ) external {
        if (revertOnFeedback) revert FeedbackRejected();

        _entries[agentId].push(
            Entry({
                client: msg.sender,
                value: value,
                valueDecimals: valueDecimals,
                tag1: tag1,
                tag2: tag2,
                endpoint: endpoint,
                feedbackURI: feedbackURI,
                feedbackHash: feedbackHash
            })
        );

        uint64 index = uint64(_entries[agentId].length - 1);
        _lastIndex[agentId][msg.sender] = index;
        _emitFeedback(agentId, index);
    }

    /// @dev Reads the entry back out of storage so the eleven-field event fits on the stack.
    function _emitFeedback(uint256 agentId, uint64 index) private {
        Entry storage entry = _entries[agentId][index];
        emit NewFeedback(
            agentId,
            entry.client,
            index,
            entry.value,
            entry.valueDecimals,
            entry.tag1,
            entry.tag1,
            entry.tag2,
            entry.endpoint,
            entry.feedbackURI,
            entry.feedbackHash
        );
    }

    function getSummary(uint256 agentId, address[] calldata clientAddresses, string calldata tag1, string calldata tag2)
        external
        view
        returns (uint64 count, int128 summaryValue, uint8 summaryValueDecimals)
    {
        if (revertOnSummary) revert SummaryUnavailable();

        Entry[] storage entries = _entries[agentId];
        int256 total;
        for (uint256 i = 0; i < entries.length; ++i) {
            Entry storage entry = entries[i];
            if (!_matchesClient(clientAddresses, entry.client)) continue;
            if (!_matchesTag(tag1, entry.tag1)) continue;
            if (!_matchesTag(tag2, entry.tag2)) continue;
            count += 1;
            total += int256(entry.value);
            summaryValueDecimals = entry.valueDecimals;
        }
        // The mean of int128 values is itself within int128 range.
        // forge-lint: disable-next-line(unsafe-typecast)
        if (count != 0) summaryValue = int128(total / int256(uint256(count)));
    }

    function getLastIndex(uint256 agentId, address clientAddress) external view returns (uint64) {
        return _lastIndex[agentId][clientAddress];
    }

    // --- test helpers ---

    function entryCount(uint256 agentId) external view returns (uint256) {
        return _entries[agentId].length;
    }

    function entryAt(uint256 agentId, uint256 index) external view returns (Entry memory) {
        return _entries[agentId][index];
    }

    function lastEntry(uint256 agentId) external view returns (Entry memory) {
        return _entries[agentId][_entries[agentId].length - 1];
    }

    function _matchesClient(address[] calldata clients, address client) private pure returns (bool) {
        if (clients.length == 0) return true;
        for (uint256 i = 0; i < clients.length; ++i) {
            if (clients[i] == client) return true;
        }
        return false;
    }

    function _matchesTag(string calldata filter, string memory tag) private pure returns (bool) {
        if (bytes(filter).length == 0) return true;
        return keccak256(bytes(filter)) == keccak256(bytes(tag));
    }
}
