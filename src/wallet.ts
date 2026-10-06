import {
  constants,
  publicEncrypt,
  privateDecrypt,
  createPublicKey,
  createPrivateKey,
} from "node:crypto";
import { Wallet, verifyMessage } from "ethers";
export interface EncryptedWallet {
  address: string;
  ciphertext: string;
  keyId: string;
}
export interface WalletKey {
  id: string;
  publicPem: string;
  privatePem: string;
}
export class WalletVault {
  readonly keyId: string;
  private readonly keys = new Map<string, WalletKey>();
  constructor(publicPem: string, privatePem: string, keyId: string);
  constructor(keys: WalletKey[], activeKeyId: string);
  constructor(
    input: string | WalletKey[],
    privateOrActive: string,
    legacyId?: string,
  ) {
    const keys =
      typeof input === "string"
        ? [{ id: legacyId!, publicPem: input, privatePem: privateOrActive }]
        : input;
    this.keyId = typeof input === "string" ? legacyId! : privateOrActive;
    for (const entry of keys) {
      if (!entry.id || this.keys.has(entry.id))
        throw Error("duplicate or empty wallet key ID");
      const pub = createPublicKey(entry.publicPem),
        priv = createPrivateKey(entry.privatePem);
      if (
        pub.asymmetricKeyType !== "rsa" ||
        priv.asymmetricKeyType !== "rsa" ||
        (pub.asymmetricKeyDetails?.modulusLength ?? 0) < 2048 ||
        (priv.asymmetricKeyDetails?.modulusLength ?? 0) < 2048
      )
        throw Error("RSA key must be >=2048 bits");
      if (
        !pub
          .export({ type: "spki", format: "der" })
          .equals(createPublicKey(priv).export({ type: "spki", format: "der" }))
      )
        throw Error("RSA public/private keys do not match");
      this.keys.set(entry.id, { ...entry });
    }
    if (!this.keys.has(this.keyId))
      throw Error("active wallet key version unavailable");
  }
  private encrypt(raw: Buffer, address: string): EncryptedWallet {
    return {
      address,
      keyId: this.keyId,
      ciphertext: publicEncrypt(
        {
          key: this.keys.get(this.keyId)!.publicPem,
          padding: constants.RSA_PKCS1_OAEP_PADDING,
          oaepHash: "sha256",
        },
        raw,
      ).toString("base64"),
    };
  }
  create(): EncryptedWallet {
    const w = Wallet.createRandom(),
      raw = Buffer.from(w.privateKey.slice(2), "hex");
    try {
      return this.encrypt(raw, w.address);
    } finally {
      raw.fill(0);
    }
  }
  withWallet<T>(record: EncryptedWallet, fn: (wallet: Wallet) => T): T {
    const key = this.keys.get(record.keyId);
    if (!key) throw Error("wallet key version unavailable");
    const raw = privateDecrypt(
      {
        key: key.privatePem,
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
  reencrypt(record: EncryptedWallet): EncryptedWallet {
    return this.withWallet(record, (w) => {
      const raw = Buffer.from(w.privateKey.slice(2), "hex");
      try {
        const next = this.encrypt(raw, w.address);
        this.withWallet(next, () => undefined);
        return next;
      } finally {
        raw.fill(0);
      }
    });
  }
  async verify(record: EncryptedWallet): Promise<void> {
    const challenge =
      "a2a wallet integrity " + record.keyId + " " + record.address;
    const signature = await this.withWallet(record, (w) =>
      w.signMessage(challenge),
    );
    if (verifyMessage(challenge, signature) !== record.address)
      throw Error("wallet signature integrity failure");
  }
}
