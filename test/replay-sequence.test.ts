import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";
import { applyObservation, getWorld, loadFixture, resetFixture, type Observation, type WorldState } from "../src/index.ts";

const VENUE = "seaside-market";
const BOOT_A = "00000000-0000-4000-8000-0000000000b1";
const BOOT_B = "00000000-0000-4000-8000-0000000000b2";

function observation(
  distanceMm: number,
  valid: boolean,
  deviceSeq: number,
  bootId: string,
  source: Observation["source"]["type"],
): Observation {
  return {
    schemaVersion: "1.0",
    eventId: "00000000-0000-4000-8000-0000000000e1",
    receivedAt: "2026-09-26T03:50:00Z",
    venueId: VENUE,
    kind: "obstruction.distance",
    source: {
      type: source,
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
  assert.ok(edge);
  return edge;
}

describe("replay and device sequence", { concurrency: 1 }, () => {
  beforeEach(() => {
    loadFixture();
  });

  it("ignores a duplicate or older deviceSeq on the same boot", () => {
    const blocked = applyObservation(observation(84, true, 2, BOOT_A, "sensor"));
    assert.equal(ramp(blocked).obstructionState, "blocked");
    assert.equal(blocked.worldVersion.revision, 1);

    const duplicate = applyObservation(observation(400, true, 2, BOOT_A, "sensor"));
    assert.equal(duplicate.worldVersion.revision, 1);
    assert.equal(ramp(duplicate).obstructionState, "blocked");

    const older = applyObservation(observation(400, true, 1, BOOT_A, "sensor"));
    assert.equal(older.worldVersion.revision, 1);
    assert.equal(ramp(older).obstructionState, "blocked");
    assert.equal(ramp(older).evidence.freshness, "fresh");
  });

  it("keeps an older deviceSeq ignored after another boot takes a turn", () => {
    applyObservation(observation(84, true, 2, BOOT_A, "sensor"));
    const other = applyObservation(observation(400, true, 1, BOOT_B, "simulator"));
    assert.equal(ramp(other).obstructionState, "clear");
    assert.equal(ramp(other).evidence.freshness, "fresh");
    assert.equal(other.worldVersion.revision, 2);

    const staleBoot = applyObservation(observation(84, true, 1, BOOT_A, "sensor"));
    assert.equal(staleBoot.worldVersion.revision, 2);
    assert.equal(ramp(staleBoot).obstructionState, "clear");

    const later = applyObservation(observation(84, true, 3, BOOT_A, "sensor"));
    assert.equal(later.worldVersion.revision, 3);
    assert.equal(ramp(later).obstructionState, "blocked");
    assert.equal(ramp(later).evidence.freshness, "fresh");
  });

  it("treats a new bootId as its own sequence", () => {
    applyObservation(observation(84, true, 5, BOOT_A, "sensor"));
    const rebooted = applyObservation(observation(400, true, 1, BOOT_B, "sensor"));
    assert.equal(rebooted.worldVersion.revision, 2);
    assert.equal(ramp(rebooted).obstructionState, "clear");
    assert.equal(ramp(rebooted).evidence.freshness, "fresh");
  });

  it("does not label a valid replay as a live sensor", () => {
    const replayed = applyObservation(observation(84, true, 1, BOOT_A, "replay"));
    assert.equal(ramp(replayed).obstructionState, "blocked");
    assert.equal(ramp(replayed).evidence.freshness, "missing");
    assert.notEqual(ramp(replayed).evidence.freshness, "fresh");

    const live = applyObservation(observation(400, true, 1, BOOT_B, "sensor"));
    assert.equal(ramp(live).obstructionState, "clear");
    assert.equal(ramp(live).evidence.freshness, "fresh");
  });

  it("does not let an invalid sample clear a blockage", () => {
    applyObservation(observation(84, true, 1, BOOT_A, "sensor"));
    const invalid = applyObservation(observation(400, false, 2, BOOT_A, "replay"));
    assert.equal(ramp(invalid).obstructionState, "blocked");
    assert.notEqual(ramp(invalid).obstructionState, "clear");
    assert.equal(ramp(invalid).evidence.freshness, "invalid");
    assert.equal(invalid.worldVersion.revision, 2);
  });

  it("lets a reset accept deviceSeq 1 on the same boot again", () => {
    applyObservation(observation(84, true, 1, BOOT_A, "sensor"));
    const reset = resetFixture(VENUE);
    assert.equal(ramp(reset).obstructionState, "unknown");
    assert.equal(ramp(reset).evidence.freshness, "missing");
    const again = applyObservation(observation(400, true, 1, BOOT_A, "simulator"));
    assert.equal(again.worldVersion.revision, 1);
    assert.equal(ramp(again).obstructionState, "clear");
    assert.equal(ramp(again).evidence.freshness, "fresh");
    assert.equal(getWorld(VENUE).worldVersion.worldEpoch, reset.worldVersion.worldEpoch);
  });
});
