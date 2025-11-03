# 🚀 Grafana OSS vs Deepseek Demo

This MVP project demonstrates the integration of *Deepseek LLM (via Ollama)* with *Grafana OSS*, providing basic autocompletion capabilities. It also enables *Deepseek* integration with *VSCode*, offering partial support for the *Model Context Protocol* (MCP).

> ⚠️ **Warning**: This is a prototype (MVP) working in progress project intended for testing only.
> Do not deploy it to production environments — it lacks security hardening and validation mechanisms.

## 📖 User's Guide

### Introduction

Grafana’s built-in LLM support is currently available only on Grafana Cloud through the [Grafana Assistent](https://grafana.com/docs/grafana-cloud/machine-learning/assistant/) service. While [initially free](https://grafana.com/whats-new/2025-10-08-grafana-assistant-is-now-generally-available/) it will become a [paid feature in 2026](https://grafana.com/docs/grafana-cloud/machine-learning/assistant/introduction/pricing/).

However, Grafana OSS provides basic LLM integration that works with OpenAI-compatible APIs.

This MVP demonstrates how to connect Grafana OSS to a local Deepseek model running on Ollama, using a Node.js bridge that converts responses into OpenAI-compatible format.

You can easily run this setup locally with Docker and adapt it to your own environment.

> ⚠️ **Warning**: Some LLM models can be very slow on low-spec or cost-effective machines. While the Grafana integration may fail under these conditions, the integration logs will continue to function correctly.

---

### ⚡ Quick start

#### ⚙️ Bridge configuration

1. Create a `.env` file in the project root (see `.env.example`);
2. Choose your preferred model for `OLLAMA_DEFAULT_MODEL` environment variable.

#### 🧱 Build containers

```
sudo docker-compose build
```

#### ▶️ Start the stack

```
sudo docker-compose up -d
```

#### 🛑 Stopping the stack

```
sudo docker-compose down
```

---

### 👉 Grafana basic integration

#### 🖥️ Access Grafana

```
http://localhost:3000 (admin/admin)
```

#### ⚙️ LLM plugin setup

1. Open Grafana's plugins list:  
   Navigate to `Grafana > Administration > Plugins and data > Plugins` or go directly to `http://localhost:3000/plugins`.
2. Search for LLM plugin;
3. Configure it as follows:  
  Select `Use a Custom API` option  
  Provider: `OpenAI`  
  API URL: `http://llm-bridge:3001`
4. Click on `Save & test` and wait for the health check to complete.

### 🧪 Testing

1. Open Granafa in your browser;
2. Create a *new dashboard*;
3. Click on the Panel Title → Auto-generate option.  
   Grafana will use the connected LLM to generate a title and description automatically.

Try using `Hello` as the panel title to test the bridge integration.

Additionally, try the `Explain Flame Graph` option in the `Drilldown > Profiles > Flame graph`.

---

### 👉 VSCode partial MCP integration

#### Setting Up the Local Assistant in VSCode with Continue

1. Install and enable the [Continue - open-source AI code agent](https://continue.dev/) extension in VSCode;
2. Click on the *Continue* icon in the left-hand toolbar;
3. In the Continue *Chat* tab, click the *Open Settings* icon (⚙️);
4. Select the *Configs* paper icon in the left-hand new toolbar and click the *Local Config* icon (⚙️);
5. Add the following to your `.continue/agents/config.yaml` file and save it.

```
name: Local Assistant
version: 1.0.0
schema: v1
models:
  - name: Deepseek Proxy Chat
    provider: openai
    model: deepseek-r1:1.5b
    apiBase: http://localhost:3001/v1
    apiKey:
    roles:
      - chat
      - edit
      - apply
```

> 📌 *Note*:  
> 1. Change `apiKey` to the same `LLM_BRIDGE_API_KEY` value key you put in the `.env` file;  
> 2. See `.continue/agents/config.yaml.example` in the project repository for a more complete configuration.

#### Testing

1. Select the model:  
   In the Chat section, choose *Deepseek Proxy Chat* and click *Back*.
2. Test the assistant:  
   Type *Hello* in the chat and wait for the response from your local Deepseek model.

Inside VSCode, try prompts like:

- `#llm:test`
- `Hello!`
- `What do you know about Node.js?`

And, still experimentally (needs `MCP_API_KEY` to work):

- `#mcp:grafana Show grafana version`
- `#mcp:grafana Show all dashboards names.`
- `#mcp:grafana Show all metrics names.`
- `#mcp:grafana Show the CPU metrics.`
- `#mcp:grafana Show tools list`


## 🧑‍💻 Developer Guide

### 🧩 Stack Overview:

| Name | Description | URL |
|---|---|---|
| Prometheus | Metrics | http://localhost:9090 | 
| Grafana | Dashboards and alerts | http://localhost:3000 (admin/admin) |
| Loki | Logs | http://localhost:3100 |
| Pyroscope | Profiler | http://localhost:4040 |
| node_exporter | Exposes host CPU/memory | http://localhost:9100 |
| [mcp-grafana](https://github.com/grafana/mcp-grafana) | MCP server | http://localhost:8000/mcp | 
| Ollama | LLM (Deepseek) | http://localhost:11434 |
| Bridge | OpenAI-like proxy | http://localhost:3001/v1 |

---

### 🪵 Logs

#### Grafana Logs

Open Grafana > Drilldown > Logs

#### Container logs

```
sudo docker-compose logs | grep 'bridge[[:space:]]*|'
```

---

### 🧠 LLM Bridge Manual Tests

#### Health check

```
curl -X GET http://localhost:3001/health
```

#### Simple chat test

```
curl -X POST http://localhost:3001/v1/chat/completions -H "Content-Type: application/json" -d '{"messages": [{"role":"user","content":"#llm:test"}]}'

curl -X POST http://localhost:3001/v1/chat/completions -H "Content-Type: application/json" -d '{"messages": [{"role":"user","content":"Hello"}]}'
```

#### Example MCP query (needs MCP_API_KEY to work)

```
curl -X POST http://localhost:3001/v1/chat/completions -H "Content-Type: application/json" -d '{"messages":[{"role":"user","content":"#mcp:grafana Show grafana version."}]}'

curl -X POST http://localhost:3001/v1/chat/completions -H "Content-Type: application/json" -d '{"messages":[{"role":"user","content":"#mcp:grafana Show all dashboards names."}]}'
```

#### Example when LLM_BRIDGE_API_KEY is set

```
curl -X POST http://localhost:3001/v1/chat/completions -H "Content-Type: application/json" -H "Authorization: Bearer LLM_BRIDGE_API_KEY_value" -d '{"messages": [{ "role": "user", "content": "Hello" }]}'
```

---

### ⚙️ Operations

#### Restart all containers

```
sudo docker-compose restart
```

#### Downloading and testing Deepseek model:

```
sudo docker exec -it ollama sh
ollama pull deepseek-r1:1.5b
ollama list
ollama run deepseek-r1:1.5b "Hello"
exit
```

#### Open Grafana container shell

```
sudo docker exec -it grafana sh
```

---

### 📌 Configuration Notes

#### Bridge configurations

- *Changing the LLM model*: edit `.env` file and change the `OLLAMA_DEFAULT_MODEL` environment variable;
- *Security API key*: edit `.env` file and change the `LLM_BRIDGE_API_KEY` environment variable. Enter the same value in the Grafana LLM plugin and into VSCode `.Continue` plugin config.

#### Grafana configurations

- *Default user/password*: edit `./grafana/grafana.ini` file and search for `security' section;
- *Connections url (prometheus, loki, pyroscope and tempo)*: edit `./grafana/provisioning/datasources/datasources.yml` and `./.env` files.

#### Grafana MCP configurations

- *MCP token*: go to `Administration > Users and access > Service accounts`, add a new service as `viewer` and create a new token. Copy this token to `MCP_API_KEY` environment variable in the `.env` file. Restart the container.

#### Extending MCP capabilities:

Edit the `./bridge/GrafanaMcp.js` file by adding new MCP server methods (follow the examples there).

---

### 📌 Additional Notes

- Node Exporter (used for CPU and memory local data telemetry): requires read access to /proc and /sys. The provided Docker Compose uses read-only mounts for safety;
- All components are pulled from the latest Docker images. If upstream versions change, review and update `docker-compose.yml` and related configs to maintain compatibility.

---

## 📚 References & Further Reading

### 🔗 [Grafana OSS](https://grafana.com/oss/grafana/)
- [Grafana LLM plugin](https://grafana.com/grafana/plugins/grafana-llm-app/), [additional help](https://grafana.com/docs/plugins/grafana-ml-app/v1.32.2/llm/) and [repo](https://github.com/grafana/grafana-llm-app);
- [Grafana LLM examples](https://github.com/grafana/grafana-llmexamples-app);
- [Campfire MCP Demo](https://github.com/grafana/campfire-mcp-demo) for more details about Grafana MCP integration.

### 🔗 LLM and OpenAI
- [OpenAI API guide](https://platform.openai.com/docs/guides/text) and [chat completion object reference](https://platform.openai.com/docs/api-reference/chat/get);
- [OWASP LLM top 10 list](https://owasp.org/www-project-top-10-for-large-language-model-applications/);
- [OWASP LLM top 10 detailed](https://genai.owasp.org/llm-top-10/).

### 🔗 MCP and OpenAI
- [Ollama MCP streaming tool](https://ollama.com/blog/streaming-tool);
- [MCP reference guide](https://modelcontextprotocol.io/specification/2025-06-18/basic);
- [MCP JSON-RPC Reference Guide](https://portkey.ai/blog/mcp-message-types-complete-json-rpc-reference-guide/);
- [Node.js FastMCP](https://npmjs.com/package/fastmcp).

### 🔗 VSCode .Continue extension
- [.Continue - open-source AI code agent extension](https://continue.dev/) extension;
- [.Continue config](https://docs.continue.dev/reference);
- [.Continue MCP config](https://docs.continue.dev/reference/continue-mcp);
- [.Continue MCP customize](https://docs.continue.dev/customize/deep-dives/mcp);
- [.Continue models](https://docs.continue.dev/customization/models);
- [.Continue rules](https://docs.continue.dev/customize/deep-dives/rules);
- [.Continue prompts](https://docs.continue.dev/customize/deep-dives/prompts).

### 🔗 [Prometheus](https://prometheus.io)
- [Prometheus and Node.js](https://prometheus.io/docs/instrumenting/clientlibs/).

### 🔗 [Loki OSS](https://grafana.com/oss/loki/)
- [Loki and Node.js](https://grafana.com/docs/loki/latest/send-data/).

### 🔗 [Pyroscope OSS](https://grafana.com/oss/pyroscope/)
- [Pyroscope and Node.js](https://grafana.com/docs/pyroscope/latest/configure-client/language-sdks/nodejs/);
- [Java span profiles](https://grafana.com/docs/pyroscope/latest/configure-client/trace-span-profiles/java-span-profiles/).

### 🔗 [Tempo OSS](https://grafana.com/oss/tempo/)
- [Tempo configuration](https://grafana.com/docs/grafana/next/datasources/tempo/configure-tempo-data-source/);
- [Tempo and Node.js](https://grafana.com/docs/opentelemetry/instrument/node/).

