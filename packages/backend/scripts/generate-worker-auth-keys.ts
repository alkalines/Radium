import { exportJWK, generateKeyPair } from "jose";

const { privateKey, publicKey } = await generateKeyPair("ES256", { extractable: true });
const kid = crypto.randomUUID();

console.log("Private Key: ", JSON.stringify({ ...(await exportJWK(privateKey)), kid, alg: "ES256" }))
console.log("Public Key: ", JSON.stringify({ keys: [{ ...(await exportJWK(publicKey)), kid, alg: "ES256", use: "sig" }] }))