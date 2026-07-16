// Shared between the server module and client components; keep free of
// server-only imports.

// minLevel is compared against membership_tiers.level (int4) in the public
// query; anything above int4 max would make every wall read fail at bind time.
export const SUPPORTER_WALL_MAX_MIN_LEVEL = 2147483647;
