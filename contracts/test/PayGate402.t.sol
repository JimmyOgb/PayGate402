// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Test} from "forge-std/Test.sol";
import {PayGate402} from "../PayGate402.sol";
import {MockUSDC} from "./MockUSDC.sol";

/**
 * @title PayGate402Test
 * @notice Foundry unit + fuzz test suite for PayGate402.
 *
 * Coverage map:
 *  - Deployment & immutables
 *  - registerService: happy path, default values, ServiceRegistered event, zero-price revert
 *  - payForAccess: happy path, fee split, AccessGranted event, verifyAccess, reverts (nonexistent /
 *    inactive service, zero requestId, replay, insufficient allowance, insufficient balance)
 *  - setServiceActive: toggle on/off, ServiceStatusUpdated event, non-provider revert
 *  - Fuzz: fee arithmetic (no rounding loss)
 */
contract PayGate402Test is Test {
    // ─────────────────────────── state ───────────────────────────
    PayGate402 internal gate;
    MockUSDC   internal usdc;

    address internal owner    = makeAddr("owner");
    address internal treasury = makeAddr("treasury");
    address internal provider = makeAddr("provider");
    address internal alice    = makeAddr("alice");
    address internal bob      = makeAddr("bob");

    // Test-service parameters
    string  internal constant SVC_NAME     = "AI Image API";
    string  internal constant SVC_ENDPOINT = "https://api.example.com/v1/image";
    string  internal constant SVC_PREVIEW  = "First 512 bytes of response";
    uint256 internal constant PRICE_6DEC   = 1_000e6;   // 1 000 USDC (6-decimal)

    // Large working balance for payers
    uint256 internal constant USER_BALANCE = 10_000e6;

    // ─────────────────────────── setUp ───────────────────────────
    function setUp() public {
        // Deploy token (constructor mints 1 M USDC to deployer address = this contract)
        usdc = new MockUSDC();

        // Distribute liquidity
        usdc.mint(alice, USER_BALANCE);
        usdc.mint(bob,   USER_BALANCE);

        // Deploy PayGate402
        gate = new PayGate402(address(usdc), treasury);
    }

    // ═══════════════════════════════════════════════════════════════
    //  1. DEPLOYMENT & IMMUTABLES
    // ═══════════════════════════════════════════════════════════════

    function test_Deployment_ImmutablesStoredCorrectly() public view {
        assertEq(address(gate.usdcToken()),      address(usdc));
        assertEq(gate.protocolTreasury(),         treasury);
        assertEq(gate.PROTOCOL_FEE_BPS(),         500);
        assertEq(gate.BPS_DENOMINATOR(),          10_000);
        assertEq(gate.nextServiceId(),            0);
    }

    function test_Deployment_RevertsOnZeroUSDCAddress() public {
        vm.expectRevert(bytes("Zero USDC address"));
        new PayGate402(address(0), treasury);
    }

    function test_Deployment_RevertsOnZeroTreasuryAddress() public {
        vm.expectRevert(bytes("Zero treasury address"));
        new PayGate402(address(usdc), address(0));
    }

    // ═══════════════════════════════════════════════════════════════
    //  2. registerService — happy path, defaults, event
    // ═══════════════════════════════════════════════════════════════

    function test_RegisterService_ReturnsExpectedId() public {
        vm.prank(provider);
        uint256 id = gate.registerService(SVC_NAME, SVC_ENDPOINT, PRICE_6DEC, SVC_PREVIEW);
        assertEq(id, 0);
    }

    function test_RegisterService_IncrementsNextServiceId() public {
        vm.prank(provider);
        gate.registerService(SVC_NAME, SVC_ENDPOINT, PRICE_6DEC, SVC_PREVIEW);
        assertEq(gate.nextServiceId(), 1);

        vm.prank(provider);
        gate.registerService("Second", SVC_ENDPOINT, 1e6, SVC_PREVIEW);
        assertEq(gate.nextServiceId(), 2);
    }

    function test_RegisterService_DefaultValues() public {
        vm.prank(provider);
        uint256 id = gate.registerService(SVC_NAME, SVC_ENDPOINT, PRICE_6DEC, SVC_PREVIEW);

        (
            uint256 storedId,
            address storedProvider,
            string memory storedName,
            string memory storedEndpoint,
            uint256 storedPrice,
            string memory storedPreview,
            bool   storedActive,
            uint256 storedCalls,
            uint256 storedRevenue
        ) = gate.services(id);

        assertEq(storedId,       id,           "serviceId mismatch");
        assertEq(storedProvider, provider,     "provider mismatch");
        assertEq(storedName,     SVC_NAME,     "name mismatch");
        assertEq(storedEndpoint, SVC_ENDPOINT, "endpoint mismatch");
        assertEq(storedPrice,    PRICE_6DEC,   "price mismatch");
        assertEq(storedPreview,  SVC_PREVIEW,  "preview mismatch");
        assertTrue(storedActive,               "should start active");
        assertEq(storedCalls,    0,            "totalCalls should be 0");
        assertEq(storedRevenue,  0,            "totalRevenue should be 0");
    }

    function test_RegisterService_EmitsServiceRegistered() public {
        vm.prank(provider);
        // checkTopic1=true (serviceId), checkTopic2=true (provider), checkTopic3=false (n/a), checkData=true
        vm.expectEmit(true, true, false, true, address(gate));
        emit PayGate402.ServiceRegistered(0, provider, SVC_NAME, PRICE_6DEC);
        gate.registerService(SVC_NAME, SVC_ENDPOINT, PRICE_6DEC, SVC_PREVIEW);
    }

    function test_RegisterService_RevertsOnZeroPrice() public {
        vm.prank(provider);
        vm.expectRevert(bytes("Price too low for fee split (min 20 base units)"));
        gate.registerService(SVC_NAME, SVC_ENDPOINT, 0, SVC_PREVIEW);
    }

    function test_RegisterService_RevertsOnBelowMinPrice() public {
        vm.prank(provider);
        vm.expectRevert(bytes("Price too low for fee split (min 20 base units)"));
        gate.registerService(SVC_NAME, SVC_ENDPOINT, 19, SVC_PREVIEW);
    }

    // ═══════════════════════════════════════════════════════════════
    //  3. payForAccess — happy path
    // ═══════════════════════════════════════════════════════════════

    /// @dev Returns serviceId=0 with PRICE_6DEC, alice approved.
    function _registerAndApprove() internal returns (uint256 serviceId) {
        vm.prank(provider);
        serviceId = gate.registerService(SVC_NAME, SVC_ENDPOINT, PRICE_6DEC, SVC_PREVIEW);
        vm.prank(alice);
        usdc.approve(address(gate), type(uint256).max);
    }

    function test_PayForAccess_TransfersCorrectTotalAmount() public {
        uint256 id = _registerAndApprove();
        bytes32 reqId = keccak256("request-1");

        uint256 aliceBefore = usdc.balanceOf(alice);
        vm.prank(alice);
        gate.payForAccess(id, reqId);

        assertEq(usdc.balanceOf(alice), aliceBefore - PRICE_6DEC, "alice deducted wrong amount");
    }

    function test_PayForAccess_FeeSplit_95ProviderAnd5Treasury() public {
        uint256 id = _registerAndApprove();
        bytes32 reqId = keccak256("request-fee-split");

        uint256 expectedFee      = (PRICE_6DEC * 500) / 10_000;    // 5 %  = 50 USDC
        uint256 expectedProvider = PRICE_6DEC - expectedFee;        // 95 % = 950 USDC

        uint256 providerBefore  = usdc.balanceOf(provider);
        uint256 treasuryBefore  = usdc.balanceOf(treasury);

        vm.prank(alice);
        gate.payForAccess(id, reqId);

        assertEq(usdc.balanceOf(provider) - providerBefore, expectedProvider, "provider share wrong");
        assertEq(usdc.balanceOf(treasury) - treasuryBefore, expectedFee,      "treasury fee wrong");
    }

    function test_PayForAccess_EmitsAccessGranted() public {
        uint256 id = _registerAndApprove();
        bytes32 reqId = keccak256("request-event");

        // Freeze the timestamp so we can match it in the event
        vm.warp(1_700_000_000);

        // checkTopic1=true (serviceId), checkTopic2=true (caller), checkTopic3=true (requestId), checkData=true
        vm.expectEmit(true, true, true, true, address(gate));
        emit PayGate402.AccessGranted(id, alice, reqId, PRICE_6DEC, block.timestamp);

        vm.prank(alice);
        gate.payForAccess(id, reqId);
    }

    function test_PayForAccess_GrantsAccessAfterPayment() public {
        uint256 id = _registerAndApprove();

        // Verify no access before payment
        assertFalse(gate.verifyAccess(id, alice), "should have no access before payment");

        vm.prank(alice);
        gate.payForAccess(id, keccak256("request-access"));

        assertTrue(gate.verifyAccess(id, alice), "should have access after payment");
    }

    function test_PayForAccess_UpdatesServiceCountersAndRevenue() public {
        uint256 id = _registerAndApprove();

        vm.prank(alice);
        gate.payForAccess(id, keccak256("req-1"));

        // Second payer
        usdc.mint(bob, USER_BALANCE);
        vm.prank(bob);
        usdc.approve(address(gate), type(uint256).max);
        vm.prank(bob);
        gate.payForAccess(id, keccak256("req-2"));

        (,,,,,,,uint256 calls, uint256 revenue) = gate.services(id);
        assertEq(calls,   2,             "totalCalls should be 2");
        assertEq(revenue, 2 * PRICE_6DEC, "totalRevenue should be 2 * price");
    }

    function test_PayForAccess_MarksRequestIdAsUsed() public {
        uint256 id  = _registerAndApprove();
        bytes32 req = keccak256("used-req");

        vm.prank(alice);
        gate.payForAccess(id, req);

        assertTrue(gate.usedRequestIds(id, alice, req), "requestId should be marked used");
    }

    // ═══════════════════════════════════════════════════════════════
    //  4. verifyAccess — returns false before payment
    // ═══════════════════════════════════════════════════════════════

    function test_VerifyAccess_ReturnsFalseBeforePayment() public {
        vm.prank(provider);
        uint256 id = gate.registerService(SVC_NAME, SVC_ENDPOINT, PRICE_6DEC, SVC_PREVIEW);
        assertFalse(gate.verifyAccess(id, alice));
    }

    function test_VerifyAccess_ReturnsFalseForNonPayer() public {
        uint256 id = _registerAndApprove();

        vm.prank(alice);
        gate.payForAccess(id, keccak256("req-alice"));

        // Bob never paid
        assertFalse(gate.verifyAccess(id, bob), "bob should not have access");
    }

    // ═══════════════════════════════════════════════════════════════
    //  5. payForAccess — revert paths
    // ═══════════════════════════════════════════════════════════════

    function test_PayForAccess_RevertsOnNonexistentService() public {
        vm.prank(alice);
        vm.expectRevert(bytes("Service does not exist"));
        gate.payForAccess(999, keccak256("r"));
    }

    function test_PayForAccess_RevertsOnInactiveService() public {
        uint256 id = _registerAndApprove();

        // Deactivate
        vm.prank(provider);
        gate.setServiceActive(id, false);

        vm.prank(alice);
        vm.expectRevert(bytes("Service inactive"));
        gate.payForAccess(id, keccak256("r"));
    }

    function test_PayForAccess_RevertsOnZeroRequestId() public {
        uint256 id = _registerAndApprove();

        vm.prank(alice);
        vm.expectRevert(bytes("Invalid requestId"));
        gate.payForAccess(id, bytes32(0));
    }

    function test_PayForAccess_RevertsOnDuplicateRequestId() public {
        uint256 id  = _registerAndApprove();
        bytes32 req = keccak256("duplicate");

        vm.prank(alice);
        gate.payForAccess(id, req);

        // Second alice attempt with same requestId
        usdc.mint(alice, USER_BALANCE); // ensure funds aren't the problem
        vm.prank(alice);
        vm.expectRevert(bytes("Request already used"));
        gate.payForAccess(id, req);
    }

    function test_PayForAccess_RevertsOnInsufficientAllowance() public {
        vm.prank(provider);
        uint256 id = gate.registerService(SVC_NAME, SVC_ENDPOINT, PRICE_6DEC, SVC_PREVIEW);

        // Alice has balance but has NOT approved gate
        vm.prank(alice);
        vm.expectRevert(); // OZ ERC20 throws ERC20InsufficientAllowance
        gate.payForAccess(id, keccak256("r"));
    }

    function test_PayForAccess_RevertsOnInsufficientBalance() public {
        vm.prank(provider);
        uint256 id = gate.registerService(SVC_NAME, SVC_ENDPOINT, PRICE_6DEC, SVC_PREVIEW);

        address poorUser = makeAddr("poorUser");
        // poorUser has zero balance; give full allowance so balance is the limiting factor
        vm.prank(poorUser);
        usdc.approve(address(gate), type(uint256).max);

        vm.prank(poorUser);
        vm.expectRevert(); // OZ ERC20 throws ERC20InsufficientBalance
        gate.payForAccess(id, keccak256("r"));
    }

    // ═══════════════════════════════════════════════════════════════
    //  6. setServiceActive — toggle, event, non-provider revert
    // ═══════════════════════════════════════════════════════════════

    function test_SetServiceActive_ToggleToFalse() public {
        vm.prank(provider);
        uint256 id = gate.registerService(SVC_NAME, SVC_ENDPOINT, PRICE_6DEC, SVC_PREVIEW);

        vm.prank(provider);
        gate.setServiceActive(id, false);

        (,,,,,, bool active,,) = gate.services(id);
        assertFalse(active, "service should be inactive");
    }

    function test_SetServiceActive_ToggleBackToTrue() public {
        vm.prank(provider);
        uint256 id = gate.registerService(SVC_NAME, SVC_ENDPOINT, PRICE_6DEC, SVC_PREVIEW);

        vm.prank(provider);
        gate.setServiceActive(id, false);

        vm.prank(provider);
        gate.setServiceActive(id, true);

        (,,,,,, bool active,,) = gate.services(id);
        assertTrue(active, "service should be active again");
    }

    function test_SetServiceActive_EmitsServiceStatusUpdated() public {
        vm.prank(provider);
        uint256 id = gate.registerService(SVC_NAME, SVC_ENDPOINT, PRICE_6DEC, SVC_PREVIEW);

        vm.prank(provider);
        vm.expectEmit(true, false, false, true, address(gate));
        emit PayGate402.ServiceStatusUpdated(id, false);
        gate.setServiceActive(id, false);
    }

    function test_SetServiceActive_RevertsForNonProvider() public {
        vm.prank(provider);
        uint256 id = gate.registerService(SVC_NAME, SVC_ENDPOINT, PRICE_6DEC, SVC_PREVIEW);

        vm.prank(alice);
        vm.expectRevert(bytes("Not service provider"));
        gate.setServiceActive(id, false);
    }

    function test_SetServiceActive_RevertsOnNonexistentService() public {
        // Existence check now fires before provider check
        vm.prank(alice);
        vm.expectRevert(bytes("Service does not exist"));
        gate.setServiceActive(999, false);
    }

    // ═══════════════════════════════════════════════════════════════
    //  7. FUZZ — fee arithmetic correctness and no total-loss rounding
    // ═══════════════════════════════════════════════════════════════

    /**
     * @dev For any non-zero price up to 10 M USDC (6-dec):
     *   fee + providerAmount == price  (no dust lost)
     *   fee == price * 500 / 10_000   (exact BPS calc)
     *   providerAmount >= fee * 19     (provider always ≥ 95 %)
     */
    function testFuzz_FeeSplit_NoRoundingLoss(uint256 price) public {
        // Bound to [20, 10_000_000e6] to respect the min-price floor
        price = bound(price, 20, 10_000_000e6);

        uint256 fee           = (price * 500) / 10_000;
        uint256 providerAmt   = price - fee;

        // The two legs must sum to the full price
        assertEq(fee + providerAmt, price, "fee + providerAmt != price");

        // The fee must be exactly 5 % (rounded down per integer division)
        assertEq(fee, (price * 500) / 10_000, "fee BPS calc inconsistent");

        // Provider always gets ≥ 95 % (could be slightly more due to floor on fee)
        // i.e. providerAmt * 10_000 >= price * 9_500
        assertGe(providerAmt * 10_000, price * 9_500, "provider gets less than 95%");

        // Treasury never gets more than 5 %
        assertLe(fee * 10_000, price * 500 + 9_999, "fee exceeds 5 %");
    }

    /**
     * @dev End-to-end fuzz: register a service at fuzz price, pay with alice,
     *      assert exact balances on both provider and treasury.
     */
    function testFuzz_PayForAccess_ExactFeeSplit_EndToEnd(uint256 price) public {
        // Stay within alice's balance of 10_000e6; minimum 20 (fee split floor)
        price = bound(price, 20, USER_BALANCE);

        // Register service at fuzz price
        vm.prank(provider);
        uint256 id = gate.registerService(SVC_NAME, SVC_ENDPOINT, price, SVC_PREVIEW);

        // Alice approves and pays
        vm.prank(alice);
        usdc.approve(address(gate), type(uint256).max);

        uint256 expectedFee      = (price * 500) / 10_000;
        uint256 expectedProvider = price - expectedFee;

        uint256 providerBefore  = usdc.balanceOf(provider);
        uint256 treasuryBefore  = usdc.balanceOf(treasury);
        uint256 aliceBefore     = usdc.balanceOf(alice);

        vm.prank(alice);
        gate.payForAccess(id, keccak256(abi.encodePacked(price, "fuzz-req")));

        assertEq(usdc.balanceOf(alice),    aliceBefore    - price,            "alice delta wrong");
        assertEq(usdc.balanceOf(provider), providerBefore + expectedProvider,  "provider delta wrong");
        assertEq(usdc.balanceOf(treasury), treasuryBefore + expectedFee,       "treasury delta wrong");

        // Conservation: no USDC created or destroyed
        assertEq(
            (usdc.balanceOf(provider) - providerBefore) + (usdc.balanceOf(treasury) - treasuryBefore),
            price,
            "total transferred != price"
        );
    }

    // ═══════════════════════════════════════════════════════════════
    //  8. Edge-case / boundary checks
    // ═══════════════════════════════════════════════════════════════

    /// @dev A price of 20 (minimum floor) produces a well-defined fee split.
    function test_RegisterAndPay_MinimumPrice_FloorAtomicUnit() public {
        uint256 minPrice = 20;
        vm.prank(provider);
        uint256 id = gate.registerService("Min price svc", SVC_ENDPOINT, minPrice, SVC_PREVIEW);

        vm.prank(alice);
        usdc.approve(address(gate), type(uint256).max);

        // fee = (20 * 500) / 10_000 = 1  → provider gets 19, treasury gets 1
        uint256 providerBefore  = usdc.balanceOf(provider);
        uint256 treasuryBefore  = usdc.balanceOf(treasury);

        vm.prank(alice);
        gate.payForAccess(id, keccak256("min-price-req"));

        uint256 providerDelta  = usdc.balanceOf(provider) - providerBefore;
        uint256 treasuryDelta  = usdc.balanceOf(treasury) - treasuryBefore;

        assertEq(providerDelta + treasuryDelta, minPrice, "total should equal price");
        assertEq(treasuryDelta, 1,  "fee should be 1 at min price");
        assertEq(providerDelta, 19, "provider should get 19 at min price");
        assertTrue(gate.verifyAccess(id, alice), "alice should have access");
    }

    /// @dev Multiple distinct callers each get independent access records.
    function test_PayForAccess_IndependentAccessPerCaller() public {
        uint256 id = _registerAndApprove();

        usdc.mint(bob, USER_BALANCE);
        vm.prank(bob);
        usdc.approve(address(gate), type(uint256).max);

        vm.prank(alice);
        gate.payForAccess(id, keccak256("req-alice"));

        // bob hasn't paid yet
        assertFalse(gate.verifyAccess(id, bob), "bob should not have access before paying");

        vm.prank(bob);
        gate.payForAccess(id, keccak256("req-bob"));

        assertTrue(gate.verifyAccess(id, alice), "alice access should persist");
        assertTrue(gate.verifyAccess(id, bob),   "bob access should exist after paying");
    }

    /// @dev The same caller can pay for multiple distinct services independently.
    function test_PayForAccess_IndependentAccessPerService() public {
        vm.prank(provider);
        uint256 id0 = gate.registerService("Svc A", SVC_ENDPOINT, PRICE_6DEC, SVC_PREVIEW);

        vm.prank(provider);
        uint256 id1 = gate.registerService("Svc B", SVC_ENDPOINT, PRICE_6DEC, SVC_PREVIEW);

        vm.prank(alice);
        usdc.approve(address(gate), type(uint256).max);

        vm.prank(alice);
        gate.payForAccess(id0, keccak256("r0"));

        assertTrue( gate.verifyAccess(id0, alice), "should have access to svc A");
        assertFalse(gate.verifyAccess(id1, alice), "should NOT have access to svc B yet");

        vm.prank(alice);
        gate.payForAccess(id1, keccak256("r1"));

        assertTrue(gate.verifyAccess(id1, alice), "should have access to svc B after paying");
    }

    /// @dev requestId replay is per-service; same bytes32 is valid on a different service.
    function test_PayForAccess_ReplayProtectionIsPerService() public {
        vm.prank(provider);
        uint256 id0 = gate.registerService("Svc A", SVC_ENDPOINT, PRICE_6DEC, SVC_PREVIEW);
        vm.prank(provider);
        uint256 id1 = gate.registerService("Svc B", SVC_ENDPOINT, PRICE_6DEC, SVC_PREVIEW);

        vm.prank(alice);
        usdc.approve(address(gate), type(uint256).max);

        bytes32 sharedReq = keccak256("shared-req-id");

        vm.prank(alice);
        gate.payForAccess(id0, sharedReq);

        // Same bytes32 on a different serviceId must succeed (not a replay)
        vm.prank(alice);
        gate.payForAccess(id1, sharedReq);

        assertTrue(gate.verifyAccess(id0, alice), "should have access to svc 0");
        assertTrue(gate.verifyAccess(id1, alice), "should have access to svc 1");
    }
}
