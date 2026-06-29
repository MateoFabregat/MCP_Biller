import { describe, expect, it } from "vitest";
import { assertReadOnlyMethod } from "../src/biller/httpGuard.js";
import { BillerReadOnlyViolationError } from "../src/utils/errors.js";

describe("assertReadOnlyMethod (read-only guard)", () => {
  // Requisito #4
  it.each(["POST", "PUT", "PATCH", "DELETE", "post", "delete", "OPTIONS", "HEAD", ""])(
    "rechaza el método %s",
    (method) => {
      expect(() => assertReadOnlyMethod(method)).toThrow(BillerReadOnlyViolationError);
    },
  );

  it.each(["GET", "get", "Get"])("permite el método %s", (method) => {
    expect(() => assertReadOnlyMethod(method)).not.toThrow();
  });
});
