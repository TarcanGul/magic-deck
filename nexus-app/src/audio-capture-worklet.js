class PcmCaptureProcessor extends AudioWorkletProcessor {
  constructor() {
    super()
    this.recording = false
    this.recordingId = 0
    this.targetFrames = 0
    this.capturedFrames = 0
    this.port.onmessage = (event) => {
      if (event.data?.type === 'start') {
        this.recordingId = event.data.recordingId
        this.targetFrames = Math.max(0, Math.floor(event.data.frameCount))
        this.capturedFrames = 0
        this.recording = this.targetFrames > 0
      } else if (event.data?.type === 'stop') {
        this.recording = false
      }
    }
  }

  process(inputs) {
    if (!this.recording) return true

    const input = inputs[0]
    const leftInput = input?.[0]
    if (!leftInput?.length) return true

    const rightInput = input[1] ?? leftInput
    const remainingFrames = this.targetFrames - this.capturedFrames
    const frameCount = Math.min(leftInput.length, remainingFrames)
    const left = new Float32Array(leftInput.subarray(0, frameCount))
    const right = new Float32Array(rightInput.subarray(0, frameCount))
    this.capturedFrames += frameCount
    this.port.postMessage({
      type: 'chunk',
      recordingId: this.recordingId,
      left,
      right,
      capturedFrames: this.capturedFrames,
      targetFrames: this.targetFrames,
    }, [left.buffer, right.buffer])

    if (this.capturedFrames >= this.targetFrames) {
      this.recording = false
      this.port.postMessage({
        type: 'complete',
        recordingId: this.recordingId,
        capturedFrames: this.capturedFrames,
        targetFrames: this.targetFrames,
      })
    }
    return true
  }
}

registerProcessor('pcm-capture-processor', PcmCaptureProcessor)
