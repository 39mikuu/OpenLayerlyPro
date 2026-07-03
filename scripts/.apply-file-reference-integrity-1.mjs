import { readFileSync, writeFileSync } from "node:fs";
const operations = [{"path":"src/db/schema/index.ts","old":"ICBxckZpbGVJZDogdXVpZCgicXJfZmlsZV9pZCIpLA==","new":"ICBxckZpbGVJZDogdXVpZCgicXJfZmlsZV9pZCIpLnJlZmVyZW5jZXMoKCkgPT4gZmlsZXMuaWQsIHsgb25EZWxldGU6ICJyZXN0cmljdCIgfSks"},{"path":"src/db/schema/index.ts","old":"ICAgIHByb29mRmlsZUlkOiB1dWlkKCJwcm9vZl9maWxlX2lkIiks","new":"ICAgIHByb29mRmlsZUlkOiB1dWlkKCJwcm9vZl9maWxlX2lkIikucmVmZXJlbmNlcygoKSA9PiBmaWxlcy5pZCwgeyBvbkRlbGV0ZTogInJlc3RyaWN0IiB9KSw="},{"path":"src/db/schema/index.ts","old":"ICAgIGNvdmVyRmlsZUlkOiB1dWlkKCJjb3Zlcl9maWxlX2lkIiks","new":"ICAgIGNvdmVyRmlsZUlkOiB1dWlkKCJjb3Zlcl9maWxlX2lkIikucmVmZXJlbmNlcygoKSA9PiBmaWxlcy5pZCwgeyBvbkRlbGV0ZTogInJlc3RyaWN0IiB9KSw="},{"path":"src/db/schema/index.ts","old":"ICAgICAgLnJlZmVyZW5jZXMoKCkgPT4gZmlsZXMuaWQsIHsgb25EZWxldGU6ICJjYXNjYWRlIiB9KSw=","new":"ICAgICAgLnJlZmVyZW5jZXMoKCkgPT4gZmlsZXMuaWQsIHsgb25EZWxldGU6ICJyZXN0cmljdCIgfSks"}];
const decode = (value) => Buffer.from(value, "base64").toString("utf8");
for (const operation of operations) {
  const before = decode(operation.old);
  const after = decode(operation.new);
  const current = readFileSync(operation.path, "utf8");
  const count = current.split(before).length - 1;
  if (count !== 1) throw new Error(`${operation.path}: expected one target, found ${count}`);
  writeFileSync(operation.path, current.replace(before, after));
}
