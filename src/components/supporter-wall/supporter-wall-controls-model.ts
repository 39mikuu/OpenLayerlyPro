export type FanWallEntry = {
  id: string;
  dedication: string | null;
  status: "pending" | "approved" | "hidden";
  version: number;
};

export type SupporterWallControlsState = {
  entry: FanWallEntry | null;
  dedication: string;
  dirty: boolean;
};

export type SupporterWallControlsAction =
  | { type: "server-synced"; entry: FanWallEntry | null }
  | { type: "dedication-changed"; dedication: string }
  | {
      type: "save-succeeded";
      entry: FanWallEntry;
      submittedDedication: string;
    }
  | { type: "opted-out" };

export function createSupporterWallControlsState(
  entry: FanWallEntry | null,
): SupporterWallControlsState {
  return {
    entry,
    dedication: entry?.dedication ?? "",
    dirty: false,
  };
}

export function supporterWallControlsReducer(
  state: SupporterWallControlsState,
  action: SupporterWallControlsAction,
): SupporterWallControlsState {
  switch (action.type) {
    case "server-synced":
      return {
        entry: action.entry,
        dedication: state.dirty ? state.dedication : (action.entry?.dedication ?? ""),
        dirty: state.dirty,
      };
    case "dedication-changed":
      return {
        ...state,
        dedication: action.dedication,
        dirty: true,
      };
    case "save-succeeded":
      return {
        ...state,
        entry: action.entry,
        // A matching value means the server has confirmed the text that is
        // still on screen. If the fan typed again while saving, keep that
        // newer text dirty so a later router refresh cannot overwrite it.
        dirty: state.dedication !== action.submittedDedication,
      };
    case "opted-out":
      return createSupporterWallControlsState(null);
  }
}
