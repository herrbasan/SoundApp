import { __awaiter } from "tslib";
function createWorkletAsRubberNode(context, options) {
    const node = new AudioWorkletNode(context, "rubberband-processor", options);
    node.setPitch = (pitch) => {
        node.port.postMessage(JSON.stringify(["pitch", pitch]));
    };
    node.setTempo = (pitch) => {
        node.port.postMessage(JSON.stringify(["tempo", pitch]));
    };
    node.setHighQuality = (pitch) => {
        node.port.postMessage(JSON.stringify(["quality", pitch]));
    };
    node.close = () => {
        node.port.postMessage(JSON.stringify(["close"]));
    };
    return node;
}
function createRubberBandNode(context, url, options) {
    return __awaiter(this, void 0, void 0, function* () {
        try {
            return createWorkletAsRubberNode(context, options);
        }
        catch (err) {
            yield context.audioWorklet.addModule(url);
            return createWorkletAsRubberNode(context, options);
        }
    });
}
export { createRubberBandNode };
//# sourceMappingURL=createRubberBandNode.js.map