// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";

interface IPayGate402V2 {
    function payForAccess(uint256 serviceId, bytes32 requestId) external;
}

/**
 * @title MaliciousReentrantToken
 * @notice Mock ERC-20 token specifically designed to attempt reentrancy attacks
 *         against PayGate402V2 during transferFrom execution.
 */
contract MaliciousReentrantToken is IERC20 {
    string public name = "Malicious Token";
    string public symbol = "MAL";
    uint8 public decimals = 6;
    uint256 public totalSupply = 1_000_000_000e6;

    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    address public reenterTarget;
    uint256 public reenterServiceId;
    bytes32 public reenterRequestId;
    bool public hasAttemptedReentrancy;
    bool public reentrancySucceeded;

    constructor() {
        balanceOf[msg.sender] = totalSupply;
    }

    function setReentrancyTarget(
        address target,
        uint256 serviceId,
        bytes32 requestId
    ) external {
        reenterTarget = target;
        reenterServiceId = serviceId;
        reenterRequestId = requestId;
        hasAttemptedReentrancy = false;
        reentrancySucceeded = false;
    }

    function transfer(address to, uint256 amount) external returns (bool) {
        balanceOf[msg.sender] -= amount;
        balanceOf[to] += amount;
        emit Transfer(msg.sender, to, amount);
        return true;
    }

    function approve(address spender, uint256 amount) external returns (bool) {
        allowance[msg.sender][spender] = amount;
        emit Approval(msg.sender, spender, amount);
        return true;
    }

    function transferFrom(address from, address to, uint256 amount) external returns (bool) {
        require(balanceOf[from] >= amount, "Insufficient balance");
        require(allowance[from][msg.sender] >= amount, "Insufficient allowance");

        allowance[from][msg.sender] -= amount;
        balanceOf[from] -= amount;
        balanceOf[to] += amount;
        emit Transfer(from, to, amount);

        // Attempt malicious reentrancy during transferFrom
        if (reenterTarget != address(0) && !hasAttemptedReentrancy) {
            hasAttemptedReentrancy = true;
            try IPayGate402V2(reenterTarget).payForAccess(reenterServiceId, reenterRequestId) {
                reentrancySucceeded = true;
            } catch {
                reentrancySucceeded = false;
                // Propagate revert to demonstrate atomic rollback when reentrancy fails
                revert("MaliciousReentrancyBlocked");
            }
        }

        return true;
    }

    function mint(address to, uint256 amount) external {
        balanceOf[to] += amount;
        totalSupply += amount;
        emit Transfer(address(0), to, amount);
    }
}
