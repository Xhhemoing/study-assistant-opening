export class PipelineStateError extends Error {
  constructor(message, code = "STATE_INVALID") {
    super(message);
    this.name = "PipelineStateError";
    this.code = code;
  }
}
