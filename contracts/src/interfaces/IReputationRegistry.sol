// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title IReputationRegistry
/// @notice Portion of the ERC-8004 Reputation Registry that Hallmark reads and writes.
/// @dev The registry refuses feedback whose submitter is the agent's own owner or operator, so any
///      contract writing on a client's behalf must be a distinct account from the agent itself.
interface IReputationRegistry {
    event NewFeedback(
        uint256 indexed agentId,
        address indexed clientAddress,
        uint64 feedbackIndex,
        int128 value,
        uint8 valueDecimals,
        string indexed indexedTag1,
        string tag1,
        string tag2,
        string endpoint,
        string feedbackURI,
        bytes32 feedbackHash
    );

    /// @notice Appends a feedback entry for `agentId` attributed to `msg.sender`.
    /// @param agentId ERC-8004 agent the feedback is about.
    /// @param value Score, interpreted with `valueDecimals` decimal places.
    /// @param valueDecimals Number of decimals encoded into `value`.
    /// @param tag1 Primary tag; indexed by the registry for filtering.
    /// @param tag2 Secondary tag.
    /// @param endpoint Optional endpoint the feedback relates to.
    /// @param feedbackURI Optional off-chain evidence document.
    /// @param feedbackHash Optional commitment to the evidence.
    function giveFeedback(
        uint256 agentId,
        int128 value,
        uint8 valueDecimals,
        string calldata tag1,
        string calldata tag2,
        string calldata endpoint,
        string calldata feedbackURI,
        bytes32 feedbackHash
    ) external;

    /// @notice Aggregates feedback for an agent, optionally filtered by client and tags.
    /// @param clientAddresses Clients to include; an empty array means every client.
    /// @return count Number of matching feedback entries.
    /// @return summaryValue Aggregate score across the matching entries.
    /// @return summaryValueDecimals Decimals of `summaryValue`.
    function getSummary(uint256 agentId, address[] calldata clientAddresses, string calldata tag1, string calldata tag2)
        external
        view
        returns (uint64 count, int128 summaryValue, uint8 summaryValueDecimals);

    /// @notice Index of the most recent feedback a given client left for an agent.
    function getLastIndex(uint256 agentId, address clientAddress) external view returns (uint64);
}
