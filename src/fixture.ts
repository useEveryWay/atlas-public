import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

export type ObstructionState = "unknown" | "clear" | "blocked";
export type Freshness = "missing" | "fresh" | "invalid";

export type FixtureEdge = {
  edgeId: string;
  fromNodeId: string;
  toNodeId: string;
  distanceM: number;
  estimatedTimeSec: number;
  stairs: boolean;
  slope: number | null;
  widthM: number | null;
  monitored: boolean;
  obstructionState: ObstructionState;
  crowdIndex: number;
  noiseIndex: number;
  evidence: { freshness: Freshness };
};

export type VenueFixture = {
  schemaVersion: "1.0";
  venueId: string;
  graphVersion: string;
  worldEpoch: string;
  revision: number;
  nodes: { nodeId: string }[];
  edges: FixtureEdge[];
  obstructionProjection: {
    policy: string;
    blockedWhenValidDistanceMmAtMost: number;
  };
};

const CONTRACTS_DIR =
  process.env.CONDUIT_CONTRACTS_DIR ?? fileURLToPath(new URL("../../conduit/contracts/", import.meta.url));

const fixturePath = join(CONTRACTS_DIR, "fixtures", "valid", "venue-seaside-market-v1.json");

export function readVenueFixture(): VenueFixture {
  const fixture = JSON.parse(readFileSync(fixturePath, "utf8")) as VenueFixture;
  if (fixture.venueId !== "seaside-market") {
    throw new Error("Seaside Market fixture venueId is not seaside-market");
  }
  if (fixture.graphVersion !== "seaside-market-v1") {
    throw new Error("Seaside Market fixture graphVersion is not seaside-market-v1");
  }
  if (fixture.obstructionProjection.policy !== "synthetic-demo") {
    throw new Error("Seaside Market fixture projection policy is not synthetic-demo");
  }
  if (fixture.obstructionProjection.blockedWhenValidDistanceMmAtMost !== 150) {
    throw new Error("Seaside Market fixture cutoff is not 150 mm");
  }
  if (!fixture.edges.some((edge) => edge.edgeId === "edge-north-ramp")) {
    throw new Error("Seaside Market fixture is missing edge-north-ramp");
  }
  return fixture;
}
