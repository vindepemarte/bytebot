import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import OpenAI, { APIUserAbortError } from 'openai';
import {
  ChatCompletionMessageParam,
  ChatCompletionContentPart,
} from 'openai/resources/chat/completions';
import {
  MessageContentBlock,
  MessageContentType,
  TextContentBlock,
  ToolUseContentBlock,
  ToolResultContentBlock,
  ImageContentBlock,
  isUserActionContentBlock,
  isComputerToolUseContentBlock,
  isImageContentBlock,
  ThinkingContentBlock,
} from '@bytebot/shared';
import { Message, Role } from '@prisma/client';
import { proxyTools } from './proxy.tools';
import {
  BytebotAgentService,
  BytebotAgentInterrupt,
  BytebotAgentResponse,
} from '../agent/agent.types';

@Injectable()
export class ProxyService implements BytebotAgentService {
  private readonly openai: OpenAI;
  private readonly logger = new Logger(ProxyService.name);

  constructor(private readonly configService: ConfigService) {
    const proxyUrl = this.configService.get<string>('BYTEBOT_LLM_PROXY_URL');

    if (!proxyUrl) {
      this.logger.warn(
        'BYTEBOT_LLM_PROXY_URL is not set. ProxyService will not work properly.',
      );
    }

    // Initialize OpenAI client with proxy configuration
    this.openai = new OpenAI({
      apiKey: 'dummy-key-for-proxy',
      baseURL: proxyUrl,
    });
  }

  /**
   * Main method to generate messages using the Chat Completions API
   */
  async generateMessage(
    systemPrompt: string,
    messages: Message[],
    model: string,
    useTools: boolean = true,
    signal?: AbortSignal,
  ): Promise<BytebotAgentResponse> {
    // Convert messages to Chat Completion format
    const chatMessages = this.formatMessagesForChatCompletion(
      systemPrompt,
      messages,
    );
    try {
      // Prepare the Chat Completion request with model-specific parameters
      const completionRequest: OpenAI.Chat.ChatCompletionCreateParams = {
        model,
        messages: chatMessages,
        max_tokens: 8192,
        ...(useTools && { tools: proxyTools }),
        ...this.getModelSpecificParameters(model),
      };

      // Make the API call
      const completion = await this.openai.chat.completions.create(
        completionRequest,
        { signal },
      );

      // Process the response
      const choice = completion.choices[0];
      if (!choice || !choice.message) {
        throw new Error('No valid response from Chat Completion API');
      }

      // Convert response to MessageContentBlocks
      const contentBlocks = this.formatChatCompletionResponse(choice.message);

      return {
        contentBlocks,
        tokenUsage: {
          inputTokens: completion.usage?.prompt_tokens || 0,
          outputTokens: completion.usage?.completion_tokens || 0,
          totalTokens: completion.usage?.total_tokens || 0,
        },
      };
    } catch (error: any) {
      if (error instanceof APIUserAbortError) {
        this.logger.log('Chat Completion API call aborted');
        throw new BytebotAgentInterrupt();
      }

      // Enhanced error handling for different API providers
      const enhancedError = this.handleApiError(error, model);
      
      this.logger.error(
        `Error sending message to proxy: ${enhancedError.message}`,
        enhancedError.stack,
      );
      throw enhancedError;
    }
  }

  /**
   * Convert Bytebot messages to Chat Completion format
   */
  private formatMessagesForChatCompletion(
    systemPrompt: string,
    messages: Message[],
  ): ChatCompletionMessageParam[] {
    const chatMessages: ChatCompletionMessageParam[] = [];

    // Add system message
    chatMessages.push({
      role: 'system',
      content: systemPrompt,
    });

    // Process each message
    for (const message of messages) {
      const messageContentBlocks = message.content as MessageContentBlock[];

      // Handle user actions specially
      if (
        messageContentBlocks.every((block) => isUserActionContentBlock(block))
      ) {
        const userActionBlocks = messageContentBlocks.flatMap(
          (block) => block.content,
        );

        for (const block of userActionBlocks) {
          if (isComputerToolUseContentBlock(block)) {
            chatMessages.push({
              role: 'user',
              content: `User performed action: ${block.name}\n${JSON.stringify(
                block.input,
                null,
                2,
              )}`,
            });
          } else if (isImageContentBlock(block)) {
            chatMessages.push({
              role: 'user',
              content: [
                {
                  type: 'image_url',
                  image_url: {
                    url: `data:${block.source.media_type};base64,${block.source.data}`,
                    detail: 'high',
                  },
                },
              ],
            });
          }
        }
      } else {
        for (const block of messageContentBlocks) {
          switch (block.type) {
            case MessageContentType.Text: {
              chatMessages.push({
                role: message.role === Role.USER ? 'user' : 'assistant',
                content: block.text,
              });
              break;
            }
            case MessageContentType.Image: {
              const imageBlock = block as ImageContentBlock;
              chatMessages.push({
                role: 'user',
                content: [
                  {
                    type: 'image_url',
                    image_url: {
                      url: `data:${imageBlock.source.media_type};base64,${imageBlock.source.data}`,
                      detail: 'high',
                    },
                  },
                ],
              });
              break;
            }
            case MessageContentType.ToolUse: {
              const toolBlock = block as ToolUseContentBlock;
              chatMessages.push({
                role: 'assistant',
                tool_calls: [
                  {
                    id: toolBlock.id,
                    type: 'function',
                    function: {
                      name: toolBlock.name,
                      arguments: JSON.stringify(toolBlock.input),
                    },
                  },
                ],
              });
              break;
            }
            case MessageContentType.Thinking: {
              const thinkingBlock = block as ThinkingContentBlock;
              const message: ChatCompletionMessageParam = {
                role: 'assistant',
                content: null,
              };
              message['reasoning_content'] = thinkingBlock.thinking;
              chatMessages.push(message);
              break;
            }
            case MessageContentType.ToolResult: {
              const toolResultBlock = block as ToolResultContentBlock;

              if (
                toolResultBlock.content.every(
                  (content) => content.type === MessageContentType.Image,
                )
              ) {
                chatMessages.push({
                  role: 'tool',
                  tool_call_id: toolResultBlock.tool_use_id,
                  content: 'screenshot',
                });
              }

              toolResultBlock.content.forEach((content) => {
                if (content.type === MessageContentType.Text) {
                  chatMessages.push({
                    role: 'tool',
                    tool_call_id: toolResultBlock.tool_use_id,
                    content: content.text,
                  });
                }

                if (content.type === MessageContentType.Image) {
                  chatMessages.push({
                    role: 'user',
                    content: [
                      {
                        type: 'text',
                        text: 'Screenshot',
                      },
                      {
                        type: 'image_url',
                        image_url: {
                          url: `data:${content.source.media_type};base64,${content.source.data}`,
                          detail: 'high',
                        },
                      },
                    ],
                  });
                }
              });
              break;
            }
          }
        }
      }
    }

    return chatMessages;
  }

  /**
   * Convert Chat Completion response to MessageContentBlocks
   */
  private formatChatCompletionResponse(
    message: OpenAI.Chat.ChatCompletionMessage,
  ): MessageContentBlock[] {
    const contentBlocks: MessageContentBlock[] = [];

    // Handle text content
    if (message.content) {
      contentBlocks.push({
        type: MessageContentType.Text,
        text: message.content,
      } as TextContentBlock);
    }

    if (message['reasoning_content']) {
      contentBlocks.push({
        type: MessageContentType.Thinking,
        thinking: message['reasoning_content'],
        signature: message['reasoning_content'],
      } as ThinkingContentBlock);
    }

    // Handle tool calls
    if (message.tool_calls && message.tool_calls.length > 0) {
      for (const toolCall of message.tool_calls) {
        if (toolCall.type === 'function') {
          let parsedInput = {};
          try {
            parsedInput = JSON.parse(toolCall.function.arguments || '{}');
          } catch (e) {
            this.logger.warn(
              `Failed to parse tool call arguments: ${toolCall.function.arguments}`,
            );
            parsedInput = {};
          }

          contentBlocks.push({
            type: MessageContentType.ToolUse,
            id: toolCall.id,
            name: toolCall.function.name,
            input: parsedInput,
          } as ToolUseContentBlock);
        }
      }
    }

    // Handle refusal
    if (message.refusal) {
      contentBlocks.push({
        type: MessageContentType.Text,
        text: `Refusal: ${message.refusal}`,
      } as TextContentBlock);
    }

    return contentBlocks;
  }

  /**
   * Get model-specific parameters based on the model name
   * Different models support different parameters and have different requirements
   */
  private getModelSpecificParameters(model: string): Record<string, any> {
    const parameters: Record<string, any> = {};

    // Check if this is an OpenRouter or Gemini model
    const isOpenRouter = this.isOpenRouterModel(model);
    const isGemini = this.isGeminiModel(model);

    // Only add reasoning_effort for OpenAI models (not OpenRouter or Gemini)
    if (!isOpenRouter && !isGemini) {
      parameters.reasoning_effort = 'high';
    }

    // OpenRouter and Gemini specific parameters are handled at the LiteLLM level
    // via the configuration file, so no additional parameters needed here

    return parameters;
  }

  /**
   * Handle API errors from different providers with enhanced error information
   */
  private handleApiError(error: any, model: string): Error {
    // Determine the API provider based on model name
    const isOpenRouter = this.isOpenRouterModel(model);
    const isGemini = this.isGeminiModel(model);
    const isOpenAI = !isOpenRouter && !isGemini;

    // Extract error details based on provider
    let errorMessage = error.message || 'Unknown API error';
    let errorCode = error.code || 'UNKNOWN_ERROR';
    let statusCode = error.status || error.statusCode || 500;

    // OpenRouter-specific error handling
    if (isOpenRouter) {
      if (error.response?.data?.error) {
        const openRouterError = error.response.data.error;
        errorMessage = `OpenRouter API Error: ${openRouterError.message || openRouterError}`;
        errorCode = openRouterError.code || 'OPENROUTER_ERROR';
      } else if (error.message?.includes('401')) {
        errorMessage = 'OpenRouter API authentication failed. Check OPENROUTER_API_KEY.';
        errorCode = 'OPENROUTER_AUTH_ERROR';
      } else if (error.message?.includes('429')) {
        errorMessage = 'OpenRouter API rate limit exceeded. Please try again later.';
        errorCode = 'OPENROUTER_RATE_LIMIT';
      }
    }

    // Gemini-specific error handling
    if (isGemini) {
      if (error.response?.data?.error) {
        const geminiError = error.response.data.error;
        errorMessage = `Gemini API Error: ${geminiError.message || geminiError}`;
        errorCode = geminiError.code || 'GEMINI_ERROR';
      } else if (error.message?.includes('403')) {
        errorMessage = 'Gemini API access denied. Check GEMINI_API_KEY and permissions.';
        errorCode = 'GEMINI_AUTH_ERROR';
      } else if (error.message?.includes('quota')) {
        errorMessage = 'Gemini API quota exceeded. Check your usage limits.';
        errorCode = 'GEMINI_QUOTA_ERROR';
      }
    }

    // OpenAI-specific error handling (default)
    if (isOpenAI) {
      if (error.response?.data?.error) {
        const openaiError = error.response.data.error;
        errorMessage = `OpenAI API Error: ${openaiError.message || openaiError}`;
        errorCode = openaiError.code || 'OPENAI_ERROR';
      }
    }

    // Create enhanced error with additional context
    const enhancedError = new Error(errorMessage);
    (enhancedError as any).code = errorCode;
    (enhancedError as any).status = statusCode;
    (enhancedError as any).model = model;
    (enhancedError as any).provider = isOpenRouter ? 'OpenRouter' : isGemini ? 'Gemini' : 'OpenAI';
    (enhancedError as any).originalError = error;

    return enhancedError;
  }

  /**
   * Check if model is from OpenRouter
   */
  private isOpenRouterModel(model: string): boolean {
    const openRouterModels = [
      'gpt-oss-120b',
      'sonoma-dusk-alpha',
      'sonoma-sky-alpha',
      'glm-4.1v-9b-thinking',
      'ernie-4.5-vl-28b-a3b',
      'claude-3.7-sonnet:thinking',
      'llama-4-maverick:free',
      'llama-4-scout:free',
      'kimi-vl-a3b-thinking:free',
    ];
    return openRouterModels.some(m => model.includes(m));
  }

  /**
   * Check if model is from Gemini
   */
  private isGeminiModel(model: string): boolean {
    const geminiModels = [
      'gemini-2.5-flash',
      'gemini-2.5-pro',
    ];
    return geminiModels.some(m => model.includes(m));
  }
}
