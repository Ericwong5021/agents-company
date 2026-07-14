import { $ } from "bun"
const src = "./icons/agent-company"
const dest = "resources/icons"

await $`rm -rf ${dest}`
await $`cp -R ${src} ${dest}`
console.log(`Copied Agent Company icons from ${src} to ${dest}`)
