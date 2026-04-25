import "@testing-library/jest-dom/vitest";
import { cleanup } from "@testing-library/react";
import { afterEach } from "vitest";

if (!window.PointerEvent) {
  window.PointerEvent = class MockPointerEvent extends MouseEvent {
    constructor(type, props = {}) {
      super(type, props);
      Object.defineProperty(this, "pointerId", { configurable: true, value: props.pointerId ?? 1 });
      Object.defineProperty(this, "pointerType", { configurable: true, value: props.pointerType ?? "mouse" });
      Object.defineProperty(this, "buttons", { configurable: true, value: props.buttons ?? 0 });
    }
  };
}

afterEach(() => {
  cleanup();
});
