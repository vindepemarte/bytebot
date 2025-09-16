# OpenRouter and Gemini Integration Changes

## Overview
This document outlines all changes made to integrate OpenRouter and Gemini APIs into the ByteBot system, including proper authentication, model configuration, and error handling.

## Changes Made

### 1. Helm Chart Configuration Updates

#### `/helm/charts/bytebot-llm-proxy/values.yaml`
- Added `OPENROUTER_API_KEY: ""` to the environment variables section
- This allows configuration of OpenRouter API key through Helm values

#### `/helm/charts/bytebot-llm-proxy/templates/deployment.yaml`
- Added conditional environment variable for `OPENROUTER_API_KEY`
- Uses secretKeyRef to securely reference the API key from Kubernetes secrets
- Follows the same pattern as existing `GEMINI_API_KEY` configuration

#### `/helm/charts/bytebot-llm-proxy/templates/secret.yaml`
- Updated conditional check to include `OPENROUTER_API_KEY`
- Added `openrouter-api-key` entry in the secret data section
- Ensures OpenRouter API key is properly stored as a Kubernetes secret

### 2. LiteLLM Configuration Updates

#### `/packages/bytebot-llm-proxy/litellm-config.yaml`
- **OpenRouter Models**: Updated model configurations to use proper `openrouter/` prefix
  - Changed from `openai/gpt-oss-120b` to `openrouter/gpt-oss-120b`
  - Changed from `openai/sonoma-dusk-alpha` to `openrouter/sonoma-dusk-alpha`
  - Added `api_base: https://openrouter.ai/api/v1` to all OpenRouter models
- **Gemini Models**: Added proper API base configuration
  - Added `api_base: https://generativelanguage.googleapis.com/v1beta` to both `gemini-2.5-pro` and `gemini-2.5-flash`

### 3. Enhanced Error Handling

#### `/packages/bytebot-agent/src/proxy/proxy.service.ts`
- **New `handleApiError` method**: Processes errors based on the model provider
  - OpenRouter-specific error parsing and context
  - Gemini-specific error parsing and context
  - OpenAI/default error handling
- **Helper methods**:
  - `isOpenRouterModel`: Identifies OpenRouter models by prefix
  - `isGeminiModel`: Identifies Gemini models by prefix
- **Enhanced error context**: Includes model information and provider-specific details
- **Improved error logging**: More detailed error information for debugging

## Model Support

### OpenRouter Models
- `gpt-oss-120b` - Large open-source model
- `sonoma-dusk-alpha` - Advanced reasoning model

### Gemini Models
- `gemini-2.5-pro` - Google's flagship model
- `gemini-2.5-flash` - Fast, efficient model

### Authentication
- OpenRouter: Uses `OPENROUTER_API_KEY` environment variable
- Gemini: Uses `GEMINI_API_KEY` environment variable
- Both keys are managed through Kubernetes secrets in production

## Deployment Notes
- All changes are backward compatible
- Environment variables need to be set in the deployment environment
- Testing should be performed on Coolify VPS after deployment
- No breaking changes to existing API endpoints or functionality

## Files Modified
1. `/helm/charts/bytebot-llm-proxy/values.yaml`
2. `/helm/charts/bytebot-llm-proxy/templates/deployment.yaml`
3. `/helm/charts/bytebot-llm-proxy/templates/secret.yaml`
4. `/packages/bytebot-llm-proxy/litellm-config.yaml`
5. `/packages/bytebot-agent/src/proxy/proxy.service.ts`

## Next Steps
1. Commit and push changes to GitHub repository
2. Deploy to Coolify VPS for testing
3. Configure `OPENROUTER_API_KEY` and `GEMINI_API_KEY` environment variables
4. Test integration with new models