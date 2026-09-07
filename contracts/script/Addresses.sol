// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title Addresses
/// @notice Verified deployment addresses Hallmark builds on, keyed by chain id.
/// @dev The ERC-8004 registries share a vanity prefix per registry because they were deployed with
///      CREATE2 from the same salt scheme on every chain: `0x8004A…` identity, `0x8004B…`
///      reputation, `0x8004C…` validation.
library Addresses {
    uint256 internal constant BSC_MAINNET = 56;
    uint256 internal constant BSC_TESTNET = 97;

    error UnsupportedChain(uint256 chainId);

    /// @notice ERC-8004 registry addresses for a chain.
    struct Registries {
        address identity;
        address reputation;
        address validation;
    }

    /// @notice Altana ERC-8183 deployment for a chain.
    struct Altana {
        address commerce;
        address router;
        address policy;
        address paymentToken;
    }

    /// @notice ERC-8004 Identity, Reputation and Validation registries.
    function registries(uint256 chainId) internal pure returns (Registries memory r) {
        if (chainId == BSC_MAINNET) {
            return Registries({
                identity: 0x8004A169FB4a3325136EB29fA0ceB6D2e539a432,
                reputation: 0x8004BAa17C55a88189AE136b182e5fdA19dE9b63,
                validation: 0x8004Cc8439f36fd5F9F049D9fF86523Df6dAAB58
            });
        }
        if (chainId == BSC_TESTNET) {
            return Registries({
                identity: 0x8004A818BFB912233c491871b3d84c89A494BD9e,
                reputation: 0x8004B663056A597Dffe9eCcC1965A193B7388713,
                validation: 0x8004Cb1BF31DAf7788923b405b754f57acEB4272
            });
        }
        revert UnsupportedChain(chainId);
    }

    /// @notice Altana's live ERC-8183 contracts and the $U payment token (18 decimals).
    function altana(uint256 chainId) internal pure returns (Altana memory a) {
        if (chainId == BSC_MAINNET) {
            return Altana({
                commerce: 0xEa4DAa3100A767e86FDed867729ae7446476EBA6,
                router: 0x51895229E12F9876011789B04f8698af06cCD6DA,
                policy: 0x9C01845705b3078Aa2e8cfF7520a6376FD766dE5,
                paymentToken: 0xcE24439F2D9C6a2289F741120FE202248B666666
            });
        }
        if (chainId == BSC_TESTNET) {
            return Altana({
                commerce: 0xa206c0517B6371C6638CD9e4a42Cc9f02A33B0DE,
                router: 0xD7d36D66d2F1B608A0F943f722D27e3744f66F25,
                policy: 0xd6a4217588F6B1F5657a92A3e94E6422aD771cEA,
                paymentToken: 0xc70B8741B8B07A6d61E54fd4B20f22Fa648E5565
            });
        }
        revert UnsupportedChain(chainId);
    }

    /// @notice Human-readable chain label, for deployment logs.
    function name(uint256 chainId) internal pure returns (string memory) {
        if (chainId == BSC_MAINNET) return "BNB Smart Chain";
        if (chainId == BSC_TESTNET) return "BNB Smart Chain Testnet";
        revert UnsupportedChain(chainId);
    }
}
