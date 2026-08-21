#!/usr/bin/env bun

import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import sharp from "sharp"

const root = path.resolve(import.meta.dir, "..")
const check = process.argv.includes("--check")
const canonical = path.join(root, "packages/app/public/agent-company-mark.svg")

const browser = [
  { name: "agent-company-icon-180.png", size: 180 },
  { name: "agent-company-icon-192.png", size: 192 },
  { name: "agent-company-icon-512.png", size: 512 },
]
async function writePng(source: Buffer, file: string, size: number) {
  await sharp(source).resize(size, size).png().toFile(file)
}

async function same(left: string, right: string) {
  const [a, b] = await Promise.all([Bun.file(left).arrayBuffer(), Bun.file(right).arrayBuffer()])
  return Buffer.from(a).equals(Buffer.from(b))
}

async function publish(source: string, target: string) {
  if (check) {
    if (!(await Bun.file(target).exists())) throw new Error(`Missing generated asset: ${path.relative(root, target)}`)
    if (await same(source, target)) return
    throw new Error(`Generated asset is stale: ${path.relative(root, target)}`)
  }
  await fs.mkdir(path.dirname(target), { recursive: true })
  await Bun.write(target, Bun.file(source))
}

const temp = await fs.mkdtemp(path.join(os.tmpdir(), "agent-company-brand-"))
try {
  const svg = Buffer.from(await Bun.file(canonical).arrayBuffer())
  await Promise.all(
    browser.map(async (asset) => {
      const generated = path.join(temp, asset.name)
      await writePng(svg, generated, asset.size)
      await publish(generated, path.join(root, "packages/app/public", asset.name))
    }),
  )
} finally {
  await fs.rm(temp, { recursive: true, force: true })
}
