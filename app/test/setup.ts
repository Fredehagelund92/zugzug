import "@testing-library/jest-dom/vitest";

// jsdom does not implement scrollIntoView — polyfill it so components that
// call el.scrollIntoView() don't throw in the test environment.
Element.prototype.scrollIntoView = () => {};
