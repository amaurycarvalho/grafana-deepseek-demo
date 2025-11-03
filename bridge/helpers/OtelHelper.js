import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { NodeTracerProvider } from "@opentelemetry/sdk-trace-node";
import { SimpleSpanProcessor } from "@opentelemetry/sdk-trace-base";
import { registerInstrumentations } from "@opentelemetry/instrumentation";
import { getNodeAutoInstrumentations } from "@opentelemetry/auto-instrumentations-node";
import { WinstonInstrumentation } from "@opentelemetry/instrumentation-winston";
import { resourceFromAttributes } from "@opentelemetry/resources";
import { trace, diag, DiagLogLevel } from "@opentelemetry/api";
import { ATTR_SERVICE_NAME } from "@opentelemetry/semantic-conventions";
const ATTR_DEPLOYMENT_ENVIRONMENT = "env";
const ATTR_REGION = "region";

/**
 * Identifier normalizer to Otel accepted format [a-zA-Z_:][a-zA-Z0-9_:]*
 * @param {string} input Identifier
 * @returns {string} Normalized identified
 */
function normalizeIdentifier(input) {
  if (typeof input !== "string" || input.length === 0) {
    return "_";
  }
  let first = input[0];
  if (!/^[a-zA-Z_:]$/.test(first)) {
    first = "_";
  }
  const rest = input.slice(1).replace(/[^a-zA-Z0-9_:]/g, "_");
  return first + rest;
}

export default {
  OTLPTraceExporter,
  NodeTracerProvider,
  SimpleSpanProcessor,
  registerInstrumentations,
  WinstonInstrumentation,
  getNodeAutoInstrumentations,
  resourceFromAttributes,
  trace,
  diag,
  DiagLogLevel,
  normalizeIdentifier,
  ATTR_SERVICE_NAME,
  ATTR_DEPLOYMENT_ENVIRONMENT,
  ATTR_REGION,
};
