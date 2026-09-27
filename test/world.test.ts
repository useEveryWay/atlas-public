import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";
import {
  applyObservation,
  getGraph,
  getWorld,
  loadFixture,
  resetFixture,
  type Observation,
  type WorldState,
} from "../src/index.ts";

const VENUE = "seaside-market";
const EPOCH = "00000000-0000-4000-8000-000000000001";
const GRAPH = "seaside-market-v1";
const BOOT = "00000000-0000-4000-8000-0000000000b1";
const OTHER_BOOT = "00000000-0000-4000-8000-0000000000b2";
const EDGE_IDS = [
  "edge-start-plaza",
  "edge-north-ramp",
  "edge-north-market",
  "edge-east-path",
  "edge-east-market",
  "edge-stair-shortcut",
];

function observation(
  distanceMm: number,
  valid: boolean,
  deviceSeq: number,
  bootId = BOOT,
): Observation {
  return {
    schemaVersion: "1.0",
    eventId: "00000000-0000-4000-8000-0000000000e1",
    receivedAt: "2026-09-26T03:50:00Z",
    venueId: VENUE,
    kind: "obstruction.distance",
    source: {
      type: "simulator",
      deviceId: "beacon-north-ramp",
      bootId,
      deviceSeq,
    },
    location: { edgeId: "edge-north-ramp" },
    value: { distanceMm, valid },
  };
}

function ramp(world: WorldState) {
  const edge = world.edges.find((item) => item.edgeId === "edge-north-ramp");
  assert.ok(edge, "missing edge-north-ramp");
  return edge;
}

describe("atlas seaside market", { concurrency: 1 }, () => {
  beforeEach(() => {
    loadFixture();
  });

  it("starts unknown on the loaded fixture", () => {
    const world = getWorld(VENUE);
    const graph = getGraph(VENUE);
    assert.equal(world.schemaVersion, "1.0");
    assert.equal(world.venueId, VENUE);
    assert.deepEqual(world.worldVersion, {
      worldEpoch: EPOCH,
      graphVersion: GRAPH,
      revision: 0,
    });
    assert.deepEqual(
      world.edges.map((edge) => edge.edgeId),
      EDGE_IDS,
    );
    assert.ok(
      world.edges.every(
        (edge) => edge.obstructionState === "unknown" && edge.evidence.freshness === "missing",
      ),
    );
    assert.equal(ramp(world).monitored, true);
    assert.ok(
      world.edges
        .filter((edge) => edge.edgeId !== "edge-north-ramp")
        .every((edge) => edge.monitored === false),
    );
    assert.equal(graph.graphVersion, GRAPH);
    assert.equal(graph.worldEpoch, EPOCH);
    assert.equal(graph.revision, 0);
    assert.deepEqual(
      graph.edges.map((edge) => edge.edgeId),
      EDGE_IDS,
    );
    const north = graph.edges.find((edge) => edge.edgeId === "edge-north-ramp");
    assert.ok(north);
    assert.equal(north.distanceM, 12);
    assert.equal(north.monitored, true);
    assert.equal(north.obstructionState, "unknown");
    assert.throws(() => getWorld("other-venue"), /Unknown venue: other-venue/);
  });

  it("projects a valid distance above 150 mm to clear", () => {
    const world = applyObservation(observation(400, true, 1));
    assert.equal(ramp(world).obstructionState, "clear");
    assert.equal(ramp(world).evidence.freshness, "fresh");
    assert.equal(world.worldVersion.revision, 1);
    assert.equal(world.worldVersion.graphVersion, GRAPH);
    assert.equal(world.worldVersion.worldEpoch, EPOCH);
    assert.ok(
      world.edges
        .filter((edge) => edge.edgeId !== "edge-north-ramp")
        .every((edge) => edge.obstructionState === "unknown"),
    );

    loadFixture();
    const aboveCutoff = applyObservation(observation(151, true, 1));
    assert.equal(ramp(aboveCutoff).obstructionState, "clear");
  });

  it("projects a valid distance at or below 150 mm to blocked", () => {
    const sample = applyObservation(observation(84, true, 1));
    assert.equal(ramp(sample).obstructionState, "blocked");
    assert.equal(ramp(sample).evidence.freshness, "fresh");
    assert.equal(sample.worldVersion.graphVersion, GRAPH);

    loadFixture();
    const cutoff = applyObservation(observation(150, true, 1));
    assert.equal(ramp(cutoff).obstructionState, "blocked");
    assert.equal(ramp(cutoff).evidence.freshness, "fresh");
  });

  it("increments revision only when a reading is applied", () => {
    assert.equal(getWorld(VENUE).worldVersion.revision, 0);
    const clear = applyObservation(observation(400, true, 1));
    assert.equal(clear.worldVersion.revision, 1);
    assert.equal(ramp(clear).obstructionState, "clear");

    const duplicate = applyObservation(observation(400, true, 1));
    assert.equal(duplicate.worldVersion.revision, 1);
    assert.equal(ramp(duplicate).obstructionState, "clear");

    const blocked = applyObservation(observation(84, true, 2));
    assert.equal(blocked.worldVersion.revision, 2);
    assert.equal(ramp(blocked).obstructionState, "blocked");

    const stale = applyObservation(observation(400, true, 1));
    assert.equal(stale.worldVersion.revision, 2);
    assert.equal(ramp(stale).obstructionState, "blocked");
    assert.equal(stale.worldVersion.graphVersion, GRAPH);
    assert.equal(stale.worldVersion.worldEpoch, EPOCH);
  });

  it("does not turn unknown, invalid, or conflicting evidence into clear", () => {
    const invalid = applyObservation(observation(400, false, 1));
    assert.equal(ramp(invalid).obstructionState, "unknown");
    assert.notEqual(ramp(invalid).obstructionState, "clear");
    assert.equal(ramp(invalid).evidence.freshness, "invalid");
    assert.equal(invalid.worldVersion.revision, 1);

    loadFixture();
    applyObservation(observation(400, true, 1));
    const conflict = applyObservation(observation(400, false, 1, OTHER_BOOT));
    assert.equal(ramp(conflict).obstructionState, "unknown");
    assert.notEqual(ramp(conflict).obstructionState, "clear");
    assert.equal(ramp(conflict).evidence.freshness, "invalid");
    assert.equal(getGraph(VENUE).graphVersion, GRAPH);
  });

  it("reset clears applied sample identity and does not write clear", () => {
    const scripted = observation(400, true, 1, BOOT);
    const first = applyObservation(scripted);
    assert.equal(first.worldVersion.revision, 1);
    assert.equal(ramp(first).obstructionState, "clear");

    const duplicate = applyObservation(scripted);
    assert.equal(duplicate.worldVersion.revision, 1);
    assert.equal(ramp(duplicate).obstructionState, "clear");

    const later = applyObservation(observation(84, true, 2));
    assert.equal(later.worldVersion.revision, 2);
    assert.equal(ramp(later).obstructionState, "blocked");

    const reset = resetFixture(VENUE);
    assert.notEqual(reset.worldVersion.worldEpoch, first.worldVersion.worldEpoch);
    assert.match(
      reset.worldVersion.worldEpoch,
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
    assert.equal(reset.worldVersion.graphVersion, GRAPH);
    assert.equal(reset.worldVersion.revision, 0);
    assert.equal(ramp(reset).obstructionState, "unknown");
    assert.equal(ramp(reset).evidence.freshness, "missing");
    assert.notEqual(ramp(reset).obstructionState, "clear");
    assert.ok(
      reset.edges.every(
        (edge) => edge.obstructionState === "unknown" && edge.evidence.freshness === "missing",
      ),
    );
    assert.equal(getGraph(VENUE).graphVersion, GRAPH);
    assert.equal(getGraph(VENUE).worldEpoch, reset.worldVersion.worldEpoch);
    assert.equal(getGraph(VENUE).revision, 0);

    const appliedAgain = applyObservation(scripted);
    assert.equal(appliedAgain.worldVersion.revision, 1);
    assert.equal(ramp(appliedAgain).obstructionState, "clear");
    assert.equal(ramp(appliedAgain).evidence.freshness, "fresh");
    assert.equal(appliedAgain.worldVersion.worldEpoch, reset.worldVersion.worldEpoch);
    assert.equal(appliedAgain.worldVersion.graphVersion, GRAPH);
  });

  it("follows the frozen projection sequence", () => {
    const first = applyObservation(observation(400, true, 1));
    assert.equal(ramp(first).obstructionState, "clear");
    assert.equal(ramp(first).evidence.freshness, "fresh");
    assert.equal(first.worldVersion.revision, 1);

    const duplicate = applyObservation(observation(400, true, 1));
    assert.equal(ramp(duplicate).obstructionState, "clear");
    assert.equal(duplicate.worldVersion.revision, 1);

    const blocked = applyObservation(observation(84, true, 2));
    assert.equal(ramp(blocked).obstructionState, "blocked");
    assert.equal(ramp(blocked).evidence.freshness, "fresh");
    assert.equal(blocked.worldVersion.revision, 2);

    const older = applyObservation(observation(400, true, 1));
    assert.equal(ramp(older).obstructionState, "blocked");
    assert.equal(older.worldVersion.revision, 2);

    const invalid = applyObservation(observation(10, false, 3));
    assert.equal(ramp(invalid).obstructionState, "blocked");
    assert.notEqual(ramp(invalid).obstructionState, "clear");
    assert.equal(ramp(invalid).evidence.freshness, "invalid");
    assert.equal(invalid.worldVersion.revision, 3);

    const rebooted = applyObservation(observation(400, true, 1, OTHER_BOOT));
    assert.equal(ramp(rebooted).obstructionState, "clear");
    assert.equal(ramp(rebooted).evidence.freshness, "fresh");
    assert.equal(rebooted.worldVersion.revision, 4);
    assert.equal(rebooted.worldVersion.graphVersion, GRAPH);
  });
});
