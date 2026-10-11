// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;
// Local test double for the documented Portal V6 ABI; not a bonding curve.
contract MockProcessor {address public marketAddress;address public taxToken;constructor(address m,address t){marketAddress=m;taxToken=t;}}
contract MockTaxToken {address public taxProcessor;function initialize(address beneficiary) external {require(taxProcessor==address(0));taxProcessor=address(new MockProcessor(beneficiary,address(this)));}function buyTaxRate() external pure returns(uint256){return 300;}function sellTaxRate() external pure returns(uint256){return 300;}}
contract MockFlap {
 address public immutable implementation;bool public wrongRecipient;function setWrongRecipient() external {wrongRecipient=true;}
 event TokenCreated(uint256 ts,address creator,uint256 nonce,address token,string name,string symbol,string meta);
 event VanityTokenCreated(address token,address creator,address beneficiary);
 constructor(address impl){implementation=impl;}
 struct Params {string name;string symbol;string meta;uint8 dexThresh;bytes32 salt;uint8 migratorType;address quoteToken;uint256 quoteAmt;address beneficiary;bytes permitData;bytes32 extensionID;bytes extensionData;uint8 dexId;uint8 lpFeeProfile;uint16 buyTaxRate;uint16 sellTaxRate;uint64 taxDuration;uint64 antiFarmerDuration;uint16 mktBps;uint16 deflationBps;uint16 dividendBps;uint16 lpBps;uint256 minimumShareBalance;address dividendToken;address commissionReceiver;uint8 tokenVersion;}
 function newTokenV6(Params calldata p) external payable returns(address token){
 require(p.buyTaxRate==300&&p.sellTaxRate==300&&p.tokenVersion==6&&p.migratorType==1&&p.beneficiary!=address(0),"params");
 bytes memory code=abi.encodePacked(hex"3d602d80600a3d3981f3363d3d373d3d3d363d73",implementation,hex"5af43d82803e903d91602b57fd5bf3");bytes32 salt=p.salt;
 assembly{token:=create2(0,add(code,32),mload(code),salt)}require(token!=address(0)&&uint16(uint160(token))==0x7777,"vanity");
 MockTaxToken(token).initialize(wrongRecipient?msg.sender:p.beneficiary);
 emit TokenCreated(block.timestamp,msg.sender,0,token,p.name,p.symbol,p.meta);emit VanityTokenCreated(token,msg.sender,p.beneficiary);
 }
}
