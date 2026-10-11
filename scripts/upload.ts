import { readFileSync } from "node:fs";
import { basename } from "node:path";
import { uploadMetadata } from "../src/flap.js";
import { configureProxy } from "../src/network.js";
configureProxy();
const [image, description] = process.argv.slice(2);
if (!image)
  throw Error('Usage: npm run metadata:upload -- image.png "description"');
const cid = await uploadMetadata(readFileSync(image), basename(image), {
  description: description ?? "",
  creator: "0x0000000000000000000000000000000000000000",
  website: null,
  twitter: null,
  telegram: null,
});
console.log(cid);
