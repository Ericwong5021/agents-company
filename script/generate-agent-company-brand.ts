#!/usr/bin/env bun

import { appBuilderPath } from "app-builder-bin"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import sharp from "sharp"

const root = path.resolve(import.meta.dir, "..")
const check = process.argv.includes("--check")
const desktop = process.argv.includes("--desktop")
const canonical = path.join(root, "packages/app/public/agent-company-mark.svg")

const browser = [
  { name: "agent-company-icon-180.png", size: 180 },
  { name: "agent-company-icon-192.png", size: 192 },
  { name: "agent-company-icon-512.png", size: 512 },
]
const desktopPng = [
  { name: "32x32.png", size: 32 },
  { name: "64x64.png", size: 64 },
  { name: "128x128.png", size: 128 },
  { name: "256x256.png", size: 256 },
  { name: "512x512.png", size: 512 },
  { name: "icon.png", size: 512 },
  { name: "dock.png", size: 512 },
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

async function icon(format: "icns" | "ico", input: string, output: string) {
  const child = Bun.spawn([appBuilderPath, "icon", "--input", input, "--format", format, "--out", path.dirname(output)], {
    stdout: "inherit",
    stderr: "inherit",
  })
  if ((await child.exited) !== 0) throw new Error(`Unable to generate ${format} icon`)
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

  if (desktop) {
    const iconset = path.join(temp, "agent-company")
    await fs.mkdir(iconset, { recursive: true })
    await Bun.write(path.join(iconset, "source.svg"), svg)
    await Promise.all(desktopPng.map((asset) => writePng(svg, path.join(iconset, asset.name), asset.size)))
    await icon("icns", path.join(iconset, "icon.png"), path.join(iconset, "icon.icns"))
    await icon("ico", path.join(iconset, "icon.png"), path.join(iconset, "icon.ico"))
    await Promise.all(
      ["source.svg", ...desktopPng.map((asset) => asset.name), "icon.icns", "icon.ico"].map((name) =>
        publish(path.join(iconset, name), path.join(root, "packages/desktop/icons/agent-company", name)),
      ),
    )
  }
} finally {
  await fs.rm(temp, { recursive: true, force: true })
}
