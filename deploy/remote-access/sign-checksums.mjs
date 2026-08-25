import { createPrivateKey, createPublicKey, sign } from "node:crypto"
import { chmod, readFile, writeFile } from "node:fs/promises"
import { join, resolve } from "node:path"

const output = resolve(process.argv[2] || "release")
const privatePem = process.env.AGENT_COMPANY_UPDATE_PRIVATE_KEY?.replace(/\\n/g, "\n")
if (!privatePem) throw new Error("update_private_key_required")

const privateKey = createPrivateKey(privatePem)
const publicKey = createPublicKey(privateKey).export({ type: "spki", format: "pem" })
const pinnedPublicKey = await readFile(resolve("deploy/remote-access/update-public-key.pem"), "utf8")
if (publicKey.trim() !== pinnedPublicKey.trim()) throw new Error("update_public_key_mismatch")

const checksums = await readFile(join(output, "checksums.txt"))
await writeFile(join(output, "checksums.sig"), `${sign(null, checksums, privateKey).toString("base64")}\n`, { mode: 0o644 })
await writeFile(join(output, "update-public-key.pem"), pinnedPublicKey, { mode: 0o644 })
await chmod(join(output, "checksums.sig"), 0o644)
await chmod(join(output, "update-public-key.pem"), 0o644)
