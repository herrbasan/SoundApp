// Post-JS hook for Emscripten builds.
// Ensures heap views are available on the returned Module object (required by HeapArray in the worklet bundle).
(function () {
  function attachHeaps() {
    if (typeof Module === "undefined") return;
    try {
      if (typeof HEAP8 !== "undefined") Module["HEAP8"] = HEAP8;
      if (typeof HEAP16 !== "undefined") Module["HEAP16"] = HEAP16;
      if (typeof HEAP32 !== "undefined") Module["HEAP32"] = HEAP32;
      if (typeof HEAPU8 !== "undefined") Module["HEAPU8"] = HEAPU8;
      if (typeof HEAPU16 !== "undefined") Module["HEAPU16"] = HEAPU16;
      if (typeof HEAPU32 !== "undefined") Module["HEAPU32"] = HEAPU32;
      if (typeof HEAPF32 !== "undefined") Module["HEAPF32"] = HEAPF32;
      if (typeof HEAPF64 !== "undefined") Module["HEAPF64"] = HEAPF64;
      if (typeof HEAP64 !== "undefined") Module["HEAP64"] = HEAP64;
      if (typeof HEAPU64 !== "undefined") Module["HEAPU64"] = HEAPU64;
    } catch (_) {
      // Intentionally ignore: worst case, the worklet will gate on HEAPF32 and remain silent.
    }
  }

  if (typeof updateMemoryViews === "function") {
    var originalUpdateMemoryViews = updateMemoryViews;
    updateMemoryViews = function () {
      originalUpdateMemoryViews();
      attachHeaps();
    };
  }

  attachHeaps();
})();
