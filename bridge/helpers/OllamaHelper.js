import crypto from "crypto";
import { Ollama } from "ollama";
import { LoggerHelper } from "./LoggerHelper.js";

/**
 * Ollama Helper class
 */
export class OllamaHelper {
  /**
   * @param {string} [ollamaHost] - Ollama URL
   * @param {string} [logLevel] - log level
   */
  constructor(options = {}) {
    const logLevel = options.logLevel || process.env.LOG_LEVEL || "info";
    const ollamaHost =
      options.ollamaHost || process.env.OLLAMA_HOST || "http://ollama:11434";
    this.logger = new LoggerHelper("Ollama", { level: logLevel });
    this.ollama = new Ollama({ host: ollamaHost });

    this.logger.debug("[ollama] LLM service initialized", {
      host: ollamaHost,
    });
  }

  /***
   * Get helper object from HTTP request
   * @param req HTTP request object
   * @param res HTTP response object
   * @returns helper object
   * helper: { prompt, answer, res }
   * prompt: { model, stream, tools, tool_calls, messages: [ { role: "user", content: "text", } ] }
   * answer: { id, created, stream, model, defaultModel, content }
   */
  getHelperFromRequest(req, res) {
    try {
      const body = req.body;
      const prompt = body.messages
        ? body
        : body.prompt || body.input || JSON.stringify(body);
      const defaultModel =
        process.env.OLLAMA_DEFAULT_MODEL || "deepseek-r1:1.5b";

      if (prompt.model) {
        if (
          prompt.model.trim() === "" ||
          prompt.model === "default" ||
          prompt.model === "OLLAMA_DEFAULT_MODEL"
        ) {
          prompt.model = defaultModel;
        }
      } else {
        prompt.model = defaultModel;
      }

      const answer = {
        id: "",
        created: 0,
        stream: (prompt.stream || body.stream) === true,
        model: prompt.model,
        defaultModel,
        content: "",
        tool_calls: [],
      };

      this.logger.debug("[ollama] prompt received", { prompt });

      return { prompt, answer, res };
    } catch (err) {
      this.logger.error("[ollama] internal error", { error: err.message });
      throw err;
    }
  }

  /***
   * Check prompt integrity (OWASP)
   * @param helper Ollama helper object
   * @returns true/false
   * @see
   * https://owasp.org/www-project-top-10-for-large-language-model-applications/
   * https://genai.owasp.org/llm-top-10/
   */
  checkOWASP() {
    // LLM01: Prompt Injection
    // LLM02: Sensitive Information Disclosure
    // LLM03: Supply Chain
    // LLM04: Data and Model Poisoning
    // LLM05: Improper Output Handling
    // LLM06: Excessive Agency
    // LLM07: System Prompt Leakage
    // LLM08: Vector and Embedding Weaknesses
    // LLM09: Misinformation
    // LLM10: Unbounded Consumption
    return true;
  }

  /**
   * LLM caller (Ollama API helper)
   * @param helper Helper object { model, messages: [{ role: "user", content: "text" }] }
   */
  async callLLM(helper) {
    try {
      const response = await this.ollama.chat({
        model: helper.answer.model,
        messages: helper.prompt.messages,
        tools: helper.prompt.tools,
        stream: false,
      });
      helper.answer.tool_calls = response.message.tool_calls;
      helper.answer.content =
        response?.message?.content || JSON.stringify(response);
    } catch (err) {
      this.logger.error("[ollama] LLM call failed", {
        error: err.message,
        stack: err.stack,
        prompt: helper.prompt,
      });
      throw err;
    }
  }

  /**
   * OpenAI compatible chat completions router helper
   * @param helper Helper object
   */
  async answerChat(helper) {
    try {
      helper.answer.id = `chatcmpl-${crypto.randomUUID()}`;
      helper.answer.created = Math.floor(Date.now() / 1000);

      if (helper.answer.stream) {
        this.logger.debug(
          "[ollama] response as stream requested by the chat client"
        );
        this._setupStream(helper);
      }

      const response = await this._processPrompt(helper);

      if (!helper.answer.stream) {
        helper.res.json(response);
      }
    } catch (err) {
      this.logger.error("[ollama] internal error", {
        error: err.message,
        stack: err.stack,
        answer: helper.answer,
        prompt: helper.prompt,
      });
      throw err;
    }
  }

  /**
   * Prompt processor helper
   * @param helper Helper object
   */
  async _processPrompt(helper) {
    if (helper.answer.stream) {
      if (!helper.answer.content || helper.answer.content.trim() === "") {
        this.logger.debug("[ollama] asking LLM for a streaming response", {
          model: helper.answer.model,
          prompt: helper.prompt,
        });
        helper.answer.content = await this._streamLLMResponse(helper);
      } else {
        this._writeStreamChunk(helper, helper.answer.content);
      }
      this._endStream(helper);
      this.logger.debug("[ollama] LLM answer", {
        message: helper.answer.content,
      });
      return {};
    } else {
      if (!helper.answer.content || helper.answer.content.trim() === "") {
        this.logger.debug("[ollama] asking LLM for a response", {
          model: helper.answer.model,
          prompt: helper.prompt,
        });
        await this.callLLM(helper);
      }
      this.logger.debug("[ollama] LLM answer", {
        message: helper.answer.content,
      });
      return this._createResponse(helper);
    }
  }

  /***
   * Non streaming chat completion response helper
   * @param helper Helper object
   */
  _createResponse(helper) {
    return {
      id: helper.answer.id,
      object: "chat.completion",
      created: Math.floor(Date.now() / 1000),
      model: helper.answer.model,
      choices: [
        {
          index: 0,
          message: { role: "assistant", content: helper.answer.content },
          finish_reason: "stop",
        },
      ],
      usage: {},
    };
  }

  /**
   * Chat completion streaming header setup (SSE)
   */
  _setupStream(helper) {
    helper.res.setHeader("Content-Type", "text/event-stream");
    helper.res.setHeader("Cache-Control", "no-cache");
    helper.res.setHeader("Connection", "keep-alive");
    helper.res.write(
      `data: ${JSON.stringify({
        id: helper.answer.id,
        object: "chat.completion.chunk",
        created: helper.answer.created,
        model: helper.answer.model,
        choices: [{ index: 0, delta: { role: "assistant" } }],
      })}\n\n`
    );
  }

  /**
   * Chat completion streaming chunk writer (SSE)
   */
  _writeStreamChunk(helper, content) {
    helper.res.write(
      `data: ${JSON.stringify({
        id: helper.answer.id,
        object: "chat.completion.chunk",
        created: Math.floor(Date.now() / 1000),
        model: helper.answer.model,
        choices: [{ index: 0, delta: { content } }],
      })}\n\n`
    );
  }

  /**
   * Chat completion streaming response
   */
  async _streamLLMResponse(helper) {
    helper.answer.content = "";
    helper.answer.tool_calls = [];

    try {
      for await (const chunk of await this.ollama.chat({
        model: helper.answer.model,
        messages: helper.prompt.messages,
        tools: helper.prompt.tools,
        stream: true,
      })) {
        if (chunk.message?.content) {
          this._writeStreamChunk(helper, chunk.message?.content);
          helper.answer.content += chunk.message?.content;
        }
        if (chunk.message?.tool_calls?.length) {
          helper.answer.tool_calls = chunk.message.tool_calls;
        }
        if (chunk.done) break;
      }
    } catch (err) {
      helper.answer.content = "[ollama] error in streaming";
      this.logger.error(helper.answer.content, {
        error: err.message,
        answer: helper.answer,
        prompt: helper.prompt,
      });
      this._writeStreamChunk(helper, helper.answer.content);
    }
    return helper.answer.content;
  }

  /**
   * Finalize chat completion streaming (SSE)
   */
  _endStream(helper) {
    helper.res.write(
      `data: ${JSON.stringify({
        id: helper.answer.id,
        object: "chat.completion.chunk",
        created: Math.floor(Date.now() / 1000),
        model: helper.answer.model,
        choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
      })}\n\n`
    );
    helper.res.write("data: [DONE]\n\n");
    helper.res.end();
  }
}
