import { describe, expect, test } from "bun:test"
import path from "node:path"
import {
  B5ScenarioIds,
  B5ScenarioPlan,
  B5StrategyOrder,
  b5SeedPolicy,
  exactB5RunBindings,
  loadB5ScenarioSnapshots,
  requiredB5ObservationTypes,
} from "../../src/metrics/b5-candidate-scenarios"
import { evaluateSeedPolicy } from "../../src/project-orchestrator/seed-policy"
import {
  B5CandidateAttemptSummary,
  parseB5ProducerArguments,
} from "../../script/produce-seed-grow-candidate-facts"

const benchmarkPath = path.resolve(
  import.meta.dir,
  "../../../../docs/product-design/experience-refactor/seed-grow-benchmark-scenarios.v1.json",
)
const snapshots = loadB5ScenarioSnapshots(JSON.parse(await Bun.file(benchmarkPath).text()) as unknown)

describe("B5 candidate scenarios", () => {
  test("loads the fixed S13-S27 benchmark sequence without a uniform fixture driver", () => {
    expect(snapshots.map((snapshot) => snapshot.scenario.id)).toEqual([...B5ScenarioIds])
    expect(new Set(snapshots.map((snapshot) => snapshot.snapshotDigest)).size).toBe(15)
    expect(B5ScenarioPlan.map((scenario) => scenario.id)).toEqual([...B5ScenarioIds])
    expect(new Set(B5ScenarioPlan.map((scenario) => scenario.driverId)).size).toBe(15)
    expect(new Set(B5ScenarioPlan.map((scenario) => scenario.oracleKey)).size).toBe(15)
  })

  test("normalizes exactly 30 bindings in scenario then legacy-seed order", () => {
    const unordered = snapshots
      .flatMap((snapshot) =>
        B5StrategyOrder.map((strategy) => ({
          projectId: `${snapshot.scenario.id}-${strategy}`,
          scenarioId: snapshot.scenario.id,
          runId: `run-${snapshot.scenario.id}-${strategy}`,
          strategy,
          snapshotDigest: snapshot.snapshotDigest,
        })),
      )
      .toReversed()
    const bindings = exactB5RunBindings(unordered)
    expect(bindings).toHaveLength(30)
    expect(
      bindings.map((binding) => `${binding.scenarioId}:${binding.strategy}`),
    ).toEqual(
      B5ScenarioIds.flatMap((scenarioId) =>
        B5StrategyOrder.map((strategy) => `${scenarioId}:${strategy}`),
      ),
    )
    expect(() => exactB5RunBindings(bindings.slice(1))).toThrow("exactly 30")
    expect(() => exactB5RunBindings([...bindings.slice(0, 29), bindings[0]!])).toThrow(
      "exactly 30",
    )
  })

  test("uses the real policy modes for S13 and S15", () => {
    expect(evaluateSeedPolicy(b5SeedPolicy(snapshots.find((item) => item.scenario.id === "S13")!.scenario)).mode)
      .toBe("seed_pair")
    expect(evaluateSeedPolicy(b5SeedPolicy(snapshots.find((item) => item.scenario.id === "S15")!.scenario)).mode)
      .toBe("discovery_first")
  })

  test("requires scenario-specific checked oracles for S15 S22 and S24", () => {
    expect(requiredB5ObservationTypes("S15", "seed_and_grow")).toContain("approval_gate.checked")
    expect(requiredB5ObservationTypes("S15", "seed_and_grow")).not.toContain("validation_anchor.checked")
    expect(requiredB5ObservationTypes("S22", "seed_and_grow")).toContain("repair.circuit_checked")
    expect(requiredB5ObservationTypes("S24", "seed_and_grow")).toContain("quiescence.checked")
    expect(requiredB5ObservationTypes("S24", "seed_and_grow")).not.toContain("delivery.checked")
  })

  test("pins the B5 producer CLI and six top-level artifact names", () => {
    expect(
      parseB5ProducerArguments([
        "--candidate-sha",
        "a".repeat(40),
        "--attempt-id",
        "attempt-01",
        "--out",
        "/tmp/b5-attempt-01",
      ]),
    ).toEqual({
      candidateSha: "a".repeat(40),
      attemptId: "attempt-01",
      outputDirectory: "/tmp/b5-attempt-01",
    })
    expect(() =>
      parseB5ProducerArguments([
        "--candidate-sha",
        "a".repeat(40),
        "--attempt-id",
        "attempt-03",
        "--out",
        "/tmp/b5-attempt-03",
      ]),
    ).toThrow()
    expect(B5CandidateAttemptSummary.keyof().options).toContain("files")
    expect(
      parseB5ProducerArguments([
        "--candidate-sha",
        "HEAD",
        "--attempt-id",
        "automatic",
        "--out",
        ".artifacts/seed-grow-b5/real-candidate-facts",
      ]),
    ).toEqual({
      candidateSha: "HEAD",
      attemptId: "automatic",
      outputDirectory: path.resolve(
        ".artifacts/seed-grow-b5/real-candidate-facts",
      ),
    })
  })
})
