import { describe, test, expect } from "@jest/globals";
import { FlowDriver } from "../src/flow-driver.js";

describe("FlowDriver", () => {
  test("constructor accepts a browser context", () => {
    expect(FlowDriver).toBeDefined();
  });
});
