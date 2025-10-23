import Pyroscope from "@pyroscope/nodejs";

export class PyroscopeProfiler {
  constructor({
    appName = "app",
    serverAddress = process.env.PYROSCOPE_URL || "http://pyroscope:4040",
    authToken = process.env.PYROSCOPE_AUTH_TOKEN || "",
  } = {}) {
    this.appName = appName;
    this.serverAddress = serverAddress;
    this.authToken = authToken;

    this.init();
  }

  init() {
    Pyroscope.init({
      appName: this.appName,
      serverAddress: this.serverAddress,
      authToken: this.authToken,
      sampleRate: 10,
      tags: {
        env: process.env.NODE_ENV || "dev",
        service: this.appName,
      },
      labels: {},
      sourceMap: true,
    });

    Pyroscope.start();
  }

  middleware(labels) {
    return (req, res, next) => {
      Pyroscope.wrapWithLabels(labels, async () => {
        next();
      });
    };
  }
}
