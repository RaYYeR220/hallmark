// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IIdentityRegistry} from "../../src/interfaces/IIdentityRegistry.sol";

/// @notice Minimal ERC-8004 Identity Registry stand-in.
/// @dev Mirrors the behaviour that matters to the gate: `ownerOf` reverts for an agent id that was
///      never registered, exactly as an ERC-721 registry does.
contract MockIdentityRegistry is IIdentityRegistry {
    error NonexistentAgent(uint256 agentId);

    mapping(uint256 => address) private _owners;
    mapping(uint256 => address) private _wallets;
    mapping(uint256 => string) private _tokenURIs;
    mapping(uint256 => mapping(string => string)) private _metadata;

    function register(uint256 agentId, address owner) external {
        _owners[agentId] = owner;
        _wallets[agentId] = owner;
    }

    function setAgentWallet(uint256 agentId, address wallet) external {
        _wallets[agentId] = wallet;
    }

    function setTokenURI(uint256 agentId, string calldata uri) external {
        _tokenURIs[agentId] = uri;
    }

    function setMetadata(uint256 agentId, string calldata key, string calldata value) external {
        _metadata[agentId][key] = value;
    }

    function ownerOf(uint256 agentId) external view returns (address) {
        address owner = _owners[agentId];
        if (owner == address(0)) revert NonexistentAgent(agentId);
        return owner;
    }

    function tokenURI(uint256 agentId) external view returns (string memory) {
        return _tokenURIs[agentId];
    }

    function getMetadata(uint256 agentId, string calldata key) external view returns (string memory) {
        return _metadata[agentId][key];
    }

    function getAgentWallet(uint256 agentId) external view returns (address) {
        return _wallets[agentId];
    }
}
