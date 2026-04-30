import { randomBytes } from "node:crypto";

export type VinstaTraceContext = {
  traceId: string;
  parentSpanId?: string;
  traceFlags?: string;
  traceparent: string;
};

const TRACE_ID_RE = /^[0-9a-f]{32}$/;
const SPAN_ID_RE = /^[0-9a-f]{16}$/;
const TRACE_FLAGS_RE = /^[0-9a-f]{2}$/;
const TRACEPARENT_RE = /^00-([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{2})$/;

function isNonZero(value: string) {
  return !/^0+$/.test(value);
}

export function createVinstaSpanId() {
  let spanId = randomBytes(8).toString("hex");
  while (!isNonZero(spanId)) spanId = randomBytes(8).toString("hex");
  return spanId;
}

export function buildVinstaTraceparent(input: {
  traceId: string;
  spanId?: string;
  traceFlags?: string;
}) {
  const traceId = input.traceId.toLowerCase();
  const spanId = (input.spanId ?? createVinstaSpanId()).toLowerCase();
  const traceFlags = (input.traceFlags ?? "01").toLowerCase();

  if (!TRACE_ID_RE.test(traceId) || !isNonZero(traceId)) {
    throw new Error("traceId must be a non-zero 32-character hex value.");
  }
  if (!SPAN_ID_RE.test(spanId) || !isNonZero(spanId)) {
    throw new Error("spanId must be a non-zero 16-character hex value.");
  }
  if (!TRACE_FLAGS_RE.test(traceFlags)) {
    throw new Error("traceFlags must be a 2-character hex value.");
  }

  return `00-${traceId}-${spanId}-${traceFlags}`;
}

export function parseVinstaTraceparent(value: unknown): VinstaTraceContext | null {
  if (typeof value !== "string") return null;
  const match = TRACEPARENT_RE.exec(value.trim().toLowerCase());
  if (!match || !isNonZero(match[1]) || !isNonZero(match[2])) return null;

  return {
    traceId: match[1],
    parentSpanId: match[2],
    traceFlags: match[3],
    traceparent: `00-${match[1]}-${match[2]}-${match[3]}`,
  };
}

export function extractVinstaTraceContext(metadata: Record<string, unknown> | null | undefined) {
  if (!metadata) return null;

  const traceparent = parseVinstaTraceparent(metadata.traceparent);
  if (traceparent) return traceparent;

  const traceIdValue = metadata.traceId ?? metadata.trace_id;
  const parentSpanIdValue = metadata.parentSpanId ?? metadata.parent_span_id;
  const traceFlagsValue = metadata.traceFlags ?? metadata.trace_flags;
  const traceId = typeof traceIdValue === "string" ? traceIdValue.toLowerCase() : null;
  const parentSpanId = typeof parentSpanIdValue === "string" ? parentSpanIdValue.toLowerCase() : null;
  const traceFlags = typeof traceFlagsValue === "string" ? traceFlagsValue.toLowerCase() : "01";

  if (!traceId || !TRACE_ID_RE.test(traceId) || !isNonZero(traceId)) return null;
  if (parentSpanId && (!SPAN_ID_RE.test(parentSpanId) || !isNonZero(parentSpanId))) return null;
  if (!TRACE_FLAGS_RE.test(traceFlags)) return null;

  return {
    traceId,
    parentSpanId: parentSpanId ?? undefined,
    traceFlags,
    traceparent: buildVinstaTraceparent({ traceId, spanId: parentSpanId ?? undefined, traceFlags }),
  };
}
