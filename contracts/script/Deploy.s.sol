// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script} from "forge-std/Script.sol";
import {console2} from "forge-std/console2.sol";

import {AgenticCommerceHooked} from "../src/AgenticCommerceHooked.sol";
import {HallmarkHook} from "../src/HallmarkHook.sol";
import {Addresses} from "./Addresses.sol";

/// @title Deploy
/// @notice Deploys the Hallmark escrow and its evidence gate, wired to the ERC-8004 registries of
///         whichever BNB Chain the script is pointed at.
/// @dev Environment:
///      - `PRIVATE_KEY`  deployer key; becomes the owner of both contracts
///      - `TREASURY`     platform fee recipient
///      - `ATTESTOR`     Hallmark prober address whose evidence the gate trusts
///      - `FEE_BPS`      optional, defaults to 250 (2.5%), capped at 1000
///      - `PAYMENT_TOKEN` optional override; defaults to the $U token for the chain
///      - `EVIDENCE_BASE_URI` optional prefix for feedback evidence documents
contract Deploy is Script {
    uint16 internal constant DEFAULT_FEE_BPS = 250;

    function run() external {
        uint256 chainId = block.chainid;
        uint256 deployerKey = vm.envUint("PRIVATE_KEY");
        address treasury = vm.envAddress("TREASURY");
        address attestor = vm.envAddress("ATTESTOR");
        uint16 feeBps = uint16(vm.envOr("FEE_BPS", uint256(DEFAULT_FEE_BPS)));
        string memory evidenceBaseURI = vm.envOr("EVIDENCE_BASE_URI", string(""));

        Addresses.Registries memory registries = Addresses.registries(chainId);
        address paymentToken = vm.envOr("PAYMENT_TOKEN", Addresses.altana(chainId).paymentToken);

        address deployer = vm.addr(deployerKey);

        vm.startBroadcast(deployerKey);

        AgenticCommerceHooked commerce = new AgenticCommerceHooked(paymentToken, treasury, feeBps);

        HallmarkHook hook = new HallmarkHook(
            address(commerce), registries.identity, registries.reputation, registries.validation, attestor
        );

        commerce.setHookWhitelisted(address(hook), true);
        if (bytes(evidenceBaseURI).length != 0) hook.setEvidenceBaseURI(evidenceBaseURI);

        vm.stopBroadcast();

        console2.log("== Hallmark deployment ==");
        console2.log("chain                :", Addresses.name(chainId));
        console2.log("chainId              :", chainId);
        console2.log("deployer / owner     :", deployer);
        console2.log("paymentToken         :", paymentToken);
        console2.log("treasury             :", treasury);
        console2.log("feeBps               :", feeBps);
        console2.log("attestor             :", attestor);
        console2.log("-- deployed --");
        console2.log("AgenticCommerceHooked:", address(commerce));
        console2.log("HallmarkHook         :", address(hook));
        console2.log("-- ERC-8004 registries --");
        console2.log("IdentityRegistry     :", registries.identity);
        console2.log("ReputationRegistry   :", registries.reputation);
        console2.log("ValidationRegistry   :", registries.validation);
    }
}
