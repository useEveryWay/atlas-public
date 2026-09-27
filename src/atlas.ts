import { randomUUID } from "node:crypto";
import {
  readVenueFixture,
  type Freshness,
  type ObstructionState,
  type VenueFixture,
} from "./fixture.ts";

export type Observation = {
  schemaVersion: "1.0";
  eventId: string;
  receivedAt: string;
  venueId: string;
  kind: "obstruction.distance";
  source: {
    type: "sensor" | "simulator" | "replay";
    deviceId: string;
    bootId: string;
    deviceSeq: number;
  };
  location: {
    edgeId: string;
  };
  value: {
    distanceMm: number;
    valid: boolean;
  };
};

export type WorldEdge = {
  edgeId: string;
  monitored: boolean;
  obstructionState: ObstructionState;
  crowdIndex: number;
  noiseIndex: number;
  evidence: {
    freshness: Freshness;
  };
};

export type WorldState = {
  schemaVersion: "1.0";
  venueId: string;
  worldVersion: {
    worldEpoch: string;
    graphVersion: string;
    revision: number;
  };
  edges: WorldEdge[];
};

export type Venue = VenueFixture;

type TrackedEdge = {
  edgeId: string;
  monitored: boolean;
  obstructionState: ObstructionState;
  crowdIndex: number;
  noiseIndex: number;
  freshness: Freshness;
  bootId: string | null;
  highSeq: number | null;
  /** Highest applied deviceSeq for each boot. A boot keeps its own sequence. */
  bootHigh: Map<string, number>;
  applied: Set<string>;
  beaconBootId: string | null;
  beaconHighSeq: number | null;
  retiredBeaconBootIds: string[];
};

export type BeaconStateInput = {
  venueId: string;
  edgeId: string;
  bootId: string;
  deviceSeq: number;
  state: "open" | "blocked" | "unknown";
};

export type BeaconExpiryInput = {
  venueId: string;
  edgeId: string;
  bootId: string;
  deviceSeq: number;
};

const MAX_RETIRED_BEACON_BOOTS = 32;

type LiveVenue = {
  fixture: VenueFixture;
  worldEpoch: string;
  revision: number;
  edges: TrackedEdge[];
};

const venues = new Map<string, LiveVenue>();

function trackedFromFixture(fixture: VenueFixture): TrackedEdge[] {
  return fixture.edges.map((edge) => ({
    edgeId: edge.edgeId,
    monitored: edge.monitored,
    obstructionState: edge.obstructionState,
    crowdIndex: edge.crowdIndex,
    noiseIndex: edge.noiseIndex,
    freshness: edge.evidence.freshness,
    bootId: null,
    highSeq: null,
    bootHigh: new Map<string, number>(),
    applied: new Set<string>(),
    beaconBootId: null,
    beaconHighSeq: null,
    retiredBeaconBootIds: [],
  }));
}

function liveFromFixture(fixture: VenueFixture): LiveVenue {
  return {
    fixture,
    worldEpoch: fixture.worldEpoch,
    revision: fixture.revision,
    edges: trackedFromFixture(fixture),
  };
}

function requireVenue(venueId: string): LiveVenue {
  const live = venues.get(venueId);
  if (!live) {
    throw new Error(`Unknown venue: ${venueId}`);
  }
  return live;
}

function snapshot(live: LiveVenue): WorldState {
  return {
    schemaVersion: "1.0",
    venueId: live.fixture.venueId,
    worldVersion: {
      worldEpoch: live.worldEpoch,
      graphVersion: live.fixture.graphVersion,
      revision: live.revision,
    },
    edges: live.edges.map((edge) => ({
      edgeId: edge.edgeId,
      monitored: edge.monitored,
      obstructionState: edge.obstructionState,
      crowdIndex: edge.crowdIndex,
      noiseIndex: edge.noiseIndex,
      evidence: { freshness: edge.freshness },
    })),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function assertBeaconCursor(value: unknown, withState: boolean): BeaconStateInput | BeaconExpiryInput {
  if (!isRecord(value)) throw new TypeError("beacon input must be an object");
  for (const key of ["venueId", "edgeId", "bootId"] as const) {
    if (typeof value[key] !== "string" || value[key].length === 0) {
      throw new TypeError(`beacon ${key} is missing`);
    }
  }
  if (!Number.isSafeInteger(value.deviceSeq) || (value.deviceSeq as number) < 0) {
    throw new TypeError("beacon deviceSeq must be a safe integer >= 0");
  }
  if (withState && value.state !== "open" && value.state !== "blocked" && value.state !== "unknown") {
    throw new TypeError("beacon state must be open, blocked, or unknown");
  }
  return value as unknown as BeaconStateInput | BeaconExpiryInput;
}

function monitoredEdge(live: LiveVenue, edgeId: string): TrackedEdge {
  const edge = live.edges.find((item) => item.edgeId === edgeId);
  if (!edge || !edge.monitored) throw new Error(`Beacon edge is not monitored: ${edgeId}`);
  return edge;
}

function projectBeaconState(edge: TrackedEdge, state: BeaconStateInput["state"]): boolean {
  const obstructionState: ObstructionState = state === "open" ? "clear" : state;
  const freshness: Freshness = state === "unknown" ? "missing" : "fresh";
  const changed = edge.obstructionState !== obstructionState || edge.freshness !== freshness;
  edge.obstructionState = obstructionState;
  edge.freshness = freshness;
  return changed;
}

function retireBeaconBoot(edge: TrackedEdge, bootId: string): void {
  if (edge.retiredBeaconBootIds.includes(bootId)) return;
  edge.retiredBeaconBootIds.push(bootId);
  if (edge.retiredBeaconBootIds.length > MAX_RETIRED_BEACON_BOOTS) {
    edge.retiredBeaconBootIds.shift();
  }
}

export function applyBeaconState(value: BeaconStateInput): WorldState {
  const input = assertBeaconCursor(value, true) as BeaconStateInput;
  const live = requireVenue(input.venueId);
  const edge = monitoredEdge(live, input.edgeId);
  if (edge.retiredBeaconBootIds.includes(input.bootId)) return snapshot(live);
  if (edge.beaconBootId === input.bootId) {
    if (edge.beaconHighSeq !== null && input.deviceSeq <= edge.beaconHighSeq) return snapshot(live);
  } else {
    if (edge.beaconBootId !== null) retireBeaconBoot(edge, edge.beaconBootId);
    edge.beaconBootId = input.bootId;
  }
  edge.beaconHighSeq = input.deviceSeq;
  if (projectBeaconState(edge, input.state)) live.revision += 1;
  return snapshot(live);
}

export function expireBeaconState(value: BeaconExpiryInput): WorldState {
  const input = assertBeaconCursor(value, false) as BeaconExpiryInput;
  const live = requireVenue(input.venueId);
  const edge = monitoredEdge(live, input.edgeId);
  if (edge.beaconBootId === input.bootId && edge.beaconHighSeq === input.deviceSeq) {
    if (projectBeaconState(edge, "unknown")) live.revision += 1;
  }
  return snapshot(live);
}

function assertObservation(value: unknown): Observation {
  if (!isRecord(value)) {
    throw new TypeError("observation must be an object");
  }
  if (value.schemaVersion !== "1.0" || value.kind !== "obstruction.distance") {
    throw new TypeError("observation schemaVersion and kind are not obstruction.distance 1.0");
  }
  if (typeof value.eventId !== "string" || value.eventId.length === 0) {
    throw new TypeError("observation eventId is missing");
  }
  if (typeof value.receivedAt !== "string" || value.receivedAt.length === 0) {
    throw new TypeError("observation receivedAt is missing");
  }
  if (typeof value.venueId !== "string" || value.venueId.length === 0) {
    throw new TypeError("observation venueId is missing");
  }
  if (!isRecord(value.source) || !isRecord(value.location) || !isRecord(value.value)) {
    throw new TypeError("observation source, location, and value are required");
  }
  const sourceType = value.source.type;
  if (sourceType !== "sensor" && sourceType !== "simulator" && sourceType !== "replay") {
    throw new TypeError("observation source.type is not sensor, simulator, or replay");
  }
  if (typeof value.source.deviceId !== "string" || value.source.deviceId.length === 0) {
    throw new TypeError("observation source.deviceId is missing");
  }
  if (typeof value.source.bootId !== "string" || value.source.bootId.length === 0) {
    throw new TypeError("observation source.bootId is missing");
  }
  if (!Number.isInteger(value.source.deviceSeq) || (value.source.deviceSeq as number) < 0) {
    throw new TypeError("observation source.deviceSeq must be an integer >= 0");
  }
  if (typeof value.location.edgeId !== "string" || value.location.edgeId.length === 0) {
    throw new TypeError("observation location.edgeId is missing");
  }
  const distanceMm = value.value.distanceMm;
  if (typeof distanceMm !== "number" || !Number.isFinite(distanceMm) || distanceMm < 0) {
    throw new TypeError("observation value.distanceMm must be a finite number >= 0");
  }
  if (typeof value.value.valid !== "boolean") {
    throw new TypeError("observation value.valid must be a boolean");
  }
  return value as Observation;
}

function applyToEdge(edge: TrackedEdge, observation: Observation, cutoff: number): boolean {
  const { bootId, deviceSeq, type } = observation.source;
  const identity = `${bootId}:${deviceSeq}`;
  if (edge.applied.has(identity)) {
    return false;
  }
  const seen = edge.bootHigh.get(bootId);
  if (seen !== undefined && deviceSeq <= seen) {
    return false;
  }
  if (edge.bootId !== null && edge.bootId !== bootId) {
    edge.obstructionState = "unknown";
    edge.freshness = "missing";
  }
  edge.bootId = bootId;
  edge.highSeq = deviceSeq;
  edge.bootHigh.set(bootId, deviceSeq);
  edge.applied.add(identity);
  if (observation.value.valid !== true) {
    edge.freshness = "invalid";
    return true;
  }
  edge.obstructionState = observation.value.distanceMm <= cutoff ? "blocked" : "clear";
  // Replay is a recorded sample, not a live sensor. Freshness has no TTL.
  edge.freshness = type === "replay" ? "missing" : "fresh";
  return true;
}

export function loadFixture(): WorldState {
  const fixture = readVenueFixture();
  const live = liveFromFixture(fixture);
  venues.clear();
  venues.set(live.fixture.venueId, live);
  return snapshot(live);
}

export function resetFixture(venueId: string): WorldState {
  const live = requireVenue(venueId);
  live.worldEpoch = randomUUID();
  live.revision = 0;
  live.edges = trackedFromFixture(live.fixture);
  return snapshot(live);
}

export function getGraph(venueId: string): Venue {
  const live = requireVenue(venueId);
  const graph = structuredClone(live.fixture);
  graph.worldEpoch = live.worldEpoch;
  graph.revision = 0;
  return graph;
}

export function getWorld(venueId: string): WorldState {
  return snapshot(requireVenue(venueId));
}

export function applyObservation(observation: Observation): WorldState {
  const input = assertObservation(observation);
  const live = requireVenue(input.venueId);
  const edge = live.edges.find((item) => item.edgeId === input.location.edgeId);
  if (!edge) {
    return snapshot(live);
  }
  const cutoff = live.fixture.obstructionProjection.blockedWhenValidDistanceMmAtMost;
  if (applyToEdge(edge, input, cutoff)) {
    live.revision += 1;
  }
  return snapshot(live);
}

loadFixture();
