class PcmCaptureProcessor extends AudioWorkletProcessor {
  process(inputs) {
    const input = inputs[0]
    const leftInput = input?.[0]
    if (!leftInput?.length) return true

    const rightInput = input[1] ?? leftInput
    const left = new Float32Array(leftInput)
    const right = new Float32Array(rightInput)
    this.port.postMessage({ left, right }, [left.buffer, right.buffer])
    return true
  }
}

registerProcessor('pcm-capture-processor', PcmCaptureProcessor)
