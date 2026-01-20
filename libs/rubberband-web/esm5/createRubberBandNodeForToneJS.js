import { __awaiter, __generator } from "tslib";
import * as Tone from 'tone';
var createWorkletAsRubberToneJSNode = function () { return __awaiter(void 0, void 0, void 0, function () {
    var node, enhancement;
    return __generator(this, function (_a) {
        node = Tone.context.createAudioWorkletNode('rubberband-processor');
        enhancement = {
            setPitch: function (pitch) {
                node.port.postMessage(JSON.stringify(['pitch', pitch]));
            },
            setTempo: function (tempo) {
                node.port.postMessage(JSON.stringify(['tempo', tempo]));
            },
            setHighQuality: function (enabled) {
                node.port.postMessage(JSON.stringify(['quality', enabled]));
            },
            close: function () {
                node.port.postMessage(JSON.stringify(['close']));
            },
        };
        return [2, Object.assign(node, enhancement)];
    });
}); };
var createRubberBandNodeForToneJS = function (url) { return __awaiter(void 0, void 0, void 0, function () {
    var err_1;
    return __generator(this, function (_a) {
        switch (_a.label) {
            case 0:
                _a.trys.push([0, 2, , 5]);
                return [4, createWorkletAsRubberToneJSNode()];
            case 1: return [2, _a.sent()];
            case 2:
                err_1 = _a.sent();
                return [4, Tone.context.addAudioWorkletModule(url, 'rubberband-processor')];
            case 3:
                _a.sent();
                return [4, createWorkletAsRubberToneJSNode()];
            case 4: return [2, _a.sent()];
            case 5: return [2];
        }
    });
}); };
export { createRubberBandNodeForToneJS };
//# sourceMappingURL=createRubberBandNodeForToneJS.js.map