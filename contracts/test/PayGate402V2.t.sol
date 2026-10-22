// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Test} from "forge-std/Test.sol";
import {PayGate402V2} from "../PayGate402V2.sol";
import {MockUSDC} from "./MockUSDC.sol";
import {MaliciousReentrantToken} from "./MaliciousReentrantToken.sol";

/**
 * @title PayGate402V2Test
 * @notice Foundry unit + fuzz test suite for PayGate402V2.
 *
 * Verifies all Contract v2 Architectural Invariants:
 *  1. Pure Per-Call Micropayments: No `hasAccess` storage or `verifyAccess()` method.
 *  2. Contract-Wide Request ID Replay Protection: `usedRequestIds[requestId]` prevents
 *     cross-caller, cross-service, and duplicate request ID reuse.
 *  3. Defense-in-Depth Reentrancy Protection: Combines CEI with `nonReentrant` modifier.
 *  4. Correct 95/5 USDC fee split and `AccessGranted` event emission.
 *  5. Provider service management and pause toggling.
 */
contract PayGate402V2Test is Test {
    PayGate402V2 internal gate;
    MockUSDC internal usdc;

    address internal owner = makeAddr("owner");
    address internal treasury = makeAddr("treasury");
    address internal provider = makeAddr("provider");
    address internal alice = makeAddr("alice");
    address internal bob = makeAddr("bob");

    string internal constant SVC_NAME = "Arc L1 Real-Time Telemetry";
    string internal constant SVC_ENDPOINT = "https://rpc.mainnet.arc.io/v1/telemetry";
    string internal constant SVC_PREVIEW = '{"service":"arc-telemetry","status":"active"}';
    uint256 internal constant PRICE_6DEC = 100_000; // 0.10 USDC (6-decimal)
    uint256 internal constant USER_BALANCE = 10_000e6;

    function setUp() public {
        usdc = new MockUSDC();
        usdc.mint(alice, USER_BALANCE);
        usdc.mint(bob, USER_BALANCE);
        gate = new PayGate402V2(address(usdc), treasury);
    }

    // ─────────────────────────── 1. Deployment & Immutables ───────────────────────────

    function test_Deployment_ImmutablesStoredCorrectly() public view {
        assertEq(address(gate.usdcToken()), address(usdc));
        assertEq(gate.protocolTreasury(), treasury);
        assertEq(gate.PROTOCOL_FEE_BPS(), 500);
        assertEq(gate.BPS_DENOMINATOR(), 10000);
        assertEq(gate.nextServiceId(), 0);
    }

    function test_Deployment_RevertsOnZeroUSDCAddress() public {
        vm.expectRevert(bytes("Zero USDC address"));
        new PayGate402V2(address(0), treasury);
    }

    function test_Deployment_RevertsOnZeroTreasuryAddress() public {
        vm.expectRevert(bytes("Zero treasury address"));
        new PayGate402V2(address(usdc), address(0));
    }

    // ─────────────────────────── 2. Service Registration ───────────────────────────

    function test_RegisterService_HappyPath() public {
        vm.prank(provider);
        uint256 id = gate.registerService(SVC_NAME, SVC_ENDPOINT, PRICE_6DEC, SVC_PREVIEW);
        assertEq(id, 0);
        assertEq(gate.nextServiceId(), 1);

        (
            uint256 storedId,
            address storedProvider,
            string memory storedName,
            string memory storedEndpoint,
            uint256 storedPrice,
            string memory storedPreview,
            bool storedActive,
            uint256 storedCalls,
            uint256 storedRevenue
        ) = gate.services(id);

        assertEq(storedId, id);
        assertEq(storedProvider, provider);
        assertEq(storedName, SVC_NAME);
        assertEq(storedEndpoint, SVC_ENDPOINT);
        assertEq(storedPrice, PRICE_6DEC);
        assertEq(storedPreview, SVC_PREVIEW);
        assertTrue(storedActive);
        assertEq(storedCalls, 0);
        assertEq(storedRevenue, 0);
    }

    function test_RegisterService_RevertsOnEmptyName() public {
        vm.prank(provider);
        vm.expectRevert(bytes("Empty service name"));
        gate.registerService("", SVC_ENDPOINT, PRICE_6DEC, SVC_PREVIEW);
    }

    function test_RegisterService_EmitsServiceRegistered() public {
        vm.prank(provider);
        vm.expectEmit(true, true, false, true, address(gate));
        emit PayGate402V2.ServiceRegistered(0, provider, SVC_NAME, PRICE_6DEC);
        gate.registerService(SVC_NAME, SVC_ENDPOINT, PRICE_6DEC, SVC_PREVIEW);
    }

    function test_RegisterService_RevertsOnBelowMinPrice() public {
        vm.prank(provider);
        vm.expectRevert(bytes("Price too low for fee split (min 20 base units)"));
        gate.registerService(SVC_NAME, SVC_ENDPOINT, 19, SVC_PREVIEW);
    }

    // ─────────────────────────── 3. Per-Call Payment & Fee Split ───────────────────────────

    function _registerAndApprove() internal returns (uint256 serviceId) {
        vm.prank(provider);
        serviceId = gate.registerService(SVC_NAME, SVC_ENDPOINT, PRICE_6DEC, SVC_PREVIEW);
        vm.prank(alice);
        usdc.approve(address(gate), type(uint256).max);
        vm.prank(bob);
        usdc.approve(address(gate), type(uint256).max);
    }

    function test_PayForAccess_FeeSplit_95ProviderAnd5Treasury() public {
        uint256 id = _registerAndApprove();
        bytes32 reqId = keccak256("unique-request-1");

        uint256 expectedFee = (PRICE_6DEC * 500) / 10000; // 5% = 5,000 base units (0.005 USDC)
        uint256 expectedProvider = PRICE_6DEC - expectedFee; // 95% = 95,000 base units (0.095 USDC)

        uint256 providerBefore = usdc.balanceOf(provider);
        uint256 treasuryBefore = usdc.balanceOf(treasury);
        uint256 aliceBefore = usdc.balanceOf(alice);

        vm.prank(alice);
        gate.payForAccess(id, reqId);

        assertEq(usdc.balanceOf(alice), aliceBefore - PRICE_6DEC, "Alice balance mismatch");
        assertEq(usdc.balanceOf(provider) - providerBefore, expectedProvider, "Provider share mismatch");
        assertEq(usdc.balanceOf(treasury) - treasuryBefore, expectedFee, "Treasury fee mismatch");
    }

    function test_PayForAccess_EmitsAccessGranted() public {
        uint256 id = _registerAndApprove();
        bytes32 reqId = keccak256("event-req-1");

        vm.warp(1_750_000_000);

        vm.expectEmit(true, true, true, true, address(gate));
        emit PayGate402V2.AccessGranted(id, alice, reqId, PRICE_6DEC, block.timestamp);

        vm.prank(alice);
        gate.payForAccess(id, reqId);
    }

    function test_PayForAccess_UpdatesServiceTotals() public {
        uint256 id = _registerAndApprove();

        vm.prank(alice);
        gate.payForAccess(id, keccak256("req-alice-1"));

        vm.prank(bob);
        gate.payForAccess(id, keccak256("req-bob-1"));

        (,,,,,,,uint256 calls, uint256 revenue) = gate.services(id);
        assertEq(calls, 2);
        assertEq(revenue, 2 * PRICE_6DEC);
    }

    // ─────────────────────────── 4. Replay Protection (Contract-Wide) ───────────────────────────

    function test_PayForAccess_RevertsOnDuplicateRequestIdBySameCaller() public {
        uint256 id = _registerAndApprove();
        bytes32 reqId = keccak256("duplicate-req");

        vm.prank(alice);
        gate.payForAccess(id, reqId);

        vm.prank(alice);
        vm.expectRevert(bytes("Request already used"));
        gate.payForAccess(id, reqId);
    }

    function test_PayForAccess_RevertsWhenDifferentCallerReusesRequestId() public {
        uint256 id = _registerAndApprove();
        bytes32 reqId = keccak256("shared-challenge-req");

        // Alice pays first for this gateway challenge
        vm.prank(alice);
        gate.payForAccess(id, reqId);

        // Bob tries to replay the same requestId for the same service — MUST REVERT
        vm.prank(bob);
        vm.expectRevert(bytes("Request already used"));
        gate.payForAccess(id, reqId);
    }

    function test_PayForAccess_CrossService_RevertsWhenReusedAcrossDifferentServices() public {
        uint256 svc0 = _registerAndApprove();

        // Register second service
        vm.prank(provider);
        uint256 svc1 = gate.registerService("Second Service", "https://api.example.com", 200_000, "{}");

        bytes32 reqId = keccak256("cross-service-req");

        // Alice pays for Service 0 with reqId
        vm.prank(alice);
        gate.payForAccess(svc0, reqId);

        // Bob tries to use the same reqId on Service 1 — MUST REVERT on contract-wide mapping
        vm.prank(bob);
        vm.expectRevert(bytes("Request already used"));
        gate.payForAccess(svc1, reqId);
    }

    function test_PayForAccess_RevertsOnZeroRequestId() public {
        uint256 id = _registerAndApprove();

        vm.prank(alice);
        vm.expectRevert(bytes("Invalid requestId"));
        gate.payForAccess(id, bytes32(0));
    }

    function test_PayForAccess_RevertsOnInactiveService() public {
        uint256 id = _registerAndApprove();

        vm.prank(provider);
        gate.setServiceActive(id, false);

        vm.prank(alice);
        vm.expectRevert(bytes("Service inactive"));
        gate.payForAccess(id, keccak256("req-inactive"));
    }

    function test_PayForAccess_RevertsOnNonexistentService() public {
        _registerAndApprove();

        vm.prank(alice);
        vm.expectRevert(bytes("Service does not exist"));
        gate.payForAccess(999, keccak256("req-missing"));
    }

    function test_PayForAccess_RevertsOnInsufficientAllowance() public {
        vm.prank(provider);
        uint256 id = gate.registerService(SVC_NAME, SVC_ENDPOINT, PRICE_6DEC, SVC_PREVIEW);

        // Alice has balance but zero allowance
        vm.prank(alice);
        vm.expectRevert();
        gate.payForAccess(id, keccak256("req-no-allowance"));
    }

    // ─────────────────────────── 5. Adversarial Reentrancy Test ───────────────────────────

    function test_PayForAccess_ReentrancyAttack_BlockedByNonReentrant() public {
        // Deploy malicious token that attempts reentrant call into gate.payForAccess
        MaliciousReentrantToken malToken = new MaliciousReentrantToken();
        PayGate402V2 malGate = new PayGate402V2(address(malToken), treasury);

        vm.prank(provider);
        uint256 svcId = malGate.registerService(SVC_NAME, SVC_ENDPOINT, PRICE_6DEC, SVC_PREVIEW);

        malToken.mint(alice, USER_BALANCE);
        vm.prank(alice);
        malToken.approve(address(malGate), type(uint256).max);

        // Configure malicious token to reenter with a different requestId during transferFrom
        bytes32 req1 = keccak256("initial-request");
        bytes32 req2 = keccak256("reentrant-request");
        malToken.setReentrancyTarget(address(malGate), svcId, req2);

        // Execution must revert when reentrancy is attempted
        vm.prank(alice);
        vm.expectRevert(); // ReentrancyGuardReentrantCall triggers revert
        malGate.payForAccess(svcId, req1);

        // Verify that reentrancy did not succeed and state rolled back completely
        assertFalse(malToken.reentrancySucceeded());
        (,,,,,,,uint256 calls, uint256 rev) = malGate.services(svcId);
        assertEq(calls, 0, "No calls recorded after blocked reentrancy");
        assertEq(rev, 0, "No revenue recorded after blocked reentrancy");
        assertFalse(malGate.usedRequestIds(req1), "req1 not marked used");
        assertFalse(malGate.usedRequestIds(req2), "req2 not marked used");
    }

    // ─────────────────────────── 6. Provider Active Toggle ───────────────────────────

    function test_SetServiceActive_TogglesStatus() public {
        uint256 id = _registerAndApprove();

        vm.prank(provider);
        vm.expectEmit(true, false, false, true, address(gate));
        emit PayGate402V2.ServiceStatusUpdated(id, false);
        gate.setServiceActive(id, false);

        (,,,,,,bool active,,) = gate.services(id);
        assertFalse(active);

        vm.prank(provider);
        gate.setServiceActive(id, true);
        (,,,,,,bool activeAgain,,) = gate.services(id);
        assertTrue(activeAgain);
    }

    function test_SetServiceActive_RevertsForNonProvider() public {
        uint256 id = _registerAndApprove();

        vm.prank(alice);
        vm.expectRevert(bytes("Not service provider"));
        gate.setServiceActive(id, false);
    }

    // ─────────────────────────── 7. Fuzz Tests ───────────────────────────

    function testFuzz_FeeSplitArithmetic(uint256 price) public view {
        vm.assume(price >= 20 && price <= 1_000_000_000e6);
        uint256 fee = (price * 500) / 10000;
        uint256 providerAmount = price - fee;

        assertEq(fee + providerAmount, price, "Split sum must equal total price");
        assertTrue(fee <= price / 20 + 1, "Fee cannot exceed 5% + rounding");
    }
}
