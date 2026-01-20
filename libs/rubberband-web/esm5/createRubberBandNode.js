import { __awaiter, __generator } from "tslib";
function createWorkletAsRubberNode(context, options) {
    var node = new AudioWorkletNode(context, "rubberband-processor", options);
    node.setPitch = function (pitch) {
        node.port.postMessage(JSON.stringify(["pitch", pitch]));
    };
    node.setTempo = function (pitch) {
        node.port.postMessage(JSON.stringify(["tempo", pitch]));
    };
    node.setHighQuality = function (pitch) {
        node.port.postMessage(JSON.stringify(["quality", pitch]));
    };
    node.close = function () {
        node.port.postMessage(JSON.stringify(["close"]));
    };
    return node;
}
function createRubberBandNode(context, url, options) {
    return __awaiter(this, void 0, void 0, function () {
        var err_1;
        return __generator(this, function (_a) {
            switch (_a.label) {
                case 0:
                    _a.trys.push([0, 1, , 3]);
                    return [2, createWorkletAsRubberNode(context, options)];
                case 1:
                    err_1 = _a.sent();
                    return [4, context.audioWorklet.addModule(url)];
                case 2:
                    _a.sent();
                    return [2, createWorkletAsRubberNode(context, options)];
                case 3: return [2];
            }
        });
    });
}
export { createRubberBandNode };
//# sourceMappingURL=createRubberBandNode.js.map