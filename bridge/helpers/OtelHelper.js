import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { NodeTracerProvider } from "@opentelemetry/sdk-trace-node";
import { SimpleSpanProcessor } from "@opentelemetry/sdk-trace-base";
import { registerInstrumentations } from "@opentelemetry/instrumentation";
import { getNodeAutoInstrumentations } from "@opentelemetry/auto-instrumentations-node";
import { resourceFromAttributes } from "@opentelemetry/resources";
import { trace, diag, DiagLogLevel } from "@opentelemetry/api";
import { ATTR_SERVICE_NAME } from "@opentelemetry/semantic-conventions";
const ATTR_DEPLOYMENT_ENVIRONMENT = "env";
const ATTR_REGION = "region";
export default {
  OTLPTraceExporter,
  NodeTracerProvider,
  SimpleSpanProcessor,
  registerInstrumentations,
  getNodeAutoInstrumentations,
  resourceFromAttributes,
  trace,
  diag,
  DiagLogLevel,
  ATTR_SERVICE_NAME,
  ATTR_DEPLOYMENT_ENVIRONMENT,
  ATTR_REGION,
};
