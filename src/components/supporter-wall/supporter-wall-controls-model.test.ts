import { describe, expect, it } from "vitest";

import {
  createSupporterWallControlsState,
  type FanWallEntry,
  supporterWallControlsReducer,
} from "./supporter-wall-controls-model";

function entry(overrides: Partial<FanWallEntry> = {}): FanWallEntry {
  return {
    id: "entry-1",
    dedication: "A",
    status: "approved",
    version: 1,
    ...overrides,
  };
}

describe("supporter wall controls state", () => {
  it("preserves newer text through a save response and a later server refresh", () => {
    let state = createSupporterWallControlsState(entry());
    state = supporterWallControlsReducer(state, {
      type: "dedication-changed",
      dedication: "B",
    });
    const submittedDedication = state.dedication;

    // The fan types C while the request carrying B is still in flight.
    state = supporterWallControlsReducer(state, {
      type: "dedication-changed",
      dedication: "C",
    });
    state = supporterWallControlsReducer(state, {
      type: "save-succeeded",
      entry: entry({ dedication: "B", status: "pending", version: 2 }),
      submittedDedication,
    });

    expect(state.dedication).toBe("C");
    expect(state.dirty).toBe(true);

    const refreshedEntry = entry({ dedication: "B", status: "approved", version: 3 });
    state = supporterWallControlsReducer(state, {
      type: "server-synced",
      entry: refreshedEntry,
    });

    expect(state.entry).toEqual(refreshedEntry);
    expect(state.dedication).toBe("C");
    expect(state.dirty).toBe(true);
  });

  it("applies server text when the current text is clean", () => {
    let state = createSupporterWallControlsState(entry());
    const refreshedEntry = entry({ dedication: "Server value", status: "hidden", version: 2 });

    state = supporterWallControlsReducer(state, {
      type: "server-synced",
      entry: refreshedEntry,
    });

    expect(state).toEqual({
      entry: refreshedEntry,
      dedication: "Server value",
      dirty: false,
    });
  });
});
