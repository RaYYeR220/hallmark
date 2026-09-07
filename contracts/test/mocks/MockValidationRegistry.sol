// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IValidationRegistry} from "../../src/interfaces/IValidationRegistry.sol";

/// @notice Minimal ERC-8004 Validation Registry stand-in.
/// @dev Keeps the two-step request/response shape of the real registry, stamps `lastUpdate` on every
///      write, and can be told to revert so the hook's defensive `try/catch` paths are exercised.
contract MockValidationRegistry is IValidationRegistry {
    struct Record {
        address validatorAddress;
        uint256 agentId;
        uint8 response;
        bytes32 responseHash;
        string tag;
        uint256 lastUpdate;
        bool exists;
    }

    error UnknownRequest();
    error NotValidator();
    error RegistryUnavailable();

    bool public revertOnRead;

    mapping(bytes32 => Record) private _records;
    mapping(uint256 => bytes32[]) private _agentRequests;

    function setRevertOnRead(bool value) external {
        revertOnRead = value;
    }

    function validationRequest(address validatorAddress, uint256 agentId, string calldata, bytes32 requestHash)
        external
    {
        Record storage record = _records[requestHash];
        if (!record.exists) _agentRequests[agentId].push(requestHash);
        record.validatorAddress = validatorAddress;
        record.agentId = agentId;
        record.lastUpdate = block.timestamp;
        record.exists = true;
    }

    function validationResponse(
        bytes32 requestHash,
        uint8 response,
        string calldata,
        bytes32 responseHash,
        string calldata tag
    ) external {
        Record storage record = _records[requestHash];
        if (!record.exists) revert UnknownRequest();
        if (msg.sender != record.validatorAddress) revert NotValidator();
        record.response = response;
        record.responseHash = responseHash;
        record.tag = tag;
        record.lastUpdate = block.timestamp;
    }

    function getValidationStatus(bytes32 requestHash)
        external
        view
        returns (
            address validatorAddress,
            uint256 agentId,
            uint8 response,
            bytes32 responseHash,
            string memory tag,
            uint256 lastUpdate
        )
    {
        if (revertOnRead) revert RegistryUnavailable();
        Record storage record = _records[requestHash];
        return
            (
                record.validatorAddress,
                record.agentId,
                record.response,
                record.responseHash,
                record.tag,
                record.lastUpdate
            );
    }

    function getSummary(uint256 agentId, address[] calldata validatorAddresses, string calldata tag)
        external
        view
        returns (uint64 count, uint8 averageResponse)
    {
        if (revertOnRead) revert RegistryUnavailable();
        bytes32[] storage hashes = _agentRequests[agentId];
        uint256 total;
        for (uint256 i = 0; i < hashes.length; ++i) {
            Record storage record = _records[hashes[i]];
            if (validatorAddresses.length != 0 && !_contains(validatorAddresses, record.validatorAddress)) continue;
            if (bytes(tag).length != 0 && keccak256(bytes(tag)) != keccak256(bytes(record.tag))) continue;
            count += 1;
            total += record.response;
        }
        // The mean of values that are each at most 255 cannot exceed 255.
        // forge-lint: disable-next-line(unsafe-typecast)
        if (count != 0) averageResponse = uint8(total / count);
    }

    function getAgentValidations(uint256 agentId) external view returns (bytes32[] memory) {
        if (revertOnRead) revert RegistryUnavailable();
        return _agentRequests[agentId];
    }

    function _contains(address[] calldata list, address value) private pure returns (bool) {
        for (uint256 i = 0; i < list.length; ++i) {
            if (list[i] == value) return true;
        }
        return false;
    }
}
