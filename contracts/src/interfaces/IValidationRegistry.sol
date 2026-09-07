// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title IValidationRegistry
/// @notice Portion of the ERC-8004 Validation Registry that Hallmark reads.
/// @dev A validation is a two-step record: a request commits to a job of work under `requestHash`,
///      and the named validator later answers it with a `response` score in [0, 100] plus a `tag`.
///      `lastUpdate` is the timestamp of the most recent write and is the freshness signal Hallmark
///      relies on.
interface IValidationRegistry {
    /// @notice Reads a single validation record.
    /// @return validatorAddress Validator the request was addressed to.
    /// @return agentId Agent the request concerns.
    /// @return response Score in [0, 100]; zero until the validator answers.
    /// @return responseHash Commitment to the validator's off-chain response document.
    /// @return tag Free-form label chosen by the validator, e.g. a probe type.
    /// @return lastUpdate Timestamp of the latest write to this record.
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
        );

    /// @notice Aggregates validation responses for an agent.
    /// @param validatorAddresses Validators to include; an empty array means every validator.
    function getSummary(uint256 agentId, address[] calldata validatorAddresses, string calldata tag)
        external
        view
        returns (uint64 count, uint8 averageResponse);

    /// @notice Every validation request hash recorded against an agent, oldest first.
    function getAgentValidations(uint256 agentId) external view returns (bytes32[] memory requestHashes);

    /// @notice Opens a validation request addressed to `validatorAddress`.
    function validationRequest(
        address validatorAddress,
        uint256 agentId,
        string calldata requestURI,
        bytes32 requestHash
    ) external;

    /// @notice Answers an open validation request. Validator only.
    function validationResponse(
        bytes32 requestHash,
        uint8 response,
        string calldata responseURI,
        bytes32 responseHash,
        string calldata tag
    ) external;
}
