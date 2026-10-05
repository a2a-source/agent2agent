import {
  constants,
  publicEncrypt,
  privateDecrypt,
  createPublicKey,
} from "node:crypto";
import { Wallet } from "ethers";
export interface EncryptedWallet {
  address: string;
  ciphertext: string;
  keyId: string;
}
export class WalletVault {
  constructor(
    private publicPem: string,
    private privatePem: string,
    readonly keyId: string,
  ) {
    const key = createPublicKey(publicPem);
    if (
      key.asymmetricKeyType !== "rsa" ||
      (key.asymmetricKeyDetails?.modulusLength ?? 0) < 2048
    )
      throw Error("RSA key must be >=2048 bits");
  }
  create(): EncryptedWallet {
    const w = Wallet.createRandom();
    const raw = Buffer.from(w.privateKey.slice(2), "hex");
    try {
      return {
        address: w.address,
        keyId: this.keyId,
        ciphertext: publicEncrypt(
          {
            key: this.publicPem,
            padding: constants.RSA_PKCS1_OAEP_PADDING,
            oaepHash: "sha256",
          },
          raw,
        ).toString("base64"),
      };
    } finally {
      raw.fill(0);
    }
  }
  withWallet<T>(record: EncryptedWallet, fn: (wallet: Wallet) => T): T {
    if (record.keyId !== this.keyId)
      throw Error("wallet key version unavailable");
    const raw = privateDecrypt(
      {
        key: this.privatePem,
        padding: constants.RSA_PKCS1_OAEP_PADDING,
        oaepHash: "sha256",
      },
      Buffer.from(record.ciphertext, "base64"),
    );
    try {
      const w = new Wallet("0x" + raw.toString("hex"));
      if (w.address !== record.address) throw Error("wallet integrity failure");
      return fn(w);
    } finally {
      raw.fill(0);
    }
  }
}
