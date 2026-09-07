// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title IIdentityRegistry
/// @notice Minimal read surface of the ERC-8004 Identity Registry.
/// @dev The registry is ERC-721 based: an agent id is a token id and the token owner is the agent's
///      controller. It is NOT ERC-721 Enumerable, so there is deliberately no `totalSupply()` here —
///      consumers must never assume agent ids form a dense range.
interface IIdentityRegistry {
    /// @notice Owner of the agent token. Reverts for an agent id that was never registered.
    function ownerOf(uint256 agentId) external view returns (address);

    /// @notice Metadata URI of the agent's registration document.
    function tokenURI(uint256 agentId) external view returns (string memory);

    /// @notice Reads a single on-chain metadata entry of an agent.
    function getMetadata(uint256 agentId, string calldata key) external view returns (string memory);

    /// @notice Payout / operational wallet declared by the agent.
    function getAgentWallet(uint256 agentId) external view returns (address);
}
