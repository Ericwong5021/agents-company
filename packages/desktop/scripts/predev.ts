import { $ } from "bun"

await $`bun ./scripts/copy-icons.ts`

await $`cd ../control-plane && bun script/build-node.ts`
