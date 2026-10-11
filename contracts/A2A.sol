// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// Fixed recipients; no upgrade, rescue, discretionary withdrawal or privileged role.
/// A beneficiary splitter for Flap Portal, not a Flap verified Vault.
contract RevenueSplitter {
    address payable public immutable platform;
    address payable public immutable agent;
    uint256 public platformPending;
    uint256 public computePending;
    uint256 public agentPending;
    bool private entered;
    event Revenue(uint256 received, uint256 platformAmount, uint256 compute, uint256 agentAmount);
    event PlatformPaid(uint256 amount, uint256 compute);
    event AgentPaid(uint256 amount);
    constructor(address payable p, address payable a) {
        require(p != address(0) && a != address(0) && p != a, "recipients"); platform=p; agent=a;
    }
    receive() external payable {
        require(!entered, "reentrant");
        uint256 p=msg.value*3000/10000;
        uint256 c=msg.value*1500/10000;
        platformPending+=p; computePending+=c; agentPending+=msg.value-p;
        emit Revenue(msg.value,p,c,msg.value-p);
        _flush();
    }
    function flush() external { require(!entered,"reentrant"); _flush(); }
    function _flush() private {
        entered=true;
        uint256 p=platformPending; uint256 c=computePending; uint256 a=agentPending;
        if(p>0) {
            platformPending=0;computePending=0;
            (bool ok,)=platform.call{value:p,gas:50000}("");
            if(ok) emit PlatformPaid(p,c); else {platformPending=p;computePending=c;}
        }
        if(a>0) {
            agentPending=0;
            (bool ok,)=agent.call{value:a,gas:50000}("");
            if(ok) emit AgentPaid(a); else agentPending=a;
        }
        entered=false;
    }
}

contract SplitterFactory {
    address payable public immutable platform;
    mapping(bytes32=>address) public splitters;
    event Created(bytes32 indexed key,address splitter,address agent);
    constructor(address payable p){require(p!=address(0),"platform");platform=p;}
    // Key binds recipients, so front-running cannot substitute a recipient.
    function create(bytes32 id,address payable agent) external returns(address splitter){
        bytes32 key=keccak256(abi.encode(id,agent));splitter=splitters[key];
        if(splitter==address(0)){splitter=address(new RevenueSplitter{salt:key}(platform,agent));splitters[key]=splitter;emit Created(key,splitter,agent);}
    }
    function predict(bytes32 id,address agent) external view returns(address){
        bytes32 key=keccak256(abi.encode(id,agent));
        bytes32 codeHash=keccak256(abi.encodePacked(type(RevenueSplitter).creationCode,abi.encode(platform,agent)));
        return address(uint160(uint256(keccak256(abi.encodePacked(bytes1(0xff),address(this),key,codeHash)))));
    }
}

/// Principal is not slashable in custodial v1. Operational quarantine lives in QSP.
contract AgentStake {
    uint256 public immutable unbondingSeconds;
    mapping(address=>uint256) public bonded;
    struct Exit {uint256 amount;uint256 unlockAt;}
    mapping(address=>Exit) public exits;
    event Deposited(address indexed agent,uint256 amount);
    event ExitRequested(address indexed agent,uint256 amount,uint256 unlockAt);
    event Withdrawn(address indexed agent,uint256 amount);
    constructor(uint256 delaySeconds){require(delaySeconds>0,"delay");unbondingSeconds=delaySeconds;}
    function deposit() external payable {require(msg.value>0&&exits[msg.sender].amount==0,"deposit");bonded[msg.sender]+=msg.value;emit Deposited(msg.sender,msg.value);}
    function requestExit() external {
        uint256 amount=bonded[msg.sender];require(amount>0&&exits[msg.sender].amount==0,"exit");bonded[msg.sender]=0;
        uint256 unlockAt=block.timestamp+unbondingSeconds;exits[msg.sender]=Exit(amount,unlockAt);emit ExitRequested(msg.sender,amount,unlockAt);
    }
    function withdraw() external {
        Exit memory e=exits[msg.sender];require(e.amount>0&&block.timestamp>=e.unlockAt,"locked");delete exits[msg.sender];
        (bool ok,)=payable(msg.sender).call{value:e.amount}("");require(ok,"transfer");emit Withdrawn(msg.sender,e.amount);
    }
}
