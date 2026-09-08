// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script} from "forge-std/Script.sol";
import {console2} from "forge-std/console2.sol";

import {HallmarkHook} from "../src/HallmarkHook.sol";

/// @title Configure
/// @notice Changes the evidence gate's owner-settable parameters on a deployed `HallmarkHook`.
/// @dev Four of the hook's inputs are deliberately not immutable — the freshness window, the score
///      floor, the attestable-budget floor and the attestor address. They are policy, not
///      mechanism, and every one of them is read live by the interface rather than hard-coded, so
///      that what the app tells a user is whatever the contract will actually enforce.
///
///      Before this script existed the only way to move them was an ad-hoc `cast send` with a key
///      on the command line, which is both unreviewable and the easiest way to put a private key in
///      a shell history. Every change here prints the before and after, and refuses a no-op.
///
///      Environment:
///      - `PRIVATE_KEY`            owner key; every setter here is `onlyOwner`
///      - `HOOK`                   the HallmarkHook address to configure
///      - `MAX_EVIDENCE_AGE`       optional, seconds. 0 < value <= 30 days
///      - `MIN_VALIDATION_SCORE`   optional, 0…100
///      - `MIN_ATTESTABLE_BUDGET`  optional, atomic units of the escrow's payment token
///      - `ATTESTOR`               optional, the address whose evidence the gate trusts
///      - `EVIDENCE_BASE_URI`      optional, prefix for evidence documents
///
///      Anything left unset is left alone. Setting a value to what it already is is skipped rather
///      than sent, because a transaction that changes nothing still shows up in a block explorer as
///      though something happened.
///
///      Example — widen the freshness window to 30 days:
///        HOOK=0x… MAX_EVIDENCE_AGE=2592000 forge script script/Configure.s.sol:Configure \
///          --rpc-url bsc_testnet --broadcast
contract Configure is Script {
    function run() external {
        uint256 ownerKey = vm.envUint("PRIVATE_KEY");
        HallmarkHook hook = HallmarkHook(vm.envAddress("HOOK"));

        // Sentinels, because zero is a meaningful value for two of these and "unset" has to be
        // distinguishable from "set to zero".
        uint256 maxAge = vm.envOr("MAX_EVIDENCE_AGE", type(uint256).max);
        uint256 minScore = vm.envOr("MIN_VALIDATION_SCORE", type(uint256).max);
        uint256 minBudget = vm.envOr("MIN_ATTESTABLE_BUDGET", type(uint256).max);
        address attestor = vm.envOr("ATTESTOR", address(0));
        string memory baseUri = vm.envOr("EVIDENCE_BASE_URI", string(""));

        address owner = vm.addr(ownerKey);
        require(owner == hook.owner(), "PRIVATE_KEY does not own this hook");

        console2.log("== HallmarkHook, before ==");
        _dump(hook);

        vm.startBroadcast(ownerKey);

        if (maxAge != type(uint256).max && maxAge != hook.maxEvidenceAge()) {
            require(maxAge != 0 && maxAge <= hook.MAX_EVIDENCE_AGE_LIMIT(), "MAX_EVIDENCE_AGE out of range");
            hook.setMaxEvidenceAge(maxAge);
            console2.log("setMaxEvidenceAge    :", maxAge);
        }

        if (minScore != type(uint256).max) {
            require(minScore <= 100, "MIN_VALIDATION_SCORE must be 0..100");
            // The bound above is checked before the cast, so the narrowing cannot lose a value.
            // forge-lint: disable-next-line(unsafe-typecast)
            uint8 narrowed = uint8(minScore);
            if (narrowed != hook.minValidationScore()) {
                hook.setMinValidationScore(narrowed);
                console2.log("setMinValidationScore:", minScore);
            }
        }

        if (minBudget != type(uint256).max && minBudget != hook.minAttestableBudget()) {
            hook.setMinAttestableBudget(minBudget);
            console2.log("setMinAttestableBudget:", minBudget);
        }

        if (attestor != address(0) && attestor != hook.attestor()) {
            hook.setAttestor(attestor);
            console2.log("setAttestor          :", attestor);
        }

        if (bytes(baseUri).length != 0 && keccak256(bytes(baseUri)) != keccak256(bytes(hook.evidenceBaseURI()))) {
            hook.setEvidenceBaseURI(baseUri);
            console2.log("setEvidenceBaseURI   :", baseUri);
        }

        vm.stopBroadcast();

        console2.log("== HallmarkHook, after ==");
        _dump(hook);
    }

    function _dump(HallmarkHook hook) internal view {
        console2.log("  hook               :", address(hook));
        console2.log("  owner              :", hook.owner());
        console2.log("  attestor           :", hook.attestor());
        console2.log("  maxEvidenceAge     :", hook.maxEvidenceAge());
        console2.log("  minValidationScore :", hook.minValidationScore());
        console2.log("  minAttestableBudget:", hook.minAttestableBudget());
        console2.log("  evidenceBaseURI    :", hook.evidenceBaseURI());
    }
}
