import { __awaiter } from "tslib";
import * as Tone from 'tone';
const createWorkletAsRubberToneJSNode = () => __awaiter(void 0, void 0, void 0, function* () {
    const node = Tone.context.createAudioWorkletNode('rubberband-processor');
    const enhancement = {
        setPitch(pitch) {
            node.port.postMessage(JSON.stringify(['pitch', pitch]));
        },
        setTempo(tempo) {
            node.port.postMessage(JSON.stringify(['tempo', tempo]));
        },
        setHighQuality(enabled) {
            node.port.postMessage(JSON.stringify(['quality', enabled]));
        },
        close() {
            node.port.postMessage(JSON.stringify(['close']));
        },
    };
    return Object.assign(node, enhancement);
});
const createRubberBandNodeForToneJS = (url) => __awaiter(void 0, void 0, void 0, function* () {
    try {
        return yield createWorkletAsRubberToneJSNode();
    }
    catch (err) {
        yield Tone.context.addAudioWorkletModule(url, 'rubberband-processor');
        return yield createWorkletAsRubberToneJSNode();
    }
});
export { createRubberBandNodeForToneJS };
//# sourceMappingURL=createRubberBandNodeForToneJS.js.map