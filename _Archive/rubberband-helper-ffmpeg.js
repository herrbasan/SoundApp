export async function createRubberBandNode(context, processorUrl, options) {
	await context.audioWorklet.addModule(processorUrl);
	
	const node = new AudioWorkletNode(context, "rubberband-processor", options);
	
	node.setPitch = (pitch) => {
		node.port.postMessage(JSON.stringify(["pitch", pitch]));
	};
	
	node.setTempo = (tempo) => {
		node.port.postMessage(JSON.stringify(["tempo", tempo]));
	};
	
	node.setHighQuality = (quality) => {
		node.port.postMessage(JSON.stringify(["quality", quality]));
	};
	
	node.close = () => {
		node.port.postMessage(JSON.stringify(["close"]));
	};
	
	return node;
}
