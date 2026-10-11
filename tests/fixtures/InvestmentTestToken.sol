// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;
/// Test fixture only: no production value, no price-peg guarantee.
contract InvestmentTestToken {
    string public name;
    string public symbol;
    uint8 public constant decimals = 18;
    uint256 public totalSupply;
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;
    event Transfer(address indexed from, address indexed to, uint256 value);
    event Approval(address indexed owner, address indexed spender, uint256 value);
    constructor(string memory label, string memory ticker) {
        require(block.chainid == 97 || block.chainid == 1337, "test chain only");
        name = label; symbol = ticker;
        totalSupply = 2000000 ether; balanceOf[msg.sender] = totalSupply;
        emit Transfer(address(0), msg.sender, totalSupply);
    }
    function approve(address spender, uint256 amount) external returns (bool) {
        allowance[msg.sender][spender] = amount; emit Approval(msg.sender, spender, amount); return true;
    }
    function transfer(address to, uint256 amount) external returns (bool) { _transfer(msg.sender,to,amount); return true; }
    function transferFrom(address from,address to,uint256 amount) external returns(bool) {
        require(allowance[from][msg.sender] >= amount, "allowance");
        allowance[from][msg.sender] -= amount; _transfer(from,to,amount); return true;
    }
    function _transfer(address from,address to,uint256 amount) internal {
        require(to != address(0) && balanceOf[from] >= amount, "balance");
        balanceOf[from] -= amount; balanceOf[to] += amount; emit Transfer(from,to,amount);
    }
}
