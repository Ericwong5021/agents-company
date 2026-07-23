export const companyProviderConfig = {
  provider: {
    "m1-test": {
      name: "M1 Test",
      npm: "@ai-sdk/openai-compatible",
      env: [],
      models: {
        "test-model": {
          name: "Test Model",
          tool_call: true,
          limit: { context: 8_000, output: 2_000 },
        },
      },
      options: { apiKey: "test-key" },
    },
    "m2-test": {
      name: "M2 Test",
      npm: "@ai-sdk/openai-compatible",
      env: [],
      models: {
        "test-model": {
          name: "Test Model",
          tool_call: true,
          limit: { context: 8_000, output: 2_000 },
        },
      },
      options: { apiKey: "test-key" },
    },
  },
}
