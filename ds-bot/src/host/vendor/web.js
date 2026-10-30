import { HarnessError } from './llm-errors.js'

// A web failure as the web service raises it: the same coded harness error, under its own
// name so a caller can tell a network path failed.
export class WebError extends HarnessError {}
