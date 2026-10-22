// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";

contract PayGate402 {
    IERC20 public immutable usdcToken;
    address public immutable protocolTreasury;
    uint256 public constant PROTOCOL_FEE_BPS = 500;
    uint256 public constant BPS_DENOMINATOR = 10000;
    uint256 public nextServiceId;

    struct Service {
        uint256 serviceId;
        address provider;
        string name;
        string endpointDescription;
        uint256 priceInUsdc;
        string gatedPayloadPreview;
        bool active;
        uint256 totalCalls;
        uint256 totalRevenue;
    }

    mapping(uint256 => Service) public services;
    mapping(uint256 => mapping(address => bool)) public hasAccess;
    mapping(uint256 => mapping(address => mapping(bytes32 => bool))) public usedRequestIds;

    event ServiceRegistered(uint256 indexed serviceId, address indexed provider, string name, uint256 priceInUsdc);
    event AccessGranted(
        uint256 indexed serviceId,
        address indexed caller,
        bytes32 indexed requestId,
        uint256 amountPaid,
        uint256 timestamp
    );
    event ServiceStatusUpdated(uint256 indexed serviceId, bool active);

    constructor(address _usdcToken, address _protocolTreasury) {
        require(_usdcToken != address(0), "Zero USDC address");
        require(_protocolTreasury != address(0), "Zero treasury address");
        usdcToken = IERC20(_usdcToken);
        protocolTreasury = _protocolTreasury;
    }

    function registerService(
        string memory name,
        string memory endpointDescription,
        uint256 priceInUsdc,
        string memory gatedPayloadPreview
    ) external returns (uint256) {
        require(priceInUsdc >= 20, "Price too low for fee split (min 20 base units)");

        uint256 serviceId = nextServiceId;
        nextServiceId += 1;

        services[serviceId] = Service({
            serviceId: serviceId,
            provider: msg.sender,
            name: name,
            endpointDescription: endpointDescription,
            priceInUsdc: priceInUsdc,
            gatedPayloadPreview: gatedPayloadPreview,
            active: true,
            totalCalls: 0,
            totalRevenue: 0
        });

        emit ServiceRegistered(serviceId, msg.sender, name, priceInUsdc);
        return serviceId;
    }

    function payForAccess(uint256 serviceId, bytes32 requestId) external {
        require(serviceId < nextServiceId, "Service does not exist");

        Service storage service = services[serviceId];
        require(service.active, "Service inactive");
        require(requestId != bytes32(0), "Invalid requestId");
        require(!usedRequestIds[serviceId][msg.sender][requestId], "Request already used");

        usedRequestIds[serviceId][msg.sender][requestId] = true;

        uint256 fee = (service.priceInUsdc * PROTOCOL_FEE_BPS) / BPS_DENOMINATOR;
        uint256 providerAmount = service.priceInUsdc - fee;

        require(usdcToken.transferFrom(msg.sender, service.provider, providerAmount), "Provider transfer failed");
        require(usdcToken.transferFrom(msg.sender, protocolTreasury, fee), "Fee transfer failed");

        services[serviceId].totalCalls += 1;
        services[serviceId].totalRevenue += service.priceInUsdc;
        hasAccess[serviceId][msg.sender] = true;

        emit AccessGranted(serviceId, msg.sender, requestId, service.priceInUsdc, block.timestamp);
    }

    function verifyAccess(uint256 serviceId, address caller) external view returns (bool) {
        return hasAccess[serviceId][caller];
    }

    function setServiceActive(uint256 serviceId, bool active) external {
        require(serviceId < nextServiceId, "Service does not exist");
        require(msg.sender == services[serviceId].provider, "Not service provider");

        services[serviceId].active = active;
        emit ServiceStatusUpdated(serviceId, active);
    }
}
