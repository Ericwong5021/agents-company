import { createControlPlaneClient, createControlPlaneServer } from "@agents-company/sdk"
import { pathToFileURL } from "bun"

const server = await createControlPlaneServer()
const client = createControlPlaneClient({ baseUrl: server.url })

const input = await Array.fromAsync(new Bun.Glob("packages/core/*.ts").scan())

const tasks: Promise<void>[] = []
for await (const file of input) {
  console.log("processing", file)
  const session = await client.session.create()
  tasks.push(
    client.session.prompt({
      sessionID: session.data.id,
      parts: [
        {
          type: "file",
          mime: "text/plain",
          url: pathToFileURL(file).href,
        },
        {
          type: "text",
          text: `Write tests for every public function in this file.`,
        },
      ],
    }),
  )
  console.log("done", file)
}

await Promise.all(
  input.map(async (file) => {
    const session = await client.session.create()
    console.log("processing", file)
    await client.session.prompt({
      sessionID: session.data.id,
      parts: [
        {
          type: "file",
          mime: "text/plain",
          url: pathToFileURL(file).href,
        },
        {
          type: "text",
          text: `Write tests for every public function in this file.`,
        },
      ],
    })
    console.log("done", file)
  }),
)
