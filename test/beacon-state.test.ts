import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";
import {
  applyBeaconState,
  expireBeaconState,
  getWorld,
  loadFixture,
  resetFixture,
  type BeaconExpiryInput,
  type BeaconStateInput,
  type WorldState,
} from "../src/index.ts";

const VENUE = "seaside-market";
const EDGE = "edge-north-ramp";
const BOOT_A = "boot-a";
const BOOT_B = "boot-b";

function update(state: BeaconStateInput["state"], deviceSeq: number, bootId = BOOT_A): BeaconStateInput {
  return { venueId: VENUE, edgeId: EDGE, bootId, deviceSeq, state };
}

function expire(deviceSeq: number, bootId = BOOT_A): BeaconExpiryInput {
  return { venueId: VENUE, edgeId: EDGE, bootId, deviceSeq };
}

function ramp(world: WorldState) {
  const edge = world.edges.find((item) => item.edgeId === EDGE);
  assert.ok(edge);
  return edge;
}

describe("atlas beacon state seam", { concurrency: 1 }, () => {
  beforeEach(() => loadFixture());

  it("projects open, blocked, and unknown transitions, counting only projection changes", () => {
    let world = applyBeaconState(update("open", 1));
    assert.equal(ramp(world).obstructionState, "clear");
    assert.equal(ramp(world).evidence.freshness, "fresh");
    assert.equal(world.worldVersion.revision, 1);

    world = applyBeaconState(update("open", 2));
    assert.equal(world.worldVersion.revision, 1);
    world = applyBeaconState(update("blocked", 3));
    assert.equal(ramp(world).obstructionState, "blocked");
    assert.equal(ramp(world).evidence.freshness, "fresh");
    assert.equal(world.worldVersion.revision, 2);
    world = applyBeaconState(update("unknown", 4));
    assert.equal(ramp(world).obstructionState, "unknown");
    assert.equal(ramp(world).evidence.freshness, "missing");
    assert.equal(world.worldVersion.revision, 3);
  });

  it("ignores duplicate, older, and retired-boot updates while accepting a new boot", () => {
    applyBeaconState(update("blocked", 5));
    assert.equal(applyBeaconState(update("open", 5)).worldVersion.revision, 1);
    assert.equal(applyBeaconState(update("open", 4)).worldVersion.revision, 1);
    const newBoot = applyBeaconState(update("open", 1, BOOT_B));
    assert.equal(ramp(newBoot).obstructionState, "clear");
    assert.equal(newBoot.worldVersion.revision, 2);
    const delayed = applyBeaconState(update("blocked", 6, BOOT_A));
    assert.equal(ramp(delayed).obstructionState, "clear");
    assert.equal(delayed.worldVersion.revision, 2);
  });

  it("expires only the matching latest lease, then recovers on a newer sample", () => {
    applyBeaconState(update("blocked", 10));
    const staleExpiry = expireBeaconState(expire(9));
    assert.equal(ramp(staleExpiry).obstructionState, "blocked");
    assert.equal(staleExpiry.worldVersion.revision, 1);

    const expired = expireBeaconState(expire(10));
    assert.equal(ramp(expired).obstructionState, "unknown");
    assert.equal(ramp(expired).evidence.freshness, "missing");
    assert.equal(expired.worldVersion.revision, 2);
    assert.equal(expireBeaconState(expire(10)).worldVersion.revision, 2);

    const recovered = applyBeaconState(update("open", 11));
    assert.equal(ramp(recovered).obstructionState, "clear");
    assert.equal(ramp(recovered).evidence.freshness, "fresh");
    assert.equal(recovered.worldVersion.revision, 3);
  });

  it("clears beacon cursors and projected state on reset", () => {
    const initial = applyBeaconState(update("blocked", 7));
    assert.equal(initial.worldVersion.revision, 1);
    const reset = resetFixture(VENUE);
    assert.equal(reset.worldVersion.revision, 0);
    assert.equal(ramp(reset).obstructionState, "unknown");
    assert.equal(ramp(reset).evidence.freshness, "missing");
    const afterReset = applyBeaconState(update("open", 1, BOOT_A));
    assert.equal(afterReset.worldVersion.revision, 1);
    assert.equal(ramp(afterReset).obstructionState, "clear");
    assert.equal(getWorld(VENUE).worldVersion.worldEpoch, reset.worldVersion.worldEpoch);
  });

  it("validates input and requires a monitored edge", () => {
    assert.throws(() => applyBeaconState({ ...update("open", 1), deviceSeq: -1 }), /deviceSeq/);
    assert.throws(() => applyBeaconState({ ...update("open", 1), state: "clear" } as never), /state/);
    assert.throws(() => applyBeaconState({ ...update("open", 1), edgeId: "edge-east-path" }), /not monitored/);
  });
});
