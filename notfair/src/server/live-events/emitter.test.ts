import { expect, it, vi } from "vitest";

import { publishSessionEvent, subscribeSessionEvents } from "./emitter";

it("publishes only to the matching session and unsubscribes", () => {
  const one = vi.fn();
  const two = vi.fn();
  const offOne = subscribeSessionEvents("one", one);
  const offTwo = subscribeSessionEvents("two", two);
  const event = { id: "e", session_id: "one", seq: 1, kind: "user", payload_json: "{}", created_at: "now" } as const;
  publishSessionEvent("one", event);
  expect(one).toHaveBeenCalledWith(event);
  expect(two).not.toHaveBeenCalled();
  offOne();
  publishSessionEvent("one", event);
  expect(one).toHaveBeenCalledTimes(1);
  offTwo();
});
